import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isAuthenticated, kNoAuth } from "../../config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "../../config/model-resolver";
import { councilRoleLabel } from "../../config/model-roles";
import { getDefault } from "../../config/settings";
import {
	COUNCIL_ADJUDICATOR_ROLE,
	COUNCIL_PLANNER_ROLE,
	type CouncilMemberSetting,
	councilMemberRounds,
	parseCouncilConfig,
	resolveCouncilMemberSelector,
} from "../../council/config";
import type { CouncilCoordinator, CouncilCoordinatorHost, CouncilRunOptions } from "../../council/coordinator";
import { formatCouncilKickoff, getCouncilCoordinator } from "../../council/coordinator";
import { type CouncilManifest, councilStateLabel, isCouncilTerminalState } from "../../council/state";
import { previewLine, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { COUNCIL_USAGE } from "./council-grammar";
import { commandConsumed } from "./parse";

/** Appended to every subcommand-argument refusal so the literal-task escape is always discoverable. */
const ESCAPE_HINT = " (prefix with -- if your task starts with a subcommand word)";
const COUNCIL_SUBCOMMANDS: Record<string, true> = {
	status: true,
	cancel: true,
	resume: true,
	config: true,
};

type ParsedCouncilAction =
	| { kind: "usage" }
	| { kind: "task"; task: string }
	| { kind: "status" }
	| { kind: "cancel" }
	| { kind: "resume"; runId?: string }
	| { kind: "config" }
	| { kind: "error"; message: string };

export interface CouncilCommandDependencies {
	getCoordinator(host: CouncilCoordinatorHost): CouncilCoordinator;
}

const DEFAULT_DEPENDENCIES: CouncilCommandDependencies = {
	getCoordinator: getCouncilCoordinator,
};

/** Parse council arguments without normalizing task content beyond the command's documented outer trim. */
export function parseCouncilCommandArgs(rawArgs: string): ParsedCouncilAction {
	const args = rawArgs.trim();
	if (!args) return { kind: "usage" };

	const markerMatch = /^--(?:\s|$)/.exec(args);
	if (markerMatch) {
		const task = args.slice(markerMatch[0].length).trim();
		return task ? { kind: "task", task } : { kind: "usage" };
	}

	const firstWhitespace = args.search(/\s/);
	const rawFirstToken = firstWhitespace === -1 ? args : args.slice(0, firstWhitespace);
	const firstToken = rawFirstToken.toLowerCase();
	const trailing = firstWhitespace === -1 ? "" : args.slice(firstWhitespace).trim();
	if (!Object.hasOwn(COUNCIL_SUBCOMMANDS, firstToken)) {
		// A mistyped subcommand is only a mistype when nothing follows it; a real task that happens
		// to open with a near-miss word still dispatches as a task.
		if (!trailing) {
			// Declaration order is the tie-breaker.
			const suggestion = Object.keys(COUNCIL_SUBCOMMANDS).find(name => isSingleEditAway(firstToken, name));
			if (suggestion) {
				return {
					kind: "error",
					message: `Unknown council subcommand "${rawFirstToken}". Did you mean /council ${suggestion}? Run /council -- ${rawFirstToken} to use it as a task.`,
				};
			}
		}
		return { kind: "task", task: args };
	}
	switch (firstToken) {
		case "status":
			return trailing ? { kind: "error", message: `Usage: /council status${ESCAPE_HINT}` } : { kind: "status" };
		case "cancel":
			return trailing ? { kind: "error", message: `Usage: /council cancel${ESCAPE_HINT}` } : { kind: "cancel" };
		case "config":
			return trailing ? { kind: "error", message: `Usage: /council config${ESCAPE_HINT}` } : { kind: "config" };
		case "resume": {
			if (!trailing) return { kind: "resume" };
			if (/\s/.test(trailing)) return { kind: "error", message: `Usage: /council resume [run-id]${ESCAPE_HINT}` };
			return { kind: "resume", runId: trailing };
		}
	}
	return { kind: "task", task: args };
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance-1 test: one substitution, insertion,
 * deletion, or adjacent transposition. Plain Levenshtein scores `statsu` and `cnacel` at 2, so
 * `levenshteinDistance` in `edit/modes/replace.ts` cannot serve this check.
 */
function isSingleEditAway(token: string, candidate: string): boolean {
	if (token === candidate) return false;
	const delta = token.length - candidate.length;
	if (delta > 1 || delta < -1) return false;
	let beforePrevious: number[] = [];
	let previous: number[] = Array.from({ length: candidate.length + 1 }, (_, index) => index);
	for (let row = 1; row <= token.length; row++) {
		const current: number[] = [row];
		for (let column = 1; column <= candidate.length; column++) {
			const cost = token[row - 1] === candidate[column - 1] ? 0 : 1;
			let best = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + cost);
			if (
				row > 1 &&
				column > 1 &&
				token[row - 1] === candidate[column - 2] &&
				token[row - 2] === candidate[column - 1]
			) {
				best = Math.min(best, beforePrevious[column - 2]! + 1);
			}
			current.push(best);
		}
		beforePrevious = previous;
		previous = current;
	}
	return previous[candidate.length] === 1;
}

/** Stable one-line snapshot used by start, resume, cancel, and status output. */
export function formatCouncilSnapshot(manifest: CouncilManifest): string {
	const currentRound =
		manifest.rounds.find(round => round.status === "running") ??
		manifest.rounds.find(round => round.status === "pending") ??
		manifest.rounds.at(-1);
	const members = currentRound?.members ?? [];
	const running = members.filter(member => member.status === "running").length;
	const succeeded = members.filter(member => member.status === "succeeded").length;
	const failed = members.filter(member => member.status === "failed").length;
	const round = currentRound?.round ?? 0;
	// The first warning verbatim (sanitized, width-bounded) stands in for the rest: an operator
	// cannot act on a bare count, and the full list would swamp a one-line snapshot.
	const firstWarning = manifest.warnings[0];
	const warning =
		firstWarning === undefined
			? ""
			: `; warning: ${previewLine(sanitizeText(firstWarning), TRUNCATE_LENGTHS.CONTENT)}${
					manifest.warnings.length > 1 ? ` (+${manifest.warnings.length - 1} more)` : ""
				}`;
	return `Council ${manifest.runId} ${councilStateLabel(manifest.state)} (round ${round}/${manifest.config.rounds}): ${succeeded} of ${members.length} members done, ${running} running, ${failed} failed; plan: local://${manifest.outputPath}${warning}`;
}

export function isCouncilRunTerminal(manifest: CouncilManifest): boolean {
	return isCouncilTerminalState(manifest.state);
}
export function councilMoveBlockMessage(
	coordinator: Pick<CouncilCoordinator, "executionInFlight" | "setupInFlight" | "snapshot">,
): string | undefined {
	if (coordinator.setupInFlight) {
		return "Cannot move while council setup/preflight is in progress; use /council cancel first.";
	}
	const snapshot = coordinator.snapshot;
	if (snapshot && !isCouncilRunTerminal(snapshot)) {
		return `Cannot move while council run ${snapshot.runId} is ${councilStateLabel(snapshot.state)}; use /council cancel first.`;
	}
	if (coordinator.executionInFlight) {
		return "Cannot move while council execution is still settling; wait for it to finish.";
	}
	return undefined;
}

function coordinatorHost(runtime: SlashCommandRuntime): CouncilCoordinatorHost {
	return {
		session: runtime.session,
		toolSession: runtime.session.getToolSession(),
		sessionManager: runtime.sessionManager,
		settings: runtime.settings,
		modelRegistry: runtime.session.modelRegistry,
	};
}

/** Operator-facing text for a thrown Council error, stripped of anything a provider could inject. */
function sanitizedErrorText(error: unknown): string {
	return sanitizeText(error instanceof Error ? error.message : String(error));
}
/**
 * Resolving the roster can block on the keychain or an OAuth refresh, and `resume` additionally
 * reads storage first, so both paths announce what they are doing before the coordinator call and
 * announce the roster the moment the run id exists — no silent window ahead of the first child.
 */
async function runAndHold(
	runtime: SlashCommandRuntime,
	coordinator: CouncilCoordinator,
	kind: "start" | "resume",
	operation: (options: CouncilRunOptions) => Promise<CouncilManifest>,
): Promise<void> {
	const expectedSessionId = runtime.sessionManager.getSessionId();
	const ownsSession = (): boolean => runtime.sessionManager.getSessionId() === expectedSessionId;
	try {
		if (kind === "resume" && ownsSession()) await runtime.output("Loading council run…");
		if (ownsSession()) await runtime.output("Resolving council roster…");
		const manifest = await operation({
			onKickoff: async preview => {
				if (ownsSession()) await runtime.output(formatCouncilKickoff(preview));
			},
		});
		if (!ownsSession()) return;
		if (kind === "resume" && (manifest.state === "completed" || manifest.state === "completed-degraded")) {
			await runtime.output(`Run ${sanitizeText(manifest.runId)} already completed; nothing to resume.`);
		}
		const completion = coordinator.completion;
		let kickoffReported: PromiseWithResolvers<void> | undefined;
		if (completion && !isCouncilTerminalState(manifest.state)) {
			kickoffReported = Promise.withResolvers<void>();
			const heldCompletion = completion.finally(async () => {
				await kickoffReported!.promise;
				if (!ownsSession()) return;
				const terminal = coordinator.snapshot;
				if (!terminal) return;
				const rawFailure = sanitizeText(terminal.failure?.reason ?? "")
					.replace(/\s+/g, " ")
					.trim();
				const failure = rawFailure && rawFailure.length > 240 ? `${rawFailure.slice(0, 239)}…` : rawFailure;
				try {
					await runtime.output(`${formatCouncilSnapshot(terminal)}${failure ? `; failure=${failure}` : ""}`);
				} catch {
					// Command output delivery must not rewrite the coordinator's outcome.
				}
			});
			runtime.holdTurn?.(heldCompletion);
		}
		try {
			if (ownsSession()) await runtime.output(formatCouncilSnapshot(manifest));
		} finally {
			kickoffReported?.resolve();
		}
	} catch (error) {
		if (ownsSession()) await runtime.output(sanitizedErrorText(error));
	}
}

/** Resolve one council role to a display string, flagging anything that would block a run. */
async function describeCouncilRole(
	runtime: SlashCommandRuntime,
	role: string,
	sessionId: string,
): Promise<{ text: string; incomplete: boolean }> {
	const roleResolution = resolveCouncilMemberSelector(runtime.settings, role);
	if (roleResolution.kind === "unassigned") return { text: "unassigned", incomplete: true };
	if (roleResolution.kind === "invalid") return { text: "invalid-selector", incomplete: true };
	const resolved = resolveCliModel({
		cliModel: roleResolution.selector,
		modelRegistry: runtime.session.modelRegistry,
		settings: runtime.settings,
		preferences: getModelMatchPreferences(runtime.settings),
	});
	if (!resolved.model) return { text: "unresolvable", incomplete: true };
	const modelName = `${resolved.model.provider}/${resolved.model.id}`;
	try {
		const apiKey = await runtime.session.modelRegistry.getApiKey(resolved.model, sessionId);
		return apiKey === kNoAuth || isAuthenticated(apiKey)
			? { text: modelName, incomplete: false }
			: { text: `${modelName} (credentials unavailable)`, incomplete: false };
	} catch {
		return { text: `${modelName} (credentials unresolved)`, incomplete: false };
	}
}

async function formatIdleCouncilStatus(runtime: SlashCommandRuntime): Promise<string> {
	try {
		const config = parseCouncilConfig(runtime.settings);
		const sessionId = runtime.sessionManager.getSessionId();
		let rosterIncomplete = false;
		const roster = await Promise.all(
			config.members.map(async member => {
				if (!member.enabled) return `${councilRoleLabel(member.role)}=disabled`;
				const rounds = councilMemberRounds(member, config.rounds);
				const suffix =
					rounds.length === 0
						? ` (pinned to round ${member.round}, inactive)`
						: config.rounds > 1
							? ` (r${rounds.join(",")})`
							: "";
				const described = await describeCouncilRole(runtime, member.role, sessionId);
				// An inert member never runs, so an unresolved model on it cannot block anything.
				if (described.incomplete && rounds.length > 0) rosterIncomplete = true;
				return `${councilRoleLabel(member.role)}=${described.text}${suffix}`;
			}),
		);
		const plannerResolution = resolveCouncilMemberSelector(runtime.settings, COUNCIL_PLANNER_ROLE);
		const planner =
			plannerResolution.kind === "resolved"
				? (await describeCouncilRole(runtime, COUNCIL_PLANNER_ROLE, sessionId)).text
				: "slow model role";
		const adjudicatorResolution = resolveCouncilMemberSelector(runtime.settings, COUNCIL_ADJUDICATOR_ROLE);
		const adjudicator =
			adjudicatorResolution.kind === "resolved"
				? `${(await describeCouncilRole(runtime, COUNCIL_ADJUDICATOR_ROLE, sessionId)).text} (delegated)`
				: "main session (in-session adjudication)";
		const enabled = config.members.filter(member => member.enabled).length;
		return `No active council run. planner=${planner}, adjudicator=${adjudicator}; ${enabled} role${enabled === 1 ? "" : "s"} enabled (${roster.join(", ")}); ${config.rounds} round(s) per run.${
			rosterIncomplete ? " Fix the roster with /council config." : ""
		}`;
	} catch (error) {
		return `No active council run. Council configuration is invalid: ${sanitizedErrorText(error)}. Fix it in ${runtime.settings.getGlobalConfigPath()}.`;
	}
}

/**
 * ACP has no Model Hub, so `/council config` has to stand on its own. Enabled member selectors are
 * read exclusively from `modelRoles[role]`, so a `council.members` snippet alone can never make a
 * run succeed: the example carries both halves and is derived from the effective roster so the role
 * names match what the operator already has.
 */
async function formatCouncilConfigGuidance(runtime: SlashCommandRuntime): Promise<string> {
	let members: readonly CouncilMemberSetting[];
	let rounds: number;
	try {
		const config = parseCouncilConfig(runtime.settings);
		members = config.members;
		rounds = config.rounds;
	} catch {
		members = getDefault("council.members");
		rounds = getDefault("council.rounds");
	}
	const yaml = ["council:", "  members:"];
	for (const member of members) {
		yaml.push(`    - role: ${member.role}`, `      enabled: ${member.enabled}`);
		// Only emit a pin the operator already has: an omitted `round` means every configured round,
		// and writing one out would silently narrow a roster that is currently unrestricted.
		if (member.round !== undefined) yaml.push(`      round: ${member.round}`);
	}
	yaml.push(
		`  rounds: ${rounds}`,
		"  advisor:",
		"    planner: false",
		"    reviewers: false",
		"    adjudicator: false",
		"modelRoles:",
	);
	for (const member of members) {
		if (!member.enabled) continue;
		yaml.push(`  ${member.role}: provider/model`);
	}
	yaml.push(`  ${COUNCIL_PLANNER_ROLE}: provider/model`, `  ${COUNCIL_ADJUDICATOR_ROLE}: provider/model`);
	return [
		await formatIdleCouncilStatus(runtime),
		`Council configuration is TUI-only in the Model Hub; edit ${runtime.settings.getGlobalConfigPath()} directly instead:`,
		yaml.join("\n"),
		`Each member's optional \`round\` pins it to that review round; omit it to run in every configured round. An unassigned \`${COUNCIL_PLANNER_ROLE}\` role falls back to the \`slow\` model role, and an unassigned \`${COUNCIL_ADJUDICATOR_ROLE}\` role keeps adjudication in your main session.`,
		"Each `council.advisor.*` flag attaches a live advisor (the `advisor` model role) to that role's turns; its tools are clamped to the council child's read-only allowlist and its spend is billed to that role.",
	].join("\n");
}

/** Shared TUI/ACP handler. Every branch consumes the slash command and never forwards task text to the model. */
export async function handleCouncilCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
	dependencies: CouncilCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<SlashCommandResult> {
	const action = parseCouncilCommandArgs(command.args);
	if (action.kind === "usage" || action.kind === "error") {
		await runtime.output(action.kind === "usage" ? COUNCIL_USAGE : action.message);
		return commandConsumed();
	}
	if (action.kind === "config") {
		if (runtime.openCouncilConfig) {
			await runtime.openCouncilConfig();
		} else {
			await runtime.output(await formatCouncilConfigGuidance(runtime));
		}
		return commandConsumed();
	}

	const coordinator = dependencies.getCoordinator(coordinatorHost(runtime));
	if (action.kind === "status") {
		try {
			if (coordinator.setupInFlight && !coordinator.snapshot) {
				await runtime.output("Council setup/preflight is in progress.");
			} else {
				const manifest = await coordinator.status();
				await runtime.output(manifest ? formatCouncilSnapshot(manifest) : await formatIdleCouncilStatus(runtime));
			}
		} catch (error) {
			await runtime.output(sanitizedErrorText(error));
		}
		return commandConsumed();
	}
	if (action.kind === "cancel") {
		try {
			const prior = coordinator.snapshot;
			const pendingSetup = coordinator.setupInFlight;
			if (pendingSetup) {
				await coordinator.cancelForSessionTransition();
				const current = coordinator.snapshot;
				const createdDuringCancellation =
					current && (!prior || current.runId !== prior.runId || current.state !== prior.state);
				await runtime.output(
					createdDuringCancellation ? formatCouncilSnapshot(current) : "Council setup cancelled before dispatch.",
				);
			} else {
				const active = await coordinator.status();
				if (!active || (isCouncilTerminalState(active.state) && !coordinator.executionInFlight)) {
					await runtime.output("No active council run.");
				} else if (isCouncilTerminalState(active.state)) {
					await runtime.output(formatCouncilSnapshot(active));
				} else {
					await runtime.output(formatCouncilSnapshot(await coordinator.cancel()));
				}
			}
		} catch (error) {
			await runtime.output(sanitizedErrorText(error));
		}
		return commandConsumed();
	}
	if (action.kind === "resume") {
		await runAndHold(runtime, coordinator, "resume", options => coordinator.resume(action.runId, options));
		return commandConsumed();
	}

	await runAndHold(runtime, coordinator, "start", options => coordinator.start(action.task, options));
	return commandConsumed();
}
