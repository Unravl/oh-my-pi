import { councilRoleLabel } from "../config/model-roles";
import type { StructuredSubagentResult } from "../task/structured-subagent";
import { COUNCIL_DISPOSITIONS, type CouncilAdjudication, type CouncilDisposition, type CouncilGrade } from "./schema";
import type { CouncilManifest, CouncilRunState, CouncilUsage } from "./state";

/** Warning rows a stats box will ever show; the tail is reported as a count. */
export const COUNCIL_STATS_WARNING_LIMIT = 8;
const COUNCIL_STATS_WARNING_CHAR_LIMIT = 300;

export type CouncilRoleKind = "planner" | "reviewer" | "adjudicator";

export type CouncilDispositionTally = Record<CouncilDisposition, number>;

export interface CouncilRoleStats {
	/** Stable identity: `planner`, `adjudicator`, or the roster role name. */
	key: string;
	label: string;
	kind: CouncilRoleKind;
	model: string;
	effort: string | null;
	/** Whether a live advisor watched this role's turns; rendered as a `++` model suffix. */
	advisor?: boolean;
	/** Configured rounds a reviewer served; absent for the planner and the adjudicator. */
	rounds?: readonly number[];
	/**
	 * Adjudicator rank for this reviewer's whole contribution, or `F` when it never finished. Absent
	 * for the planner and the adjudicator, and for a run adjudicated before grading existed.
	 */
	grade?: CouncilGrade | "F";
	/** Total attempts across every round, schema retries included. */
	attempts: number;
	status: string;
	usage: CouncilUsage;
	/** Findings this role raised across every round. */
	findings: number;
	/** How the adjudicator disposed of this role's findings, summed per round from that round's own adjudication. */
	dispositions: CouncilDispositionTally;
}

export interface CouncilRunStats {
	runId: string;
	state: CouncilRunState;
	degraded: boolean;
	rounds: number;
	reviewersSucceeded: number;
	reviewersTotal: number;
	outputPath: string;
	/**
	 * Wall-clock span of the whole run: launch to settle. Derived from the manifest alone, so a
	 * persisted card and a live recompute always agree. Absent when neither endpoint parses.
	 */
	durationMs?: number;
	/**
	 * Summed from the per-role buckets, so it visibly includes the adjudicator. This is deliberately
	 * not a copy of `manifest.usage`: a manifest written before per-role accounting has no
	 * `plannerUsage`, `adjudicatorUsage`, or `member.usage`, and reporting the aggregate beside empty
	 * rows would look like a bookkeeping error rather than missing history.
	 */
	total: CouncilUsage;
	roles: CouncilRoleStats[];
	warnings: string[];
	/**
	 * True only when this run raised findings **and** the adjudication read threw. An empty
	 * disposition map is not corruption: a run with zero findings, or a round Main has not judged
	 * yet, legitimately has nothing to report. Optional so a caller that never attempted the read
	 * leaves the segment off rather than claiming the artifacts are fine.
	 */
	dispositionsUnavailable?: boolean;
}
/** A fresh zero ledger. Every council usage bucket starts here, in the run and in a consult. */
export function zeroCouncilUsage(): CouncilUsage {
	return { requests: 0, tokens: 0, cost: 0 };
}

/**
 * A settled council child's charge, with its attached advisor folded in.
 *
 * The advisor runs its own model on its own ledger and never reaches the child's `requests`/`tokens`,
 * so every council surface that reports spend has to fold it the same way — otherwise the `++`
 * marker beside a role has no number behind it, and the aggregate stops reconciling with the
 * per-role buckets. One definition, used by the durable run and by a consult.
 */
export function councilChildUsage(result: StructuredSubagentResult): CouncilUsage {
	const child = result.result;
	const advisor = child.advisorUsage;
	const rawCost = child.usage?.cost;
	const cost =
		typeof rawCost === "number"
			? rawCost
			: typeof rawCost?.total === "number" && Number.isFinite(rawCost.total)
				? rawCost.total
				: 0;
	return {
		requests: child.requests + (advisor?.requests ?? 0),
		tokens: child.tokens + (advisor?.tokens ?? 0),
		cost: Math.max(0, Number.isFinite(cost) ? cost : 0) + (advisor?.cost ?? 0),
	};
}

function emptyTally(): CouncilDispositionTally {
	const tally = {} as CouncilDispositionTally;
	for (const disposition of COUNCIL_DISPOSITIONS) tally[disposition] = 0;
	return tally;
}

function addUsage(target: CouncilUsage, source: CouncilUsage | undefined): void {
	if (!source) return;
	target.requests += source.requests;
	target.tokens += source.tokens;
	target.cost += source.cost;
}

/** Collapse a role's per-round member statuses into one word the operator can act on. */
function reviewerStatus(statuses: readonly string[]): string {
	if (statuses.length === 0) return "pending";
	if (statuses.includes("failed")) return "failed";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("interrupted") || statuses.includes("cancelled")) return "interrupted";
	if (statuses.every(status => status === "succeeded")) return "succeeded";
	return statuses.at(-1) ?? "pending";
}

function plannerStatus(manifest: CouncilManifest): string {
	if (manifest.planVersions.some(version => version.kind === "draft")) return "succeeded";
	if (manifest.state === "planning") return "running";
	if (manifest.state === "failed" && manifest.failure?.phase.startsWith("planner")) return "failed";
	if (manifest.state === "interrupted") return "interrupted";
	return "pending";
}

/**
 * Exhaustive over `CouncilRunState` on purpose: a `default` arm silently demoted the adjudicator to
 * `pending` the moment a new state landed, which is exactly how the `publishing` window would have
 * made a finished adjudication look like it had never started.
 */
function adjudicatorStatus(manifest: CouncilManifest): string {
	switch (manifest.state) {
		case "completed":
		case "completed-degraded":
		// Adjudication is already done while the plan is being written out.
		case "publishing":
			return "succeeded";
		case "adjudicating":
		case "awaiting-main":
			return "running";
		case "failed":
			return manifest.failure?.phase.startsWith("planner") === true ? "pending" : "failed";
		case "interrupted":
			return "interrupted";
		case "dispatching":
		case "planning":
		case "reviewing":
		case "round-transition":
		case "cancelling":
			return "pending";
	}
}

function boundedWarnings(manifest: CouncilManifest): string[] {
	const raw: string[] = [...manifest.warnings];
	if (manifest.failure) raw.push(`${manifest.failure.phase}: ${manifest.failure.reason}`);
	for (const round of manifest.rounds) {
		for (const member of round.members) {
			const label = councilRoleLabel(member.role);
			if (member.authFallbackUsed) raw.push(`${label} used an authentication fallback`);
			if (member.failureReason) raw.push(`${label} round ${round.round}: ${member.failureReason}`);
		}
	}
	const shown = raw
		.slice(0, COUNCIL_STATS_WARNING_LIMIT)
		.map(warning => warning.slice(0, COUNCIL_STATS_WARNING_CHAR_LIMIT))
		.filter(Boolean);
	if (raw.length > COUNCIL_STATS_WARNING_LIMIT) {
		shown.push(`${raw.length - COUNCIL_STATS_WARNING_LIMIT} more warnings`);
	}
	return shown;
}

export interface CouncilRunStatsOptions {
	/**
	 * Set by whoever owns the `readAdjudications` call when that read **threw**. It is not inferable
	 * from an empty `adjudications` map: a run with no findings, and a round Main has not judged yet,
	 * both hand over an empty map while being perfectly healthy.
	 */
	adjudicationsUnreadable?: boolean;
	/**
	 * Live-session marker for a `mode: "main"` adjudicator **only**, which follows the global
	 * `advisor.enabled` and is therefore unknowable from the manifest. It is ignored for a delegated
	 * adjudicator, whose marker is durable on `manifest.adjudicator.advisor`.
	 */
	adjudicatorAdvisor?: boolean;
}

/**
 * Pure projection of a finished (or interrupted) council run into a per-role cost and outcome table.
 *
 * The result is plain JSON — no functions, no width-baked or ANSI-styled strings — so a durable
 * lifecycle card can persist it verbatim and re-render it at the live terminal width later.
 *
 * `adjudications` is keyed by round rather than by plan version because a round-two adjudication
 * legitimately carries **only** round-two dispositions: tallying every round's findings against the
 * final adjudication alone would drop every round-one disposition. A round with no readable
 * adjudication simply contributes no dispositions — findings are still counted — so a corrupt or
 * absent artifact degrades the table instead of failing the approval screen.
 */
export function summarizeCouncilRun(
	manifest: CouncilManifest,
	adjudications: ReadonlyMap<number, CouncilAdjudication> = new Map(),
	options: CouncilRunStatsOptions = {},
): CouncilRunStats {
	// A duplicate is not an outcome of its own: it says "another finding already covered this", so it
	// inherits whatever the canonical finding got. Finding ids are globally unique across rounds (the
	// slot prefix folds in the round), and a duplicate may target a *previous* round's finding, so
	// canonical dispositions are indexed run-wide rather than per round.
	const canonicalById = new Map<string, CouncilDisposition>();
	for (const adjudication of adjudications.values()) {
		for (const disposition of adjudication.dispositions) {
			if (disposition.disposition !== "duplicate") canonicalById.set(disposition.id, disposition.disposition);
		}
	}
	const dispositionByRoundAndId = new Map<string, CouncilDisposition>();
	for (const [round, adjudication] of adjudications) {
		for (const disposition of adjudication.dispositions) {
			const resolved =
				disposition.disposition === "duplicate" && disposition.duplicateOf
					? canonicalById.get(disposition.duplicateOf)
					: disposition.disposition;
			dispositionByRoundAndId.set(`${round}:${disposition.id}`, resolved ?? disposition.disposition);
		}
	}
	// The newest graded round wins: a round-two grade supersedes the same reviewer's round-one grade.
	const gradeBySlot = new Map<number, CouncilGrade>();
	for (const round of [...adjudications.keys()].sort((left, right) => left - right)) {
		for (const grade of adjudications.get(round)?.grades ?? []) gradeBySlot.set(grade.slot, grade.grade);
	}

	const roles: CouncilRoleStats[] = [
		{
			key: "planner",
			label: "Planner",
			kind: "planner",
			model: manifest.planner.resolvedModel,
			effort: manifest.planner.effort,
			advisor: manifest.planner.advisor,
			attempts: plannerStatus(manifest) === "pending" ? 0 : 1,
			status: plannerStatus(manifest),
			usage: manifest.plannerUsage ? { ...manifest.plannerUsage } : { requests: 0, tokens: 0, cost: 0 },
			findings: 0,
			dispositions: emptyTally(),
		},
	];

	let reviewersSucceeded = 0;
	let reviewersTotal = 0;
	for (const [slotIndex, rosterMember] of [...manifest.roster]
		.sort((left, right) => left.order - right.order)
		.entries()) {
		const usage: CouncilUsage = { requests: 0, tokens: 0, cost: 0 };
		const dispositions = emptyTally();
		const statuses: string[] = [];
		let attempts = 0;
		let findings = 0;
		for (const round of manifest.rounds) {
			const record = round.members.find(member => member.order === rosterMember.order);
			if (!record) continue;
			statuses.push(record.status);
			attempts += record.attempts;
			findings += record.findingIds.length;
			addUsage(usage, record.usage);
			for (const findingId of record.findingIds) {
				const disposition = dispositionByRoundAndId.get(`${round.round}:${findingId}`);
				if (disposition) dispositions[disposition]++;
			}
		}
		const status = reviewerStatus(statuses);
		// One roster member, one reviewer. Counting inside the round loop above reported a two-round
		// run with three passing members as `6/6`, which reads as six distinct reviewers.
		reviewersTotal++;
		if (status === "succeeded") reviewersSucceeded++;
		roles.push({
			key: rosterMember.role,
			label: councilRoleLabel(rosterMember.role),
			kind: "reviewer",
			// The pinned roster identity, never the round record's runtime model: that one carries the
			// resolved thinking selector (`…:xhigh`), which the effort column already owns.
			model: rosterMember.resolvedModel,
			effort: rosterMember.effort,
			advisor: rosterMember.advisor,
			rounds: [...rosterMember.rounds],
			// `F` is the harness's own verdict on a reviewer that never finished: the adjudicator only
			// ever grades a submitted report, so it cannot express "did not deliver".
			grade: status === "succeeded" ? gradeBySlot.get(slotIndex + 1) : "F",
			attempts,
			status,
			usage,
			findings,
			dispositions,
		});
	}

	const delegated = manifest.adjudicator.mode === "delegated";
	roles.push({
		key: "adjudicator",
		label: "Adjudicator",
		kind: "adjudicator",
		model: manifest.adjudicator.resolvedModel,
		effort: manifest.adjudicator.effort,
		// A delegated adjudicator's advisor is durable, so a rebuilt card keeps the marker; a
		// main-mode one follows the live session and can only be known from the caller.
		advisor: delegated ? manifest.adjudicator.advisor : options.adjudicatorAdvisor === true,
		// One child id is reserved per delegated attempt, so `agentIds` is the attempt count. In main
		// mode there is no child and every adjudication turn is one request, so requests are attempts,
		// a reading that only holds because no advisor traffic is folded into a live session's turn.
		attempts: delegated ? (manifest.adjudicator.agentIds?.length ?? 0) : (manifest.adjudicatorUsage?.requests ?? 0),
		status: adjudicatorStatus(manifest),
		usage: manifest.adjudicatorUsage ? { ...manifest.adjudicatorUsage } : { requests: 0, tokens: 0, cost: 0 },
		findings: 0,
		dispositions: emptyTally(),
	});

	const total: CouncilUsage = { requests: 0, tokens: 0, cost: 0 };
	for (const role of roles) addUsage(total, role.usage);

	const findings = roles.reduce((sum, role) => sum + role.findings, 0);
	const stats: CouncilRunStats = {
		runId: manifest.runId,
		state: manifest.state,
		degraded: manifest.degraded,
		rounds: manifest.rounds.length,
		reviewersSucceeded,
		reviewersTotal,
		outputPath: manifest.outputPath,
		total,
		roles,
		warnings: boundedWarnings(manifest),
	};
	// Launch to settle. A terminal run always carries `finishedAt` (the manifest validator enforces
	// it), so the `updatedAt` fallback only covers a run summarized while it is still moving.
	const startedAt = Date.parse(manifest.timestamps.startedAt ?? manifest.timestamps.createdAt);
	const finishedAt = Date.parse(manifest.timestamps.finishedAt ?? manifest.timestamps.updatedAt);
	if (Number.isFinite(startedAt) && Number.isFinite(finishedAt)) {
		stats.durationMs = Math.max(0, finishedAt - startedAt);
	}
	if (options.adjudicationsUnreadable === true && findings > 0) stats.dispositionsUnavailable = true;
	return stats;
}

/** Structural view of `CouncilStorage`, so the loader below stays testable without storage wiring. */
export interface CouncilAdjudicationReader {
	readAdjudications(manifest: CouncilManifest): Promise<Map<number, CouncilAdjudication>>;
}

export interface CouncilAdjudicationLoad {
	adjudications: ReadonlyMap<number, CouncilAdjudication>;
	/** The read threw. Feeds `CouncilRunStatsOptions.adjudicationsUnreadable` verbatim. */
	unreadable: boolean;
}

/**
 * The one place a stats surface is allowed to read adjudications. Findings-only stats beat no stats
 * at all — a missing or corrupt adjudication is exactly when the operator most needs the table — so
 * a failure degrades to an empty map and records that it degraded, rather than throwing.
 */
export async function loadCouncilAdjudications(
	storage: CouncilAdjudicationReader,
	manifest: CouncilManifest,
): Promise<CouncilAdjudicationLoad> {
	try {
		return { adjudications: await storage.readAdjudications(manifest), unreadable: false };
	} catch {
		return { adjudications: new Map(), unreadable: true };
	}
}
