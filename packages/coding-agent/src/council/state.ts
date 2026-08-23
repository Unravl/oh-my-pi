import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { COUNCIL_MAX_ACTIVE_REVIEWERS, COUNCIL_ROLE_ID, type CouncilConfig } from "./config";
import { sha256CouncilContent } from "./hash";
import { DEFAULT_COUNCIL_INSTRUCTION_BYTES } from "./instructions";

export const COUNCIL_MANIFEST_VERSION = 2 as const;
/** Superseded envelope version, still decoded so an in-flight run survives the upgrade. */
const COUNCIL_MANIFEST_VERSION_V1 = 1 as const;

export const COUNCIL_RUN_STATES = [
	"dispatching",
	"planning",
	"reviewing",
	"awaiting-main",
	"adjudicating",
	"round-transition",
	"publishing",
	"cancelling",
	"interrupted",
	"failed",
	"completed",
	"completed-degraded",
] as const;

export type CouncilRunState = (typeof COUNCIL_RUN_STATES)[number];
export type CouncilTerminalRunState = "interrupted" | "failed" | "completed" | "completed-degraded";
export type CouncilMemberStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type CouncilRoundStatus = "pending" | "running" | "settled" | "interrupted";

/**
 * Plain-language rendering of a durable run state. Total over {@link CouncilRunState} so a new
 * state is a compile error here rather than a raw enum leaking into operator-facing text.
 */
export function councilStateLabel(state: CouncilRunState): string {
	switch (state) {
		case "dispatching":
			return "starting";
		case "planning":
			return "drafting the plan";
		case "reviewing":
			return "under review";
		case "awaiting-main":
			return "waiting for your turn to finish";
		case "adjudicating":
			return "judging findings";
		case "round-transition":
			return "starting next round";
		case "publishing":
			return "writing the plan";
		case "cancelling":
			return "cancelling";
		case "interrupted":
			return "interrupted";
		case "failed":
			return "failed";
		case "completed":
			return "completed";
		case "completed-degraded":
			return "completed with warnings";
	}
}

/**
 * Title Case for a bracketed state badge. {@link councilStateLabel} is prose ("under review")
 * because it also lands mid-sentence in command output; a badge reads as a label, not a clause.
 */
export function councilStateBadgeLabel(state: CouncilRunState): string {
	return councilStateLabel(state).replace(
		/(^|\s)(\p{Ll})/gu,
		(_match, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`,
	);
}

export interface CouncilArtifactReference {
	url: string;
	sha256: string;
	bytes: number;
}

export interface CouncilPublishedArtifact {
	path: string;
	sha256: string;
	bytes: number;
	publishedAt: string;
}

export interface CouncilTimestamps {
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	finishedAt?: string;
	interruptedAt?: string;
}

export interface CouncilResolvedRosterMember {
	role: string;
	enabled: boolean;
	order: number;
	/** Configured rounds this reviewer serves; non-empty and strictly ascending. */
	rounds: number[];
	/** Whether a live advisor watched this reviewer's turns. */
	advisor: boolean;
	requestedSelector: string;
	resolvedModel: string;
	effort: string | null;
	lens: string;
}

export interface CouncilPlannerSnapshot {
	/** Model role the planner resolved through: `planner` when assigned, `slow` when it fell back. */
	role: string;
	requestedSelector: string;
	resolvedModel: string;
	effort: string | null;
	/** Whether a live advisor watched the planner's turns. */
	advisor: boolean;
	/**
	 * Structured-subagent ids reserved for this role, appended one per launch and never cleared, so a
	 * `history://` pointer survives schema retries and resumed re-runs. Optional so manifests written
	 * before transcript pointers still parse.
	 */
	agentIds?: string[];
}

/**
 * Who judged the findings. `main` is the live session driving `xd://council`; it is informational
 * and excluded from resume compatibility, exactly as `mainSnapshot` was. `delegated` is a pinned
 * child agent and *is* compared, because changing it changes what the run costs and produces.
 */
export interface CouncilAdjudicatorSnapshot {
	mode: "main" | "delegated";
	/** `@main` in main mode; the configured `modelRoles.adjudicator` selector when delegated. */
	requestedSelector: string;
	resolvedModel: string;
	effort: string | null;
	advisor: boolean;
	capturedAt: string;
	instructionSha256?: string;
	/** Delegated only: reserved child ids, one per adjudication attempt. */
	agentIds?: string[];
}

export interface CouncilInstructionContextFile {
	path: string;
	content: string;
	depth?: number;
}

export interface CouncilInstructionFileRecord {
	path: string;
	sha256: string;
}

export interface CouncilInstructionSnapshot {
	repoRoot: string;
	contextFiles: CouncilInstructionContextFile[];
	files: CouncilInstructionFileRecord[];
	totalBytes: number;
}

export interface CouncilInstructionSnapshotReference {
	artifact: CouncilArtifactReference;
	sha256: string;
}

/** Durable slot state. Every field is explicit; filesystem presence never implies a phase or outcome. */
export interface CouncilRoundMemberRecord {
	role: string;
	order: number;
	status: CouncilMemberStatus;
	attempts: number;
	startedAt: string | null;
	finishedAt: string | null;
	artifact: CouncilArtifactReference | null;
	resolvedModel: string | null;
	authFallbackUsed: boolean;
	failureReason: string | null;
	findingIds: string[];
	/**
	 * Charge for every attempt this slot made, schema retries included. Optional so manifests
	 * written before per-role accounting still parse.
	 */
	usage?: CouncilUsage;
	/**
	 * Structured-subagent ids reserved for this slot, appended one per attempt and never cleared, so
	 * a `history://` pointer survives schema retries and resumed re-runs. Optional so manifests
	 * written before transcript pointers still parse.
	 */
	agentIds?: string[];
}

export interface CouncilRoundRecord {
	round: number;
	status: CouncilRoundStatus;
	startedAt: string | null;
	finishedAt: string | null;
	members: CouncilRoundMemberRecord[];
}

export interface CouncilPlanVersion {
	version: number;
	round: number;
	kind: "draft" | "round" | "final";
	artifact: CouncilArtifactReference;
	createdAt: string;
}

export interface CouncilUsage {
	requests: number;
	tokens: number;
	cost: number;
}

export interface CouncilAdjudicationBudget {
	injectedChars: number;
	cap: number;
}

export interface CouncilFailure {
	phase: string;
	reason: string;
	code?: string;
	time?: string;
}

/** Versioned source of truth for a council run. */
export interface CouncilManifestV2 {
	version: typeof COUNCIL_MANIFEST_VERSION;
	runId: string;
	sessionId: string;
	mainAgentId: string;
	state: CouncilRunState;
	task: string;
	repoRoot: string;
	/**
	 * Who convened this run. Optional so a manifest written before origins existed still parses; read
	 * it through {@link DEFAULT_COUNCIL_RUN_ORIGIN}, never bare. Durable because it decides both the
	 * published stem and whether a resume may fall back to Main-mode adjudication.
	 */
	origin?: CouncilRunOrigin;
	/** Collision-free repo-relative promise, resolved before model spend. */
	outputPath: string;
	published?: CouncilPublishedArtifact;
	timestamps: CouncilTimestamps;
	config: CouncilConfig;
	roster: CouncilResolvedRosterMember[];
	planner: CouncilPlannerSnapshot;
	/**
	 * Who judged. A `main` adjudicator is informational and excluded from resume compatibility;
	 * a `delegated` one is compared, because swapping it changes the run.
	 */
	adjudicator: CouncilAdjudicatorSnapshot;
	instructionSnapshot: CouncilInstructionSnapshotReference;
	rounds: CouncilRoundRecord[];
	planVersions: CouncilPlanVersion[];
	/** Whole-run total: planner + every member attempt + every adjudication turn. */
	usage: CouncilUsage;
	/** Planner-only charge. Optional so manifests written before per-role accounting still parse. */
	plannerUsage?: CouncilUsage;
	/** The adjudicator's charge, which `usage` alone used to omit entirely. */
	adjudicatorUsage?: CouncilUsage;
	adjudicationBudget: CouncilAdjudicationBudget;
	warnings: string[];
	degraded: boolean;
	failure?: CouncilFailure;
}

export type CouncilManifest = CouncilManifestV2;

const RUN_STATES: Record<CouncilRunState, true> = {
	dispatching: true,
	planning: true,
	reviewing: true,
	"awaiting-main": true,
	adjudicating: true,
	"round-transition": true,
	publishing: true,
	cancelling: true,
	interrupted: true,
	failed: true,
	completed: true,
	"completed-degraded": true,
};
const MEMBER_STATUSES: Record<CouncilMemberStatus, true> = {
	pending: true,
	running: true,
	succeeded: true,
	failed: true,
	cancelled: true,
	interrupted: true,
};
const ROUND_STATUSES: Record<CouncilRoundStatus, true> = {
	pending: true,
	running: true,
	settled: true,
	interrupted: true,
};
const PLAN_KINDS: Record<CouncilPlanVersion["kind"], true> = { draft: true, round: true, final: true };
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Sanitized structured-subagent id grammar, mirroring `sanitizeAgentId` in `src/task/structured-subagent.ts`. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/;
/**
 * Hard ceiling on the transcript pointers one role may accumulate. Bounded so a pathological retry
 * or resume loop cannot grow the manifest without limit; writers clamp their appends against it.
 */
export const COUNCIL_AGENT_ID_LIMIT = 16;
/**
 * Who convened a run.
 *
 * `command` is `/council <task>`: the operator asked, so the published plan is a plan-review
 * candidate and an unassigned `adjudicator` role lets the live Main session judge.
 *
 * `agent` is the `convene` tool: the caller holds the turn for the whole run, so Main can never
 * take an adjudication turn (it would deadlock against the tool call) and the result is returned to
 * the caller rather than offered to the operator for execution. Both differences are derived from
 * this one field.
 */
export type CouncilRunOrigin = "command" | "agent";

/** Compatibility default for a manifest written before origins existed. */
export const DEFAULT_COUNCIL_RUN_ORIGIN: CouncilRunOrigin = "command";

const RUN_ORIGINS: Record<CouncilRunOrigin, true> = { command: true, agent: true };

/**
 * Published-file stem per origin. `plan` is deliberately the only stem `listPlanFiles` can see: an
 * agent-origin run publishes a `brief`, so convening the council mid-turn never injects a candidate
 * into the operator's plan-review listing.
 */
export const COUNCIL_OUTPUT_STEMS: Record<CouncilRunOrigin, string> = { command: "plan", agent: "brief" };

/** Every stem the published-plan grammar accepts, for the slug guards that must reject all of them. */
const COUNCIL_RESERVED_SLUG_STEMS: readonly string[] = Object.values(COUNCIL_OUTPUT_STEMS);

/**
 * Council plans are published into the session `local://` root, namespaced so they can never be
 * mistaken for a user plan-mode plan (`local://<slug>-plan.md`) by `listPlanFiles`.
 */
const COUNCIL_OUTPUT_PATH_PATTERN = /^council-([a-z0-9]+(?:-[a-z0-9]+)*)-(plan|brief)\.md$/;
/**
 * Pre-retarget grammar, still parsed so a developer's in-flight run stays readable and resumable.
 * A legacy manifest publishes to `<planRoot>/plans/<slug>.md` — inside the session cache, never the
 * working tree. Read compatibility only: new runs mint solely the namespaced form above.
 */
const LEGACY_OUTPUT_PATH_PATTERN = /^plans\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

export class CouncilManifestError extends Error {
	readonly code = "COUNCIL_MANIFEST_CORRUPT";
	readonly spending = false;

	constructor(
		readonly field: string,
		message: string,
	) {
		super(`Council manifest ${field}: ${message}`);
		this.name = "CouncilManifestError";
	}
}

function invalid(field: string, message: string): never {
	throw new CouncilManifestError(field, message);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) invalid(field, "expected an object");
	return value;
}

function assertExactKeys(record: Record<string, unknown>, field: string, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) invalid(`${field}.${key}`, "unknown field");
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) invalid(field, "expected a non-empty string");
	return value;
}

function requireNullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") invalid(field, "expected a boolean");
	return value;
}

function requireCount(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		invalid(field, "expected a non-negative safe integer");
	}
	return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
	const count = requireCount(value, field);
	if (count === 0) invalid(field, "expected a positive safe integer");
	return count;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		invalid(field, "expected a finite non-negative number");
	}
	return value;
}

function requireTimestamp(value: unknown, field: string): string {
	const timestamp = requireString(value, field);
	const parsed = Date.parse(timestamp);
	if (!ISO_TIMESTAMP_PATTERN.test(timestamp) || Number.isNaN(parsed) || new Date(parsed).toISOString() !== timestamp) {
		invalid(field, "expected an ISO-8601 UTC timestamp");
	}
	return timestamp;
}

function requireNullableTimestamp(value: unknown, field: string): string | null {
	if (value === null) return null;
	return requireTimestamp(value, field);
}

function validateOptionalTimestamp(record: Record<string, unknown>, key: string, field: string): string | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	return requireTimestamp(record[key], `${field}.${key}`);
}

/** Shared shape check for `usage` and every optional per-role bucket beside it. */
function validateUsage(value: unknown, field: string): void {
	const usage = requireRecord(value, field);
	assertExactKeys(usage, field, ["requests", "tokens", "cost"]);
	requireCount(usage.requests, `${field}.requests`);
	requireCount(usage.tokens, `${field}.tokens`);
	requireNonNegativeNumber(usage.cost, `${field}.cost`);
}

/**
 * Shared shape check for the optional `agentIds` transcript pointers on a member or planner record.
 *
 * `attempts` bounds the list from above only. `#runRound` checkpoints `status=running, attempts=N`
 * before the attempt reserves its id, so a legitimately checkpointed row can carry fewer ids than
 * attempts; requiring a lower bound would reject a manifest the coordinator writes by design. Pass
 * `null` for the single-shot planner, whose ids accumulate across resumed re-runs with no attempt
 * counter to compare against.
 */
function validateAgentIds(
	record: Record<string, unknown>,
	field: string,
	attempts: number | null,
): string[] | undefined {
	if (!Object.hasOwn(record, "agentIds")) return undefined;
	const key = `${field}.agentIds`;
	const value = record.agentIds;
	if (!Array.isArray(value)) invalid(key, "expected an array");
	if (value.length > COUNCIL_AGENT_ID_LIMIT)
		invalid(key, `expected at most ${COUNCIL_AGENT_ID_LIMIT} structured-subagent ids`);
	const seen = new Set<string>();
	for (const [index, entry] of value.entries()) {
		if (typeof entry !== "string" || !AGENT_ID_PATTERN.test(entry)) {
			invalid(`${key}[${index}]`, "expected a sanitized structured-subagent id");
		}
		if (seen.has(entry)) invalid(`${key}[${index}]`, "duplicate structured-subagent id");
		seen.add(entry);
	}
	if (attempts !== null && value.length > attempts) invalid(key, "records more ids than attempts");
	return value as string[];
}

function requireSha256(value: unknown, field: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		invalid(field, "expected a lowercase SHA-256 digest");
	}
	return value;
}

function assertOrderedTimes(
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
	field: string,
): void {
	if (startedAt && finishedAt && Date.parse(finishedAt) < Date.parse(startedAt)) {
		invalid(field, "finishedAt precedes startedAt");
	}
}

function validateArtifact(value: unknown, field: string, nullable = false): CouncilArtifactReference | null {
	if (nullable && value === null) return null;
	const artifact = requireRecord(value, field);
	assertExactKeys(artifact, field, ["url", "sha256", "bytes"]);
	const url = requireString(artifact.url, `${field}.url`);
	const sha256 = requireSha256(artifact.sha256, `${field}.sha256`);
	const bytes = requireCount(artifact.bytes, `${field}.bytes`);
	return { url, sha256, bytes };
}

function validateConfigMember(value: unknown, field: string, index: number): CouncilConfig["members"][number] {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, ["role", "enabled", "order", "round"]);
	const role = requireString(member.role, `${field}.role`);
	if (!COUNCIL_ROLE_ID.test(role)) invalid(`${field}.role`, "invalid council role identifier");
	const enabled = requireBoolean(member.enabled, `${field}.enabled`);
	const order = requireCount(member.order, `${field}.order`);
	if (order !== index) invalid(`${field}.order`, `expected ordered slot ${index}`);
	if (!Object.hasOwn(member, "round")) return { role, enabled, order };
	if (member.round !== 1 && member.round !== 2) invalid(`${field}.round`, "expected 1 or 2");
	return { role, enabled, order, round: member.round };
}

function validateRosterMember(value: unknown, field: string): CouncilResolvedRosterMember {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, [
		"role",
		"enabled",
		"order",
		"rounds",
		"advisor",
		"requestedSelector",
		"resolvedModel",
		"effort",
		"lens",
	]);
	const role = requireString(member.role, `${field}.role`);
	if (!COUNCIL_ROLE_ID.test(role)) invalid(`${field}.role`, "invalid council role identifier");
	// Deliberately unbounded above: a member pinned beyond the configured rounds never reaches the
	// roster, and bounding here would turn a two-keystroke `Rounds` 2→1 flip into a start failure
	// on an otherwise valid persisted run.
	if (!Array.isArray(member.rounds) || member.rounds.length === 0)
		invalid(`${field}.rounds`, "expected a non-empty array of round numbers");
	const rounds: number[] = [];
	for (const [index, round] of member.rounds.entries()) {
		const parsed = requirePositiveInteger(round, `${field}.rounds[${index}]`);
		const previous = rounds[index - 1];
		if (previous !== undefined && parsed <= previous)
			invalid(`${field}.rounds[${index}]`, "rounds are not strictly ascending");
		rounds.push(parsed);
	}
	return {
		role,
		enabled: requireBoolean(member.enabled, `${field}.enabled`),
		order: requireCount(member.order, `${field}.order`),
		rounds,
		advisor: requireBoolean(member.advisor, `${field}.advisor`),
		requestedSelector: requireString(member.requestedSelector, `${field}.requestedSelector`),
		resolvedModel: requireString(member.resolvedModel, `${field}.resolvedModel`),
		effort: requireNullableString(member.effort, `${field}.effort`),
		lens: requireString(member.lens, `${field}.lens`),
	};
}

/**
 * Instruction paths are identity keys only: the snapshot carries its content inline, so nothing is
 * read from disk for them. User-level instruction files legitimately sit outside the repository, so
 * only shape is enforced here.
 */
function validateInstructionPath(value: unknown, field: string): string {
	const instructionPath = requireString(value, field);
	if (!path.isAbsolute(instructionPath)) invalid(field, "expected an absolute path");
	if (path.normalize(instructionPath) !== instructionPath) invalid(field, "expected a normalized path");
	return instructionPath;
}

export function parseCouncilInstructionSnapshot(value: unknown, manifestRoot: string): CouncilInstructionSnapshot {
	const snapshot = requireRecord(value, "instructionSnapshot");
	assertExactKeys(snapshot, "instructionSnapshot", ["repoRoot", "contextFiles", "files", "totalBytes"]);
	const snapshotRoot = requireString(snapshot.repoRoot, "instructionSnapshot.repoRoot");
	if (snapshotRoot !== manifestRoot) invalid("instructionSnapshot.repoRoot", "must equal repoRoot");
	if (!Array.isArray(snapshot.contextFiles)) invalid("instructionSnapshot.contextFiles", "expected an array");
	if (!Array.isArray(snapshot.files)) invalid("instructionSnapshot.files", "expected an array");

	const contents = new Map<string, string>();
	const contextFiles: CouncilInstructionContextFile[] = [];
	let totalBytes = 0;
	for (const [index, entryValue] of snapshot.contextFiles.entries()) {
		const field = `instructionSnapshot.contextFiles[${index}]`;
		const entry = requireRecord(entryValue, field);
		assertExactKeys(entry, field, ["path", "content", "depth"]);
		const entryPath = validateInstructionPath(entry.path, `${field}.path`);
		if (contents.has(entryPath)) invalid(`${field}.path`, "duplicate instruction path");
		if (typeof entry.content !== "string") invalid(`${field}.content`, "expected a string");
		const depth = Object.hasOwn(entry, "depth") ? requireCount(entry.depth, `${field}.depth`) : undefined;
		contents.set(entryPath, entry.content);
		contextFiles.push({ path: entryPath, content: entry.content, ...(depth === undefined ? {} : { depth }) });
		totalBytes += Buffer.byteLength(entry.content);
		if (!Number.isSafeInteger(totalBytes))
			invalid("instructionSnapshot.totalBytes", "instruction contents exceed safe integer range");
	}

	const hashes = new Map<string, string>();
	const files: CouncilInstructionFileRecord[] = [];
	for (const [index, fileValue] of snapshot.files.entries()) {
		const field = `instructionSnapshot.files[${index}]`;
		const file = requireRecord(fileValue, field);
		assertExactKeys(file, field, ["path", "sha256"]);
		const filePath = validateInstructionPath(file.path, `${field}.path`);
		if (hashes.has(filePath)) invalid(`${field}.path`, "duplicate instruction path");
		const digest = requireSha256(file.sha256, `${field}.sha256`);
		const content = contents.get(filePath);
		if (content === undefined) invalid(`${field}.path`, "has no corresponding context file");
		if (sha256CouncilContent(content) !== digest) invalid(`${field}.sha256`, "does not match captured content");
		hashes.set(filePath, digest);
		files.push({ path: filePath, sha256: digest });
	}
	for (const entryPath of contents.keys()) {
		if (!hashes.has(entryPath))
			invalid("instructionSnapshot.files", `missing hash record for ${JSON.stringify(entryPath)}`);
	}
	if (hashes.size !== contents.size)
		invalid("instructionSnapshot.files", "must correspond one-to-one with contextFiles");
	const declaredBytes = requireCount(snapshot.totalBytes, "instructionSnapshot.totalBytes");
	if (declaredBytes > DEFAULT_COUNCIL_INSTRUCTION_BYTES) {
		invalid(
			"instructionSnapshot.totalBytes",
			`exceeds ${DEFAULT_COUNCIL_INSTRUCTION_BYTES} byte council instruction limit`,
		);
	}
	if (declaredBytes !== totalBytes) invalid("instructionSnapshot.totalBytes", `expected ${totalBytes}`);
	return { repoRoot: snapshotRoot, contextFiles, files, totalBytes };
}

function validateInstructionSnapshotReference(value: unknown): string {
	const reference = requireRecord(value, "instructionSnapshot");
	assertExactKeys(reference, "instructionSnapshot", ["artifact", "sha256"]);
	const artifact = validateArtifact(reference.artifact, "instructionSnapshot.artifact");
	const digest = requireSha256(reference.sha256, "instructionSnapshot.sha256");
	if (!artifact || artifact.sha256 !== digest) {
		invalid("instructionSnapshot.sha256", "must match instructionSnapshot.artifact.sha256");
	}
	return digest;
}

function validateMemberRecord(
	value: unknown,
	field: string,
	rosterMember: CouncilResolvedRosterMember,
): CouncilMemberStatus {
	const member = requireRecord(value, field);
	assertExactKeys(member, field, [
		"role",
		"order",
		"status",
		"attempts",
		"startedAt",
		"finishedAt",
		"artifact",
		"resolvedModel",
		"authFallbackUsed",
		"failureReason",
		"findingIds",
		"usage",
		"agentIds",
	]);
	const role = requireString(member.role, `${field}.role`);
	const order = requireCount(member.order, `${field}.order`);
	if (role !== rosterMember.role || order !== rosterMember.order)
		invalid(field, "does not match the persisted roster slot");
	if (typeof member.status !== "string" || !Object.hasOwn(MEMBER_STATUSES, member.status)) {
		invalid(`${field}.status`, "unknown member status");
	}
	const status = member.status as CouncilMemberStatus;
	const attempts = requireCount(member.attempts, `${field}.attempts`);
	const startedAt = requireNullableTimestamp(member.startedAt, `${field}.startedAt`);
	const finishedAt = requireNullableTimestamp(member.finishedAt, `${field}.finishedAt`);
	const artifact = validateArtifact(member.artifact, `${field}.artifact`, true);
	const resolvedModel = requireNullableString(member.resolvedModel, `${field}.resolvedModel`);
	const authFallbackUsed = requireBoolean(member.authFallbackUsed, `${field}.authFallbackUsed`);
	const failureReason = requireNullableString(member.failureReason, `${field}.failureReason`);
	if (!Array.isArray(member.findingIds)) invalid(`${field}.findingIds`, "expected an array");
	const findingIds = new Set<string>();
	for (const [index, id] of member.findingIds.entries()) {
		const findingId = requireString(id, `${field}.findingIds[${index}]`);
		if (findingIds.has(findingId)) invalid(`${field}.findingIds[${index}]`, "duplicate finding id");
		findingIds.add(findingId);
	}
	assertOrderedTimes(startedAt, finishedAt, field);
	const hasUsage = Object.hasOwn(member, "usage");
	if (hasUsage) validateUsage(member.usage, `${field}.usage`);
	const agentIds = validateAgentIds(member, field, attempts);

	if (status === "pending") {
		if (attempts !== 0 || startedAt !== null || finishedAt !== null || artifact !== null || resolvedModel !== null) {
			invalid(field, "pending member has attempt, timestamp, model, or artifact state");
		}
		if (authFallbackUsed || failureReason !== null || findingIds.size !== 0 || hasUsage || agentIds?.length)
			invalid(field, "pending member has terminal metadata");
	} else if (status === "running") {
		if (attempts === 0 || startedAt === null || finishedAt !== null || artifact !== null || failureReason !== null) {
			invalid(field, "running member has inconsistent attempts, timestamps, artifact, or failure");
		}
		if (findingIds.size !== 0) invalid(`${field}.findingIds`, "running member cannot have findings");
	} else if (status === "succeeded") {
		if (attempts === 0 || startedAt === null || finishedAt === null || artifact === null || resolvedModel === null) {
			invalid(field, "succeeded member requires attempts, timestamps, artifact, and resolvedModel");
		}
		if (failureReason !== null) invalid(`${field}.failureReason`, "succeeded member cannot have a failure reason");
		if (authFallbackUsed)
			invalid(`${field}.authFallbackUsed`, "succeeded member cannot use an authentication fallback");
		if (resolvedModel !== rosterMember.resolvedModel && !resolvedModel.startsWith(`${rosterMember.resolvedModel}:`)) {
			invalid(`${field}.resolvedModel`, `does not match pinned roster model ${rosterMember.resolvedModel}`);
		}
	} else if (status === "failed") {
		if (attempts === 0 || startedAt === null || finishedAt === null || artifact !== null || failureReason === null) {
			invalid(field, "failed member requires attempts, timestamps, and failureReason but no artifact");
		}
		if (findingIds.size !== 0) invalid(`${field}.findingIds`, "failed member cannot have findings");
	} else {
		if (finishedAt === null || artifact !== null || findingIds.size !== 0) {
			invalid(field, `${status} member requires finishedAt and cannot have an artifact or findings`);
		}
		if ((attempts === 0) !== (startedAt === null)) invalid(field, "attempts and startedAt disagree");
	}
	return status;
}

function validateRoundRecord(
	value: unknown,
	field: string,
	roundIndex: number,
	roster: readonly CouncilResolvedRosterMember[],
): CouncilRoundStatus {
	const round = requireRecord(value, field);
	assertExactKeys(round, field, ["round", "status", "startedAt", "finishedAt", "members"]);
	const roundNumber = requirePositiveInteger(round.round, `${field}.round`);
	if (roundNumber !== roundIndex + 1) invalid(`${field}.round`, `expected ordered round ${roundIndex + 1}`);
	if (typeof round.status !== "string" || !Object.hasOwn(ROUND_STATUSES, round.status)) {
		invalid(`${field}.status`, "unknown round status");
	}
	const status = round.status as CouncilRoundStatus;
	const startedAt = requireNullableTimestamp(round.startedAt, `${field}.startedAt`);
	const finishedAt = requireNullableTimestamp(round.finishedAt, `${field}.finishedAt`);
	assertOrderedTimes(startedAt, finishedAt, field);
	if (!Array.isArray(round.members)) invalid(`${field}.members`, "expected an array");
	// The expected members of round N are exactly the roster entries that serve N, in roster order.
	// Positional matching against the whole roster would reject every per-round roster.
	const expected = roster.filter(member => member.rounds.includes(roundNumber));
	if (round.members.length !== expected.length)
		invalid(`${field}.members`, `must contain each round-${roundNumber} roster slot exactly once`);
	const memberStatuses = round.members.map((member, index) =>
		validateMemberRecord(member, `${field}.members[${index}]`, expected[index]!),
	);

	if (status === "pending") {
		if (startedAt !== null || finishedAt !== null || memberStatuses.some(member => member !== "pending")) {
			invalid(field, "pending round has timestamps or non-pending members");
		}
	} else if (status === "running") {
		if (startedAt === null || finishedAt !== null)
			invalid(field, "running round requires startedAt and no finishedAt");
		if (!memberStatuses.some(member => member === "running")) invalid(field, "running round has no running member");
	} else if (status === "settled") {
		if (startedAt === null || finishedAt === null) invalid(field, "settled round requires startedAt and finishedAt");
		if (memberStatuses.some(member => member === "pending" || member === "running")) {
			invalid(field, "settled round has an active member");
		}
	} else {
		if (startedAt === null || finishedAt === null)
			invalid(field, "interrupted round requires startedAt and finishedAt");
		if (memberStatuses.some(member => member === "running")) invalid(field, "interrupted round has a running member");
	}
	return status;
}

/**
 * Accepts the namespaced session-cache form and the legacy `plans/<slug>.md` form. Both grammars
 * bound the slug at 80 characters and reject every reserved stem (`plan`, `brief`) bare or trailing:
 * a slug that ends in the stem would make `council-x-plan-plan.md` and a stem-only name ambiguous
 * against a user plan-mode plan and against the other origin's artifact.
 */
export function isValidCouncilOutputPath(value: string): boolean {
	const match = COUNCIL_OUTPUT_PATH_PATTERN.exec(value) ?? LEGACY_OUTPUT_PATH_PATTERN.exec(value);
	if (!match) return false;
	const slug = match[1]!;
	if (slug.length > 80) return false;
	return !COUNCIL_RESERVED_SLUG_STEMS.some(stem => slug === stem || slug.endsWith(`-${stem}`));
}

/** True only for the pre-retarget grammar, which publishes under a `plans/` subdirectory. */
export function isLegacyCouncilOutputPath(value: string): boolean {
	return LEGACY_OUTPUT_PATH_PATTERN.test(value) && isValidCouncilOutputPath(value);
}

function validateOutputPath(value: unknown): string {
	const outputPath = requireString(value, "outputPath");
	if (!isValidCouncilOutputPath(outputPath)) {
		invalid(
			"outputPath",
			`expected council-<lowercase-kebab-slug>-(${COUNCIL_RESERVED_SLUG_STEMS.join("|")}).md (or legacy plans/<slug>.md) with a 1..80 character slug not ending in -${COUNCIL_RESERVED_SLUG_STEMS.join(" or -")}`,
		);
	}
	return outputPath;
}

/**
 * Rewrite a version-1 envelope into the version-2 shape.
 *
 * Every new field has a compatibility default that reproduces v1 behaviour exactly: no `round`
 * means every configured round, no advisor anywhere, the planner ran on `slow`, and the
 * adjudicator was the live Main session. A v1 payload is therefore upgraded rather than treated as
 * corrupt, so `/council status`, `list()`, the summary card, and `resume` keep working for a run
 * that was in flight across the upgrade; the next checkpoint writes v2.
 */
function decodeCouncilManifestV1(manifest: Record<string, unknown>): Record<string, unknown> {
	const decoded: Record<string, unknown> = { ...manifest, version: COUNCIL_MANIFEST_VERSION };
	const config = isRecord(decoded.config) ? { ...decoded.config } : undefined;
	const configuredRounds = config?.rounds === 2 ? 2 : 1;
	if (config) {
		config.advisor = { planner: false, reviewers: false, adjudicator: false };
		decoded.config = config;
	}
	if (Array.isArray(decoded.roster)) {
		decoded.roster = decoded.roster.map(member =>
			isRecord(member)
				? {
						...member,
						rounds: Array.from({ length: configuredRounds }, (_unused, index) => index + 1),
						advisor: false,
					}
				: member,
		);
	}
	if (isRecord(decoded.planner)) decoded.planner = { ...decoded.planner, role: "slow", advisor: false };
	const mainSnapshot = decoded.mainSnapshot;
	delete decoded.mainSnapshot;
	if (isRecord(mainSnapshot)) {
		decoded.adjudicator = {
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: mainSnapshot.model,
			effort: mainSnapshot.effort,
			advisor: false,
			capturedAt: mainSnapshot.capturedAt,
			...(Object.hasOwn(mainSnapshot, "instructionSha256")
				? { instructionSha256: mainSnapshot.instructionSha256 }
				: {}),
		};
	}
	if (Object.hasOwn(decoded, "mainUsage")) {
		decoded.adjudicatorUsage = decoded.mainUsage;
		delete decoded.mainUsage;
	}
	return decoded;
}

/** Strictly parses the durable envelope. Referenced artifact content is verified by CouncilStorage.load. */
export function parseCouncilManifest(value: unknown): CouncilManifest {
	const raw = requireRecord(value, "root");
	const manifest = raw.version === COUNCIL_MANIFEST_VERSION_V1 ? decodeCouncilManifestV1(raw) : raw;
	assertExactKeys(manifest, "root", [
		"version",
		"runId",
		"sessionId",
		"mainAgentId",
		"state",
		"task",
		"repoRoot",
		"origin",
		"outputPath",
		"published",
		"timestamps",
		"config",
		"roster",
		"planner",
		"adjudicator",
		"instructionSnapshot",
		"rounds",
		"planVersions",
		"usage",
		"plannerUsage",
		"adjudicatorUsage",
		"adjudicationBudget",
		"warnings",
		"degraded",
		"failure",
	]);
	if (manifest.version !== COUNCIL_MANIFEST_VERSION) {
		invalid("version", `expected ${COUNCIL_MANIFEST_VERSION}, received ${String(manifest.version)}`);
	}
	for (const field of ["runId", "sessionId", "mainAgentId", "task"] as const) requireString(manifest[field], field);
	requireString(manifest.repoRoot, "repoRoot");
	const outputPath = validateOutputPath(manifest.outputPath);
	if (Object.hasOwn(manifest, "origin")) {
		if (typeof manifest.origin !== "string" || !Object.hasOwn(RUN_ORIGINS, manifest.origin)) {
			invalid("origin", `expected one of ${Object.keys(RUN_ORIGINS).join(", ")}`);
		}
	}
	// The stem is what keeps an agent-origin brief out of `listPlanFiles`, so a manifest whose origin
	// and stem disagree is corrupt rather than merely odd: honouring it would either hide an
	// operator's plan or offer an agent's brief for execution. Legacy `plans/<slug>.md` carries no
	// stem and predates origins, so it is exempt.
	const stem = COUNCIL_OUTPUT_PATH_PATTERN.exec(outputPath)?.[2];
	const expectedStem = COUNCIL_OUTPUT_STEMS[(manifest.origin as CouncilRunOrigin) ?? DEFAULT_COUNCIL_RUN_ORIGIN];
	if (stem !== undefined && stem !== expectedStem) {
		invalid(
			"outputPath",
			`expected a -${expectedStem}.md stem for a ${manifest.origin ?? DEFAULT_COUNCIL_RUN_ORIGIN}-origin run`,
		);
	}
	if (typeof manifest.state !== "string" || !Object.hasOwn(RUN_STATES, manifest.state))
		invalid("state", "unknown run state");
	const state = manifest.state as CouncilRunState;

	const timestamps = requireRecord(manifest.timestamps, "timestamps");
	assertExactKeys(timestamps, "timestamps", ["createdAt", "updatedAt", "startedAt", "finishedAt", "interruptedAt"]);
	const createdAt = requireTimestamp(timestamps.createdAt, "timestamps.createdAt");
	const updatedAt = requireTimestamp(timestamps.updatedAt, "timestamps.updatedAt");
	const startedAt = validateOptionalTimestamp(timestamps, "startedAt", "timestamps");
	const finishedAt = validateOptionalTimestamp(timestamps, "finishedAt", "timestamps");
	const interruptedAt = validateOptionalTimestamp(timestamps, "interruptedAt", "timestamps");
	if (Date.parse(updatedAt) < Date.parse(createdAt)) invalid("timestamps.updatedAt", "precedes createdAt");
	assertOrderedTimes(startedAt, finishedAt, "timestamps");

	if (Object.hasOwn(manifest, "published")) {
		const published = requireRecord(manifest.published, "published");
		assertExactKeys(published, "published", ["path", "sha256", "bytes", "publishedAt"]);
		if (requireString(published.path, "published.path") !== outputPath)
			invalid("published.path", "must equal outputPath");
		requireSha256(published.sha256, "published.sha256");
		requireCount(published.bytes, "published.bytes");
		requireTimestamp(published.publishedAt, "published.publishedAt");
	}

	const config = requireRecord(manifest.config, "config");
	assertExactKeys(config, "config", ["rounds", "members", "advisor"]);
	const configAdvisor = requireRecord(config.advisor, "config.advisor");
	assertExactKeys(configAdvisor, "config.advisor", ["planner", "reviewers", "adjudicator"]);
	for (const scope of ["planner", "reviewers", "adjudicator"] as const) {
		requireBoolean(configAdvisor[scope], `config.advisor.${scope}`);
	}
	if (config.rounds !== 1 && config.rounds !== 2) invalid("config.rounds", "expected 1 or 2");
	const configuredRounds: 1 | 2 = config.rounds;
	if (!Array.isArray(config.members)) invalid("config.members", "expected an array");
	const configuredRoles = new Set<string>();
	const configMembers = config.members.map((member, index) => {
		const validated = validateConfigMember(member, `config.members[${index}]`, index);
		if (configuredRoles.has(validated.role)) invalid(`config.members[${index}].role`, "duplicate role");
		configuredRoles.add(validated.role);
		return validated;
	});

	if (!Array.isArray(manifest.roster)) invalid("roster", "expected an array");
	const roster = manifest.roster.map((member, index) => validateRosterMember(member, `roster[${index}]`));
	// Roster ↔ config pairing is *enabled and active*: an enabled member pinned above the
	// configured round count is parked configuration and deliberately never reaches the roster.
	const activeConfigMembers = configMembers.filter(
		member => member.enabled && (member.round === undefined || member.round <= configuredRounds),
	);
	if (roster.length !== activeConfigMembers.length)
		invalid("roster", "must contain every enabled, in-range config slot exactly once");
	for (const [index, member] of roster.entries()) {
		const configured = activeConfigMembers[index]!;
		if (!member.enabled || member.role !== configured.role || member.order !== configured.order) {
			invalid(`roster[${index}]`, "role, enabled, or order does not match enabled config slot");
		}
		const expectedRounds =
			configured.round === undefined
				? Array.from({ length: configuredRounds }, (_unused, round) => round + 1)
				: [configured.round];
		if (member.rounds.length !== expectedRounds.length || member.rounds.some((r, i) => r !== expectedRounds[i])) {
			invalid(`roster[${index}].rounds`, `expected [${expectedRounds.join(", ")}] for the configured round pin`);
		}
		if (index > 0 && roster[index - 1]!.order >= member.order)
			invalid(`roster[${index}].order`, "roster slots are not ordered");
	}

	const planner = requireRecord(manifest.planner, "planner");
	assertExactKeys(planner, "planner", ["role", "requestedSelector", "resolvedModel", "effort", "advisor", "agentIds"]);
	requireString(planner.role, "planner.role");
	requireString(planner.requestedSelector, "planner.requestedSelector");
	requireString(planner.resolvedModel, "planner.resolvedModel");
	requireNullableString(planner.effort, "planner.effort");
	requireBoolean(planner.advisor, "planner.advisor");
	validateAgentIds(planner, "planner", null);

	const adjudicator = requireRecord(manifest.adjudicator, "adjudicator");
	assertExactKeys(adjudicator, "adjudicator", [
		"mode",
		"requestedSelector",
		"resolvedModel",
		"effort",
		"advisor",
		"capturedAt",
		"instructionSha256",
		"agentIds",
	]);
	if (adjudicator.mode !== "main" && adjudicator.mode !== "delegated")
		invalid("adjudicator.mode", "expected main or delegated");
	requireString(adjudicator.requestedSelector, "adjudicator.requestedSelector");
	requireString(adjudicator.resolvedModel, "adjudicator.resolvedModel");
	requireNullableString(adjudicator.effort, "adjudicator.effort");
	requireBoolean(adjudicator.advisor, "adjudicator.advisor");
	requireTimestamp(adjudicator.capturedAt, "adjudicator.capturedAt");
	const adjudicatorAgentIds = validateAgentIds(adjudicator, "adjudicator", null);
	if (adjudicator.mode === "main" && adjudicatorAgentIds !== undefined) {
		invalid("adjudicator.agentIds", "a main-mode adjudicator spawns no child agents");
	}
	const adjudicatorInstructionSha = Object.hasOwn(adjudicator, "instructionSha256")
		? requireSha256(adjudicator.instructionSha256, "adjudicator.instructionSha256")
		: undefined;
	const instructionSha = validateInstructionSnapshotReference(manifest.instructionSnapshot);
	if (adjudicatorInstructionSha !== undefined && adjudicatorInstructionSha !== instructionSha) {
		invalid("adjudicator.instructionSha256", "must match instructionSnapshot.sha256");
	}

	if (!Array.isArray(manifest.rounds)) invalid("rounds", "expected an array");
	if (manifest.rounds.length !== config.rounds) invalid("rounds", `expected ${config.rounds} ordered round records`);
	const roundStatuses = manifest.rounds.map((round, index) =>
		validateRoundRecord(round, `rounds[${index}]`, index, roster),
	);
	if (isCouncilTerminalState(state) && roundStatuses.some(status => status === "running")) {
		invalid("rounds", "terminal run cannot contain an active round");
	}

	if (!Array.isArray(manifest.planVersions)) invalid("planVersions", "expected an array");
	const canonicalPlanSequence: ReadonlyArray<Pick<CouncilPlanVersion, "round" | "kind">> =
		config.rounds === 1
			? [
					{ round: 0, kind: "draft" },
					{ round: 1, kind: "final" },
				]
			: [
					{ round: 0, kind: "draft" },
					{ round: 1, kind: "round" },
					{ round: 2, kind: "final" },
				];
	if (manifest.planVersions.length > canonicalPlanSequence.length) {
		invalid("planVersions", `exceeds canonical ${config.rounds}-round sequence length`);
	}
	for (const [index, versionValue] of manifest.planVersions.entries()) {
		const field = `planVersions[${index}]`;
		const version = requireRecord(versionValue, field);
		assertExactKeys(version, field, ["version", "round", "kind", "artifact", "createdAt"]);
		const versionNumber = requirePositiveInteger(version.version, `${field}.version`);
		if (versionNumber !== index + 1) invalid(`${field}.version`, `expected ordered version ${index + 1}`);
		const round = requireCount(version.round, `${field}.round`);
		if (typeof version.kind !== "string" || !Object.hasOwn(PLAN_KINDS, version.kind))
			invalid(`${field}.kind`, "unknown plan kind");
		const kind = version.kind as CouncilPlanVersion["kind"];
		const expected = canonicalPlanSequence[index]!;
		if (round !== expected.round || kind !== expected.kind) {
			invalid(field, `expected canonical ${expected.kind} version for round ${expected.round}`);
		}
		validateArtifact(version.artifact, `${field}.artifact`);
		requireTimestamp(version.createdAt, `${field}.createdAt`);
	}

	validateUsage(manifest.usage, "usage");
	if (Object.hasOwn(manifest, "plannerUsage")) validateUsage(manifest.plannerUsage, "plannerUsage");
	if (Object.hasOwn(manifest, "adjudicatorUsage")) validateUsage(manifest.adjudicatorUsage, "adjudicatorUsage");
	const budget = requireRecord(manifest.adjudicationBudget, "adjudicationBudget");
	assertExactKeys(budget, "adjudicationBudget", ["injectedChars", "cap"]);
	const injectedChars = requireCount(budget.injectedChars, "adjudicationBudget.injectedChars");
	const cap = requireCount(budget.cap, "adjudicationBudget.cap");
	if (injectedChars > cap) invalid("adjudicationBudget.injectedChars", "exceeds cap");
	if (!Array.isArray(manifest.warnings)) invalid("warnings", "expected an array");
	for (const [index, warning] of manifest.warnings.entries()) requireString(warning, `warnings[${index}]`);
	const degraded = requireBoolean(manifest.degraded, "degraded");

	if (Object.hasOwn(manifest, "failure")) {
		const failure = requireRecord(manifest.failure, "failure");
		assertExactKeys(failure, "failure", ["phase", "reason", "code", "time"]);
		requireString(failure.phase, "failure.phase");
		requireString(failure.reason, "failure.reason");
		if (Object.hasOwn(failure, "code")) requireString(failure.code, "failure.code");
		if (Object.hasOwn(failure, "time")) requireTimestamp(failure.time, "failure.time");
	}
	const completed = state === "completed" || state === "completed-degraded";
	if (completed) {
		if (roundStatuses.some(status => status !== "settled")) {
			invalid("rounds", "completed run requires every round to be settled");
		}
		if (manifest.planVersions.length !== canonicalPlanSequence.length) {
			invalid("planVersions", "completed run requires the full canonical version sequence");
		}
		if (!Object.hasOwn(manifest, "published")) {
			invalid("published", "completed run requires a published record matching outputPath");
		}
	}

	if (isCouncilTerminalState(state)) {
		if (!finishedAt) invalid("timestamps.finishedAt", "terminal run requires finishedAt");
	} else if (finishedAt || interruptedAt) {
		invalid("timestamps", "nonterminal run cannot have finishedAt or interruptedAt");
	}
	if (state === "interrupted" && (!interruptedAt || interruptedAt !== finishedAt)) {
		invalid("timestamps.interruptedAt", "interrupted run requires matching interruptedAt and finishedAt");
	}
	if (state === "failed" && !Object.hasOwn(manifest, "failure"))
		invalid("failure", "failed run requires failure details");
	if (state === "completed" && degraded) invalid("degraded", "completed run cannot be degraded");
	if (state === "completed-degraded" && !degraded) invalid("degraded", "completed-degraded run must be degraded");
	return manifest as unknown as CouncilManifest;
}

export function isCouncilTerminalState(state: CouncilRunState): state is CouncilTerminalRunState {
	return state === "interrupted" || state === "failed" || state === "completed" || state === "completed-degraded";
}

/**
 * Whether the run *state* leaves work to continue.
 *
 * A completed run has nothing left to do, and two failure classes are terminal by construction: a
 * structurally invalid planner result would be re-requested against the same pinned model, and a
 * publication collision (`EEXIST`) can never resolve itself. `state !== "completed"` alone is not
 * enough — the no-id resume selector would otherwise pick a newer terminal failure and refuse,
 * shadowing an older run that is genuinely resumable.
 *
 * Split out from {@link isCouncilResumableManifest} so a refusal can tell "terminal" apart from
 * "would still run, but its persisted roster is no longer dispatchable".
 */
export function isCouncilResumableRunState(manifest: Pick<CouncilManifest, "state" | "failure">): boolean {
	if (manifest.state === "completed" || manifest.state === "completed-degraded") return false;
	if (manifest.state !== "failed") return true;
	return manifest.failure?.phase !== "planner-schema" && manifest.failure?.code !== "EEXIST";
}

/**
 * Reviewers a persisted roster would actually dispatch on resume.
 *
 * The manifest roster only ever holds enabled, in-range slots — parked configuration never reaches
 * it — but both fields are re-checked here so an artifact written by an earlier build is counted by
 * exactly the rule `countActiveCouncilMembers` applies to live configuration.
 */
export function councilManifestActiveReviewerCount(manifest: Pick<CouncilManifest, "roster">): number {
	let count = 0;
	for (const member of manifest.roster) {
		if (member.enabled && member.rounds.length > 0) count++;
	}
	return count;
}

/**
 * Whether the roster cap — and only the roster cap — is what stops this run from continuing.
 *
 * False for a run that is terminal on its own terms, so a completed run keeps "already completed"
 * and a `planner-schema`/`EEXIST` failure keeps its own wording. This is the predicate a resume
 * *selector* filters on: an oversized run is not a candidate at any priority, so it can never
 * shadow another run's completed early-return or terminal refusal.
 */
export function isCouncilRosterOverResumeLimit(
	manifest: Pick<CouncilManifest, "state" | "failure" | "roster">,
): boolean {
	return (
		isCouncilResumableRunState(manifest) &&
		councilManifestActiveReviewerCount(manifest) > COUNCIL_MAX_ACTIVE_REVIEWERS
	);
}

/**
 * The single source of truth for "can `/council resume` continue this run".
 *
 * Roster size is part of the answer, not just run state: {@link parseCouncilManifest} stays
 * permissive about roster length so a run recorded by an earlier development build keeps rendering
 * its cards, stats, and history, but a roster above {@link COUNCIL_MAX_ACTIVE_REVIEWERS} can no
 * longer be graded, so no-id resume must not select it and no surface should offer a resume hint
 * for it.
 */
export function isCouncilResumableManifest(manifest: Pick<CouncilManifest, "state" | "failure" | "roster">): boolean {
	return isCouncilResumableRunState(manifest) && !isCouncilRosterOverResumeLimit(manifest);
}

/**
 * Why a `/council resume` on an otherwise-live run has to refuse: its persisted roster is larger
 * than an adjudication can grade. Undefined when the roster fits, and undefined for a run that was
 * not resumable anyway, so a completed or terminally failed run keeps the refusal it already had
 * instead of being relabelled. The payload is never corrupt: it parses, renders, and counts — it
 * just cannot be continued.
 */
export function councilResumeRosterLimitRefusal(
	manifest: Pick<CouncilManifest, "runId" | "state" | "failure" | "roster">,
): string | undefined {
	if (!isCouncilRosterOverResumeLimit(manifest)) return undefined;
	return `Council run ${manifest.runId} has ${councilManifestActiveReviewerCount(manifest)} active reviewers, above the ${COUNCIL_MAX_ACTIVE_REVIEWERS}-reviewer limit an adjudication can grade, so it cannot be resumed. Reduce the roster with /council config (Model Hub -> Roles & Council) and start a new run.`;
}

/** Recovery is inert: every unfinished state becomes interrupted and no phase is inferred from artifacts. */
export function normalizeRecoveredCouncilManifest(
	manifest: CouncilManifest,
	now = new Date().toISOString(),
): CouncilManifest {
	if (isCouncilTerminalState(manifest.state)) return structuredClone(manifest);
	const recovered = structuredClone(manifest);
	recovered.state = "interrupted";
	recovered.timestamps.updatedAt = now;
	recovered.timestamps.finishedAt = now;
	recovered.timestamps.interruptedAt = now;
	for (const round of recovered.rounds) {
		if (round.status === "running") {
			round.status = "interrupted";
			round.finishedAt = now;
		}
		for (const member of round.members) {
			if (member.status === "running") {
				member.status = "interrupted";
				member.finishedAt = now;
			}
		}
	}
	return recovered;
}

export interface CouncilResumeIdentity {
	roster: readonly CouncilResolvedRosterMember[];
	planner: CouncilPlannerSnapshot;
	adjudicator: CouncilAdjudicatorSnapshot;
}

/** Which identity component blocked a resume, so the refusal can name it. */
export type CouncilResumeIdentityMismatch = "roster/planner" | "adjudicator";

/**
 * Compare the persisted identity against what a fresh preflight resolved.
 *
 * A Main-mode adjudicator on both sides is deliberately excluded: changing Main does not make an
 * otherwise identical run incompatible. Everything else about the adjudicator is compared —
 * including a `main` ⇄ `delegated` flip in either direction, which changes who spends and how the
 * verdict is produced.
 */
export function councilResumeMismatches(
	manifest: Pick<CouncilManifest, "roster" | "planner" | "adjudicator">,
	candidate: CouncilResumeIdentity,
): CouncilResumeIdentityMismatch[] {
	const mismatches: CouncilResumeIdentityMismatch[] = [];
	const rosterMatches =
		manifest.roster.length === candidate.roster.length &&
		manifest.roster.every((persisted, index) => {
			const current = candidate.roster[index];
			return (
				current !== undefined &&
				persisted.role === current.role &&
				persisted.order === current.order &&
				persisted.requestedSelector === current.requestedSelector &&
				persisted.resolvedModel === current.resolvedModel &&
				persisted.effort === current.effort &&
				persisted.lens === current.lens &&
				persisted.advisor === current.advisor &&
				persisted.rounds.length === current.rounds.length &&
				persisted.rounds.every((round, position) => round === current.rounds[position])
			);
		});
	const plannerMatches =
		manifest.planner.role === candidate.planner.role &&
		manifest.planner.requestedSelector === candidate.planner.requestedSelector &&
		manifest.planner.resolvedModel === candidate.planner.resolvedModel &&
		manifest.planner.effort === candidate.planner.effort &&
		manifest.planner.advisor === candidate.planner.advisor;
	if (!rosterMatches || !plannerMatches) mismatches.push("roster/planner");
	const delegatedEitherSide = manifest.adjudicator.mode === "delegated" || candidate.adjudicator.mode === "delegated";
	if (
		delegatedEitherSide &&
		(manifest.adjudicator.mode !== candidate.adjudicator.mode ||
			manifest.adjudicator.requestedSelector !== candidate.adjudicator.requestedSelector ||
			manifest.adjudicator.resolvedModel !== candidate.adjudicator.resolvedModel ||
			manifest.adjudicator.effort !== candidate.adjudicator.effort ||
			manifest.adjudicator.advisor !== candidate.adjudicator.advisor)
	) {
		mismatches.push("adjudicator");
	}
	return mismatches;
}

export function councilManifestArtifactReferences(manifest: CouncilManifest): CouncilArtifactReference[] {
	return [
		manifest.instructionSnapshot.artifact,
		...manifest.planVersions.map(version => version.artifact),
		...manifest.rounds.flatMap(round => round.members.flatMap(member => (member.artifact ? [member.artifact] : []))),
	];
}
