import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { councilRoleLabel } from "../config/model-roles";
import type { Settings } from "../config/settings";
import adjudicationRepairTemplate from "../prompts/council/adjudication-repair.md" with { type: "text" };
import adjudicationRoundOneTemplate from "../prompts/council/adjudication-round-1.md" with { type: "text" };
import adjudicationRoundTwoTemplate from "../prompts/council/adjudication-round-2.md" with { type: "text" };
import memberTaskTemplate from "../prompts/council/member-task.md" with { type: "text" };
import plannerTaskTemplate from "../prompts/council/planner-task.md" with { type: "text" };
import councilSummaryTemplate from "../prompts/council/summary.md" with { type: "text" };
import { MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { withSessionSpawnPermit } from "../task";
import {
	reserveStructuredSubagentId,
	runStructuredSubagent,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import type { AgentProgress } from "../task/types";
import type { ToolSession } from "../tools";
import {
	COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
	COUNCIL_PLANNER_PROGRESS_ORDER,
	COUNCIL_PLANNER_PROGRESS_ROUND,
	COUNCIL_RUN_MESSAGE_TYPE,
	COUNCIL_SUMMARY_MESSAGE_TYPE,
	type CouncilRunEventKind,
	type CouncilRunEventPayload,
	type CouncilSummaryPayload,
} from "./events";
import { sha256CouncilContent } from "./hash";
import {
	assertCouncilResumeRosterWithinLimit,
	type CouncilDispatchPlan,
	type CouncilMainDispatchSnapshot,
	councilDispatchWarnings,
	preflightCouncilDispatch,
	preflightCouncilMainDispatch,
	resolveCouncilMainEffort,
} from "./preflight";
import { inspectPromisedCouncilPublication, publishCouncilPlan } from "./publication";
import {
	COUNCIL_ADJUDICATION_INJECTION_CAP,
	type CouncilAdjudication,
	type CouncilFinding,
	type CouncilPlannerOutput,
	type CouncilReport,
	councilSlotPrefix,
	validateCouncilAdjudication,
	validateCouncilPlannerOutput,
	validateIncomingCouncilReport,
	validatePersistedCouncilReport,
} from "./schema";
import {
	COUNCIL_AGENT_ID_LIMIT,
	COUNCIL_MANIFEST_VERSION,
	type CouncilAdjudicatorSnapshot,
	type CouncilInstructionSnapshot,
	type CouncilManifest,
	type CouncilPlannerSnapshot,
	type CouncilResolvedRosterMember,
	type CouncilRoundMemberRecord,
	type CouncilRunOrigin,
	type CouncilUsage,
	councilResumeMismatches,
	councilStateLabel,
	DEFAULT_COUNCIL_RUN_ORIGIN,
	isCouncilResumableManifest,
	isCouncilRosterOverResumeLimit,
	isCouncilTerminalState,
	parseCouncilInstructionSnapshot,
	parseCouncilManifest,
} from "./state";
import {
	type CouncilRunStats,
	councilChildUsage,
	loadCouncilAdjudications,
	summarizeCouncilRun,
	zeroCouncilUsage,
} from "./stats";
import { type CouncilStorage, CouncilStorageError, createCouncilStorage } from "./storage";

const COUNCIL_CANCEL_DRAIN_TIMEOUT_MS = 5_000;
const COUNCIL_PROGRESS_OUTPUT_LIMIT = 8;
const COUNCIL_PROGRESS_LINE_LIMIT = 500;
const COUNCIL_MEMBER_FAILURE_SANITIZE_LIMIT = 4_000;
const COUNCIL_SUMMARY_WARNING_COUNT_LIMIT = 8;
const COUNCIL_SUMMARY_WARNING_CHAR_LIMIT = 500;
const PLANNER_METADATA_MARKER = "council-planner-metadata";
const ADJUDICATION_METADATA_MARKER = "council-adjudication-metadata";
/** Cadence for resampling Main's in-flight adjudication spend while it owns the turn. */
const MAIN_TELEMETRY_SAMPLE_MS = 500;
/** How many recent runs `/council resume <unknown-id>` lists back as recovery options. */
const COUNCIL_RESUME_DISCOVERY_LIMIT = 5;
/** Every lifecycle event reaches Main's context, so each line is capped at recap scale. */
const COUNCIL_RUN_EVENT_CHAR_LIMIT = 300;

export interface CouncilCoordinatorHost {
	session: AgentSession;
	toolSession: ToolSession;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	onStateChange?: (snapshot: CouncilManifest) => void;
	/**
	 * Repaint hook for a durable council card that was delivered outside any render path. Neither
	 * `sendCustomMessage` branch paints on its own: the idle append emits no event, and the streaming
	 * branch holds the copy for the next turn. Presentation-only; a throw is logged and swallowed.
	 */
	presentCouncilSummary?: (delivery: CouncilSummaryDelivery) => void;
	now?: () => string | Date;
	runId?: string | (() => string);
	/**
	 * Fired once per run after the manifest exists and the run id is minted, before the first child
	 * launches. Awaited so the preview lands ahead of any spend; a rejection is logged and swallowed
	 * because the run already owns a durable `dispatching` manifest.
	 */
	onKickoff?: (preview: CouncilKickoffPreview) => void | Promise<void>;
}

/**
 * Small immutable projection of what a run is about to spend. Deliberately not the
 * `CouncilDispatchPlan`: rendered assignments, instruction snapshots, and subagent requests never
 * reach presentation code.
 */
export interface CouncilKickoffPreview {
	runId: string;
	resumed: boolean;
	/** `provider/id`. */
	plannerModel: string;
	/** Resolved advisor model watching the planner, when one is attached. */
	plannerAdvisorModel?: string;
	adjudicator: {
		mode: "main" | "delegated";
		/** `provider/id`. */
		model: string;
		advisorModel?: string;
	};
	members: readonly { role: string; model: string; rounds: readonly number[]; advisorModel?: string }[];
	rounds: number;
}

/**
 * The one pre-spend line: the run id, its per-round roster, and every model — advisors included —
 * that is about to be billed. Sanitized, because every model string ultimately came from a provider.
 *
 * Shared by `/council` and by the `convene` tool so the two can never disagree about what a run is
 * about to cost. The `++model` suffix is load-bearing rather than decorative: an advisor is a second
 * model charged to the role it watches, and omitting it understates the spend the reader is being
 * asked to accept.
 */
export function formatCouncilKickoff(preview: CouncilKickoffPreview): string {
	const advisorSuffix = (model: string | undefined): string => (model ? ` ++${model}` : "");
	const rounds: string[] = [];
	for (let round = 1; round <= preview.rounds; round++) {
		const serving = preview.members
			.filter(member => member.rounds.includes(round))
			.map(member => `${councilRoleLabel(member.role)}=${member.model}${advisorSuffix(member.advisorModel)}`);
		rounds.push(`round ${round}: [${serving.join(", ")}]`);
	}
	return sanitizeText(
		`${preview.resumed ? "Resuming" : "Starting"} ${preview.runId}: planner=${preview.plannerModel}${advisorSuffix(preview.plannerAdvisorModel)}, adjudicator=${preview.adjudicator.model} (${preview.adjudicator.mode})${advisorSuffix(preview.adjudicator.advisorModel)}, ${rounds.join(", ")}.`,
	);
}

/**
 * A durable council summary card the coordinator just handed to the session, plus everything a
 * presentation layer needs to mirror it live. `deferred` is true when the copy was queued for the
 * next turn (Main was streaming) rather than appended immediately.
 */
export interface CouncilSummaryDelivery {
	runId: string;
	deferred: boolean;
	content: string;
	details: CouncilSummaryPayload;
}

export interface CouncilRunOptions {
	/**
	 * Per-invocation kickoff sink. `CouncilCoordinatorHost.onKickoff` is bound when the coordinator is
	 * constructed and belongs to whoever built it (in the TUI, the pane controller); a slash command
	 * that reaches a *cached* coordinator still needs its own `runtime.output` for this one run.
	 */
	onKickoff?: (preview: CouncilKickoffPreview) => void | Promise<void>;
	/**
	 * Who convened this run. `start` only; `resume` reads the origin back off the manifest, because a
	 * run's origin is immutable and decides both its published stem and whether Main may adjudicate.
	 * Defaults to `command`.
	 */
	origin?: CouncilRunOrigin;
}

export interface CouncilMemberLiveProgress {
	/**
	 * Session-global child agent id, reserved *before* launch. The executor stamps it on every
	 * `TASK_SUBAGENT_EVENT_CHANNEL` payload, which is what lets the transcript mirror filter one
	 * child's events without racing the ~150 ms progress coalescing window.
	 */
	agentId: string;
	round: number;
	role: string;
	order: number;
	attempt: number;
	status: AgentProgress["status"];
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput: string[];
	requests: number;
	tokens: number;
	cost: number;
	retryState?: AgentProgress["retryState"];
}

/**
 * The one council child currently running alone in its phase: the planner always, a delegated
 * adjudicator always, a review round only when exactly one roster member runs it. Set
 * synchronously at launch so a mirror can start filtering before the child's first event, and
 * cleared wherever `#liveMembers` is cleared.
 */
export interface CouncilSoloChild {
	agentId: string;
	label: string;
	kind: "planner" | "member" | "adjudicator";
	round: number;
	order: number;
}

export interface CouncilCoordinatorSnapshot {
	manifest: CouncilManifest;
	members: CouncilMemberLiveProgress[];
	mainTurnOwned: boolean;
	soloChild?: CouncilSoloChild;
}

type CoordinatorListener = (snapshot: CouncilCoordinatorSnapshot) => void;

interface PersistedPlannerMetadata {
	assumptions: string[];
	blockers: string[];
	evidenceVersion: "1.0.0";
}

interface PersistedAdjudicationMetadata {
	adjudication: CouncilAdjudication;
}

interface RoundLedger {
	reports: Array<CouncilReport | undefined>;
	failures: Array<{ role: string; reason: string } | undefined>;
	/**
	 * Presentation slot number per launch position: the reviewer's 1-based index in
	 * `manifest.roster`, which is what `stats.ts` keys grades by. It diverges from both the round
	 * position (a round runs a subset of the roster) and `record.order` (the config index, which
	 * skips disabled members), so it is computed once and reused everywhere a slot is named.
	 */
	slots: number[];
}

interface BoundedCouncilReports {
	text: string;
	overflowCount: number;
	overflowIds: string;
}

interface CoordinatorRegistryEntry {
	coordinator: CouncilCoordinator;
	session: AgentSession;
	toolSession: ToolSession;
	sessionManager: SessionManager;
}

const coordinators = new Map<string, CoordinatorRegistryEntry>();
const activeCoordinators = new Map<string, CouncilCoordinator>();
const executingCoordinators = new WeakSet<CouncilCoordinator>();

function modelIdentity(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function nullableEffort(effort: unknown): string | null {
	return typeof effort === "string" ? effort : null;
}

function encodeMetadata(marker: string, value: unknown): string {
	return `\n\n<!-- ${marker}:${Buffer.from(JSON.stringify(value)).toString("base64")} -->\n`;
}

function decodeMetadataFrame<T>(content: string, marker: string): { content: string; metadata: T } {
	const prefix = `\n\n<!-- ${marker}:`;
	const suffix = " -->\n";
	const frameIndex = content.lastIndexOf(prefix);
	if (frameIndex < 0 || !content.endsWith(suffix)) throw new Error(`Council artifact is missing ${marker}`);
	const encoded = content.slice(frameIndex + prefix.length, -suffix.length);
	if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error(`Council artifact has invalid ${marker}`);
	return {
		content: content.slice(0, frameIndex),
		metadata: JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as T,
	};
}

function decodeMetadata<T>(content: string, marker: string): T {
	return decodeMetadataFrame<T>(content, marker).metadata;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function rosterFromPlan(plan: CouncilDispatchPlan): CouncilResolvedRosterMember[] {
	return plan.members.map(member => ({
		role: member.role,
		enabled: true,
		order: member.order,
		rounds: [...member.rounds],
		advisor: member.advisor,
		requestedSelector: member.requestedSelector,
		resolvedModel: modelIdentity(member.model),
		effort: nullableEffort(member.effort),
		lens: member.lens,
	}));
}

function plannerFromPlan(plan: CouncilDispatchPlan): CouncilPlannerSnapshot {
	return {
		role: plan.planner.role,
		requestedSelector: plan.planner.requestedSelector,
		resolvedModel: modelIdentity(plan.planner.model),
		effort: nullableEffort(plan.planner.effort),
		advisor: plan.planner.advisor,
	};
}

/**
 * Durable adjudicator identity. In `main` mode the selector is the fixed `@main` alias rather than
 * the live model string: Main is informational and excluded from resume comparison, so pinning its
 * current selector here would be identity noise.
 */
function adjudicatorFromPlan(
	plan: CouncilDispatchPlan,
	capturedAt: string,
	instructionSha256: string,
): CouncilAdjudicatorSnapshot {
	const adjudicator = plan.adjudicator;
	return {
		mode: adjudicator.mode,
		requestedSelector: adjudicator.mode === "main" ? "@main" : adjudicator.requestedSelector,
		resolvedModel: modelIdentity(adjudicator.model),
		effort: nullableEffort(adjudicator.effort),
		advisor: adjudicator.mode === "delegated" && adjudicator.advisor,
		capturedAt,
		instructionSha256,
	};
}

function blankMember(member: CouncilResolvedRosterMember): CouncilRoundMemberRecord {
	return {
		role: member.role,
		order: member.order,
		status: "pending",
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		artifact: null,
		resolvedModel: null,
		authFallbackUsed: false,
		failureReason: null,
		findingIds: [],
	};
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

type CouncilResumeMismatch =
	| "roster/planner"
	| "adjudicator"
	| "config"
	| "task"
	| "repository root"
	| "instruction snapshot";

/** Why a resume was refused, in the operator's terms rather than the identity check's field names. */
const RESUME_MISMATCH_SENTENCES: Record<CouncilResumeMismatch, string> = {
	"roster/planner": "the council roster changed since this run started",
	adjudicator: "the council adjudicator changed",
	config: "council settings changed",
	task: "the task text differs",
	"repository root": "this is a different repository",
	"instruction snapshot": "AGENTS.md / CLAUDE.md changed",
};

function abortError(): Error {
	const error = new Error("Council run cancelled");
	error.name = "AbortError";
	return error;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError());
	const deferred = Promise.withResolvers<T>();
	const abort = () => deferred.reject(abortError());
	signal.addEventListener("abort", abort, { once: true });
	void promise.then(deferred.resolve, deferred.reject);
	return deferred.promise.finally(() => signal.removeEventListener("abort", abort));
}

/**
 * Prior-round findings a later duplicate may point at. A finding already dispositioned `duplicate`
 * is not canonical, so chaining onto it is refused by `validateCouncilAdjudication`.
 */
function canonicalFindingIds(adjudication: CouncilAdjudication | undefined): string[] {
	return (
		adjudication?.dispositions
			.filter(disposition => disposition.disposition !== "duplicate")
			.map(disposition => disposition.id) ?? []
	);
}

function severityRank(finding: CouncilFinding): number {
	switch (finding.severity) {
		case "critical":
			return 0;
		case "high":
			return 1;
		case "medium":
			return 2;
		case "low":
			return 3;
	}
}

function boundedReports(ledger: RoundLedger, maxChars: number): BoundedCouncilReports {
	// Every slot number below comes from `ledger.slots`, so a reviewer can never be labelled one
	// number in a failure line and a different one in its findings.
	const failureRecords = ledger.failures.flatMap((failure, index) => {
		if (!failure) return [];
		const slot = ledger.slots[index] ?? index + 1;
		return [
			{
				role: failure.role,
				slot,
				prefix: `Member ${failure.role} (slot ${slot}) failed: `,
				reason: failure.reason
					.slice(0, COUNCIL_MEMBER_FAILURE_SANITIZE_LIMIT)
					.replace(/[\u0000-\u001f\u007f]+/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
			},
		];
	});
	const failures: string[] = [];
	const separatorChars = Math.max(0, failureRecords.length - 1);
	const prefixChars = failureRecords.reduce((total, failure) => total + failure.prefix.length, 0);
	if (prefixChars + separatorChars <= maxChars) {
		let reasonChars = maxChars - prefixChars - separatorChars;
		for (const [index, failure] of failureRecords.entries()) {
			const remainingFailures = failureRecords.length - index;
			const allocation = Math.min(1_000, Math.floor(reasonChars / remainingFailures));
			const reason = failure.reason || "unknown failure";
			const clipped = reason.slice(0, allocation);
			failures.push(failure.prefix + clipped);
			reasonChars -= clipped.length;
		}
	} else {
		let compactChars = 0;
		for (const failure of failureRecords) {
			const line = `[slot ${failure.slot}:${failure.role}]`;
			const required = line.length + (failures.length > 0 ? 1 : 0);
			if (compactChars + required > maxChars) break;
			failures.push(line);
			compactChars += required;
		}
	}
	// One line per reporting slot, so a reviewer that returned `ready` with no findings is still
	// visible: without it a zero-finding report was absent from the adjudication context entirely,
	// and the grade the adjudicator owes that slot would have no basis.
	const slotSummaries = ledger.reports.flatMap((report, index) =>
		report
			? [
					JSON.stringify({
						slot: ledger.slots[index] ?? index + 1,
						readiness: report.readiness,
						findingCount: report.findings.length,
					}),
				]
			: [],
	);
	const findings = ledger.reports
		.flatMap(
			(report, index) =>
				report?.findings.map(finding => ({
					finding,
					slot: ledger.slots[index] ?? index + 1,
					readiness: report.readiness,
				})) ?? [],
		)
		.sort((left, right) => severityRank(left.finding) - severityRank(right.finding) || left.slot - right.slot);
	const included = [...failures];
	let used = failures.reduce((total, line) => total + line.length, 0) + Math.max(0, failures.length - 1);
	for (const summary of slotSummaries) {
		const separator = included.length > 0 ? 1 : 0;
		if (used + separator + summary.length > maxChars) break;
		included.push(summary);
		used += separator + summary.length;
	}
	const omittedIds: string[] = [];
	for (const item of findings) {
		const chunk = JSON.stringify({ slot: item.slot, readiness: item.readiness, finding: item.finding });
		const separator = included.length > 0 ? 1 : 0;
		if (used + separator + chunk.length <= maxChars) {
			included.push(chunk);
			used += separator + chunk.length;
		} else {
			omittedIds.push(item.finding.id);
		}
	}
	return { text: included.join("\n"), overflowCount: omittedIds.length, overflowIds: omittedIds.join(", ") };
}

export class CouncilCoordinator {
	readonly #host: CouncilCoordinatorHost;
	readonly #listeners = new Set<CoordinatorListener>();
	readonly #liveMembers = new Map<string, CouncilMemberLiveProgress>();
	#storage: CouncilStorage | undefined;
	#abortController: AbortController | undefined;
	#checkpointTail: Promise<void> = Promise.resolve();
	#summarySentFor: string | undefined;
	#summaryDelivery: { runId: string; promise: Promise<void> } | undefined;
	/** Idempotency keys (`runId:kind:round`) of lifecycle events already handed to the session. */
	readonly #lifecycleKeys = new Set<string>();
	/** FIFO for lifecycle delivery, so a cancel racing a round checkpoint still reads in order. */
	#lifecycleTail: Promise<void> = Promise.resolve();
	#mainTurnGeneration = 0;
	#ownedMainTurn: number | undefined;
	#handlerGeneration: number | undefined;
	/** Owned-turn generation plus the message-slice origin the live Main row is sampled from. */
	#mainTelemetry: { generation: number; messagesBefore: number } | undefined;
	#mainTelemetryTimer: NodeJS.Timeout | undefined;
	#resumeExecution = false;
	#executionInFlight = false;
	#setupInFlight = false;
	#executionSettlement: PromiseWithResolvers<void> | undefined;
	#soloChild: CouncilSoloChild | undefined;

	completion: Promise<void> | undefined;
	snapshot: CouncilManifest | undefined;

	constructor(host: CouncilCoordinatorHost) {
		this.#host = host;
	}

	#setExecutionInFlight(active: boolean): void {
		this.#executionInFlight = active;
		if (active) executingCoordinators.add(this);
		else executingCoordinators.delete(this);
	}

	get executionInFlight(): boolean {
		return this.#executionInFlight;
	}

	get setupInFlight(): boolean {
		return this.#setupInFlight;
	}

	/**
	 * Resolve once this coordinator owns no in-flight work: neither setup nor execution is active and
	 * the durable lifecycle queue has drained.
	 *
	 * Registry release is gated on this, so a session transition can never drop a coordinator that is
	 * still writing to the session it was bound to. Every run installs `#executionSettlement` before
	 * raising either flag, so a missing resolver means nothing is actually in flight.
	 */
	async settled(): Promise<void> {
		for (;;) {
			if (this.#setupInFlight || this.#executionInFlight) {
				const pending = this.#executionSettlement?.promise;
				if (!pending) return;
				await pending;
				continue;
			}
			// Re-read after the await: a lifecycle event queued while draining extends the tail, and a
			// fresh run may have raised the flags again.
			const tail = this.#lifecycleTail;
			await tail;
			if (this.#lifecycleTail === tail && !this.#setupInFlight && !this.#executionInFlight) return;
		}
	}

	get coordinatorSnapshot(): CouncilCoordinatorSnapshot | undefined {
		return this.#buildCoordinatorSnapshot();
	}

	subscribe(listener: CoordinatorListener): () => void {
		this.#listeners.add(listener);
		const current = this.#buildCoordinatorSnapshot();
		if (current) this.#notifyOne(listener, current);
		return () => this.#listeners.delete(listener);
	}

	#setOwnedMainTurn(generation: number | undefined): void {
		if (this.#ownedMainTurn === generation) return;
		this.#ownedMainTurn = generation;
		this.#emit();
	}

	#setSoloChild(child: CouncilSoloChild | undefined): void {
		if (this.#soloChild?.agentId === child?.agentId) return;
		this.#soloChild = child;
		this.#emit();
	}

	/**
	 * Drop every piece of live child telemetry in lockstep. Callers emit or checkpoint immediately
	 * afterwards, so this deliberately does not emit on its own.
	 */
	#clearLiveTelemetry(): void {
		this.#liveMembers.clear();
		this.#soloChild = undefined;
		// Stop *after* the clear so the sampler's own delete is a no-op and this stays emit-free.
		this.#stopMainTelemetry();
	}

	async start(task: string, options?: CouncilRunOptions): Promise<CouncilManifest> {
		if (this.#executionInFlight) throw new Error("The prior council execution is still settling");
		this.#setExecutionInFlight(true);
		this.#abortController = new AbortController();
		this.#executionSettlement = Promise.withResolvers<void>();
		this.#setupInFlight = true;
		let dispatch: CouncilDispatchPlan | undefined;
		let beganExecution = false;
		try {
			dispatch = await preflightCouncilDispatch(this.#host, task, {
				signal: this.#abortController.signal,
				origin: options?.origin ?? DEFAULT_COUNCIL_RUN_ORIGIN,
			});
			this.#abortController.signal.throwIfAborted();
			const activeCoordinator = activeCoordinators.get(dispatch.sessionId);
			if (activeCoordinator && activeCoordinator !== this) {
				throw new Error("A council run is already active in this session; use /council status.");
			}
			activeCoordinators.set(dispatch.sessionId, this);
			// Main-mode only: a delegated adjudicator never installs an `xd://council` handler, so it
			// must not be refused for a surface it does not use.
			if (dispatch.adjudicator.mode === "main") this.#assertAdjudicationSurface();
			this.#storage = createCouncilStorage(this.#host.toolSession);
			const existing = await this.#storage.list();
			this.#abortController.signal.throwIfAborted();
			const active = existing.find(manifest => !isCouncilTerminalState(manifest.state));
			if (active) {
				throw new Error(
					`Council run ${active.runId} is already active for this session; use /council status or /council cancel.`,
				);
			}
			const manifest = await this.#initialManifest(dispatch);
			const created = await this.#storage.create(manifest);
			this.snapshot = created;
			this.#abortController.signal.throwIfAborted();
			this.#clearLiveTelemetry();
			this.#emit();
			this.#resumeExecution = false;
			await this.#announceKickoff(dispatch, false, options);
			this.#begin(dispatch);
			beganExecution = true;
			this.#setupInFlight = false;
			return structuredClone(this.snapshot);
		} catch (error) {
			if (
				isAbort(error, this.#abortController.signal) &&
				this.snapshot &&
				!isCouncilTerminalState(this.snapshot.state)
			) {
				await this.#interrupt("cancel", errorText(error));
				await this.#sendSummary();
			}
			if (dispatch && activeCoordinators.get(dispatch.sessionId) === this) {
				activeCoordinators.delete(dispatch.sessionId);
			}
			throw error;
		} finally {
			if (!beganExecution) {
				this.#setupInFlight = false;
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	async status(): Promise<CouncilManifest | undefined> {
		if (this.snapshot) {
			if (isCouncilTerminalState(this.snapshot.state)) await this.#sendSummary();
			return structuredClone(this.snapshot);
		}
		this.#storage ??= createCouncilStorage(this.#host.toolSession);
		const manifests = await this.#storage.list();
		const latest = manifests.sort(
			(a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt),
		)[0];
		if (!latest) return undefined;
		this.snapshot = latest;
		this.#clearLiveTelemetry();
		this.#emit();
		await this.#sendSummary();
		return structuredClone(latest);
	}

	/**
	 * Newest manifest `/council resume` would actually continue. Deliberately side-effect free — no
	 * hydration, no `#emit()`, no summary delivery — because it exists purely so the UI can surface a
	 * resume hint without popping the terminal snapshot `status()` broadcasts.
	 */
	async resumableStatus(): Promise<CouncilManifest | undefined> {
		if (this.snapshot) return isCouncilResumableManifest(this.snapshot) ? structuredClone(this.snapshot) : undefined;
		this.#storage ??= createCouncilStorage(this.#host.toolSession);
		return (await this.#storage.list())
			.filter(isCouncilResumableManifest)
			.sort((a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt))[0];
	}

	/**
	 * The adjudicated plan of a run that reached its final round, read back from the durable artifact
	 * with the adjudication metadata frame stripped.
	 *
	 * Deliberately sourced from `planVersions`, not from the published file: the plan version is
	 * written and checkpointed before publication, so a run that adjudicated but failed to publish
	 * still yields its plan, and no caller has to know the publication naming scheme. Returns
	 * `undefined` when the run never produced a final version.
	 */
	async finalPlan(manifest: CouncilManifest | undefined = this.snapshot): Promise<string | undefined> {
		const version = manifest?.planVersions.find(candidate => candidate.kind === "final");
		if (!manifest || !version) return undefined;
		this.#storage ??= createCouncilStorage(this.#host.toolSession);
		const stored = await this.#storage.readArtifact(version.artifact);
		return decodeMetadataFrame<PersistedAdjudicationMetadata>(stored, ADJUDICATION_METADATA_MARKER).content;
	}

	async cancelForSessionTransition(): Promise<void> {
		if (!this.#setupInFlight && this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
			await this.cancel();
			if (this.#executionInFlight) {
				throw new Error(`Council cancellation timed out after ${COUNCIL_CANCEL_DRAIN_TIMEOUT_MS}ms`);
			}
			return;
		}
		if (!this.#executionInFlight) return;
		this.#abortController?.abort();
		const drains: Promise<unknown>[] = [];
		if (this.#ownsCurrentMainTurn()) {
			drains.push(this.#host.session.abort().then(() => this.#host.session.waitForIdle()));
		}
		if (this.#executionSettlement) drains.push(this.#executionSettlement.promise);
		if (drains.length === 0) return;
		const settled = await Promise.race([
			Promise.allSettled(drains).then(() => true),
			Bun.sleep(COUNCIL_CANCEL_DRAIN_TIMEOUT_MS).then(() => false),
		]);
		if (!settled) throw new Error(`Council cancellation timed out after ${COUNCIL_CANCEL_DRAIN_TIMEOUT_MS}ms`);
	}

	async cancel(): Promise<CouncilManifest> {
		if (this.#setupInFlight) {
			await this.cancelForSessionTransition();
			throw abortError();
		}
		const manifest = this.snapshot ? structuredClone(this.snapshot) : await this.status();
		if (!manifest) throw new Error("No council run exists for this session");
		if (isCouncilTerminalState(manifest.state)) return manifest;
		// Said before the drain, not after: cancellation can take the full drain timeout, and the
		// terminal event that follows is a separate key so the two can never collapse into one.
		void this.#emitLifecycleEvent("cancel", `Council ${manifest.runId} cancellation requested.`);
		const cancellingCheckpoint = this.#setState("cancelling");
		this.#abortController?.abort();
		let drainFailure: unknown;
		const observe = (operation: Promise<unknown>) =>
			operation.catch(error => {
				drainFailure ??= error;
			});
		const drains: Promise<unknown>[] = [observe(cancellingCheckpoint)];
		if (this.#ownsCurrentMainTurn()) {
			drains.push(observe(this.#host.session.abort().then(() => this.#host.session.waitForIdle())));
		}
		if (this.completion) drains.push(observe(this.completion));
		const timeout = Bun.sleep(COUNCIL_CANCEL_DRAIN_TIMEOUT_MS);
		await Promise.race([Promise.all(drains), timeout]);
		if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
			await Promise.race([observe(this.#interrupt("cancel", "Council run cancelled")), timeout]);
		}
		if (drainFailure) throw drainFailure;
		return structuredClone(this.snapshot!);
	}

	async resume(runId?: string, options?: CouncilRunOptions): Promise<CouncilManifest> {
		if (this.#executionInFlight) throw new Error("The prior council execution is still settling");
		this.#setExecutionInFlight(true);
		this.#abortController = new AbortController();
		this.#executionSettlement = Promise.withResolvers<void>();
		this.#setupInFlight = true;
		let dispatch: CouncilDispatchPlan | undefined;
		let beganExecution = false;
		try {
			this.#storage = createCouncilStorage(this.#host.toolSession);
			let manifest: CouncilManifest | undefined;
			if (runId) {
				manifest = await this.#loadForResume(runId);
			} else {
				// Newest *resumable* run, not simply the newest: a newer completed run — or a newer
				// terminal `planner-schema`/`EEXIST` failure — would otherwise shadow an older
				// interrupted run and make `/council resume` refuse work it could actually finish. The
				// newest-overall fallback keeps the completed early-return and the two precise refusals
				// below reachable when nothing is resumable, but it skips a run whose only blocker is an
				// oversized roster: that one is never a candidate at any priority.
				const manifests = (await this.#storage.list()).sort(
					(a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt),
				);
				manifest =
					manifests.find(isCouncilResumableManifest) ??
					manifests.find(candidate => !isCouncilRosterOverResumeLimit(candidate));
				if (!manifest) {
					// Every stored run is oversized: nothing is selectable, but a run does exist and still
					// renders in status and history, so the roster limit is what gets reported.
					const newest = manifests[0];
					if (newest) assertCouncilResumeRosterWithinLimit(newest);
				}
			}
			this.#abortController.signal.throwIfAborted();
			if (!manifest) throw new Error("No council run exists for this session");
			if (!isCouncilResumableManifest(manifest)) {
				// Ordered ahead of the completed early-return, and self-guarding on run state: an
				// oversized roster is a precise refusal naming the limit, never the generic
				// "cannot be resumed" below, and never mistaken for a corrupt payload.
				assertCouncilResumeRosterWithinLimit(manifest);
				// A completed run is returned rather than thrown so callers keep the finished manifest to
				// render; the command surface is what says "already completed; nothing to resume".
				if (manifest.state !== "failed") return structuredClone(manifest);
				if (manifest.failure?.phase === "planner-schema") {
					throw new Error("A structurally invalid council planner result is terminal and cannot be resumed");
				}
				throw new Error("A council publication collision is terminal and cannot be resumed");
			}
			// The persisted origin, never the caller's: an agent-convened run resumed from `/council
			// resume` must keep its delegated adjudicator, or the identity check would refuse it for an
			// adjudicator change the operator never made.
			dispatch = await preflightCouncilDispatch(this.#host, manifest.task, {
				promisedOutputPath: manifest.outputPath,
				signal: this.#abortController.signal,
				origin: manifest.origin ?? DEFAULT_COUNCIL_RUN_ORIGIN,
			});
			this.#abortController.signal.throwIfAborted();
			const activeCoordinator = activeCoordinators.get(dispatch.sessionId);
			if (activeCoordinator && activeCoordinator !== this) {
				throw new Error("A council run is already active in this session; use /council status.");
			}
			activeCoordinators.set(dispatch.sessionId, this);
			const persistedInstructions = await this.#loadInstructionSnapshot(manifest);
			await this.#assertResumeIdentity(manifest, dispatch, persistedInstructions);
			this.#applyInstructionSnapshot(dispatch, persistedInstructions);
			this.#abortController.signal.throwIfAborted();
			this.snapshot = structuredClone(manifest);
			this.#clearLiveTelemetry();
			await this.#assertResumePublicationAvailable(manifest);
			if (dispatch.adjudicator.mode === "main") this.#assertAdjudicationSurface();
			delete this.snapshot.failure;
			delete this.snapshot.timestamps.finishedAt;
			delete this.snapshot.timestamps.interruptedAt;
			// Main mode absorbs a changed Main into the resumed run; delegated mode leaves the
			// persisted snapshot alone, because `#assertResumeIdentity` already compared it.
			if (dispatch.adjudicator.mode === "main") {
				this.snapshot.adjudicator = adjudicatorFromPlan(dispatch, this.#now(), manifest.instructionSnapshot.sha256);
			}
			this.snapshot.state = this.snapshot.planVersions.length === 0 ? "planning" : "reviewing";
			await this.#checkpoint();
			this.#abortController.signal.throwIfAborted();
			this.#setupInFlight = false;
			this.#resumeExecution = true;
			await this.#announceKickoff(dispatch, true, options);
			this.#begin(dispatch);
			beganExecution = true;
			return structuredClone(this.snapshot);
		} catch (error) {
			if (
				isAbort(error, this.#abortController.signal) &&
				this.snapshot &&
				!isCouncilTerminalState(this.snapshot.state)
			) {
				await this.#interrupt("cancel", errorText(error));
				await this.#sendSummary();
			}
			if (dispatch && activeCoordinators.get(dispatch.sessionId) === this) {
				activeCoordinators.delete(dispatch.sessionId);
			}
			throw error;
		} finally {
			if (!beganExecution) {
				this.#setupInFlight = false;
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	/**
	 * Load an explicitly named run, turning the bare "no manifest" refusal into a directory of what
	 * *is* resumable. `list()` already returns parsed manifests, so state and resumability cost no
	 * extra reads.
	 */
	async #loadForResume(runId: string): Promise<CouncilManifest> {
		try {
			return await this.#storage!.load(runId);
		} catch (error) {
			if (!(error instanceof CouncilStorageError) || error.code !== "COUNCIL_RUN_NOT_FOUND") throw error;
			throw new Error(`${error.message}. ${await this.#recentRunsHint()}`);
		}
	}

	async #recentRunsHint(): Promise<string> {
		let manifests: CouncilManifest[];
		try {
			manifests = await this.#storage!.list();
		} catch {
			return "No council runs could be listed for this session.";
		}
		const recent = manifests
			.sort((left, right) => Date.parse(right.timestamps.createdAt) - Date.parse(left.timestamps.createdAt))
			.slice(0, COUNCIL_RESUME_DISCOVERY_LIMIT)
			.map(
				manifest =>
					`${manifest.runId} (${manifest.state}${isCouncilResumableManifest(manifest) ? ", resumable" : ""})`,
			);
		return recent.length === 0 ? "No council runs are stored for this session." : `Recent: ${recent.join(", ")}.`;
	}

	/**
	 * Hand presentation the roster and run id after the durable manifest exists but before any child
	 * launches, so nobody can reach a paid failure without first seeing what is about to be spent.
	 * Awaited on purpose; failures are logged and swallowed because the manifest is already durable.
	 */
	async #announceKickoff(dispatch: CouncilDispatchPlan, resumed: boolean, options?: CouncilRunOptions): Promise<void> {
		const sinks = [this.#host.onKickoff, options?.onKickoff].filter(sink => sink !== undefined);
		if (sinks.length === 0) return;
		const advisorModel = dispatch.advisorModel;
		const preview: CouncilKickoffPreview = {
			runId: this.snapshot!.runId,
			resumed,
			plannerModel: modelIdentity(dispatch.planner.model),
			...(dispatch.planner.advisor && advisorModel ? { plannerAdvisorModel: advisorModel } : {}),
			adjudicator: {
				mode: dispatch.adjudicator.mode,
				model: modelIdentity(dispatch.adjudicator.model),
				...(dispatch.adjudicator.mode === "delegated" && dispatch.adjudicator.advisor && advisorModel
					? { advisorModel }
					: {}),
			},
			members: dispatch.members.map(member => ({
				role: member.role,
				model: modelIdentity(member.model),
				rounds: [...member.rounds],
				...(member.advisor && advisorModel ? { advisorModel } : {}),
			})),
			rounds: dispatch.rounds,
		};
		for (const sink of sinks) {
			try {
				await sink(preview);
			} catch (error) {
				logger.warn("Council kickoff preview failed", { runId: preview.runId, error: errorText(error) });
			}
		}
	}

	#begin(dispatch: CouncilDispatchPlan): void {
		if (!this.#abortController) throw new Error("Council execution abort controller is unavailable");
		this.#setupInFlight = false;
		this.#setExecutionInFlight(true);
		this.completion = this.#executeGuarded(dispatch, this.#abortController.signal);
	}

	async #executeGuarded(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<void> {
		try {
			await this.#execute(dispatch, signal);
		} catch (error) {
			if (isAbort(error, signal)) {
				if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
					await this.#interrupt("cancel", errorText(error));
				}
			} else if (this.snapshot && !isCouncilTerminalState(this.snapshot.state)) {
				await this.#fail("coordinator", error, errorCode(error));
			}
		} finally {
			this.#setOwnedMainTurn(undefined);
			this.#stopMainTelemetry();
			this.#handlerGeneration = undefined;
			if (this.snapshot && activeCoordinators.get(this.snapshot.sessionId) === this) {
				activeCoordinators.delete(this.snapshot.sessionId);
			}
			try {
				await this.#sendSummary();
			} finally {
				this.#setExecutionInFlight(false);
				this.#executionSettlement?.resolve();
			}
		}
	}

	async #execute(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<void> {
		await this.#emitKickoffEvent();
		const planner = await this.#loadOrRunPlanner(dispatch, signal);
		signal.throwIfAborted();
		let plan = planner.plan;
		let priorAdjudication: CouncilAdjudication | undefined;
		let finalAllowedDuplicateTargetIds: string[] = [];
		for (let roundNumber = 1; roundNumber <= dispatch.rounds; roundNumber++) {
			const allowedDuplicateTargetIds = canonicalFindingIds(priorAdjudication);
			if (roundNumber === dispatch.rounds) finalAllowedDuplicateTargetIds = allowedDuplicateTargetIds;
			const existingVersion = this.snapshot!.planVersions.find(version => version.round === roundNumber);
			if (existingVersion) {
				const stored = await this.#storage!.readArtifact(existingVersion.artifact);
				const persisted = decodeMetadata<PersistedAdjudicationMetadata>(
					stored,
					ADJUDICATION_METADATA_MARKER,
				).adjudication;
				const round = this.snapshot!.rounds[roundNumber - 1]!;
				const expectedIds = round.members.flatMap(member => member.findingIds);
				priorAdjudication = validateCouncilAdjudication(persisted, expectedIds, allowedDuplicateTargetIds);
				plan = priorAdjudication.plan;
				continue;
			}
			this.#assertAdjudicationBaseFits(dispatch, roundNumber, planner, priorAdjudication);
			const ledger = await this.#runRound(dispatch, roundNumber, plan, signal);
			signal.throwIfAborted();
			const adjudication = await this.#adjudicate(dispatch, roundNumber, planner, priorAdjudication, ledger, signal);
			signal.throwIfAborted();
			const expectedIds = ledger.reports.flatMap(report => report?.findings.map(finding => finding.id) ?? []);
			validateCouncilAdjudication(adjudication, expectedIds, allowedDuplicateTargetIds);
			const finalRound = roundNumber === dispatch.rounds;
			const artifactContent =
				adjudication.plan +
				encodeMetadata(ADJUDICATION_METADATA_MARKER, { adjudication } satisfies PersistedAdjudicationMetadata);
			const artifact = await this.#storage!.writeArtifact(
				this.snapshot!.runId,
				`round${roundNumber}.md`,
				artifactContent,
			);
			signal.throwIfAborted();
			this.snapshot!.planVersions.push({
				version: this.snapshot!.planVersions.length + 1,
				round: roundNumber,
				kind: finalRound ? "final" : "round",
				artifact,
				createdAt: this.#now(),
			});
			signal.throwIfAborted();
			plan = adjudication.plan;
			priorAdjudication = adjudication;
			if (!finalRound) this.snapshot!.state = "round-transition";
			await this.#checkpoint();
			signal.throwIfAborted();
		}
		const finalRound = this.snapshot!.rounds[this.snapshot!.rounds.length - 1]!;
		const finalIds = finalRound.members.flatMap(member => member.findingIds);
		validateCouncilAdjudication(priorAdjudication, finalIds, finalAllowedDuplicateTargetIds);
		const published = await publishCouncilPlan({
			planRoot: await this.#storage!.canonicalPlanRoot(),
			outputPath: this.snapshot!.outputPath,
			content: plan,
			now: this.#now(),
			resume: this.#resumeExecution,
			signal,
		});
		signal.throwIfAborted();
		this.snapshot!.published = {
			path: published.path,
			sha256: published.sha256,
			bytes: published.bytes,
			publishedAt: published.publishedAt,
		};
		await this.#checkpoint();
		signal.throwIfAborted();
		await this.#settle(this.snapshot!.degraded ? "completed-degraded" : "completed");
	}

	async #loadOrRunPlanner(dispatch: CouncilDispatchPlan, signal: AbortSignal): Promise<CouncilPlannerOutput> {
		const draft = this.snapshot!.planVersions.find(version => version.kind === "draft");
		if (draft) {
			const stored = await this.#storage!.readArtifact(draft.artifact);
			signal.throwIfAborted();
			const frame = decodeMetadataFrame<PersistedPlannerMetadata>(stored, PLANNER_METADATA_MARKER);
			return validateCouncilPlannerOutput({ plan: frame.content, ...frame.metadata });
		}
		await this.#setState("planning");
		const assignment = prompt.render(plannerTaskTemplate, { task: dispatch.task, repositoryRoot: dispatch.repoRoot });
		const label = `Council planner ${this.snapshot!.runId}`;
		// Reserve the child's id before launch. Learning it from `AgentProgress` instead would be racy:
		// the executor emits raw subagent events *before* it processes progress, and progress is
		// coalesced for ~150 ms, so a short child's first tool call — or its entire message — would be
		// dropped by any consumer that waits for a progress tick to discover the id.
		const agentId = await reserveStructuredSubagentId(this.#host.toolSession, { label, inspectOnly: true });
		this.#recordAgentId(this.snapshot!.planner, agentId);
		await this.#checkpoint();
		this.#setSoloChild({
			agentId,
			label,
			kind: "planner",
			round: COUNCIL_PLANNER_PROGRESS_ROUND,
			order: COUNCIL_PLANNER_PROGRESS_ORDER,
		});
		let result: StructuredSubagentResult;
		try {
			result = await this.#runChild(
				{
					...dispatch.plannerRequest,
					assignment,
					identity: { id: agentId, label, inspectOnly: true },
					index: 0,
					signal,
					onProgress: progress => this.#capturePlannerProgress(agentId, progress),
				},
				signal,
			);
		} catch (error) {
			this.#setSoloChild(undefined);
			if (isAbort(error, signal)) throw abortError();
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		this.#setSoloChild(undefined);
		this.#liveMembers.delete(this.#memberProgressKey(COUNCIL_PLANNER_PROGRESS_ROUND, COUNCIL_PLANNER_PROGRESS_ORDER));
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) throw abortError();
		this.snapshot.plannerUsage ??= zeroCouncilUsage();
		this.#captureUsage(result, this.snapshot.plannerUsage);
		await this.#checkpoint();
		signal.throwIfAborted();
		try {
			this.#assertPinnedModel(result, modelIdentity(dispatch.planner.model));
		} catch (error) {
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		const structuredOutput = result.result.structuredOutput;
		let planner: CouncilPlannerOutput | undefined;
		if (structuredOutput?.status === "invalid" && structuredOutput.data !== undefined) {
			try {
				planner = validateCouncilPlannerOutput(structuredOutput.data);
			} catch (error) {
				await this.#fail("planner-schema", error, "COUNCIL_PLANNER_INVALID");
				throw error;
			}
		}
		try {
			this.#assertChildResult(result, modelIdentity(dispatch.planner.model));
		} catch (error) {
			await this.#fail("planner", error, errorCode(error));
			throw error;
		}
		if (!planner) {
			try {
				planner = validateCouncilPlannerOutput(structuredOutput?.data);
			} catch (error) {
				await this.#fail("planner-schema", error, "COUNCIL_PLANNER_INVALID");
				throw error;
			}
		}
		const metadata: PersistedPlannerMetadata = {
			assumptions: planner.assumptions,
			blockers: planner.blockers,
			evidenceVersion: planner.evidenceVersion,
		};
		const artifact = await this.#storage!.writeArtifact(
			this.snapshot!.runId,
			"draft.md",
			planner.plan + encodeMetadata(PLANNER_METADATA_MARKER, metadata),
		);
		signal.throwIfAborted();
		this.snapshot!.planVersions.push({ version: 1, round: 0, kind: "draft", artifact, createdAt: this.#now() });
		await this.#checkpoint();
		signal.throwIfAborted();
		return planner;
	}

	async #runRound(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		plan: string,
		signal: AbortSignal,
	): Promise<RoundLedger> {
		await this.#setState("reviewing");
		signal.throwIfAborted();
		const round = this.snapshot!.rounds[roundNumber - 1]!;
		const roster = this.snapshot!.roster;
		// One definition of a reviewer's slot number: its 1-based index in the roster. Round position
		// is a subset index and `record.order` is the config index, so neither is usable for display
		// or for the finding-id namespace, both of which `stats.ts` keys by roster index.
		const rosterIndices = round.members.map(member => roster.findIndex(entry => entry.order === member.order));
		const ledger: RoundLedger = {
			reports: new Array(round.members.length),
			failures: new Array(round.members.length),
			slots: rosterIndices.map(index => index + 1),
		};
		const globalSlotFor = (position: number): number => (roundNumber - 1) * roster.length + rosterIndices[position]!;
		const launchSlots: number[] = [];
		for (const [slot, member] of round.members.entries()) {
			if (member.status === "succeeded" && member.artifact) {
				const candidate = JSON.parse(await this.#storage!.readArtifact(member.artifact));
				ledger.reports[slot] = validatePersistedCouncilReport(candidate, globalSlotFor(slot));
			} else if (member.status === "failed") {
				ledger.failures[slot] = {
					role: member.role,
					reason: member.failureReason ?? `${member.role} did not complete`,
				};
			} else {
				launchSlots.push(slot);
			}
		}
		if (launchSlots.length > 0) {
			round.status = "running";
			round.startedAt ??= this.#now();
			round.finishedAt = null;
			for (const slot of launchSlots) {
				// This is a re-launch, not a fresh slot: `attempts` accumulates, and so does `agentIds`.
				// Clearing either would strand the earlier attempt's transcript.
				const member = round.members[slot]!;
				member.status = "running";
				member.attempts++;
				member.startedAt = this.#now();
				member.finishedAt = null;
				member.artifact = null;
				member.failureReason = null;
				member.findingIds = [];
			}
			await this.#checkpoint();
			await this.#emitLifecycleEvent(
				"round-start",
				`Council round ${roundNumber}/${this.snapshot!.rounds.length} started: ${launchSlots.length} reviewer(s) running.`,
				{ round: roundNumber },
			);
			signal.throwIfAborted();
			// A round with a single enabled roster member has exactly one running child, which makes it
			// mirrorable in the main transcript. Two or more concurrent reviewers stay HUD-only.
			const solo = launchSlots.length === 1 ? launchSlots[0]! : undefined;
			await Promise.allSettled(
				launchSlots.map(slot =>
					this.#runMember(dispatch, roundNumber, slot, rosterIndices[slot]!, plan, ledger, signal, slot === solo),
				),
			);
			signal.throwIfAborted();
		}
		if (round.status !== "settled") {
			round.status = "settled";
			round.finishedAt = this.#now();
			for (const member of round.members) {
				if (member.status === "running") {
					member.status = signal.aborted ? "cancelled" : "failed";
					member.finishedAt = this.#now();
					member.failureReason = signal.aborted
						? "Council run cancelled"
						: "Council member ended without a result";
				}
			}
			await this.#checkpoint();
		}
		signal.throwIfAborted();
		// Emitted for every settled round, not just the fallback path above: a round whose members all
		// report settles inside `#runMember` via `#settleRoundIfLast`. Two or more concurrent reviewers
		// suppress the transcript mirror, so this durable line is the only thing that says the round
		// happened at all.
		const succeeded = round.members.filter(member => member.status === "succeeded").length;
		const findings = round.members.reduce((total, member) => total + member.findingIds.length, 0);
		await this.#emitLifecycleEvent(
			"round-settle",
			`Council round ${roundNumber} settled: ${succeeded}/${round.members.length} reviewers succeeded, ${findings} findings.`,
			{ round: roundNumber },
		);
		return ledger;
	}

	async #runMember(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		slot: number,
		/** Position of this reviewer in `manifest.roster`, which owns slot numbering and finding ids. */
		rosterIndex: number,
		plan: string,
		ledger: RoundLedger,
		signal: AbortSignal,
		solo: boolean,
	): Promise<void> {
		const round = this.snapshot!.rounds[roundNumber - 1]!;
		const record = round.members[slot]!;
		const member = dispatch.members[rosterIndex]!;
		const globalSlot = (roundNumber - 1) * this.snapshot!.roster.length + rosterIndex;
		const prefix = councilSlotPrefix(globalSlot);
		const label = `Council ${councilRoleLabel(member.role)} r${roundNumber}`;
		let schemaRetry = false;
		try {
			for (;;) {
				const assignment = prompt.render(memberTaskTemplate, {
					task: dispatch.task,
					repositoryRoot: dispatch.repoRoot,
					round: roundNumber,
					lens: member.lens,
					plan,
					idPrefix: prefix,
				});
				// Reserved per attempt: a schema retry is a distinct child session, so reusing one id
				// would make the mirror attribute the retry's events to the abandoned attempt.
				const agentId = await reserveStructuredSubagentId(this.#host.toolSession, { label, inspectOnly: true });
				this.#recordAgentId(record, agentId);
				await this.#checkpoint();
				signal.throwIfAborted();
				if (solo) {
					this.#setSoloChild({ agentId, label, kind: "member", round: roundNumber, order: record.order });
				}
				const request: StructuredSubagentRequest = {
					...dispatch.memberRequests[rosterIndex]!,
					assignment,
					identity: { id: agentId, label, inspectOnly: true },
					index: globalSlot + 1,
					signal,
					onProgress: progress => this.#captureProgress(agentId, roundNumber, record, progress),
				};
				const result = await this.#runChild(request, signal);
				if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) throw abortError();
				record.resolvedModel = result.result.resolvedModel ?? null;
				record.authFallbackUsed = result.result.authFallbackUsed === true;
				// Charged before validation and accumulated (never overwritten), so the one-shot schema
				// retry below — which `continue`s past this point a second time — is billed too and the
				// per-role bucket reconciles with the aggregate.
				record.usage ??= zeroCouncilUsage();
				this.#captureUsage(result, record.usage);
				await this.#checkpoint();
				signal.throwIfAborted();
				this.#assertPinnedModel(result, modelIdentity(member.model));
				const validationStatus = result.result.structuredOutput?.status;
				if (validationStatus !== "invalid") {
					this.#assertChildResult(result, modelIdentity(member.model));
				}
				let report: CouncilReport;
				try {
					report = validateIncomingCouncilReport(result.result.structuredOutput?.data, globalSlot);
				} catch (error) {
					if (!schemaRetry && !result.result.aborted && validationStatus === "invalid") {
						schemaRetry = true;
						record.attempts++;
						await this.#checkpoint();
						signal.throwIfAborted();
						continue;
					}
					throw error;
				}
				this.#assertChildResult(result, modelIdentity(member.model));
				const artifact = await this.#storage!.writeArtifact(
					this.snapshot!.runId,
					`${member.role}-r${roundNumber}.json`,
					`${JSON.stringify(report, null, 2)}\n`,
				);
				signal.throwIfAborted();
				record.status = "succeeded";
				record.finishedAt = this.#now();
				record.artifact = artifact;
				record.findingIds = report.findings.map(finding => finding.id);
				ledger.reports[slot] = report;
				if (solo) this.#setSoloChild(undefined);
				this.#liveMembers.delete(this.#memberProgressKey(roundNumber, record.order));
				this.#settleRoundIfLast(round);
				await this.#checkpoint();
				return;
			}
		} catch (error) {
			if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
			record.status = signal.aborted ? "cancelled" : "failed";
			record.finishedAt = this.#now();
			record.artifact = null;
			record.failureReason = errorText(error);
			record.findingIds = [];
			ledger.failures[slot] = { role: record.role, reason: record.failureReason };
			this.snapshot!.degraded = true;
			if (solo) this.#setSoloChild(undefined);
			this.#liveMembers.delete(this.#memberProgressKey(roundNumber, record.order));
			this.#settleRoundIfLast(round);
			await this.#checkpoint();
		}
	}

	#memberProgressKey(round: number, order: number): string {
		return `${round}:${order}`;
	}

	/** Planner telemetry shares `#liveMembers` under a reserved out-of-band round/order key. */
	#capturePlannerProgress(agentId: string, progress: AgentProgress): void {
		this.#captureLiveProgress(
			agentId,
			COUNCIL_PLANNER_PROGRESS_ROUND,
			"planner",
			COUNCIL_PLANNER_PROGRESS_ORDER,
			1,
			progress,
		);
	}

	#captureProgress(agentId: string, round: number, record: CouncilRoundMemberRecord, progress: AgentProgress): void {
		this.#captureLiveProgress(agentId, round, record.role, record.order, record.attempts, progress);
	}

	#captureLiveProgress(
		agentId: string,
		round: number,
		role: string,
		order: number,
		attempt: number,
		progress: AgentProgress,
	): void {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const recentOutput = progress.recentOutput
			.slice(-COUNCIL_PROGRESS_OUTPUT_LIMIT)
			.map(line => line.slice(0, COUNCIL_PROGRESS_LINE_LIMIT));
		this.#liveMembers.set(this.#memberProgressKey(round, order), {
			agentId,
			round,
			role,
			order,
			attempt,
			status: progress.status,
			lastIntent: progress.lastIntent,
			currentToolArgs: progress.currentToolArgs,
			currentTool: progress.currentTool,
			recentOutput,
			requests: progress.requests,
			tokens: progress.tokens,
			cost: progress.cost,
			retryState: progress.retryState ? { ...progress.retryState } : undefined,
		});
		this.#emit();
	}

	#settleRoundIfLast(round: CouncilManifest["rounds"][number]): void {
		if (round.members.some(member => member.status === "running" || member.status === "pending")) return;
		round.status = "settled";
		round.finishedAt = this.#now();
	}

	#renderAdjudicationAssignment(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
		reports: BoundedCouncilReports,
		gradeSlots: readonly number[],
	): string {
		const template = roundNumber === 1 ? adjudicationRoundOneTemplate : adjudicationRoundTwoTemplate;
		const plannerBasis =
			roundNumber === 1
				? planner
				: {
						revisedPlan: prior?.plan,
						// The only prior IDs a round-two `duplicate` may target. A delegated adjudicator
						// never saw round one, so the eligible set has to ride in the basis itself.
						priorCanonicalFindingIds: canonicalFindingIds(prior),
						planner: {
							assumptions: planner.assumptions,
							blockers: planner.blockers,
							evidenceVersion: planner.evidenceVersion,
						},
					};
		return prompt.render(template, {
			task: dispatch.task,
			repositoryRoot: dispatch.repoRoot,
			plannerOutput: JSON.stringify(plannerBasis),
			reports: reports.text,
			overflowCount: reports.overflowCount,
			overflowIds: reports.overflowIds,
			gradeSlots: gradeSlots.join(", "),
			delegated: dispatch.adjudicator.mode === "delegated",
		});
	}

	#assertAdjudicationBaseFits(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
	): void {
		const noReports: BoundedCouncilReports = { text: "", overflowCount: 0, overflowIds: "" };
		// Worst case for the grade list: every roster slot graded.
		const allSlots = this.snapshot?.roster.map((_member, index) => index + 1) ?? [];
		const assignment = this.#renderAdjudicationAssignment(dispatch, roundNumber, planner, prior, noReports, allSlots);
		const delegated = dispatch.adjudicator.mode === "delegated";
		const repair = prompt.render(adjudicationRepairTemplate, { assignment, delegated });
		if (
			assignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP ||
			repair.length > COUNCIL_ADJUDICATION_INJECTION_CAP
		) {
			throw new Error("Council adjudication fixed context exceeds the bounded injection cap");
		}
	}

	/**
	 * Everything both adjudication modes need: the validated id sets, the grade slots, and the
	 * bounded assignment/repair pair that fits the injection cap. Factored out so `main` and
	 * `delegated` can never disagree about what the adjudicator was shown or what it owes back.
	 */
	#buildAdjudicationContext(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
		ledger: RoundLedger,
	): {
		assignment: string;
		repairAssignment: string;
		expectedIds: string[];
		priorIds: string[];
		gradeSlots: number[];
	} {
		const expectedIds = ledger.reports.flatMap(report => report?.findings.map(finding => finding.id) ?? []);
		// Only a reviewer that actually reported can be graded; a failed slot is derived `F` downstream.
		const gradeSlots = ledger.reports.flatMap((report, index) => (report ? [ledger.slots[index]!] : []));
		const priorIds = canonicalFindingIds(prior);
		const renderAssignment = (reports: BoundedCouncilReports) =>
			this.#renderAdjudicationAssignment(dispatch, roundNumber, planner, prior, reports, gradeSlots);
		const noReports: BoundedCouncilReports = { text: "", overflowCount: 0, overflowIds: "" };
		const delegated = dispatch.adjudicator.mode === "delegated";
		const emptyRepair = prompt.render(adjudicationRepairTemplate, {
			assignment: renderAssignment(noReports),
			delegated,
		});
		let reportCap = COUNCIL_ADJUDICATION_INJECTION_CAP - emptyRepair.length;
		if (reportCap < 0) throw new Error("Council adjudication fixed context exceeds the bounded injection cap");
		let reports = boundedReports(ledger, reportCap);
		let assignment = renderAssignment(reports);
		let repairAssignment = prompt.render(adjudicationRepairTemplate, { assignment, delegated });
		while (repairAssignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP && reportCap > 0) {
			reportCap = Math.max(0, reportCap - (repairAssignment.length - COUNCIL_ADJUDICATION_INJECTION_CAP));
			reports = boundedReports(ledger, reportCap);
			assignment = renderAssignment(reports);
			repairAssignment = prompt.render(adjudicationRepairTemplate, { assignment, delegated });
		}
		if (
			assignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP ||
			repairAssignment.length > COUNCIL_ADJUDICATION_INJECTION_CAP
		) {
			throw new Error("Council adjudication context exceeds the bounded injection cap");
		}
		return { assignment, repairAssignment, expectedIds, priorIds, gradeSlots };
	}

	async #adjudicate(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		planner: CouncilPlannerOutput,
		prior: CouncilAdjudication | undefined,
		ledger: RoundLedger,
		signal: AbortSignal,
	): Promise<CouncilAdjudication> {
		const context = this.#buildAdjudicationContext(dispatch, roundNumber, planner, prior, ledger);
		return dispatch.adjudicator.mode === "delegated"
			? this.#adjudicateDelegated(dispatch, roundNumber, context, signal)
			: this.#adjudicateWithMain(dispatch, context, signal);
	}

	/** Historical in-session adjudication: Main owns the turn and answers through `xd://council`. */
	async #adjudicateWithMain(
		dispatch: CouncilDispatchPlan,
		context: {
			assignment: string;
			repairAssignment: string;
			expectedIds: string[];
			priorIds: string[];
			gradeSlots: number[];
		},
		signal: AbortSignal,
	): Promise<CouncilAdjudication> {
		await this.#setState("awaiting-main");
		const { assignment, repairAssignment, expectedIds, priorIds, gradeSlots } = context;
		for (let repair = 0; repair < 2; repair++) {
			let accepted: CouncilAdjudication | undefined;
			const generation = ++this.#mainTurnGeneration;
			let handlerOpen = true;
			const handler = async (payload: string) => {
				if (
					!handlerOpen ||
					signal.aborted ||
					this.#handlerGeneration !== generation ||
					this.#ownedMainTurn !== generation
				) {
					return {
						content: [{ type: "text" as const, text: "Council adjudication is no longer active." }],
						isError: true,
					};
				}
				try {
					const candidate = JSON.parse(payload) as unknown;
					const validated = validateCouncilAdjudication(candidate, expectedIds, priorIds, gradeSlots);
					if (accepted) {
						return {
							content: [{ type: "text" as const, text: "Council adjudication was already accepted." }],
							isError: true,
						};
					}
					accepted = validated;
					return { content: [{ type: "text" as const, text: "Council adjudication accepted." }] };
				} catch (error) {
					return {
						content: [{ type: "text" as const, text: `Invalid council adjudication: ${errorText(error)}` }],
						isError: true,
					};
				}
			};
			if (this.#host.toolSession.peekCouncilHandler?.())
				throw new Error("Another council adjudication handler is active");
			this.#handlerGeneration = generation;
			this.#host.toolSession.setCouncilHandler!(handler);
			let promptError: unknown;
			// Main's turn never traverses `#captureUsage` — `promptCustomMessage` returns void — so
			// `manifest.usage` understated every run by one or two turns per round. Bracket the prompt
			// and sum the assistant messages it appended, including the repair turn.
			const messagesBefore = this.#host.session.messages.length;
			this.#startMainTelemetry(generation, messagesBefore);
			try {
				await this.#setState("adjudicating");
				const content = repair === 0 ? assignment : repairAssignment;
				this.snapshot!.adjudicationBudget.injectedChars = content.length;
				await this.#checkpoint();
				await this.#promptMainWhenIdle(dispatch, content, generation, signal);
			} catch (error) {
				promptError = error;
			} finally {
				this.#stopMainTelemetry({ keepRow: true });
				handlerOpen = false;
				if (this.#handlerGeneration === generation) {
					if (this.#host.toolSession.peekCouncilHandler?.() === handler) {
						this.#host.toolSession.setCouncilHandler?.(null);
					}
					this.#handlerGeneration = undefined;
				}
				if (this.#ownedMainTurn === generation) this.#setOwnedMainTurn(undefined);
			}
			await this.#chargeAdjudicatorTurn(messagesBefore);
			signal.throwIfAborted();
			if (accepted) return accepted;
			if (promptError) throw promptError;
		}
		signal.throwIfAborted();
		const error = new Error("Main ended two adjudication turns without a valid council payload");
		await this.#fail("adjudication", error, "COUNCIL_ADJUDICATION_MISSING");
		throw error;
	}

	/**
	 * Delegated adjudication: a pinned child agent terminal-yields the verdict.
	 *
	 * Main's turn is never taken, so the run never enters `awaiting-main` and never needs the
	 * `xd://council` surface. One schema retry mirrors `#runMember`; two failures fail the run under
	 * the same `COUNCIL_ADJUDICATION_MISSING` code the in-session path uses.
	 */
	async #adjudicateDelegated(
		dispatch: CouncilDispatchPlan,
		roundNumber: number,
		context: {
			assignment: string;
			repairAssignment: string;
			expectedIds: string[];
			priorIds: string[];
			gradeSlots: number[];
		},
		signal: AbortSignal,
	): Promise<CouncilAdjudication> {
		const request = dispatch.adjudicatorRequest;
		if (!request) throw new Error("Council delegated adjudication is missing its child request policy");
		const expectedModel = modelIdentity(dispatch.adjudicator.model);
		const label = `Council adjudicator r${roundNumber}`;
		await this.#setState("adjudicating");
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const content = attempt === 0 ? context.assignment : context.repairAssignment;
			const agentId = await reserveStructuredSubagentId(this.#host.toolSession, { label, inspectOnly: true });
			this.#recordAgentId(this.snapshot!.adjudicator, agentId);
			this.snapshot!.adjudicationBudget.injectedChars = content.length;
			await this.#checkpoint();
			signal.throwIfAborted();
			this.#setSoloChild({
				agentId,
				label,
				kind: "adjudicator",
				round: roundNumber,
				order: COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
			});
			let result: StructuredSubagentResult;
			try {
				result = await this.#runChild(
					{
						...request,
						assignment: content,
						identity: { id: agentId, label, inspectOnly: true },
						index: 0,
						signal,
						onProgress: progress =>
							this.#captureLiveProgress(
								agentId,
								COUNCIL_PLANNER_PROGRESS_ROUND,
								"adjudicator",
								COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
								attempt + 1,
								progress,
							),
					},
					signal,
				);
			} catch (error) {
				this.#clearAdjudicatorTelemetry();
				if (isAbort(error, signal)) throw abortError();
				await this.#fail("adjudication", error, errorCode(error));
				throw error;
			}
			if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) {
				this.#clearAdjudicatorTelemetry();
				throw abortError();
			}
			this.snapshot.adjudicatorUsage ??= zeroCouncilUsage();
			this.#captureUsage(result, this.snapshot.adjudicatorUsage);
			// Charged first, dropped second, with no await between: the pane sums the durable bucket
			// with the live row, so an emit in the gap would blank the cell the turn just filled.
			this.#clearAdjudicatorTelemetry();
			await this.#checkpoint();
			signal.throwIfAborted();
			const validationStatus = result.result.structuredOutput?.status;
			try {
				this.#assertPinnedModel(result, expectedModel);
				if (validationStatus !== "invalid") this.#assertChildResult(result, expectedModel);
			} catch (error) {
				await this.#fail("adjudication", error, errorCode(error));
				throw error;
			}
			try {
				const adjudication = validateCouncilAdjudication(
					result.result.structuredOutput?.data,
					context.expectedIds,
					context.priorIds,
					context.gradeSlots,
				);
				this.#assertChildResult(result, expectedModel);
				return adjudication;
			} catch (error) {
				lastError = error;
				if (attempt === 1 || result.result.aborted) break;
			}
		}
		signal.throwIfAborted();
		const error = new Error(
			`Council adjudicator ended two attempts without a valid adjudication: ${errorText(lastError)}`,
		);
		await this.#fail("adjudication", error, "COUNCIL_ADJUDICATION_MISSING");
		throw error;
	}

	/**
	 * Drop the delegated adjudicator's live row and solo-child handle in lockstep.
	 *
	 * The row is deleted before `#setSoloChild`, whose own emit would otherwise publish a frame in
	 * which the live sample and an already-charged durable bucket both count the same turn.
	 */
	#clearAdjudicatorTelemetry(): void {
		const dropped = this.#liveMembers.delete(
			this.#memberProgressKey(COUNCIL_PLANNER_PROGRESS_ROUND, COUNCIL_ADJUDICATOR_PROGRESS_ORDER),
		);
		const had = this.#soloChild !== undefined;
		this.#setSoloChild(undefined);
		if (dropped && !had) this.#emit();
	}

	async #promptMainWhenIdle(
		dispatch: CouncilDispatchPlan,
		content: string,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		for (;;) {
			await abortable(this.#host.session.waitForIdle(), signal);
			if (signal.aborted) throw abortError();
			const main = await abortable(preflightCouncilMainDispatch(this.#host), signal);
			if (signal.aborted) throw abortError();
			let identityChanged = false;
			try {
				await this.#host.session.promptCustomMessage(
					{
						customType: "council-adjudication",
						content,
						display: false,
						details: { runId: this.snapshot!.runId, generation },
					},
					{
						onPromptStart: () => {
							const current = this.#host.session.model;
							const currentEffort = current
								? resolveCouncilMainEffort(current, this.#host.session.thinkingLevel)
								: undefined;
							if (
								!current ||
								modelIdentity(current) !== modelIdentity(main.model) ||
								nullableEffort(currentEffort) !== nullableEffort(main.effort)
							) {
								identityChanged = true;
								throw new Error("Council Main model or effort changed during adjudication turn acquisition");
							}
							this.#recordLiveAdjudicator(dispatch, main);
							this.#setOwnedMainTurn(generation);
						},
					},
				);
				return;
			} catch (error) {
				this.#setOwnedMainTurn(undefined);
				if (identityChanged || error instanceof AgentBusyError) continue;
				throw error;
			}
		}
	}

	/**
	 * Main-mode only: refresh the durable adjudicator snapshot from the live Main surface as the turn
	 * is acquired, and re-derive the degrading warnings against the roster that is actually running.
	 */
	#recordLiveAdjudicator(dispatch: CouncilDispatchPlan, main: CouncilMainDispatchSnapshot): void {
		const degrading = councilDispatchWarnings({
			members: dispatch.members,
			inert: dispatch.inert,
			rounds: dispatch.rounds,
		}).degrading;
		for (const warning of degrading) {
			if (!this.snapshot!.warnings.includes(warning)) this.snapshot!.warnings.push(warning);
		}
		if (degrading.length > 0) this.snapshot!.degraded = true;
		this.snapshot!.adjudicator = {
			...this.snapshot!.adjudicator,
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: modelIdentity(main.model),
			effort: nullableEffort(main.effort),
			capturedAt: this.#now(),
			instructionSha256: this.snapshot!.instructionSnapshot.sha256,
		};
	}

	#ownsCurrentMainTurn(): boolean {
		return this.#ownedMainTurn !== undefined && this.#ownedMainTurn === this.#handlerGeneration;
	}

	async #runChild(request: StructuredSubagentRequest, signal: AbortSignal): Promise<StructuredSubagentResult> {
		return withSessionSpawnPermit(this.#host.toolSession, signal, () =>
			runStructuredSubagent({ ...request, signal }),
		);
	}

	#assertPinnedModel(result: StructuredSubagentResult, expectedModel: string): void {
		const child = result.result;
		if (child.authFallbackUsed) throw new Error("Pinned council child used an authentication fallback");
		if (
			!child.resolvedModel ||
			(child.resolvedModel !== expectedModel && !child.resolvedModel.startsWith(`${expectedModel}:`))
		) {
			throw new Error(
				`Pinned council child resolved to ${child.resolvedModel ?? "an unknown model"} instead of ${expectedModel}`,
			);
		}
	}

	/**
	 * Charge every assistant message Main appended since `messagesBefore` to both the run aggregate
	 * and the durable `adjudicatorUsage` bucket, using the canonical in-repo assistant-usage formula.
	 *
	 * This is also the hand-off point for the live row, and the two MUST land in one synchronous
	 * step. The pane sums the durable bucket with the live sample, so an emit between them publishes
	 * a row that either counts the turn twice or, before the charge, reports nothing at all — a
	 * visible blank at the exact moment an agent settles. `#stopMainTelemetry({ keepRow: true })`
	 * therefore leaves the row standing for this method to drop.
	 */
	async #chargeAdjudicatorTurn(messagesBefore: number): Promise<void> {
		const key = this.#memberProgressKey(COUNCIL_PLANNER_PROGRESS_ROUND, COUNCIL_ADJUDICATOR_PROGRESS_ORDER);
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) {
			if (this.#liveMembers.delete(key)) this.#emit();
			return;
		}
		const { requests, tokens, cost } = this.#mainTurnUsage(messagesBefore);
		if (requests === 0) {
			if (this.#liveMembers.delete(key)) this.#emit();
			return;
		}
		this.snapshot.adjudicatorUsage ??= zeroCouncilUsage();
		const sink = this.snapshot.adjudicatorUsage;
		sink.requests += requests;
		sink.tokens += tokens;
		sink.cost += cost;
		this.snapshot.usage.requests += requests;
		this.snapshot.usage.tokens += tokens;
		this.snapshot.usage.cost += cost;
		this.#liveMembers.delete(key);
		await this.#checkpoint();
	}

	/**
	 * Sum Main's assistant messages since `messagesBefore` with the canonical in-repo usage formula.
	 * Shared by the durable charge and the live sampler on purpose: reconciliation is then structural
	 * — the same slice is summed the same way — so the live row converges instead of double-counting.
	 */
	#mainTurnUsage(messagesBefore: number): CouncilUsage {
		let requests = 0;
		let tokens = 0;
		let cost = 0;
		for (const message of this.#host.session.messages.slice(messagesBefore)) {
			if (message.role !== "assistant") continue;
			requests += 1;
			tokens += message.usage.input + message.usage.output + message.usage.cacheWrite;
			cost += message.usage.cost.total;
		}
		return { requests, tokens, cost };
	}

	/**
	 * Publish Main's in-flight adjudication spend into `#liveMembers` while it owns the turn.
	 *
	 * Main is not a child agent — `promptCustomMessage` has no `onProgress` — so the only source is
	 * the message slice `#chargeMainTurn` bills at turn end, sampled early. `agent.appendMessage`
	 * grows that slice at each `message_end`, so a multi-request turn advances before it returns.
	 */
	#startMainTelemetry(generation: number, messagesBefore: number): void {
		this.#stopMainTelemetry();
		this.#mainTelemetry = { generation, messagesBefore };
		this.#sampleMainTelemetry();
		this.#mainTelemetryTimer = setInterval(() => this.#sampleMainTelemetry(), MAIN_TELEMETRY_SAMPLE_MS);
		this.#mainTelemetryTimer.unref?.();
	}

	/**
	 * Stop sampling Main's turn. `keepRow` leaves the live row standing so
	 * `#chargeAdjudicatorTurn` can retire it in the same synchronous step that charges the durable
	 * bucket; teardown paths, which never charge, drop it here instead.
	 */
	#stopMainTelemetry(options: { keepRow?: boolean } = {}): void {
		if (this.#mainTelemetryTimer) {
			clearInterval(this.#mainTelemetryTimer);
			this.#mainTelemetryTimer = undefined;
		}
		if (!this.#mainTelemetry) return;
		this.#mainTelemetry = undefined;
		if (options.keepRow === true) return;
		// Nothing will charge the durable bucket on this path, so the live row is dropped rather than
		// frozen: leaving it would strand a running row on a run that has stopped.
		if (
			this.#liveMembers.delete(
				this.#memberProgressKey(COUNCIL_PLANNER_PROGRESS_ROUND, COUNCIL_ADJUDICATOR_PROGRESS_ORDER),
			)
		) {
			this.#emit();
		}
	}

	#sampleMainTelemetry(): void {
		const sampling = this.#mainTelemetry;
		if (!sampling) return;
		// Generation-scoped: until this council turn is actually acquired — and never after another
		// turn takes ownership — an unrelated user turn's spend must not leak into the council row.
		if (this.#ownedMainTurn !== sampling.generation) return;
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const usage = this.#mainTurnUsage(sampling.messagesBefore);
		this.#liveMembers.set(
			this.#memberProgressKey(COUNCIL_PLANNER_PROGRESS_ROUND, COUNCIL_ADJUDICATOR_PROGRESS_ORDER),
			{
				agentId: this.snapshot.mainAgentId,
				round: COUNCIL_PLANNER_PROGRESS_ROUND,
				role: "main",
				order: COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
				attempt: 1,
				status: "running",
				recentOutput: [],
				requests: usage.requests,
				tokens: usage.tokens,
				cost: usage.cost,
			},
		);
		this.#emit();
	}

	#assertChildResult(result: StructuredSubagentResult, expectedModel: string): void {
		this.#assertPinnedModel(result, expectedModel);
		const child = result.result;
		if (child.exitCode !== 0 || child.error || child.aborted) {
			throw new Error(child.abortReason ?? child.error ?? (child.stderr || "Council child failed"));
		}
	}

	/**
	 * Charge a child against the run aggregate and, when supplied, its per-role bucket.
	 *
	 * Failed attempts and schema retries are charged too, so `manifest.usage`, the HUD, and the stats
	 * table stay reconciled with what the provider actually billed.
	 */
	#captureUsage(result: StructuredSubagentResult, sink?: CouncilUsage): void {
		const { requests, tokens, cost } = councilChildUsage(result);
		this.snapshot!.usage.requests += requests;
		this.snapshot!.usage.tokens += tokens;
		this.snapshot!.usage.cost += cost;
		if (!sink) return;
		sink.requests += requests;
		sink.tokens += tokens;
		sink.cost += cost;
	}

	async #setState(state: CouncilManifest["state"]): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		this.snapshot.state = state;
		await this.#checkpoint();
	}

	async #settle(state: "completed" | "completed-degraded"): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		this.#clearLiveTelemetry();
		this.snapshot.state = state;
		this.snapshot.timestamps.finishedAt = this.#now();
		await this.#checkpoint();
		await this.#emitTerminalEvent();
	}

	async #interrupt(phase: string, reason: string): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const now = this.#now();
		for (const round of this.snapshot.rounds) {
			if (round.status !== "running") continue;
			round.status = "interrupted";
			round.finishedAt = now;
			for (const member of round.members) {
				if (member.status !== "running") continue;
				member.status = "interrupted";
				member.finishedAt = now;
				member.failureReason ??= reason;
			}
		}
		this.#clearLiveTelemetry();
		this.snapshot.state = "interrupted";
		this.snapshot.failure = { phase, reason, code: "COUNCIL_INTERRUPTED", time: now };
		this.snapshot.timestamps.finishedAt = now;
		this.snapshot.timestamps.interruptedAt = now;
		await this.#checkpoint();
		await this.#emitTerminalEvent();
	}

	async #fail(phase: string, error: unknown, code?: string): Promise<void> {
		if (!this.snapshot || isCouncilTerminalState(this.snapshot.state)) return;
		const now = this.#now();
		for (const round of this.snapshot.rounds) {
			if (round.status !== "running") continue;
			round.status = "interrupted";
			round.finishedAt = now;
			for (const member of round.members) {
				if (member.status !== "running") continue;
				member.status = "interrupted";
				member.finishedAt = now;
				member.failureReason ??= errorText(error);
			}
		}
		this.#clearLiveTelemetry();
		this.snapshot.state = "failed";
		this.snapshot.failure = { phase, reason: errorText(error), ...(code ? { code } : {}), time: now };
		this.snapshot.timestamps.finishedAt = now;
		await this.#checkpoint();
		await this.#emitTerminalEvent();
	}

	/**
	 * Record a reserved child id on its durable owner. Called **before** the child launches and
	 * followed by a checkpoint: a crash between reservation and completion is precisely the
	 * interrupted run whose transcript the operator wants, so persisting on settle would lose the
	 * pointer exactly when it matters most.
	 *
	 * Ids accumulate one per attempt and are never cleared — the round re-launch reset deliberately
	 * leaves them alone, the way it leaves `attempts` alone — so a schema retry or a resumed re-run
	 * keeps every earlier transcript reachable. Past the schema cap the oldest fall off, because the
	 * newest attempt is the one whose child ref is most likely to still resolve.
	 */
	#recordAgentId(owner: { agentIds?: string[] }, agentId: string): void {
		owner.agentIds ??= [];
		const ids = owner.agentIds;
		if (ids.includes(agentId)) return;
		ids.push(agentId);
		if (ids.length > COUNCIL_AGENT_ID_LIMIT) ids.splice(0, ids.length - COUNCIL_AGENT_ID_LIMIT);
	}

	async #checkpoint(): Promise<void> {
		if (!this.snapshot || !this.#storage) throw new Error("Council storage is unavailable");
		const snapshot = parseCouncilManifest(structuredClone(this.snapshot));
		const operation = this.#checkpointTail.then(async () => {
			const persisted = await this.#storage!.checkpoint(snapshot);
			if (this.snapshot) this.snapshot.timestamps.updatedAt = persisted.timestamps.updatedAt;
			this.#emit();
		});
		this.#checkpointTail = operation.catch(() => {});
		await operation;
	}

	async #initialManifest(dispatch: CouncilDispatchPlan): Promise<CouncilManifest> {
		if (!this.#storage) throw new Error("Council storage is unavailable");
		const now = this.#now();
		const roster = rosterFromPlan(dispatch);
		const runId =
			typeof this.#host.runId === "function" ? this.#host.runId() : (this.#host.runId ?? Bun.randomUUIDv7());
		const instructionContent = `${JSON.stringify(dispatch.instructions)}\n`;
		const instructionArtifact = await this.#storage.createArtifact(runId, "instructions.json", instructionContent);
		this.#abortController?.signal.throwIfAborted();
		return parseCouncilManifest({
			version: COUNCIL_MANIFEST_VERSION,
			runId,
			sessionId: dispatch.sessionId,
			mainAgentId: MAIN_AGENT_ID,
			state: "dispatching",
			task: dispatch.task,
			repoRoot: dispatch.repoRoot,
			origin: dispatch.origin,
			outputPath: dispatch.publicationTarget.relativePath,
			timestamps: { createdAt: now, updatedAt: now, startedAt: now },
			config: structuredClone(dispatch.config),
			roster,
			planner: plannerFromPlan(dispatch),
			adjudicator: adjudicatorFromPlan(dispatch, now, instructionArtifact.sha256),
			instructionSnapshot: {
				artifact: instructionArtifact,
				sha256: instructionArtifact.sha256,
			},
			// Round N runs exactly the roster members that serve it, so a reviewer pinned to the other
			// round is absent here rather than sitting permanently `pending`.
			rounds: Array.from({ length: dispatch.rounds }, (_, index) => ({
				round: index + 1,
				status: "pending",
				startedAt: null,
				finishedAt: null,
				members: roster.filter(member => member.rounds.includes(index + 1)).map(blankMember),
			})),
			planVersions: [],
			usage: zeroCouncilUsage(),
			adjudicationBudget: { injectedChars: 0, cap: COUNCIL_ADJUDICATION_INJECTION_CAP },
			warnings: [...dispatch.warnings],
			degraded: dispatch.degraded,
		});
	}

	async #assertResumeIdentity(
		manifest: CouncilManifest,
		dispatch: CouncilDispatchPlan,
		persistedInstructions: CouncilInstructionSnapshot,
	): Promise<void> {
		const roster = rosterFromPlan(dispatch);
		const planner = plannerFromPlan(dispatch);
		const adjudicator = adjudicatorFromPlan(
			dispatch,
			manifest.adjudicator.capturedAt,
			manifest.instructionSnapshot.sha256,
		);
		const mismatches: CouncilResumeMismatch[] = [
			...councilResumeMismatches(manifest, { roster, planner, adjudicator }),
		];
		if (!sameJson(manifest.config, dispatch.config)) mismatches.push("config");
		if (manifest.task !== dispatch.task) mismatches.push("task");
		if (manifest.repoRoot !== dispatch.repoRoot) mismatches.push("repository root");
		const currentInstructionSha = sha256CouncilContent(`${JSON.stringify(dispatch.instructions)}\n`);
		if (
			manifest.instructionSnapshot.sha256 !== currentInstructionSha ||
			!sameJson(persistedInstructions, dispatch.instructions)
		) {
			mismatches.push("instruction snapshot");
		}
		if (mismatches.length === 0) return;
		const reasons = mismatches.map(mismatch => RESUME_MISMATCH_SENTENCES[mismatch]).join("; ");
		throw new Error(`Council resume refused: ${reasons}. Start a new run with /council <task>.`);
	}

	async #assertResumePublicationAvailable(manifest: CouncilManifest): Promise<void> {
		if (!this.#storage || !this.snapshot) throw new Error("Council storage is unavailable");
		const finalVersion = manifest.planVersions.find(version => version.kind === "final");
		let expected: { sha256: string; bytes: number } | undefined;
		if (finalVersion) {
			const stored = await this.#storage.readArtifact(finalVersion.artifact);
			const frame = decodeMetadataFrame<PersistedAdjudicationMetadata>(stored, ADJUDICATION_METADATA_MARKER);
			const plan = frame.metadata.adjudication?.plan;
			if (typeof plan !== "string") throw new Error("Council final artifact is missing its adjudicated plan");
			expected = {
				sha256: sha256CouncilContent(plan),
				bytes: Buffer.byteLength(plan),
			};
		}
		const status = await inspectPromisedCouncilPublication(
			await this.#storage.canonicalPlanRoot(),
			manifest.outputPath,
			expected,
		);
		if (status !== "collision") return;
		const error = new Error(
			`Council publication target already exists: ${manifest.outputPath}; rename or remove it, or start a new run.`,
		);
		const now = this.#now();
		this.snapshot.state = "failed";
		this.snapshot.failure = { phase: "publication", reason: error.message, code: "EEXIST", time: now };
		this.snapshot.timestamps.finishedAt = now;
		delete this.snapshot.timestamps.interruptedAt;
		await this.#checkpoint();
		await this.#emitTerminalEvent();
		await this.#sendSummary();
		throw error;
	}

	async #loadInstructionSnapshot(manifest: CouncilManifest): Promise<CouncilInstructionSnapshot> {
		if (!this.#storage) throw new Error("Council storage is unavailable");
		const content = await this.#storage.readArtifact(manifest.instructionSnapshot.artifact);
		const candidate: unknown = JSON.parse(content);
		return parseCouncilInstructionSnapshot(candidate, manifest.repoRoot);
	}

	#applyInstructionSnapshot(dispatch: CouncilDispatchPlan, snapshot: CouncilInstructionSnapshot): void {
		dispatch.instructions = structuredClone(snapshot);
		dispatch.plannerRequest.additionalContextFiles = structuredClone(snapshot.contextFiles);
		for (const request of dispatch.memberRequests) {
			request.additionalContextFiles = structuredClone(snapshot.contextFiles);
		}
	}

	#assertAdjudicationSurface(): void {
		if (!this.#host.toolSession.setCouncilHandler || !this.#host.toolSession.peekCouncilHandler) {
			throw new Error("Council adjudication requires the ToolSession council handler surface");
		}
		if (this.#host.toolSession.peekCouncilHandler()) {
			throw new Error("Another council adjudication handler is already active");
		}
	}

	#now(): string {
		const value = this.#host.now?.() ?? new Date();
		return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
	}

	#buildCoordinatorSnapshot(): CouncilCoordinatorSnapshot | undefined {
		if (!this.snapshot) return undefined;
		return {
			manifest: structuredClone(this.snapshot),
			members: [...this.#liveMembers.values()].map(progress => structuredClone(progress)),
			mainTurnOwned: this.#ownsCurrentMainTurn(),
			...(this.#soloChild ? { soloChild: { ...this.#soloChild } } : {}),
		};
	}

	#emit(): void {
		if (!this.snapshot) return;
		const manifest = structuredClone(this.snapshot);
		try {
			this.#host.onStateChange?.(manifest);
		} catch (error) {
			logger.warn("Council state listener failed", { error: errorText(error) });
		}
		const snapshot = this.#buildCoordinatorSnapshot()!;
		for (const listener of this.#listeners) this.#notifyOne(listener, snapshot);
	}

	#notifyOne(listener: CoordinatorListener, snapshot: CouncilCoordinatorSnapshot): void {
		try {
			listener(structuredClone(snapshot));
		} catch (error) {
			logger.warn("Council coordinator subscriber failed", { error: errorText(error) });
		}
	}

	/**
	 * Hand one immutable run-lifecycle event to the session.
	 *
	 * `SessionManager` is append-only (no update counterpart to `appendCustomMessageEntry`), so a
	 * run's story is a sequence of small durable cards, never one card that grows. Every card
	 * also lands in Main's context, which is why the line is capped and the run carries a hard event
	 * ceiling. Delivery is serialized through `#lifecycleTail` so a cancellation racing a round
	 * checkpoint reads in a deterministic order, and keyed by `{runId, kind, round}` so a duplicate
	 * is a no-op. Content is plain and width-independent; the structured payload rides in `details`.
	 */
	#emitLifecycleEvent(
		kind: CouncilRunEventKind,
		content: string,
		options: { round?: number; stats?: CouncilRunStats } = {},
	): Promise<void> {
		const manifest = this.snapshot;
		if (!manifest) return Promise.resolve();
		const runId = manifest.runId;
		const key = `${runId}:${kind}:${options.round ?? ""}`;
		if (this.#lifecycleKeys.has(key)) return this.#lifecycleTail;
		// Kickoff, a start/settle pair per round, and cancellation. The terminal event names the
		// recovery command, so it is the one event the ceiling never drops.
		const budget = 2 + 2 * Math.max(1, manifest.config.rounds);
		const spent = [...this.#lifecycleKeys].filter(entry => entry.startsWith(`${runId}:`)).length;
		if (kind !== "terminal" && spent >= budget) {
			logger.debug("Council lifecycle event dropped at the run ceiling", { runId, kind });
			return this.#lifecycleTail;
		}
		this.#lifecycleKeys.add(key);
		const sessionId = manifest.sessionId;
		const details = {
			runId,
			eventKind: kind,
			...(options.round === undefined ? {} : { round: options.round }),
			...(this.#storage ? { manifestUrl: this.#storage.artifactUrl(runId, "manifest.json") } : {}),
			...(options.stats ? { stats: options.stats } : {}),
		} satisfies CouncilRunEventPayload;
		const line = content.replace(/\s+/g, " ").trim().slice(0, COUNCIL_RUN_EVENT_CHAR_LIMIT);
		const operation = this.#lifecycleTail.then(async () => {
			try {
				await this.#host.session.sendCustomMessage(
					{ customType: COUNCIL_RUN_MESSAGE_TYPE, display: true, content: line, details },
					{ deliverAs: "nextTurn", expectedSessionId: sessionId },
				);
			} catch (error) {
				logger.warn("Council lifecycle event delivery failed", { error: errorText(error) });
			}
		});
		this.#lifecycleTail = operation.catch(() => {});
		return operation;
	}

	/**
	 * The single durable record of a terminal exit, published or not.
	 *
	 * It carries the `summarizeCouncilRun` projection as data rather than rendered rows, so the card
	 * lays the stats table out at the live frame width, and it is the only producer of the resume
	 * command on the terminal transition. `CouncilController.#emitResumeHint` covers hydration only,
	 * so the two cannot race `showStatus`, whose consecutive lines replace rather than append.
	 */
	async #emitTerminalEvent(): Promise<void> {
		try {
			const manifest = this.snapshot ? structuredClone(this.snapshot) : undefined;
			if (!manifest || !this.#storage) return;
			const load = await loadCouncilAdjudications(this.#storage, manifest);
			// No `adjudicatorAdvisor` here on purpose: this projection is persisted and re-derived from
			// the manifest alone on every rebuild, so a live-session marker would vanish on reload.
			const stats = summarizeCouncilRun(manifest, load.adjudications, {
				adjudicationsUnreadable: load.unreadable,
			});
			const recovery = isCouncilResumableManifest(manifest)
				? `resumable: /council resume ${manifest.runId}`
				: "terminal, start a new run";
			const final = manifest.published ? `local://${manifest.outputPath}` : "not published";
			await this.#emitLifecycleEvent(
				"terminal",
				`Council ${manifest.runId} ${councilStateLabel(manifest.state)}: ${stats.reviewersSucceeded}/${stats.reviewersTotal} reviewers succeeded. Final: ${final}; ${recovery}.`,
				{ stats },
			);
		} catch (error) {
			logger.warn("Council terminal event failed", { error: errorText(error) });
		}
	}

	/** One durable line naming the roster a run is about to spend on, for start and for resume. */
	async #emitKickoffEvent(): Promise<void> {
		const manifest = this.snapshot;
		if (!manifest) return;
		const roster = manifest.roster.filter(member => member.enabled);
		const models = roster
			.map(
				member =>
					`${councilRoleLabel(member.role)}=${member.resolvedModel}${manifest.rounds.length > 1 ? ` r${member.rounds.join(",")}` : ""}`,
			)
			.join(", ");
		const adjudicator = `${manifest.adjudicator.resolvedModel} (${manifest.adjudicator.mode})`;
		await this.#emitLifecycleEvent(
			"kickoff",
			`Council ${manifest.runId} ${this.#resumeExecution ? "resumed" : "started"}: planner ${manifest.planner.resolvedModel}, adjudicator ${adjudicator}, ${roster.length} member(s) [${models}], ${manifest.rounds.length} round(s).`,
		);
	}

	async #sendSummary(): Promise<void> {
		if (
			!this.snapshot ||
			!isCouncilTerminalState(this.snapshot.state) ||
			this.#summarySentFor === this.snapshot.runId
		)
			return;
		const runId = this.snapshot.runId;
		if (this.#summaryDelivery) {
			await this.#summaryDelivery.promise;
			if (this.#summarySentFor !== runId) await this.#sendSummary();
			return;
		}
		const manifest = structuredClone(this.snapshot);
		const promise = this.#deliverSummary(manifest);
		this.#summaryDelivery = { runId, promise };
		try {
			await promise;
		} finally {
			if (this.#summaryDelivery?.promise === promise) this.#summaryDelivery = undefined;
		}
	}

	async #deliverSummary(manifest: CouncilManifest): Promise<void> {
		if (this.#host.sessionManager.getSessionId() !== manifest.sessionId) return;
		const runId = manifest.runId;
		const alreadyPersisted = this.#host.session.messages.some(message => {
			if (message.role !== "custom" || message.customType !== COUNCIL_SUMMARY_MESSAGE_TYPE) return false;
			const details = message.details;
			return Boolean(details && typeof details === "object" && "runId" in details && details.runId === runId);
		});
		if (alreadyPersisted) {
			this.#summarySentFor = runId;
			return;
		}
		const succeeded = manifest.rounds
			.flatMap(round => round.members)
			.filter(member => member.status === "succeeded").length;
		const failed = manifest.rounds
			.flatMap(round => round.members)
			.filter(member => member.status === "failed").length;
		const rawWarnings = [
			...manifest.warnings,
			...(manifest.degraded ? ["Council completed with degradation."] : []),
			...(manifest.failure ? [manifest.failure.reason] : []),
		];
		const warningLimit =
			rawWarnings.length > COUNCIL_SUMMARY_WARNING_COUNT_LIMIT
				? COUNCIL_SUMMARY_WARNING_COUNT_LIMIT - 1
				: COUNCIL_SUMMARY_WARNING_COUNT_LIMIT;
		const boundedWarnings = rawWarnings.slice(0, warningLimit).map(warning =>
			warning
				.replace(/[\u0000-\u001f\u007f]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, COUNCIL_SUMMARY_WARNING_CHAR_LIMIT),
		);
		if (rawWarnings.length > warningLimit) {
			boundedWarnings.push(`${rawWarnings.length - warningLimit} additional warnings omitted.`);
		}
		const warnings = boundedWarnings.filter(Boolean).join(" ");
		const taskPreview = manifest.task.replace(/\s+/g, " ").trim().slice(0, 160);
		// The plan now lives in the session cache, so `local://<outputPath>` is a resolvable URL rather
		// than a repo-relative path the reader would have to interpret.
		const publishedUrl = manifest.published ? `local://${manifest.outputPath}` : undefined;
		// The only place this phrase is produced. The summary card no longer re-derives a `Final:` line
		// of its own, so there is exactly one wording for an unpublished run.
		const finalUrl = publishedUrl ?? "not published";
		const manifestUrl = this.#storage!.artifactUrl(runId, "manifest.json");
		const content = prompt.render(councilSummaryTemplate, {
			outcome: manifest.state,
			taskPreview,
			succeeded,
			failed,
			finalUrl,
			manifestUrl,
			warnings,
			resumeHint: isCouncilResumableManifest(manifest) ? `Resume: /council resume ${runId}` : "",
		});
		try {
			const deliveryReceipt = { delivered: false };
			// Read before the call, not to steer delivery (`deliverAs` stays `nextTurn`, so no
			// mid-stream append can split an assistant/tool-result sequence) but to know which branch
			// took it: streaming queues the copy for the next turn, idle appends it now. Neither
			// repaints, and a stale read only decides whether a redundant live card is mounted, which
			// the run-keyed live handle drops.
			const deferred = this.#host.session.isStreaming;
			const details = { runId, manifestUrl, finalUrl } satisfies CouncilSummaryPayload;
			await this.#host.session.sendCustomMessage(
				{ customType: COUNCIL_SUMMARY_MESSAGE_TYPE, display: true, content, details },
				{ deliverAs: "nextTurn", expectedSessionId: manifest.sessionId, deliveryReceipt },
			);
			if (!deliveryReceipt.delivered) return;
			this.#summarySentFor = runId;
			try {
				this.#host.presentCouncilSummary?.({ runId, deferred, content, details });
			} catch (error) {
				logger.warn("Council summary presentation failed", { error: errorText(error) });
			}
		} catch (error) {
			logger.warn("Council summary delivery failed", { error: errorText(error) });
		}
	}
}

export function getCouncilCoordinator(host: CouncilCoordinatorHost): CouncilCoordinator {
	const sessionId = host.sessionManager.getSessionId();
	const existing = coordinators.get(sessionId);
	if (existing) {
		const sameBinding =
			existing.session === host.session &&
			existing.toolSession === host.toolSession &&
			existing.sessionManager === host.sessionManager;
		if (sameBinding || executingCoordinators.has(existing.coordinator)) return existing.coordinator;
	}
	const coordinator = new CouncilCoordinator(host);
	coordinators.set(sessionId, {
		coordinator,
		session: host.session,
		toolSession: host.toolSession,
		sessionManager: host.sessionManager,
	});
	return coordinator;
}

/**
 * Drop a session's cached coordinator so a later rebind to that session id builds a fresh one over
 * the live `AgentSession`/`ToolSession` pair.
 *
 * Deliberately inert while the run matters: an entry that is still registered active, or still
 * executing, is left alone so an in-flight run keeps its owner. Durable state is untouched either
 * way, so rebinding back rehydrates through `coordinator.status()`.
 */
export function releaseCouncilCoordinator(sessionId: string): void {
	const existing = coordinators.get(sessionId);
	if (!existing) return;
	if (activeCoordinators.get(sessionId) === existing.coordinator) return;
	if (executingCoordinators.has(existing.coordinator)) return;
	coordinators.delete(sessionId);
}

/**
 * Look up the coordinator already bound to `session` under `sessionId`, without ever constructing
 * one.
 *
 * `getCouncilCoordinator` is a get-or-create over a host binding, which is wrong for cleanup and
 * cancellation paths: building an idle coordinator purely to cancel it registers an owner for a
 * session that never ran a council. A binding mismatch is a miss, because the entry then belongs to
 * a different `AgentSession` that must keep its own owner.
 */
export function peekCouncilCoordinatorForSession(
	session: AgentSession,
	sessionId: string,
): CouncilCoordinator | undefined {
	const existing = coordinators.get(sessionId);
	if (!existing || existing.session !== session) return undefined;
	return existing.coordinator;
}

/**
 * Quiesce and release the council bound to a session that is about to change identity or go away.
 *
 * The registry key is captured from the binding itself, not from the session manager's current id:
 * a host that has already advanced its id would otherwise no-op here and strand the old entry with
 * a live council inside it. Capture happens up front because the caller mutates identity
 * afterwards, and releasing under a later id would leave this entry unreachable forever.
 *
 * On a cancellation timeout the entry is deliberately retained and the release deferred to eventual
 * settlement, and the failure is rethrown so an identity-changing transition refuses rather than
 * proceeding with a live council still bound to the old id. A session that never ran a council is a
 * no-op that leaves the registry untouched.
 */
export async function quiesceAndReleaseCouncilForSessionTransition(session: AgentSession): Promise<void> {
	let captured: string | undefined;
	const current = session.sessionManager.getSessionId();
	if (coordinators.get(current)?.session === session) {
		captured = current;
	} else {
		// Diverged or foreign id: the binding is the lookup. Newest registration wins so a lingering
		// stale entry can never shadow the coordinator this session is actually using.
		for (const [key, entry] of coordinators) {
			if (entry.session === session) captured = key;
		}
	}
	if (captured === undefined) return;
	const coordinator = peekCouncilCoordinatorForSession(session, captured);
	if (!coordinator) return;
	try {
		await coordinator.cancelForSessionTransition();
	} catch (error) {
		void coordinator
			.settled()
			.then(() => releaseCouncilCoordinator(captured))
			.catch(releaseError => {
				logger.warn("Council coordinator release after cancellation timeout failed", {
					sessionId: captured,
					error: errorText(releaseError),
				});
			});
		throw error;
	}
	await coordinator.settled();
	releaseCouncilCoordinator(captured);
}

export function resetCouncilCoordinatorsForTests(): void {
	coordinators.clear();
	activeCoordinators.clear();
}
