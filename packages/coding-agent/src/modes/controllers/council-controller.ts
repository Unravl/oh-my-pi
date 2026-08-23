import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { councilRoleLabel } from "../../config/model-roles";
import {
	type CouncilCoordinator,
	type CouncilCoordinatorHost,
	type CouncilCoordinatorSnapshot,
	type CouncilMemberLiveProgress,
	type CouncilSummaryDelivery,
	getCouncilCoordinator,
	releaseCouncilCoordinator,
} from "../../council/coordinator";
import {
	COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
	COUNCIL_PLANNER_PROGRESS_ORDER,
	COUNCIL_PLANNER_PROGRESS_ROUND,
} from "../../council/events";
import {
	type CouncilManifest,
	type CouncilMemberStatus,
	councilStateLabel,
	isCouncilResumableManifest,
	isCouncilTerminalState,
} from "../../council/state";
import { loadCouncilAdjudications, summarizeCouncilRun } from "../../council/stats";
import { createCouncilStorage } from "../../council/storage";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import { previewLine, replaceTabs, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import type {
	CouncilPaneComponent,
	CouncilPaneRowSnapshot,
	CouncilPaneRowStatus,
	CouncilPaneSnapshot,
} from "../components/council-pane";
import { renderCouncilStatsHeader } from "../components/council-stats";
import { SPINNER_RENDER_INTERVAL_MS } from "../components/tool-execution";
import { CouncilTranscriptMirror, type CouncilTranscriptMirrorContext } from "./council-transcript-mirror";

interface CouncilControllerContext extends CouncilTranscriptMirrorContext {
	session: AgentSession;
	councilPane: CouncilPaneComponent;
	readonly planModeEnabled: boolean;
	showError(message: string): void;
	showStatus(message: string, options?: { dim?: boolean }): void;
	presentCouncilSummaryDelivery(delivery: CouncilSummaryDelivery): void;
	ensureCouncilPlanMode(): Promise<{ ok: true } | { ok: false; reason: string }>;
	handlePlanApproval(details: PlanApprovalDetails, options?: { header?: readonly string[] }): Promise<void>;
}

export interface CouncilControllerDependencies {
	getCoordinator?: (host: CouncilCoordinatorHost) => CouncilCoordinator;
}

const COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE = 5;
/** Session-entry marker proving the approval screen already ran (or was deliberately skipped). */
const COUNCIL_PLAN_APPROVED_MESSAGE_TYPE = "council-plan-approved";

function projectCouncilPaneWarnings(manifest: CouncilManifest): string[] {
	const warnings: string[] = [];
	for (const warning of manifest.warnings.slice(0, COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE)) {
		const sanitized = previewLine(replaceTabs(sanitizeText(warning)), TRUNCATE_LENGTHS.CONTENT);
		if (sanitized) warnings.push(sanitized);
	}

	let authFallbackCount = 0;
	for (const councilRound of manifest.rounds) {
		if (authFallbackCount >= COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE) break;
		for (const member of councilRound.members) {
			if (!member.authFallbackUsed) continue;
			const sanitized = previewLine(
				replaceTabs(sanitizeText(`${councilRoleLabel(member.role)} used an authentication fallback`)),
				TRUNCATE_LENGTHS.CONTENT,
			);
			if (sanitized) warnings.push(sanitized);
			authFallbackCount++;
			if (authFallbackCount >= COUNCIL_PANE_WARNING_LIMIT_PER_SOURCE) break;
		}
	}
	return warnings;
}

function durableMemberStatus(status: CouncilMemberStatus, attempts: number): CouncilPaneRowStatus {
	switch (status) {
		case "pending":
			return "queued";
		case "running":
			return attempts > 1 ? "retry" : "running";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
		case "interrupted":
			return "interrupted";
	}
}

function liveMemberStatus(progress: CouncilMemberLiveProgress): CouncilPaneRowStatus {
	if (progress.retryState) return "retry";
	switch (progress.status) {
		case "pending":
			return "queued";
		case "running":
			return "running";
		case "completed":
			return "succeeded";
		case "failed":
			return "failed";
		case "aborted":
			return "interrupted";
	}
}

function plannerStatus(manifest: CouncilManifest): CouncilPaneRowStatus {
	if (manifest.state === "dispatching") return "queued";
	if (manifest.state === "planning") return "running";
	if (manifest.planVersions.some(version => version.kind === "draft")) return "succeeded";
	if (manifest.state === "failed") return "failed";
	if (manifest.state === "cancelling" || manifest.state === "interrupted") return "interrupted";
	return "succeeded";
}

function adjudicatorStatus(manifest: CouncilManifest): CouncilPaneRowStatus {
	switch (manifest.state) {
		case "adjudicating":
			return "running";
		case "awaiting-main":
			// Not queued: Council is blocked on the user's own turn, and the pane says so.
			return "waiting";
		// `publishing`: adjudication is already done while the plan is written, and a `default`
		// branch here used to regress the row from running back to queued for that whole window.
		case "publishing":
		case "completed":
		case "completed-degraded":
			return "succeeded";
		case "cancelling":
		case "interrupted":
			return "interrupted";
		case "failed":
			return manifest.failure?.phase.toLowerCase().includes("planner") === true ? "queued" : "failed";
		case "dispatching":
		case "planning":
		case "reviewing":
		case "round-transition":
			return "queued";
	}
}

function currentRound(manifest: CouncilManifest): CouncilManifest["rounds"][number] | undefined {
	const running = manifest.rounds.find(round => round.status === "running");
	if (running) return running;
	const unresolved = manifest.rounds.find(
		round => !manifest.planVersions.some(version => version.round === round.round),
	);
	return unresolved ?? manifest.rounds.at(-1);
}

/** The `requests`/`tokens`/`cost` triple shared by a live progress sample and a durable bucket. */
interface CouncilRowUsageParts {
	requests?: number;
	tokens?: number;
	cost?: number;
}

/**
 * A row's spend, summed from every source that covers a distinct span of the run.
 *
 * Live telemetry is released the moment an agent settles, so a row sourced from it alone blanked
 * its `req · tok · $` cell exactly when the numbers became final. The durable buckets carry that
 * spend instead, and both `plannerUsage` and `adjudicatorUsage` accumulate across every turn
 * charged to the role, so a second adjudication round must be added to the first rather than
 * replacing it.
 *
 * Whether a source may be summed depends on the order the coordinator uses, which differs by role:
 * the planner and both adjudicator modes drop the live row *before* charging the durable bucket
 * (`#stopMainTelemetry` and `#clearAdjudicatorTelemetry` precede the charge), so live and durable
 * are disjoint and summing them is exact. A member is charged first and dropped after, so its two
 * sources overlap for one round; the reviewer path never sums them for the same round.
 *
 * All parts absent yields an empty triple, which keeps a queued row's cell blank rather than
 * printing `0 req · 0 tok · $0`.
 */
function mergeRowUsage(parts: readonly (CouncilRowUsageParts | undefined)[]): CouncilRowUsageParts {
	let present = false;
	let requests = 0;
	let tokens = 0;
	let cost = 0;
	for (const part of parts) {
		if (!part) continue;
		if (part.requests === undefined && part.tokens === undefined && part.cost === undefined) continue;
		present = true;
		requests += part.requests ?? 0;
		tokens += part.tokens ?? 0;
		cost += part.cost ?? 0;
	}
	return present ? { requests, tokens, cost } : {};
}

/** Convert the durable manifest plus bounded live telemetry into an immutable pane projection. */
export function projectCouncilPaneSnapshot(
	snapshot: CouncilCoordinatorSnapshot,
	options: { adjudicatorAdvisor?: boolean } = {},
): CouncilPaneSnapshot {
	const manifest = snapshot.manifest;
	const round = currentRound(manifest);
	const plannerState = plannerStatus(manifest);
	const adjudicatorState = adjudicatorStatus(manifest);
	const delegated = manifest.adjudicator.mode === "delegated";
	// The planner files its telemetry under reserved out-of-band coordinates, so its row is filled from
	// live progress exactly like a member row. Without this the Planner row showed no activity at all.
	const plannerLive = snapshot.members.find(
		progress =>
			progress.round === COUNCIL_PLANNER_PROGRESS_ROUND && progress.order === COUNCIL_PLANNER_PROGRESS_ORDER,
	);
	// In `main` mode the adjudicator is not a child agent, so its spend is sampled by the coordinator
	// from the same message slice it bills at turn end; in `delegated` mode the child's own progress
	// events land under the same reserved order.
	const adjudicatorLive = snapshot.members.find(
		progress =>
			progress.round === COUNCIL_PLANNER_PROGRESS_ROUND && progress.order === COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
	);
	const reviewers: CouncilPaneRowSnapshot[] = [];
	for (const rosterMember of [...manifest.roster].sort((left, right) => left.order - right.order)) {
		// Resolve each reviewer against a round it actually serves — preferring the current one — so a
		// round-2 reviewer is not reported as `queued` for the whole of round 1 and a round-1 reviewer
		// keeps its settled outcome on screen through round 2.
		const ownRound =
			round && rosterMember.rounds.includes(round.round)
				? round
				: manifest.rounds.findLast(candidate => rosterMember.rounds.includes(candidate.round));
		const record = ownRound?.members.find(member => member.order === rosterMember.order);
		const live = snapshot.members.find(
			progress => progress.round === ownRound?.round && progress.order === rosterMember.order,
		);
		const status = live
			? liveMemberStatus(live)
			: record
				? durableMemberStatus(record.status, record.attempts)
				: "queued";
		// The live sample owns the round it is running; every other round this reviewer served
		// contributes its durable bucket. Splitting on round rather than on `live ?? record` keeps the
		// sum exact across the checkpoint-then-drop window, where both briefly exist for one round.
		const usage = mergeRowUsage([
			...manifest.rounds
				.filter(candidate => candidate.round !== ownRound?.round)
				.map(candidate => candidate.members.find(member => member.order === rosterMember.order)?.usage),
			live ?? record?.usage,
		]);
		reviewers.push({
			key: `member:${rosterMember.order}:${rosterMember.role}`,
			label: councilRoleLabel(rosterMember.role),
			// The pinned roster identity, never the record's runtime model: that one carries the
			// resolved thinking selector (`…:xhigh`), which the effort column already owns.
			model: rosterMember.resolvedModel,
			effort: rosterMember.effort,
			advisor: rosterMember.advisor,
			rounds: [...rosterMember.rounds],
			status,
			attempts: Math.max(record?.attempts ?? 0, live?.attempt ?? 0),
			lastIntent: live?.lastIntent,
			currentTool: live?.currentTool,
			currentToolArgs: live?.currentToolArgs,
			recentOutput: live?.recentOutput,
			...usage,
			error: record?.failureReason ?? live?.retryState?.errorMessage,
		});
	}

	// Fixed reading order: the plan is drafted, reviewed, then judged. Rows never move, so a
	// settling agent stays where the operator last looked for it.
	const rows: CouncilPaneRowSnapshot[] = [
		{
			key: "planner",
			label: "Planner",
			model: manifest.planner.resolvedModel,
			effort: manifest.planner.effort,
			advisor: manifest.planner.advisor,
			status: plannerLive && plannerState === "running" ? liveMemberStatus(plannerLive) : plannerState,
			attempts: plannerState === "queued" ? 0 : Math.max(1, plannerLive?.attempt ?? 0),
			lastIntent: plannerLive?.lastIntent,
			currentTool: plannerLive?.currentTool,
			currentToolArgs: plannerLive?.currentToolArgs,
			recentOutput: plannerLive?.recentOutput,
			...mergeRowUsage([manifest.plannerUsage, plannerLive]),
			error:
				manifest.failure?.phase.toLowerCase().includes("planner") === true
					? manifest.failure.reason
					: plannerLive?.retryState?.errorMessage,
		},
		...reviewers,
		{
			key: "adjudicator",
			label: "Adjudicator",
			model: manifest.adjudicator.resolvedModel,
			effort: manifest.adjudicator.effort,
			// A delegated adjudicator's advisor is durable; a main-mode one follows the live session,
			// which only the caller can observe.
			advisor: delegated ? manifest.adjudicator.advisor : options.adjudicatorAdvisor === true,
			// A delegated adjudicator reports through its own child progress, so its live status wins
			// over the run-state derivation the in-session path depends on.
			status: delegated && adjudicatorLive ? liveMemberStatus(adjudicatorLive) : adjudicatorState,
			attempts: delegated
				? Math.max(manifest.adjudicator.agentIds?.length ?? 0, adjudicatorLive?.attempt ?? 0)
				: adjudicatorState === "queued"
					? 0
					: 1,
			lastIntent: delegated
				? adjudicatorLive?.lastIntent
				: adjudicatorState === "waiting"
					? "Council resumes when your current turn ends."
					: undefined,
			currentTool: delegated ? adjudicatorLive?.currentTool : undefined,
			currentToolArgs: delegated ? adjudicatorLive?.currentToolArgs : undefined,
			recentOutput: delegated ? adjudicatorLive?.recentOutput : undefined,
			...mergeRowUsage([manifest.adjudicatorUsage, adjudicatorLive]),
			error:
				manifest.failure && !manifest.failure.phase.toLowerCase().includes("planner")
					? manifest.failure.reason
					: undefined,
		},
	];

	const warnings = projectCouncilPaneWarnings(manifest);
	return {
		runId: manifest.runId,
		state: manifest.state,
		round: round?.round ?? 0,
		totalRounds: manifest.config.rounds,
		startedAt: manifest.timestamps.startedAt ?? manifest.timestamps.createdAt,
		outputPath: manifest.outputPath,
		warnings,
		failure: manifest.failure?.reason,
		usage: {
			requests: manifest.usage.requests,
			tokens: manifest.usage.tokens,
			cost: manifest.usage.cost,
		},
		rows,
		terminal: isCouncilTerminalState(manifest.state),
	};
}

/** Session-scoped bridge between Council orchestration and the anchored live pane. */
export class CouncilController {
	readonly #ctx: CouncilControllerContext;
	readonly #getCoordinator: (host: CouncilCoordinatorHost) => CouncilCoordinator;
	#coordinator: CouncilCoordinator | undefined;
	#snapshot: CouncilCoordinatorSnapshot | undefined;
	#unsubscribe: (() => void) | undefined;
	#inputUnsubscribe: (() => void) | undefined;
	#boundSessionId: string | undefined;
	#bindingGeneration = 0;
	#tickTimer: NodeJS.Timeout | undefined;
	/** Cadence of the live timer, so a cadence change restarts it instead of being ignored. */
	#tickIntervalMs = 0;
	#cancelRequested = false;
	#cancelPromise: Promise<void> | undefined;
	#disposed = false;
	readonly #mirror: CouncilTranscriptMirror;
	/**
	 * Run ids observed in a **non-terminal** snapshot. The plan-approval trigger is transition-gated on
	 * this set, never on state alone: `coordinator.status()` re-emits a full terminal snapshot on every
	 * hydration, so a state-only condition would pop the approval overlay — and abort the operator's
	 * in-flight turn — on every `omp --continue` startup and every switch back into a finished run.
	 */
	readonly #observedActive = new Set<string>();
	/** Run ids whose resume hint has already been surfaced, so it is said once per run. */
	readonly #resumeHinted = new Set<string>();
	#approvalInFlight = false;

	constructor(ctx: CouncilControllerContext, dependencies: CouncilControllerDependencies = {}) {
		this.#ctx = ctx;
		this.#getCoordinator = dependencies.getCoordinator ?? getCouncilCoordinator;
		// The mirror renders a council child's turns with Main's own components, so it takes the
		// live context directly rather than a copy: `toolOutputExpanded` and thinking visibility are
		// getters that must stay current across Ctrl+O / Ctrl+T while a child streams.
		this.#mirror = new CouncilTranscriptMirror(ctx);
	}

	attach(): void {
		if (this.#disposed) return;
		if (!this.#inputUnsubscribe) {
			this.#inputUnsubscribe = this.#ctx.ui.addInputListener(data =>
				this.#ctx.councilPane.handleInput(data) ? { consume: true } : undefined,
			);
		}
		this.rebindForSession();
	}

	rebindForSession(): void {
		if (this.#disposed) return;
		const sessionId = this.#ctx.sessionManager.getSessionId();
		if (this.#boundSessionId === sessionId && this.#unsubscribe) return;

		const generation = ++this.#bindingGeneration;
		this.#unsubscribe?.();
		// Drop the previous session's cached coordinator so a later rebind rebuilds one over the live
		// session pair. Durable state is untouched, so rebinding back rehydrates through `status()`.
		if (this.#boundSessionId) releaseCouncilCoordinator(this.#boundSessionId);
		this.#unsubscribe = undefined;
		this.#boundSessionId = undefined;
		this.#coordinator = undefined;
		this.#snapshot = undefined;
		this.#cancelPromise = undefined;
		this.#cancelRequested = false;
		this.#approvalInFlight = false;
		this.#mirror.dispose();
		this.#stopTicker();
		this.#ctx.councilPane.update(undefined);

		let toolSession: ToolSession;
		try {
			toolSession = this.#ctx.session.getToolSession();
		} catch (error) {
			// Unit/headless sessions may be intentionally constructed without mounted
			// tools. Production interactive sessions always provide the live instance.
			logger.debug("Council TUI unavailable without ToolSession", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		const coordinator = this.#getCoordinator({
			session: this.#ctx.session,
			toolSession,
			sessionManager: this.#ctx.sessionManager,
			settings: this.#ctx.settings,
			modelRegistry: this.#ctx.session.modelRegistry,
			presentCouncilSummary: delivery => this.#ctx.presentCouncilSummaryDelivery(delivery),
		});
		this.#coordinator = coordinator;
		this.#boundSessionId = sessionId;
		this.#unsubscribe = coordinator.subscribe(snapshot => {
			if (!this.#stillBound(generation, sessionId, coordinator)) return;
			this.updatePane(snapshot);
		});
		void coordinator
			.status()
			.then(() => {
				if (!this.#stillBound(generation, sessionId, coordinator)) return;
				// `CouncilPaneComponent.render` correctly returns nothing for a terminal snapshot, so a
				// session restored with an interrupted run would otherwise say nothing at all about it.
				return coordinator.resumableStatus().then(resumable => {
					if (!this.#stillBound(generation, sessionId, coordinator) || !resumable) return;
					this.#emitResumeHint(resumable);
				});
			})
			.catch(error => {
				if (!this.#stillBound(generation, sessionId, coordinator)) return;
				logger.debug("Council status hydration failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	#stillBound(generation: number, sessionId: string, coordinator: CouncilCoordinator): boolean {
		return (
			!this.#disposed &&
			generation === this.#bindingGeneration &&
			this.#boundSessionId === sessionId &&
			this.#coordinator === coordinator
		);
	}

	/**
	 * Name the recovery command for a run that was **already** terminal when this session bound to it.
	 *
	 * Hydration only. The live terminal transition is covered by the coordinator's durable
	 * `council-run` terminal event, which is append-only and therefore cannot be overwritten; a second
	 * producer here would race `showStatus`, whose consecutive lines replace rather than append.
	 */
	#emitResumeHint(manifest: CouncilManifest): void {
		if (!isCouncilResumableManifest(manifest) || this.#resumeHinted.has(manifest.runId)) return;
		this.#resumeHinted.add(manifest.runId);
		const phase = manifest.failure?.phase ?? manifest.state;
		this.#ctx.showStatus(
			`Council ${manifest.runId} ${councilStateLabel(manifest.state)} at ${phase}; /council resume ${manifest.runId} to continue.`,
		);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#bindingGeneration++;
		const boundSessionId = this.#boundSessionId;
		this.#unsubscribe?.();
		// Same contract as `rebindForSession`: the TUI is giving up this binding, so drop the cached
		// coordinator too. `releaseCouncilCoordinator` is inert while the entry is registered active
		// or still executing, so a live run keeps its owner.
		if (boundSessionId) releaseCouncilCoordinator(boundSessionId);
		this.#unsubscribe = undefined;
		this.#boundSessionId = undefined;
		this.#coordinator = undefined;
		this.#inputUnsubscribe?.();
		this.#inputUnsubscribe = undefined;
		this.#mirror.dispose();
		this.#stopTicker();
		this.#snapshot = undefined;
		this.#cancelRequested = false;
		this.#cancelPromise = undefined;
		this.#ctx.councilPane.update(undefined);
	}

	/**
	 * The chat transcript was cleared under a live mirror: settle its mounted blocks so no detached
	 * tool card keeps animating, and let the next child event re-open the phase.
	 */
	notifyTranscriptReset(): void {
		this.#mirror.resetTranscript();
	}

	hasActiveCouncil(): boolean {
		if (this.#coordinator?.executionInFlight) return true;
		const manifest = this.#snapshot?.manifest;
		return manifest !== undefined && !isCouncilTerminalState(manifest.state);
	}

	isCouncilAdjudicating(): boolean {
		return !this.#cancelRequested && this.#snapshot?.mainTurnOwned === true;
	}

	cancelCouncilRun(): boolean {
		const coordinator = this.#coordinator;
		if (!this.hasActiveCouncil() || this.#cancelPromise || !coordinator) return false;
		const generation = this.#bindingGeneration;
		this.#cancelRequested = true;
		// Draining children and Main's turn can take seconds; without this, Esc looks like a no-op.
		this.#ctx.showStatus("Cancelling council run…");
		const cancellation = coordinator.cancelForSessionTransition();
		this.#cancelPromise = cancellation;
		void cancellation
			.catch(error => {
				if (generation !== this.#bindingGeneration || this.#coordinator !== coordinator) return;
				this.#ctx.showError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (generation !== this.#bindingGeneration || this.#coordinator !== coordinator) return;
				this.#cancelRequested = false;
				this.#cancelPromise = undefined;
			});
		return true;
	}

	/**
	 * Settle Council before the owning AgentSession changes identity or storage.
	 * Reuses an in-flight UI cancellation so transitions have one bounded wait.
	 */
	async quiesceForSessionTransition(): Promise<void> {
		if (this.#cancelPromise) {
			await this.#cancelPromise;
			return;
		}
		if (!this.hasActiveCouncil() || !this.cancelCouncilRun()) return;
		await this.#cancelPromise;
	}

	setPaneExpanded(expanded: boolean): void {
		this.#ctx.councilPane.setExpanded(expanded);
	}

	togglePaneExpanded(): boolean {
		return this.#ctx.councilPane.toggleExpanded();
	}

	updatePane(snapshot: CouncilCoordinatorSnapshot): void {
		if (this.#disposed) return;
		const previous = this.#snapshot;
		this.#snapshot = snapshot;
		const manifest = snapshot.manifest;
		const terminal = isCouncilTerminalState(manifest.state);
		if (terminal) this.#cancelRequested = false;
		if (!terminal) this.#observedActive.add(manifest.runId);
		// Live session state, not manifest state: the operator can toggle the advisor mid-run.
		this.#ctx.councilPane.update(
			projectCouncilPaneSnapshot(snapshot, { adjudicatorAdvisor: this.#adjudicatorAdvisorActive() }),
		);
		this.#mirror.sync(snapshot);
		this.#syncTicker();
		if (!terminal) return;
		if (previous && isCouncilTerminalState(previous.manifest.state) && previous.manifest.runId === manifest.runId) {
			return;
		}
		if (manifest.state === "interrupted" || manifest.state === "failed") return;
		// An agent-convened run answers the tool that asked for it; its brief was never a plan-review
		// candidate, so offering the operator an approval screen would hijack a turn nobody asked to
		// spend. The pane, cards, and stats still render exactly as for a `/council` run.
		if (manifest.origin === "agent") return;
		if (manifest.published) void this.#triggerPlanApproval(manifest);
	}

	/**
	 * Whether a live advisor watches Main's turns, so the adjudicator row can say so. Guarded:
	 * headless and unit sessions may not mount the advisor runtime at all.
	 */
	#adjudicatorAdvisorActive(): boolean {
		try {
			return this.#ctx.session.isAdvisorActive();
		} catch {
			return false;
		}
	}

	/**
	 * Open the plan-review overlay on a run that finished **in this binding**.
	 *
	 * Gated on `#observedActive` rather than terminal state: `status()` re-emits a terminal snapshot on
	 * every hydration, and `handlePlanApproval` aborts the operator's in-flight turn, so a state-only
	 * condition would hijack every startup into a finished session.
	 */
	async #triggerPlanApproval(manifest: CouncilManifest): Promise<void> {
		if (this.#approvalInFlight || !this.#observedActive.has(manifest.runId)) return;
		const generation = this.#bindingGeneration;
		const sessionId = this.#boundSessionId;
		const coordinator = this.#coordinator;
		if (!coordinator || sessionId === undefined) return;
		if (this.#approvalAlreadyRecorded(manifest.runId)) return;
		this.#approvalInFlight = true;
		try {
			// `completion` is undefined on a `status()`-hydrated coordinator, so this is defensive rather
			// than required: when a live run *is* settling, wait for it before touching plan mode.
			const settle = coordinator.completion;
			if (settle) await settle.catch(() => {});
			if (!this.#stillBound(generation, sessionId, coordinator)) return;
			await this.#presentCouncilPlanApproval(manifest, generation, sessionId, coordinator);
		} catch (error) {
			logger.warn("Council plan approval failed", {
				runId: manifest.runId,
				error: error instanceof Error ? error.message : String(error),
			});
			if (this.#stillBound(generation, sessionId, coordinator)) {
				this.#ctx.showError(
					`Council plan approval could not be opened: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} finally {
			this.#approvalInFlight = false;
		}
	}

	/** Mirrors `#deliverSummary`'s dedupe so a restart mid-approval does not reopen the overlay. */
	#approvalAlreadyRecorded(runId: string): boolean {
		return this.#ctx.session.messages.some(message => {
			if (message.role !== "custom" || message.customType !== COUNCIL_PLAN_APPROVED_MESSAGE_TYPE) return false;
			const details = message.details;
			return Boolean(details && typeof details === "object" && "runId" in details && details.runId === runId);
		});
	}

	async #recordApprovalMarker(runId: string): Promise<void> {
		try {
			await this.#ctx.session.sendCustomMessage({
				customType: COUNCIL_PLAN_APPROVED_MESSAGE_TYPE,
				display: false,
				content: `Council ${runId} plan approval presented.`,
				details: { runId },
			});
		} catch (error) {
			logger.warn("Council plan approval marker not recorded", {
				runId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #presentCouncilPlanApproval(
		manifest: CouncilManifest,
		generation: number,
		sessionId: string,
		coordinator: CouncilCoordinator,
	): Promise<void> {
		// Plan mode is entered here, at completion — never at command start. Plan mode is not
		// tool-scoped: its reminder is prepended to every turn and its settle policy forces an extra
		// required-tool continuation, which would corrupt Main's adjudication turns mid-council.
		const planMode = await this.#ctx.ensureCouncilPlanMode();
		if (!this.#stillBound(generation, sessionId, coordinator)) return;
		const planUrl = `local://${manifest.outputPath}`;
		if (!planMode.ok) {
			this.#ctx.showStatus(
				`Council plan written to ${planUrl} — approval screen skipped because ${planMode.reason}. Run /plan-review after enabling plan mode.`,
			);
			await this.#recordApprovalMarker(manifest.runId);
			return;
		}
		let header: readonly string[] = [];
		try {
			const toolSession = this.#ctx.session.getToolSession();
			// One catch site for U44: `loadCouncilAdjudications` degrades a corrupt read to an empty map
			// and reports it, so the overlay says "dispositions unreadable" instead of silently
			// showing a findings-only table.
			const load = await loadCouncilAdjudications(createCouncilStorage(toolSession), manifest);
			if (!this.#stillBound(generation, sessionId, coordinator)) return;
			header = renderCouncilStatsHeader(
				summarizeCouncilRun(manifest, load.adjudications, {
					adjudicationsUnreadable: load.unreadable,
					adjudicatorAdvisor: this.#adjudicatorAdvisorActive(),
				}),
				Math.max(40, this.#ctx.ui.terminal.columns || 80),
			);
		} catch (error) {
			logger.debug("Council stats header unavailable", {
				runId: manifest.runId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		if (!this.#stillBound(generation, sessionId, coordinator)) return;
		await this.#recordApprovalMarker(manifest.runId);
		if (!this.#stillBound(generation, sessionId, coordinator)) return;
		const stem = manifest.outputPath.replace(/^council-/, "").replace(/-plan\.md$/, "");
		await this.#ctx.handlePlanApproval({ planFilePath: planUrl, title: stem, planExists: true }, { header });
	}

	/**
	 * Spinner cadence while a child is actually running, wall-clock elapsed otherwise, so
	 * the pane's animated icons stay in lockstep with every other spinner on screen
	 * without repainting 12x a second through a quiet round transition.
	 */
	#syncTicker(): void {
		if (!this.hasActiveCouncil()) {
			this.#stopTicker();
			return;
		}
		const interval = this.#ctx.councilPane.snapshot?.rows.some(row => row.status === "running")
			? SPINNER_RENDER_INTERVAL_MS
			: 1_000;
		if (this.#tickTimer && this.#tickIntervalMs === interval) return;
		this.#stopTicker();
		this.#tickIntervalMs = interval;
		this.#tickTimer = setInterval(() => this.#ctx.councilPane.tick(), interval);
		this.#tickTimer.unref?.();
	}

	#stopTicker(): void {
		if (!this.#tickTimer) return;
		clearInterval(this.#tickTimer);
		this.#tickTimer = undefined;
		this.#tickIntervalMs = 0;
	}
}
