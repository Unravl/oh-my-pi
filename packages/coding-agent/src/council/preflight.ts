import * as fs from "node:fs/promises";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { isAuthenticated, kNoAuth, type ModelRegistry } from "../config/model-registry";
import * as modelResolver from "../config/model-resolver";
import { councilRoleLabel } from "../config/model-roles";
import type { Settings } from "../config/settings";
import reviewLens from "../prompts/council/lens.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { StructuredSubagentRequest } from "../task/structured-subagent";
import * as subagents from "../task/structured-subagent";
import type { ConfiguredThinkingLevel } from "../thinking";
import * as thinking from "../thinking";
import type { ToolSession } from "../tools";
import * as git from "../utils/git";
import {
	COUNCIL_ADJUDICATOR_ROLE,
	COUNCIL_PLANNER_ROLE,
	type CouncilConfig,
	type CouncilMember,
	councilMemberRounds,
	parseCouncilConfig,
	resolveCouncilMemberSelector,
} from "./config";
import * as instructions from "./instructions";
import type { CouncilPublicationTarget } from "./publication";
import * as publication from "./publication";
import {
	COUNCIL_ADJUDICATION_SCHEMA,
	COUNCIL_CONSULT_SCHEMA,
	COUNCIL_PLANNER_SCHEMA,
	COUNCIL_REPORT_SCHEMA,
	COUNCIL_TASK_CHAR_LIMIT,
} from "./schema";
import {
	type CouncilInstructionSnapshot,
	type CouncilManifest,
	type CouncilRunOrigin,
	councilResumeRosterLimitRefusal,
	DEFAULT_COUNCIL_RUN_ORIGIN,
} from "./state";
import { councilPlanRoot } from "./storage";

export const COUNCIL_AGENT_TOOLS = ["read", "grep", "glob", "lsp", "ast_grep"] as const;

export type CouncilDispatchErrorCode =
	| "COUNCIL_CONFIG_INVALID"
	| "COUNCIL_TASK_INVALID"
	| "COUNCIL_NO_ENABLED_MEMBERS"
	| "COUNCIL_ROUND_UNSTAFFED"
	| "COUNCIL_MEMBER_MODEL_INVALID"
	| "COUNCIL_PLANNER_MODEL_INVALID"
	| "COUNCIL_ADJUDICATOR_MODEL_INVALID"
	| "COUNCIL_MAIN_MODEL_INVALID"
	| "COUNCIL_WRITE_TOOL_REQUIRED"
	| "COUNCIL_REPOSITORY_INVALID"
	| "COUNCIL_PUBLICATION_INVALID"
	| "COUNCIL_INSTRUCTIONS_INVALID"
	| "COUNCIL_SUBAGENT_POLICY_INVALID";

/** A dispatch blocker proven before any council model is invoked. */
export class CouncilDispatchError extends Error {
	readonly spending = false;

	constructor(
		readonly code: CouncilDispatchErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CouncilDispatchError";
	}
}

/** Existing live-session surfaces required by preflight. A ToolSession is supplied, never synthesized. */
export interface CouncilPreflightHost {
	toolSession: ToolSession;
	session: Pick<AgentSession, "model" | "thinkingLevel" | "getActiveToolNames">;
	modelRegistry: ModelRegistry;
	settings: Settings;
	sessionManager: Pick<SessionManager, "getCwd" | "getSessionId">;
}

export interface CouncilResolvedMember extends CouncilMember {
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
	/** The shared review brief. Identical for every reviewer; the assigned model supplies the difference. */
	lens: string;
	/**
	 * Configured rounds this reviewer serves. An omitted `round` yields every configured round, so
	 * such a member always includes round 1.
	 *
	 * Never empty under a dispatch, where an empty set is exactly what makes a member inert. A
	 * consult resolves with `scope: "all"` and ignores this field, so a consulted member pinned above
	 * `council.rounds` legitimately carries an empty set — a consult has no rounds to serve.
	 */
	rounds: readonly number[];
	/** Whether a live advisor watches this reviewer's turns. */
	advisor: boolean;
}

export interface CouncilResolvedPlanner {
	/** `planner` when the lead role is assigned, `slow` when it falls back. */
	role: string;
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
	advisor: boolean;
}

/**
 * Who judges the findings. `main` is the live session driving `xd://council` — the historical
 * behaviour, and still the default for anyone who has not assigned `modelRoles.adjudicator`.
 * `delegated` is a pinned child agent that terminal-yields its adjudication instead.
 */
export type CouncilResolvedAdjudicator =
	| { mode: "main"; selector: string; model: Model<Api>; effort: ConfiguredThinkingLevel | undefined }
	| {
			mode: "delegated";
			requestedSelector: string;
			resolvedSelector: string;
			model: Model<Api>;
			effort: ConfiguredThinkingLevel | undefined;
			advisor: boolean;
	  };

export interface CouncilMainDispatchSnapshot {
	selector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
}

export interface CouncilMemberRequestPolicy extends StructuredSubagentRequest {
	agent: "council-member";
}

export interface CouncilDispatchPlan {
	task: string;
	cwd: string;
	repoRoot: string;
	sessionId: string;
	/**
	 * Who convened the run. An `agent` dispatch can never adjudicate in Main mode — the tool call
	 * holding the turn is exactly what Main would have to finish first — so the adjudicator is always
	 * delegated, and the plan publishes under the `brief` stem instead of `plan`.
	 */
	origin: CouncilRunOrigin;
	publicationTarget: CouncilPublicationTarget;
	config: CouncilConfig;
	rounds: CouncilConfig["rounds"];
	roster: CouncilConfig["members"];
	/** Enabled members with a non-empty round set, in roster order. Inert members are absent. */
	members: CouncilResolvedMember[];
	/** Enabled members parked above the configured round count: configured, never dispatched. */
	inert: CouncilMember[];
	planner: CouncilResolvedPlanner;
	adjudicator: CouncilResolvedAdjudicator;
	/**
	 * `provider/id` an attached advisor will run on, resolved from the `advisor` model role. Absent
	 * when no `council.advisor.*` toggle applies to this run, or when the role resolves to nothing —
	 * in which case the toggle is a silent no-op at runtime and preflight warns instead.
	 */
	advisorModel?: string;
	instructions: CouncilInstructionSnapshot;
	/** Everything worth telling the operator: degrading collisions plus advisory notes. */
	warnings: string[];
	/**
	 * Whether {@link warnings} contains a real degradation of the run being executed. Parked
	 * configuration and an unattachable advisor are reported without degrading the run.
	 */
	degraded: boolean;
	plannerRequest: StructuredSubagentRequest & { agent: "council-planner" };
	memberRequests: CouncilMemberRequestPolicy[];
	/** Delegated adjudication only; absent in `main` mode. */
	adjudicatorRequest?: StructuredSubagentRequest & { agent: "council-adjudicator" };
}

function dispatchError(code: CouncilDispatchErrorCode, message: string, cause?: unknown): CouncilDispatchError {
	return new CouncilDispatchError(code, message, cause === undefined ? undefined : { cause });
}

/** Remedy for a roster slot that resolves to zero or several models: the assignment lives in the roster UI. */
const COUNCIL_ROSTER_REMEDY = "Assign models with /council config (Model Hub -> Roles & Council).";
/** The planner lead is assigned through `modelRoles.planner`, beside the roster in the same UI. */
const COUNCIL_PLANNER_REMEDY =
	"Assign the Council Planner row with /council config (Model Hub -> Roles & Council); it falls back to the `slow` model role when unassigned.";
/** The adjudicator lead is optional: unassigned means the live Main session judges, as before. */
const COUNCIL_ADJUDICATOR_REMEDY =
	"Assign the Council Adjudicator row with /council config (Model Hub -> Roles & Council), or clear it to let your main session adjudicate.";
/** Credentials are never fixed by editing the roster, so these refusals point at the login flow instead. */
const COUNCIL_CREDENTIAL_REMEDY = "Sign in to that provider with /login, then start the council again.";

function resolvedEffort(
	model: Model<Api>,
	configured: ConfiguredThinkingLevel | undefined,
	settings?: Settings,
): ConfiguredThinkingLevel | undefined {
	let preferred = configured;
	if (preferred === undefined && settings !== undefined) {
		preferred =
			model.thinking?.defaultLevel ?? thinking.parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
	}
	const concrete =
		preferred === thinking.AUTO_THINKING
			? thinking.resolveProvisionalAutoLevel(model)
			: thinking.concreteThinkingLevel(preferred);
	return thinking.resolveThinkingLevelForModel(model, concrete);
}
export function resolveCouncilMainEffort(
	model: Model<Api>,
	configured: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	return resolvedEffort(model, configured);
}

async function assertUsableModelAuth(
	modelRegistry: ModelRegistry,
	model: Model<Api>,
	sessionId: string,
): Promise<boolean> {
	const apiKey = await modelRegistry.getApiKey(model, sessionId);
	return apiKey === kNoAuth || isAuthenticated(apiKey);
}

/**
 * Resolve, validate, and credential-check one pinned council model.
 *
 * The caller resolves the selector first and passes it in: the resolution strategy is never
 * inferred from the error code, so adding a code can no longer silently re-enable a role-default
 * fallback for a lead that is supposed to be an explicit pin.
 *
 * `label` is the operator-facing name from {@link councilRoleLabel}, never the durable role id.
 * Ids belong in selectors, manifests, and config paths; refusal prose gets `Reviewer 3`.
 */
async function resolvePinnedRole(
	host: CouncilPreflightHost,
	options: {
		label: string;
		requestedSelector: string;
		code: CouncilDispatchErrorCode;
		remedy: string;
		sessionId: string;
	},
): Promise<{
	requestedSelector: string;
	resolvedSelector: string;
	model: Model<Api>;
	effort: ConfiguredThinkingLevel | undefined;
}> {
	const { label, requestedSelector, code, remedy, sessionId } = options;
	const resolved = modelResolver.resolveCliModel({
		cliModel: requestedSelector,
		modelRegistry: host.modelRegistry,
		settings: host.settings,
		preferences: modelResolver.getModelMatchPreferences(host.settings),
	});
	if (!resolved.model) {
		throw dispatchError(
			code,
			`Council ${label} model is unavailable: ${resolved.error ?? requestedSelector}. ${remedy}`,
		);
	}
	if (resolved.model.supportsTools === false) {
		throw dispatchError(
			code,
			`Council ${label} model ${resolved.model.provider}/${resolved.model.id} does not support tools. ${remedy}`,
		);
	}
	let usable: boolean;
	try {
		usable = await assertUsableModelAuth(host.modelRegistry, resolved.model, sessionId);
	} catch (error) {
		throw dispatchError(
			code,
			`Council ${label} model credentials could not be resolved: ${error instanceof Error ? error.message : String(error)}. ${COUNCIL_CREDENTIAL_REMEDY}`,
			error,
		);
	}
	if (!usable) {
		throw dispatchError(
			code,
			`Council ${label} model ${resolved.model.provider}/${resolved.model.id} has no usable credentials. ${COUNCIL_CREDENTIAL_REMEDY}`,
		);
	}
	const effort = resolvedEffort(resolved.model, resolved.thinkingLevel, host.settings);
	const resolvedSelector = modelResolver.formatModelSelectorValue(
		modelResolver.formatModelStringWithRouting(resolved.model),
		effort,
	);
	return { requestedSelector, resolvedSelector, model: resolved.model, effort };
}

function modelIdentity(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export interface CouncilDispatchWarningInputs {
	members: readonly CouncilResolvedMember[];
	/** Enabled-but-parked members, reported so a pinned round nobody configured is not silent. */
	inert: readonly CouncilMember[];
	rounds: number;
}

export interface CouncilDispatchWarnings {
	/** Collisions inside the run that actually executes: these mark the run degraded. */
	degrading: string[];
	/** Parked configuration: reported so it is not silent, never a degradation of this run. */
	advisory: string[];
}

/**
 * Advisory notes, never refusals. The duplicate-model check is per round: two reviewers on the
 * same model in *different* rounds is a deliberate second opinion, not an accidental collision.
 *
 * Every row names reviewers by their stable label, matching the kickoff preview and the durable
 * run cards; the raw role id stays in the manifest these warnings are written beside.
 */
export function councilDispatchWarnings(inputs: CouncilDispatchWarningInputs): CouncilDispatchWarnings {
	const degrading: string[] = [];
	for (let round = 1; round <= inputs.rounds; round++) {
		const labelsByModel = new Map<string, string[]>();
		for (const member of inputs.members) {
			if (!member.rounds.includes(round)) continue;
			const identity = modelIdentity(member.model);
			const label = councilRoleLabel(member.role);
			const labels = labelsByModel.get(identity);
			if (labels) labels.push(label);
			else labelsByModel.set(identity, [label]);
		}
		for (const [identity, labels] of labelsByModel) {
			if (labels.length > 1) {
				degrading.push(
					inputs.rounds > 1
						? `Council reviewers ${labels.join(", ")} resolve to the same model ${identity} in round ${round}.`
						: `Council reviewers ${labels.join(", ")} resolve to the same model ${identity}.`,
				);
			}
		}
	}
	const advisory = inputs.inert.map(
		member =>
			`Council ${councilRoleLabel(member.role)} is pinned to round ${member.round} but only ${inputs.rounds} round(s) are configured; it will not run.`,
	);
	return { degrading, advisory };
}

/** Revalidate the live Main surface immediately before an adjudication turn. */
export async function preflightCouncilMainDispatch(host: CouncilPreflightHost): Promise<CouncilMainDispatchSnapshot> {
	const mainModel = host.session.model;
	if (!mainModel) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			"Council dispatch requires an active Main model. Pick one with /model.",
		);
	}
	if (mainModel.supportsTools === false) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model ${mainModel.provider}/${mainModel.id} does not support tools. Pick a tool-capable Main model with /model.`,
		);
	}
	let mainUsable: boolean;
	try {
		mainUsable = await assertUsableModelAuth(host.modelRegistry, mainModel, host.sessionManager.getSessionId());
	} catch (error) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model credentials could not be resolved: ${error instanceof Error ? error.message : String(error)}. ${COUNCIL_CREDENTIAL_REMEDY}`,
			error,
		);
	}
	if (!mainUsable) {
		throw dispatchError(
			"COUNCIL_MAIN_MODEL_INVALID",
			`Council Main model ${mainModel.provider}/${mainModel.id} has no usable credentials. ${COUNCIL_CREDENTIAL_REMEDY}`,
		);
	}
	if (!host.session.getActiveToolNames().includes("write")) {
		throw dispatchError(
			"COUNCIL_WRITE_TOOL_REQUIRED",
			"Council dispatch requires Main's write tool for xd://council, but write is not in the active tool set. Run /tools to inspect it and restore write before starting a council.",
		);
	}
	const effort = resolveCouncilMainEffort(mainModel, host.session.thinkingLevel);
	return {
		model: mainModel,
		effort,
		selector: modelResolver.formatModelSelectorValue(modelResolver.formatModelStringWithRouting(mainModel), effort),
	};
}

/** Every bundled council child, sharing one read-only policy so no surface can widen just one of them. */
export type CouncilChildAgent = "council-planner" | "council-member" | "council-adjudicator" | "council-consultant";

function requestPolicy<TAgent extends CouncilChildAgent>(
	host: CouncilPreflightHost,
	task: string,
	cwd: string,
	agent: TAgent,
	selector: string,
	outputSchema: unknown,
	instructionSnapshot: CouncilInstructionSnapshot,
	advisor: boolean,
): StructuredSubagentRequest & { agent: TAgent } {
	return {
		session: host.toolSession,
		cwd,
		invocationKind: "task",
		assignment: task,
		agent,
		model: selector,
		tools: COUNCIL_AGENT_TOOLS,
		restrictToolNames: true,
		advisor,
		inheritContextFiles: true,
		additionalContextFiles: instructionSnapshot.contextFiles,
		skills: [],
		rules: [],
		autoloadSkills: [],
		pinModel: true,
		outputSchema,
		schemaMode: "strict",
		enableIrc: false,
	};
}

export interface CouncilPreflightOptions {
	/** Resume-only: revalidate this immutable promised path instead of allocating a new collision suffix. */
	promisedOutputPath?: string;
	/**
	 * Run cancellation. Preflight reaches no model, but it still awaits credential lookups, git
	 * discovery, instruction capture, subagent policy resolution, and filesystem probes, so it
	 * re-checks this signal before it starts and between every awaited stage.
	 *
	 * These are cooperative checkpoints, not propagation: the APIs behind those stages do not all
	 * accept an AbortSignal, so an operation already in flight still runs to completion and a
	 * pathological one still falls to the caller's bounded transition timeout. What the checkpoints
	 * guarantee is that no *later* stage starts once the run is cancelled.
	 */
	signal?: AbortSignal;
	/**
	 * Who is convening. `command` keeps the historical behaviour, including Main-mode adjudication
	 * when `modelRoles.adjudicator` is unassigned. `agent` forces a delegated adjudicator and the
	 * `brief` publication stem. Defaults to `command`.
	 */
	origin?: CouncilRunOrigin;
}

/** Cooperative cancellation probe threaded through every awaited preflight stage. */
type CouncilPreflightCheckpoint = () => void;

export interface CouncilResolvedRoster {
	config: CouncilConfig;
	/** Enabled members with a non-empty round set, in roster order. Inert members are absent. */
	members: CouncilResolvedMember[];
	/** Enabled members parked above the configured round count: configured, never dispatched. */
	inert: CouncilMember[];
}

/**
 * Which members a resolution is asking about, and whether they may be watched.
 *
 * `scope` exists because `round` is a *review-round schedule*, and only a dispatch has rounds:
 * - `rounds` (dispatch): an omitted `round` serves EVERY configured round — so it is always in
 *   round 1 — and a pin above `council.rounds` is inert.
 * - `all` (consult): round pins are ignored entirely. A consult runs no rounds, so a pin has
 *   nothing to schedule, and excluding an enabled model on account of one would silently drop
 *   input the operator asked to have available.
 */
export interface CouncilRosterOptions {
	scope?: "rounds" | "all";
	/**
	 * Whether `council.advisor.reviewers` may attach. Defaults on, so both `/council` and an
	 * agent-convened dispatch honor the operator's toggle: those runs reconcile into one artifact,
	 * and the advisor is a deliberate quality knob on that pipeline. Forced off only for a consult,
	 * where the `advisor` role being a *single shared model* would correlate N answers that are worth
	 * something only while they stay independent.
	 */
	advisors?: boolean;
}

/**
 * Strict config plus every reviewer the requested scope puts in play, resolved and
 * credential-checked in roster order.
 *
 * Shared by the full dispatch and by a consult, so "who is on the council" has exactly one
 * definition and neither surface can drift into its own notion of a member. The two differ only in
 * {@link CouncilRosterOptions.scope}, which is documented there.
 */
export async function resolveCouncilRoster(
	host: CouncilPreflightHost,
	checkpoint: CouncilPreflightCheckpoint = () => {},
	options: CouncilRosterOptions = {},
): Promise<CouncilResolvedRoster> {
	const scope = options.scope ?? "rounds";
	const advisors = options.advisors ?? true;
	let config: CouncilConfig;
	try {
		config = parseCouncilConfig(host.settings);
	} catch (error) {
		if (error instanceof CouncilDispatchError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const globalPath = host.settings.getGlobalConfigPath();
		throw dispatchError(
			"COUNCIL_CONFIG_INVALID",
			message.includes(globalPath) ? message : `${message}. Fix council configuration in ${globalPath}.`,
			error,
		);
	}
	const enabled = config.members.filter(member => member.enabled);
	if (enabled.length === 0) {
		throw dispatchError(
			"COUNCIL_NO_ENABLED_MEMBERS",
			"No enabled council members are configured. Enable a role and assign its model with /council config (Model Hub -> Roles & Council).",
		);
	}
	// `councilMemberRounds` is the single authority: an omitted `round` serves EVERY configured
	// round — so such a member is always in round 1 — and a pin above `council.rounds` yields the
	// empty set, the canonical encoding of *inert*. Inert is configuration parked for later: never
	// resolved, never credential-checked, never in the manifest roster, so a stale pin cannot fail a
	// run for a model the operator is not about to spend on.
	//
	// Under `scope: "all"` none of that applies. A consult runs no rounds, so a round pin has nothing
	// to schedule and cannot exclude anybody; every enabled member is in play and `inert` is empty.
	const active: Array<{ member: CouncilMember; rounds: number[] }> = [];
	const inert: CouncilMember[] = [];
	for (const member of enabled) {
		const rounds = councilMemberRounds(member, config.rounds);
		if (scope === "all") active.push({ member, rounds });
		else if (rounds.length === 0) inert.push(member);
		else active.push({ member, rounds });
	}
	// Round staffing is a dispatch concern only: there is no round to leave unstaffed in a consult.
	if (scope === "rounds") {
		for (let round = 1; round <= config.rounds; round++) {
			if (active.some(entry => entry.rounds.includes(round))) continue;
			throw dispatchError(
				"COUNCIL_ROUND_UNSTAFFED",
				`Council round ${round} has no enabled reviewer. Assign one with /council config (Model Hub -> Roles & Council), or reduce the review rounds.`,
			);
		}
	}
	const sessionId = host.sessionManager.getSessionId();

	// One aggregate refusal ahead of every credential lookup. An operator who has enabled a roster
	// but assigned only part of it should see the whole missing list once, not discover it one
	// reviewer per dispatch attempt. Inert members are excluded: they are not about to run.
	const assigned: Array<{ member: CouncilMember; rounds: number[]; selector: string }> = [];
	const unassigned: string[] = [];
	for (const entry of active) {
		const resolution = resolveCouncilMemberSelector(host.settings, entry.member.role);
		if (resolution.kind === "resolved") {
			assigned.push({ ...entry, selector: resolution.selector });
		} else if (resolution.kind === "unassigned") {
			unassigned.push(councilRoleLabel(entry.member.role));
		} else {
			// Unreachable through `parseCouncilConfig`, which refuses a multi-selector roster role for
			// the whole roster above. Kept total so a parser change cannot silently dispatch an
			// ambiguous pin, and kept a member error rather than a config error because it names a slot.
			throw dispatchError(
				"COUNCIL_MEMBER_MODEL_INVALID",
				`Council ${councilRoleLabel(entry.member.role)} must configure exactly one model selector. ${COUNCIL_ROSTER_REMEDY}`,
			);
		}
	}
	if (unassigned.length > 0) {
		throw dispatchError(
			"COUNCIL_MEMBER_MODEL_INVALID",
			`Council has ${assigned.length} of ${active.length} active reviewers assigned; no model selector is configured for ${unassigned.join(", ")}. ${COUNCIL_ROSTER_REMEDY}`,
		);
	}

	const members: CouncilResolvedMember[] = [];
	for (const entry of assigned) {
		checkpoint();
		const resolved = await resolvePinnedRole(host, {
			label: councilRoleLabel(entry.member.role),
			requestedSelector: entry.selector,
			code: "COUNCIL_MEMBER_MODEL_INVALID",
			remedy: COUNCIL_ROSTER_REMEDY,
			sessionId,
		});
		members.push({
			...entry.member,
			...resolved,
			lens: reviewLens,
			rounds: entry.rounds,
			advisor: advisors && config.advisor.reviewers,
		});
	}
	return { config, members, inert };
}

export interface CouncilRepositoryContext {
	cwd: string;
	repoRoot: string;
	instructionSnapshot: CouncilInstructionSnapshot;
}

/**
 * Canonical working directory, git top level, and instruction snapshot every council child runs
 * against. Shared by the full dispatch and by a consult so both confine children identically.
 */
export async function resolveCouncilRepositoryContext(
	host: CouncilPreflightHost,
	checkpoint: CouncilPreflightCheckpoint = () => {},
): Promise<CouncilRepositoryContext> {
	checkpoint();
	// Three separate probes, not one stage: `git rev-parse` spawns a subprocess, so a cancellation
	// arriving mid-discovery must not be allowed to start the next filesystem call. The checkpoints
	// sit outside the mapping helper so an abort propagates as an abort, never as
	// `COUNCIL_REPOSITORY_INVALID`.
	const repositoryProbe = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			throw dispatchError(
				"COUNCIL_REPOSITORY_INVALID",
				`Council repository root is unusable: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	};
	const cwd = await repositoryProbe(() => fs.realpath(host.sessionManager.getCwd()));
	checkpoint();
	const discoveredRoot = await repositoryProbe(() => git.repo.root(cwd));
	checkpoint();
	// `realpath` is load-bearing, not a redundant canonicalization: `git rev-parse --show-toplevel`
	// emits forward slashes even on Windows (`C:/Users/foo/repo`), and every downstream containment
	// check compares against `path`-built native separators.
	const repoRoot = await repositoryProbe(() => fs.realpath(discoveredRoot ?? cwd));
	checkpoint();
	let instructionSnapshot: CouncilInstructionSnapshot;
	try {
		instructionSnapshot = await instructions.captureCouncilInstructionSnapshot(host.toolSession, repoRoot);
	} catch (error) {
		throw dispatchError(
			"COUNCIL_INSTRUCTIONS_INVALID",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}
	return { cwd, repoRoot, instructionSnapshot };
}

export interface CouncilConsultRequestPolicy extends StructuredSubagentRequest {
	agent: "council-consultant";
}

export interface CouncilConsultPlan {
	question: string;
	cwd: string;
	repoRoot: string;
	sessionId: string;
	config: CouncilConfig;
	/** Every enabled reviewer, in roster order. Round pins do not apply; a consult runs no rounds. */
	members: CouncilResolvedMember[];
	instructions: CouncilInstructionSnapshot;
	warnings: string[];
	/** One request per member, in the same order. Deliberately schema-free: a consult answers in prose. */
	requests: CouncilConsultRequestPolicy[];
}

/**
 * Resolve a consult before any reviewer is launched.
 *
 * A consult is the review roster without the planning apparatus: no planner, no adjudicator, no
 * manifest, no publication, no rounds. It reuses the roster, confinement, and repository stages a
 * dispatch uses and skips everything a dispatch needs only in order to produce a durable plan.
 *
 * Two deliberate divergences from a dispatch, both following from "a consult has no rounds and
 * wants independent answers":
 *
 * - **Round pins do not apply** (`scope: "all"`). A `round` is a review-round schedule; a consult
 *   runs none, so a pin has nothing to schedule. Every *enabled* member with a resolvable model
 *   answers — including one pinned above `council.rounds`, which a dispatch would park as inert.
 *   An omitted `round` is unaffected either way: it always includes round 1.
 * - **No advisor ever attaches** (`advisors: false`). The `advisor` role is a single shared model,
 *   so watching N reviewers with it correlates N answers whose only value is being independent. A
 *   consult exists to surface disagreement between the assigned models; an advisor common to all of
 *   them manufactures agreement instead.
 */
export async function preflightCouncilConsult(
	host: CouncilPreflightHost,
	question: string,
	options: Pick<CouncilPreflightOptions, "signal"> = {},
): Promise<CouncilConsultPlan> {
	const checkpoint = (): void => options.signal?.throwIfAborted();
	checkpoint();
	if (question.trim().length === 0) {
		throw dispatchError("COUNCIL_TASK_INVALID", "Council consult question must contain non-whitespace content.");
	}
	if (question.length > COUNCIL_TASK_CHAR_LIMIT) {
		throw dispatchError(
			"COUNCIL_TASK_INVALID",
			`Council consult question exceeds the ${COUNCIL_TASK_CHAR_LIMIT}-character preflight limit.`,
		);
	}
	const { config, members } = await resolveCouncilRoster(host, checkpoint, { scope: "all", advisors: false });
	const sessionId = host.sessionManager.getSessionId();
	const warnings: string[] = [];
	const { cwd, repoRoot, instructionSnapshot } = await resolveCouncilRepositoryContext(host, checkpoint);
	const requests: CouncilConsultRequestPolicy[] = [];
	for (const member of members) {
		const request = requestPolicy(
			host,
			question,
			repoRoot,
			"council-consultant",
			member.resolvedSelector,
			COUNCIL_CONSULT_SCHEMA,
			instructionSnapshot,
			// Never watched. `member.advisor` is already false under `advisors: false`; passing the
			// literal makes the guarantee local to the request that carries it.
			false,
		);
		checkpoint();
		try {
			await subagents.resolveEffectiveSubagentPolicy(request);
			requests.push(request);
		} catch (error) {
			throw dispatchError(
				"COUNCIL_SUBAGENT_POLICY_INVALID",
				`Council ${councilRoleLabel(member.role)} cannot be consulted: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	}
	return {
		question,
		cwd,
		repoRoot,
		sessionId,
		config,
		members,
		instructions: instructionSnapshot,
		warnings,
		requests,
	};
}

/**
 * Resolve every dispatch input and child policy before council model spend.
 * This function neither constructs a ToolSession nor allocates council storage/manifest state.
 *
 * Nothing here reaches a completion API. The published plan is named from the task by the same
 * word-aligned slugger the roster preview uses, so the kickoff line is guaranteed to precede every
 * council request and `CouncilDispatchError.spending = false` is literally true.
 *
 * Refusals are deterministic and ordered cheapest-first: task bounds; strict config (shape, role
 * grammar, reserved and duplicate ids, configured multi-selectors, rounds, active cap); enabled-round
 * staffing; one aggregate missing-assignment refusal; sequential per-reviewer availability,
 * tool-support, and credential checks in roster order; the planner lead; the adjudicator lead;
 * repository root and instruction capture; subagent policy; and finally publication allocation. New
 * refusals belong above the publication block, whose probe can still fail on an I/O fault or a root
 * swapped between canonicalization and allocation; that residue is inherent.
 */
export async function preflightCouncilDispatch(
	host: CouncilPreflightHost,
	task: string,
	options: CouncilPreflightOptions = {},
): Promise<CouncilDispatchPlan> {
	// Cooperative cancellation checkpoint: cheap enough to sit in front of every awaited stage, and
	// the only thing standing between a cancelled run and the next credential or filesystem probe.
	const checkpoint = (): void => options.signal?.throwIfAborted();
	checkpoint();
	const origin = options.origin ?? DEFAULT_COUNCIL_RUN_ORIGIN;
	if (task.trim().length === 0) {
		throw dispatchError("COUNCIL_TASK_INVALID", "Council task must contain non-whitespace content.");
	}
	if (task.length > COUNCIL_TASK_CHAR_LIMIT) {
		throw dispatchError(
			"COUNCIL_TASK_INVALID",
			`Council task exceeds the ${COUNCIL_TASK_CHAR_LIMIT}-character preflight limit.`,
		);
	}
	// Advisors follow `council.advisor.*` here regardless of origin. A dispatch settles into one
	// adjudicated artifact, so a shared advisor is the operator's quality knob on that pipeline, not a
	// correlation across answers that are supposed to stand apart. Only a consult forces them off,
	// because a consult sells N independent reads and a common advisor would collapse them.
	const { config, members, inert } = await resolveCouncilRoster(host, checkpoint);
	const sessionId = host.sessionManager.getSessionId();

	// An assigned `planner` role pins that model; unassigned keeps the historical `@slow` fallback,
	// which is the one council selector allowed to go through a role alias. Either way the operator
	// sees `Planner`: which alias carried it is already visible in the selector the message quotes.
	const plannerResolution = resolveCouncilMemberSelector(host.settings, COUNCIL_PLANNER_ROLE);
	if (plannerResolution.kind === "invalid") {
		throw dispatchError(
			"COUNCIL_PLANNER_MODEL_INVALID",
			`Council ${councilRoleLabel(COUNCIL_PLANNER_ROLE)} must configure exactly one model selector. ${COUNCIL_PLANNER_REMEDY}`,
		);
	}
	checkpoint();
	const planner: CouncilResolvedPlanner = {
		role: plannerResolution.kind === "resolved" ? COUNCIL_PLANNER_ROLE : "slow",
		...(await resolvePinnedRole(host, {
			label: councilRoleLabel(COUNCIL_PLANNER_ROLE),
			requestedSelector: plannerResolution.kind === "resolved" ? plannerResolution.selector : "@slow",
			code: "COUNCIL_PLANNER_MODEL_INVALID",
			remedy: COUNCIL_PLANNER_REMEDY,
			sessionId,
		})),
		advisor: config.advisor.planner,
	};

	// Unassigned adjudicator ⇒ the live Main session judges, exactly as before. Only that mode
	// depends on Main's model, credentials, and `write` tool, so only that mode revalidates them.
	const adjudicatorResolution = resolveCouncilMemberSelector(host.settings, COUNCIL_ADJUDICATOR_ROLE);
	if (adjudicatorResolution.kind === "invalid") {
		throw dispatchError(
			"COUNCIL_ADJUDICATOR_MODEL_INVALID",
			`Council ${councilRoleLabel(COUNCIL_ADJUDICATOR_ROLE)} must configure exactly one model selector. ${COUNCIL_ADJUDICATOR_REMEDY}`,
		);
	}
	checkpoint();
	const adjudicatorWarnings: string[] = [];
	let adjudicator: CouncilResolvedAdjudicator;
	if (adjudicatorResolution.kind === "resolved") {
		adjudicator = {
			mode: "delegated",
			...(await resolvePinnedRole(host, {
				label: councilRoleLabel(COUNCIL_ADJUDICATOR_ROLE),
				requestedSelector: adjudicatorResolution.selector,
				code: "COUNCIL_ADJUDICATOR_MODEL_INVALID",
				remedy: COUNCIL_ADJUDICATOR_REMEDY,
				sessionId,
			})),
			advisor: config.advisor.adjudicator,
		};
	} else if (origin === "agent") {
		// Main mode is structurally unreachable here: the `convene` tool call is what holds the turn
		// Main would have to finish before it could adjudicate, so waiting for it would deadlock.
		// Delegation therefore falls back to the planner's already-resolved lead — the same
		// substitution shape as the planner's own `@slow` fallback, and never a model this run has not
		// already resolved and credential-checked.
		adjudicator = {
			mode: "delegated",
			requestedSelector: planner.requestedSelector,
			resolvedSelector: planner.resolvedSelector,
			model: planner.model,
			effort: planner.effort,
			advisor: config.advisor.adjudicator,
		};
		adjudicatorWarnings.push(
			`No model is assigned to the \`${COUNCIL_ADJUDICATOR_ROLE}\` role, and an agent-convened run cannot adjudicate in your main session; ${modelIdentity(planner.model)} adjudicates as well as plans. Assign the Council Adjudicator row to separate them.`,
		);
	} else {
		adjudicator = { mode: "main", ...(await preflightCouncilMainDispatch(host)) };
	}

	// The advisor a toggle would attach. Resolved once so the pre-spend line can name it and so an
	// unresolvable `advisor` role is reported rather than silently doing nothing at runtime.
	const advisorRequested =
		config.advisor.planner ||
		config.advisor.reviewers ||
		(adjudicator.mode === "delegated" && config.advisor.adjudicator);
	let advisorModel: string | undefined;
	const advisorWarnings: string[] = [];
	if (advisorRequested) {
		let selection: { model: Model<Api> } | undefined;
		try {
			selection = modelResolver.resolveAdvisorRoleSelection(host.settings, host.modelRegistry.getAvailable());
		} catch (error) {
			logger.debug("council: advisor role resolution failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (selection) advisorModel = modelIdentity(selection.model);
		else {
			advisorWarnings.push(
				"A council advisor is enabled but no model is assigned to the `advisor` role; the advisor will not attach.",
			);
		}
	}

	const { cwd, repoRoot, instructionSnapshot } = await resolveCouncilRepositoryContext(host, checkpoint);

	const plannerRequest = requestPolicy(
		host,
		task,
		repoRoot,
		"council-planner",
		planner.resolvedSelector,
		COUNCIL_PLANNER_SCHEMA,
		instructionSnapshot,
		planner.advisor,
	);
	checkpoint();
	try {
		await subagents.resolveEffectiveSubagentPolicy(plannerRequest);
	} catch (error) {
		throw dispatchError(
			"COUNCIL_SUBAGENT_POLICY_INVALID",
			error instanceof Error ? error.message : String(error),
			error,
		);
	}

	const memberRequests: CouncilMemberRequestPolicy[] = [];
	for (const member of members) {
		const request = requestPolicy(
			host,
			task,
			repoRoot,
			"council-member",
			member.resolvedSelector,
			COUNCIL_REPORT_SCHEMA,
			instructionSnapshot,
			member.advisor,
		);
		checkpoint();
		try {
			await subagents.resolveEffectiveSubagentPolicy(request);
			memberRequests.push(request);
		} catch (error) {
			throw dispatchError(
				"COUNCIL_SUBAGENT_POLICY_INVALID",
				`Council ${councilRoleLabel(member.role)} cannot dispatch: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	}

	let adjudicatorRequest: (StructuredSubagentRequest & { agent: "council-adjudicator" }) | undefined;
	if (adjudicator.mode === "delegated") {
		adjudicatorRequest = requestPolicy(
			host,
			task,
			repoRoot,
			"council-adjudicator",
			adjudicator.resolvedSelector,
			COUNCIL_ADJUDICATION_SCHEMA,
			instructionSnapshot,
			adjudicator.advisor,
		);
		checkpoint();
		try {
			await subagents.resolveEffectiveSubagentPolicy(adjudicatorRequest);
		} catch (error) {
			throw dispatchError(
				"COUNCIL_SUBAGENT_POLICY_INVALID",
				`Council ${councilRoleLabel(COUNCIL_ADJUDICATOR_ROLE)} cannot dispatch: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
	}

	// The plan root is the session `local://` cache, deliberately NOT the repository: a council run
	// creates nothing in the working tree. `repoRoot` stays the git discovery above because it is the
	// immutable identity `#assertResumeIdentity` compares and the root instruction capture is relative
	// to. A resume revalidates its promised path, which is immutable, so it is never renamed.
	//
	// Allocation is last because it is the only step that can leave something behind; the name it
	// needs comes from the task, so nothing above it is waiting on a model.
	const promisedOutputPath = options.promisedOutputPath;
	checkpoint();
	// Resolving the session cache root and creating the plan directory are two distinct filesystem
	// stages, so they are unnested: an abort between them must not create the directory.
	let cacheRoot: string;
	try {
		cacheRoot = await councilPlanRoot(host.toolSession);
	} catch (error) {
		throw dispatchError("COUNCIL_PUBLICATION_INVALID", error instanceof Error ? error.message : String(error), error);
	}
	checkpoint();
	let planRoot: string;
	try {
		planRoot = await publication.ensureCouncilPlanRoot(cacheRoot);
	} catch (error) {
		throw dispatchError("COUNCIL_PUBLICATION_INVALID", error instanceof Error ? error.message : String(error), error);
	}
	checkpoint();
	let publicationTarget: CouncilPublicationTarget;
	try {
		publicationTarget = promisedOutputPath
			? await publication.resolvePromisedCouncilPublicationTarget(planRoot, promisedOutputPath)
			: await publication.resolveCouncilPublicationTarget(planRoot, task, origin);
	} catch (error) {
		throw dispatchError("COUNCIL_PUBLICATION_INVALID", error instanceof Error ? error.message : String(error), error);
	}

	const dispatchWarnings = councilDispatchWarnings({ members, inert, rounds: config.rounds });
	return {
		task,
		cwd,
		repoRoot,
		sessionId,
		origin,
		publicationTarget,
		config,
		rounds: config.rounds,
		roster: config.members,
		members,
		inert,
		planner,
		adjudicator,
		...(advisorModel === undefined ? {} : { advisorModel }),
		instructions: instructionSnapshot,
		warnings: [
			...dispatchWarnings.degrading,
			...dispatchWarnings.advisory,
			...adjudicatorWarnings,
			...advisorWarnings,
		],
		degraded: dispatchWarnings.degrading.length > 0,
		plannerRequest,
		memberRequests,
		...(adjudicatorRequest ? { adjudicatorRequest } : {}),
	};
}

/**
 * Refuse to continue a run whose persisted roster is larger than an adjudication can grade.
 *
 * Kept out of {@link preflightCouncilDispatch} because it is a property of the artifact, not of the
 * current configuration: the run is readable, its cards and stats still render, and nothing about it
 * is corrupt. Only continuing it is blocked, and only when it would otherwise have been resumable —
 * a completed or terminally failed run keeps the refusal it already had.
 */
export function assertCouncilResumeRosterWithinLimit(
	manifest: Pick<CouncilManifest, "runId" | "state" | "failure" | "roster">,
): void {
	const refusal = councilResumeRosterLimitRefusal(manifest);
	if (refusal !== undefined) throw dispatchError("COUNCIL_CONFIG_INVALID", refusal);
}
