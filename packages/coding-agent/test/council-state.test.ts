import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { COUNCIL_MAX_ACTIVE_REVIEWERS } from "@oh-my-pi/pi-coding-agent/council/config";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import {
	COUNCIL_AGENT_ID_LIMIT,
	type CouncilManifest,
	CouncilManifestError,
	type CouncilUsage,
	councilManifestActiveReviewerCount,
	councilResumeMismatches,
	councilResumeRosterLimitRefusal,
	isCouncilResumableManifest,
	isCouncilResumableRunState,
	isCouncilRosterOverResumeLimit,
	isCouncilTerminalState,
	isLegacyCouncilOutputPath,
	isValidCouncilOutputPath,
	normalizeRecoveredCouncilManifest,
	parseCouncilInstructionSnapshot,
	parseCouncilManifest,
} from "@oh-my-pi/pi-coding-agent/council/state";

const now = "2026-08-05T12:00:00.000Z";
// Native separators: the parser requires `path.normalize(p) === p`, which a POSIX literal fails on Windows.
const repoRoot = path.resolve("/repo");
const instructionPath = path.join(repoRoot, "AGENTS.md");
const instructionContent = "Council rules";

function instructionSnapshot() {
	return {
		repoRoot,
		contextFiles: [{ path: instructionPath, content: instructionContent, depth: 0 }],
		files: [{ path: instructionPath, sha256: sha256CouncilContent(instructionContent) }],
		totalBytes: Buffer.byteLength(instructionContent),
	};
}

function manifest(): CouncilManifest {
	return {
		version: 2,
		runId: "run-1",
		sessionId: "session-1",
		mainAgentId: "Main",
		state: "reviewing",
		task: "Review the implementation",
		repoRoot,
		outputPath: "council-review-the-implementation-plan.md",
		timestamps: { createdAt: now, updatedAt: now, startedAt: now },
		config: {
			rounds: 1,
			members: [{ role: "council1", enabled: true, order: 0 }],
			advisor: { planner: false, reviewers: false, adjudicator: false },
		},
		roster: [
			{
				role: "council1",
				enabled: true,
				order: 0,
				rounds: [1],
				advisor: false,
				requestedSelector: "openai/gpt-5.6-sol:max",
				resolvedModel: "openai/gpt-5.6-sol:max",
				effort: "max",
				lens: "Adversarial correctness",
			},
		],
		planner: {
			role: "slow",
			requestedSelector: "openai/gpt-5.6-sol:max",
			resolvedModel: "openai/gpt-5.6-sol:max",
			effort: "max",
			advisor: false,
		},
		adjudicator: {
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: "anthropic/claude-opus-4.1:high",
			effort: "high",
			advisor: false,
			capturedAt: now,
		},
		instructionSnapshot: {
			artifact: {
				url: "local://council-run-1-instructions.json",
				sha256: "1".repeat(64),
				bytes: 256,
			},
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: now,
				finishedAt: null,
				members: [
					{
						role: "council1",
						order: 0,
						status: "running",
						attempts: 1,
						startedAt: now,
						finishedAt: null,
						artifact: null,
						resolvedModel: "openai/gpt-5.6-sol:max",
						authFallbackUsed: false,
						failureReason: null,
						findingIds: [],
					},
				],
			},
		],
		planVersions: [
			{
				version: 1,
				round: 0,
				kind: "draft",
				artifact: { url: "local://council-run-1-draft.md", sha256: "a".repeat(64), bytes: 5 },
				createdAt: now,
			},
		],
		usage: { requests: 2, tokens: 100, cost: 0.25 },
		adjudicationBudget: { injectedChars: 100, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
}

function completedManifest(): CouncilManifest {
	const value = manifest();
	const member = value.rounds[0]!.members[0]!;
	member.status = "succeeded";
	member.finishedAt = now;
	member.artifact = { url: "local://council-run-1-round1-council1.md", sha256: "b".repeat(64), bytes: 7 };
	member.findingIds = ["finding-1"];
	const round = value.rounds[0]!;
	round.status = "settled";
	round.finishedAt = now;
	value.planVersions.push({
		version: 2,
		round: 1,
		kind: "final",
		artifact: { url: "local://council-run-1-round1.md", sha256: "c".repeat(64), bytes: 11 },
		createdAt: now,
	});
	value.published = {
		path: value.outputPath,
		sha256: "d".repeat(64),
		bytes: 11,
		publishedAt: now,
	};
	value.state = "completed";
	value.timestamps.finishedAt = now;
	return value;
}

function twoRoundManifest(): CouncilManifest {
	const value = manifest();
	value.config.rounds = 2;
	value.roster[0]!.rounds = [1, 2];
	value.rounds.push({
		round: 2,
		status: "pending",
		startedAt: null,
		finishedAt: null,
		members: [
			{
				role: "council1",
				order: 0,
				status: "pending",
				attempts: 0,
				startedAt: null,
				finishedAt: null,
				artifact: null,
				resolvedModel: null,
				authFallbackUsed: false,
				failureReason: null,
				findingIds: [],
			},
		],
	});
	return value;
}

/** Usage a pre-upgrade run charged to the live Main session under the old `mainUsage` key. */
const legacyMainUsage: CouncilUsage = { requests: 3, tokens: 512, cost: 0.03 };

/**
 * Everything version 2 added, in one envelope: a reviewer pinned to round 2 beside one that serves
 * both, the three advisor toggles, a planner that resolved through its own model role, and a
 * delegated adjudicator child.
 */
function perRoundManifest(): CouncilManifest {
	const value = twoRoundManifest();
	value.config.advisor = { planner: true, reviewers: true, adjudicator: true };
	value.config.members.push({ role: "council2", enabled: true, order: 1, round: 2 });
	value.roster[0]!.advisor = true;
	value.roster.push({
		role: "council2",
		enabled: true,
		order: 1,
		rounds: [2],
		advisor: true,
		requestedSelector: "anthropic/claude-fable-5:high",
		resolvedModel: "anthropic/claude-fable-5:high",
		effort: "high",
		lens: "Systems integration",
	});
	value.planner.role = "planner";
	value.planner.advisor = true;
	value.adjudicator = {
		mode: "delegated",
		requestedSelector: "openai/gpt-5.6-sol:max",
		resolvedModel: "openai/gpt-5.6-sol:max",
		effort: "max",
		advisor: true,
		capturedAt: now,
		agentIds: ["Counciladjudicatorr1"],
	};
	value.rounds[1]!.members.push({
		role: "council2",
		order: 1,
		status: "pending",
		attempts: 0,
		startedAt: null,
		finishedAt: null,
		artifact: null,
		resolvedModel: null,
		authFallbackUsed: false,
		failureReason: null,
		findingIds: [],
	});
	return value;
}

/** {@link twoRoundManifest} rewritten back into the envelope a version-1 run left on disk. */
function version1Manifest(): Record<string, unknown> {
	const raw = JSON.parse(JSON.stringify({ ...twoRoundManifest(), version: 1, mainUsage: legacyMainUsage })) as Record<
		string,
		unknown
	>;
	delete (raw.config as Record<string, unknown>).advisor;
	for (const member of raw.roster as Array<Record<string, unknown>>) {
		delete member.rounds;
		delete member.advisor;
	}
	delete (raw.planner as Record<string, unknown>).role;
	delete (raw.planner as Record<string, unknown>).advisor;
	const adjudicator = raw.adjudicator as Record<string, unknown>;
	delete raw.adjudicator;
	raw.mainSnapshot = {
		model: adjudicator.resolvedModel,
		effort: adjudicator.effort,
		capturedAt: adjudicator.capturedAt,
	};
	return raw;
}

function expectCorrupt(value: unknown, field: string): void {
	try {
		parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(CouncilManifestError);
		expect((error as CouncilManifestError).field).toContain(field);
	}
}

describe("council manifest strict parsing", () => {
	it("accepts a complete durable identity and rejects valid-JSON omissions at every nested layer", () => {
		expect(parseCouncilManifest(manifest())).toEqual(manifest());
		const omissions: Array<[string, (value: CouncilManifest) => void]> = [
			["planner.effort", value => Reflect.deleteProperty(value.planner, "effort")],
			["adjudicator.effort", value => Reflect.deleteProperty(value.adjudicator, "effort")],
			["roster[0].lens", value => Reflect.deleteProperty(value.roster[0]!, "lens")],
			["config.members[0].enabled", value => Reflect.deleteProperty(value.config.members[0]!, "enabled")],
			["rounds[0].startedAt", value => Reflect.deleteProperty(value.rounds[0]!, "startedAt")],
			["rounds[0].members[0].startedAt", value => Reflect.deleteProperty(value.rounds[0]!.members[0]!, "startedAt")],
			["usage.requests", value => Reflect.deleteProperty(value.usage, "requests")],
			["adjudicationBudget.cap", value => Reflect.deleteProperty(value.adjudicationBudget, "cap")],
			["warnings", value => Reflect.deleteProperty(value, "warnings")],
		];
		for (const [field, mutate] of omissions) {
			const value = manifest();
			mutate(value);
			expectCorrupt(value, field);
		}
	});

	it("round-trips dispatch warnings and rejects malformed warning entries", () => {
		const value = manifest();
		value.warnings = ["Council roles first and second resolve to the same model."];
		value.degraded = true;

		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect(parsed.warnings).toEqual(value.warnings);

		(parsed as { warnings: unknown }).warnings = [""];
		expect(() => parseCouncilManifest(parsed)).toThrow("warnings[0]");
	});

	it("rejects unknown keys at the root and every representative nested object", () => {
		const cases: Array<[string, (value: CouncilManifest) => object]> = [
			["root.extra", value => value],
			["timestamps.extra", value => value.timestamps],
			[
				"published.extra",
				value => {
					value.published = { path: value.outputPath, sha256: "d".repeat(64), bytes: 1, publishedAt: now };
					return value.published;
				},
			],
			["config.extra", value => value.config],
			["config.members[0].extra", value => value.config.members[0]!],
			["roster[0].extra", value => value.roster[0]!],
			["planner.extra", value => value.planner],
			["adjudicator.extra", value => value.adjudicator],
			["instructionSnapshot.extra", value => value.instructionSnapshot],
			["instructionSnapshot.artifact.extra", value => value.instructionSnapshot.artifact],
			["rounds[0].extra", value => value.rounds[0]!],
			["rounds[0].members[0].extra", value => value.rounds[0]!.members[0]!],
			[
				"rounds[0].members[0].artifact.extra",
				value => {
					value.rounds[0]!.members[0]!.artifact = {
						url: "local://council-run-1-member.md",
						sha256: "e".repeat(64),
						bytes: 1,
					};
					return value.rounds[0]!.members[0]!.artifact!;
				},
			],
			["planVersions[0].extra", value => value.planVersions[0]!],
			["usage.extra", value => value.usage],
			["adjudicationBudget.extra", value => value.adjudicationBudget],
			[
				"failure.extra",
				value => {
					value.failure = { phase: "review", reason: "stopped", code: "STOPPED", time: now };
					return value.failure;
				},
			],
		];
		for (const [field, target] of cases) {
			const value = manifest();
			Object.assign(target(value), { extra: true });
			expectCorrupt(value, field);
		}
	});

	it("rejects invalid timestamps, counts, ordering, plan kinds, and status metadata", () => {
		const cases: Array<[string, (value: CouncilManifest) => void]> = [
			["timestamps.createdAt", value => (value.timestamps.createdAt = "2026-02-31T12:00:00.000Z")],
			["attempts", value => (value.rounds[0]!.members[0]!.attempts = 1.5)],
			["roster[0]", value => (value.roster[0]!.order = 1)],
			["rounds[0].round", value => (value.rounds[0]!.round = 2)],
			[
				"planVersions[0].kind",
				value => Object.defineProperty(value.planVersions[0]!, "kind", { value: "revision" }),
			],
			[
				"rounds[0].members[0]",
				value => {
					value.rounds[0]!.members[0]!.status = "succeeded";
					value.rounds[0]!.members[0]!.finishedAt = now;
				},
			],
		];
		for (const [field, mutate] of cases) {
			const value = manifest();
			mutate(value);
			expectCorrupt(value, field);
		}
	});

	it("rejects terminal runs with active children", () => {
		const value = manifest();
		value.state = "completed";
		value.timestamps.finishedAt = now;
		expectCorrupt(value, "rounds");
	});

	it("accepts only canonical plan-version prefixes", () => {
		expect(parseCouncilManifest(twoRoundManifest()).planVersions).toHaveLength(1);

		const missingDraft = manifest();
		missingDraft.planVersions = [{ ...missingDraft.planVersions[0]!, round: 1, kind: "final" }];
		expectCorrupt(missingDraft, "planVersions[0]");

		const duplicateDraft = manifest();
		duplicateDraft.planVersions.push({ ...duplicateDraft.planVersions[0]!, version: 2 });
		expectCorrupt(duplicateDraft, "planVersions[1]");

		const duplicateRound = twoRoundManifest();
		duplicateRound.planVersions.push(
			{ ...duplicateRound.planVersions[0]!, version: 2, round: 1, kind: "round" },
			{ ...duplicateRound.planVersions[0]!, version: 3, round: 1, kind: "round" },
		);
		expectCorrupt(duplicateRound, "planVersions[2]");

		const roundTwoBeforeRoundOne = twoRoundManifest();
		roundTwoBeforeRoundOne.planVersions.push({
			...roundTwoBeforeRoundOne.planVersions[0]!,
			version: 2,
			round: 2,
			kind: "round",
		});
		expectCorrupt(roundTwoBeforeRoundOne, "planVersions[1]");

		const finalAtWrongPosition = twoRoundManifest();
		finalAtWrongPosition.planVersions.push({
			...finalAtWrongPosition.planVersions[0]!,
			version: 2,
			round: 1,
			kind: "final",
		});
		expectCorrupt(finalAtWrongPosition, "planVersions[1]");
	});
	it("accepts only durably published completed manifests", () => {
		expect(parseCouncilManifest(completedManifest())).toEqual(completedManifest());

		const unsettled = completedManifest();
		unsettled.rounds[0]!.status = "interrupted";
		expectCorrupt(unsettled, "rounds");

		const noFinal = completedManifest();
		noFinal.planVersions.pop();
		expectCorrupt(noFinal, "planVersions");

		const unpublished = completedManifest();
		Reflect.deleteProperty(unpublished, "published");
		expectCorrupt(unpublished, "published");

		const wrongPublication = completedManifest();
		wrongPublication.published!.path = "council-wrong-output-plan.md";
		expectCorrupt(wrongPublication, "published.path");
	});

	it("rejects succeeded members that violate their pinned roster identity", () => {
		const fallback = completedManifest();
		fallback.rounds[0]!.members[0]!.authFallbackUsed = true;
		expectCorrupt(fallback, "authFallbackUsed");

		const modelDrift = completedManifest();
		modelDrift.rounds[0]!.members[0]!.resolvedModel = "other/provider-model";
		expectCorrupt(modelDrift, "resolvedModel");
	});

	it("validates instruction artifact identity and parses canonical snapshot contents", () => {
		const referenceTamper = manifest();
		referenceTamper.instructionSnapshot.sha256 = "2".repeat(64);
		expectCorrupt(referenceTamper, "instructionSnapshot.sha256");

		const contentTamper = instructionSnapshot();
		contentTamper.contextFiles[0]!.content = "tampered";
		expect(() => parseCouncilInstructionSnapshot(contentTamper, repoRoot)).toThrow("sha256");

		const byteTamper = instructionSnapshot();
		byteTamper.totalBytes++;
		expect(() => parseCouncilInstructionSnapshot(byteTamper, repoRoot)).toThrow("totalBytes");

		const pathTamper = instructionSnapshot();
		pathTamper.files[0]!.path = path.join(repoRoot, "OTHER.md");
		expect(() => parseCouncilInstructionSnapshot(pathTamper, repoRoot)).toThrow("path");

		const rootTamper = instructionSnapshot();
		rootTamper.repoRoot = path.resolve("/other");
		expect(() => parseCouncilInstructionSnapshot(rootTamper, repoRoot)).toThrow("repoRoot");
	});

	it("accepts the namespaced and legacy grammars and rejects every ambiguous or escaping form", () => {
		const rejected = [
			"x.md",
			"council-x-plan-plan.md",
			"council--plan.md",
			"council-Plan-plan.md",
			`council-${"a".repeat(81)}-plan.md`,
			"../council-x-plan.md",
			"plans/x-plan.md",
			"council-x-plan.MD",
			"nested/council-x-plan.md",
			"council-x-plan.md/",
			"plans/plan.md",
			"plans/Review.md",
			"plans/nested/review.md",
			"plans\\review.md",
			`plans/${"a".repeat(81)}.md`,
		];
		for (const outputPath of rejected) {
			expect(isValidCouncilOutputPath(outputPath)).toBeFalse();
			const value = manifest();
			value.outputPath = outputPath;
			expectCorrupt(value, "outputPath");
		}

		const accepted = [
			"council-review-the-implementation-plan.md",
			"council-x-plan.md",
			"council-x-2-plan.md",
			`council-${"a".repeat(80)}-plan.md`,
			"plans/review-the-implementation.md",
			`plans/${"a".repeat(80)}.md`,
		];
		for (const outputPath of accepted) {
			expect(isValidCouncilOutputPath(outputPath)).toBeTrue();
			const value = manifest();
			value.outputPath = outputPath;
			expect(parseCouncilManifest(JSON.parse(JSON.stringify(value))).outputPath).toBe(outputPath);
		}
	});

	it("binds the published stem to the run origin and rejects a manifest where they disagree", () => {
		// The stem is the only thing keeping an agent-convened brief out of `listPlanFiles`, so a
		// mismatch is corrupt rather than merely odd: an `agent` run wearing a `-plan.md` name would be
		// offered to the operator for execution, and a `command` run wearing `-brief.md` would vanish
		// from the plan listing it was produced for.
		const agentBrief = manifest();
		agentBrief.origin = "agent";
		agentBrief.outputPath = "council-review-the-implementation-brief.md";
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(agentBrief)));
		expect(parsed.origin).toBe("agent");
		expect(parsed.outputPath).toBe("council-review-the-implementation-brief.md");

		const agentWearingPlan = manifest();
		agentWearingPlan.origin = "agent";
		expectCorrupt(agentWearingPlan, "outputPath");

		const commandWearingBrief = manifest();
		commandWearingBrief.origin = "command";
		commandWearingBrief.outputPath = "council-review-the-implementation-brief.md";
		expectCorrupt(commandWearingBrief, "outputPath");

		// An omitted origin is a manifest written before origins existed and reads as `command`, so its
		// `-plan.md` name stays valid and it keeps reaching plan review.
		const legacy = manifest();
		delete legacy.origin;
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(legacy))).origin).toBeUndefined();

		expectCorrupt({ ...manifest(), origin: "operator" }, "origin");
	});

	it("rejects a slug that ends in either published stem", () => {
		// `council-x-brief-brief.md` and `council-x-plan-plan.md` are equally ambiguous; the slug guard
		// has to cover every stem the grammar accepts, not just the original one.
		for (const outputPath of ["council-x-brief-brief.md", "council-x-plan-brief.md", "council-brief-brief.md"]) {
			expect(isValidCouncilOutputPath(outputPath)).toBeFalse();
		}
		expect(isValidCouncilOutputPath("council-x-brief.md")).toBeTrue();
		expect(isValidCouncilOutputPath("council-debrief-brief.md")).toBeTrue();
	});

	it("marks only the pre-retarget plans/<slug>.md form as legacy", () => {
		for (const outputPath of ["plans/review-the-implementation.md", `plans/${"a".repeat(80)}.md`]) {
			expect(isLegacyCouncilOutputPath(outputPath)).toBeTrue();
		}
		for (const outputPath of [
			"council-review-the-implementation-plan.md",
			"council-x-plan.md",
			"plans/x-plan.md",
			"plans/plan.md",
			"plans/nested/review.md",
			"x.md",
		]) {
			expect(isLegacyCouncilOutputPath(outputPath)).toBeFalse();
		}
	});

	it("round-trips per-role usage buckets and still parses manifests written without them", () => {
		const plannerUsage: CouncilUsage = { requests: 1, tokens: 4_096, cost: 0.125 };
		const adjudicatorUsage: CouncilUsage = { requests: 3, tokens: 512, cost: 0.03 };
		const memberUsage: CouncilUsage = { requests: 2, tokens: 2_048, cost: 0.0625 };
		const value = manifest();
		value.plannerUsage = plannerUsage;
		value.adjudicatorUsage = adjudicatorUsage;
		value.rounds[0]!.members[0]!.usage = memberUsage;

		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect(parsed.plannerUsage).toEqual(plannerUsage);
		expect(parsed.adjudicatorUsage).toEqual(adjudicatorUsage);
		expect(parsed.rounds[0]!.members[0]!.usage).toEqual(memberUsage);

		const withoutBuckets = parseCouncilManifest(JSON.parse(JSON.stringify(manifest())));
		expect(withoutBuckets.plannerUsage).toBeUndefined();
		expect(withoutBuckets.adjudicatorUsage).toBeUndefined();
		expect(withoutBuckets.rounds[0]!.members[0]!.usage).toBeUndefined();
		expect(withoutBuckets.usage).toEqual({ requests: 2, tokens: 100, cost: 0.25 });
	});

	it("rejects a pending member that carries a usage bucket", () => {
		const value = twoRoundManifest();
		value.rounds[1]!.members[0]!.usage = { requests: 1, tokens: 10, cost: 0.01 };
		try {
			parseCouncilManifest(JSON.parse(JSON.stringify(value)));
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(CouncilManifestError);
			expect((error as CouncilManifestError).field).toBe("rounds[1].members[0]");
			expect((error as Error).message).toContain("pending member has terminal metadata");
		}
	});

	it("rejects a malformed usage bucket on every per-role key", () => {
		const malformed: ReadonlyArray<Record<string, unknown>> = [
			{ requests: 1, tokens: 10, cost: -0.01 },
			{ requests: 1.5, tokens: 10, cost: 0.01 },
		];
		const suffixes = ["cost", "requests"] as const;
		const targets: Array<[string, (value: CouncilManifest, usage: Record<string, unknown>) => void]> = [
			["plannerUsage", (value, usage) => Object.assign(value, { plannerUsage: usage })],
			["adjudicatorUsage", (value, usage) => Object.assign(value, { adjudicatorUsage: usage })],
			["rounds[0].members[0].usage", (value, usage) => Object.assign(value.rounds[0]!.members[0]!, { usage })],
		];
		for (const [field, assign] of targets) {
			for (const [index, usage] of malformed.entries()) {
				const value = manifest();
				assign(value, usage);
				expectCorrupt(value, `${field}.${suffixes[index]!}`);
			}
		}
	});

	it("requires every captured instruction path to be absolute and normalized", () => {
		for (const candidatePath of ["AGENTS.md", `${repoRoot}${path.sep}nested${path.sep}..${path.sep}AGENTS.md`]) {
			const value = instructionSnapshot();
			value.contextFiles[0]!.path = candidatePath;
			value.files[0]!.path = candidatePath;
			expect(() => parseCouncilInstructionSnapshot(value, repoRoot)).toThrow("path");
		}
	});

	it("keeps a user-level instruction path from outside the repository root", () => {
		// `~/.claude/CLAUDE.md` and friends are legitimate inherited context. The snapshot carries their
		// content inline, so the path is an identity key and containment would reject a healthy run.
		const userLevel = path.resolve("/home/dev/.claude/CLAUDE.md");
		const value = instructionSnapshot();
		value.contextFiles[0]!.path = userLevel;
		value.files[0]!.path = userLevel;

		expect(parseCouncilInstructionSnapshot(value, repoRoot).contextFiles[0]!.path).toBe(userLevel);
	});

	it("round-trips per-round pins, advisor flags, the planner role, and a delegated adjudicator", () => {
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(perRoundManifest())))).toEqual(perRoundManifest());

		const omissions: Array<[string, (value: CouncilManifest) => void]> = [
			["config.advisor", value => Reflect.deleteProperty(value.config, "advisor")],
			["roster[1].rounds", value => Reflect.deleteProperty(value.roster[1]!, "rounds")],
			["roster[1].advisor", value => Reflect.deleteProperty(value.roster[1]!, "advisor")],
			["planner.role", value => Reflect.deleteProperty(value.planner, "role")],
			["planner.advisor", value => Reflect.deleteProperty(value.planner, "advisor")],
			["adjudicator.mode", value => Reflect.deleteProperty(value.adjudicator, "mode")],
		];
		for (const [field, mutate] of omissions) {
			const value = perRoundManifest();
			mutate(value);
			expectCorrupt(value, field);
		}
	});

	it("decodes a version 1 envelope into the documented version 2 defaults", () => {
		const parsed = parseCouncilManifest(version1Manifest());

		expect(parsed.version).toBe(2);
		expect(parsed.adjudicator).toEqual({
			mode: "main",
			requestedSelector: "@main",
			resolvedModel: manifest().adjudicator.resolvedModel,
			effort: manifest().adjudicator.effort,
			advisor: false,
			capturedAt: now,
		});
		expect(parsed.adjudicatorUsage).toEqual(legacyMainUsage);
		expect(parsed.planner.role).toBe("slow");
		expect(parsed.config.advisor).toEqual({ planner: false, reviewers: false, adjudicator: false });
		expect([parsed.planner.advisor, ...parsed.roster.map(member => member.advisor)]).toEqual([false, false]);
		expect(parsed.roster.map(member => member.rounds)).toEqual([[1, 2]]);
		// Every compatibility default reproduces v1 behaviour, so the upgrade lands on the v2 fixture.
		expect(parsed).toEqual({ ...twoRoundManifest(), adjudicatorUsage: legacyMainUsage });
		// The next checkpoint writes v2, so the upgraded envelope must survive a strict re-parse.
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
	});

	it("pairs each round record with exactly the roster subset that serves that round", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(perRoundManifest())));
		expect(parsed.rounds.map(round => round.members.map(member => member.role))).toEqual([
			["council1"],
			["council1", "council2"],
		]);

		const roundOneOverstaffed = perRoundManifest();
		roundOneOverstaffed.rounds[0]!.members.push(structuredClone(roundOneOverstaffed.rounds[1]!.members[1]!));
		expectCorrupt(roundOneOverstaffed, "rounds[0].members");

		const roundTwoMissingPin = perRoundManifest();
		roundTwoMissingPin.rounds[1]!.members.pop();
		expectCorrupt(roundTwoMissingPin, "rounds[1].members");

		const roundOneWrongMember = perRoundManifest();
		roundOneWrongMember.rounds[0]!.members[0]!.role = "council2";
		expectCorrupt(roundOneWrongMember, "rounds[0].members[0]");
	});
});

describe("council recovery and resume identity", () => {
	it("uses one interrupted timestamp for the run, active round, and active member and preserves terminal runs", () => {
		const interruptedAt = "2026-08-05T12:05:00.000Z";
		const recovered = normalizeRecoveredCouncilManifest(parseCouncilManifest(manifest()), interruptedAt);
		expect(recovered).toMatchObject({
			state: "interrupted",
			timestamps: { updatedAt: interruptedAt, finishedAt: interruptedAt, interruptedAt },
		});
		expect(recovered.rounds[0]).toMatchObject({ status: "interrupted", finishedAt: interruptedAt });
		expect(recovered.rounds[0]!.members[0]).toMatchObject({ status: "interrupted", finishedAt: interruptedAt });
		expect(parseCouncilManifest(recovered)).toEqual(recovered);
		expect(normalizeRecoveredCouncilManifest(recovered, "2026-08-05T12:10:00.000Z")).toEqual(recovered);
	});

	it("compares member and planner identity while intentionally excluding a Main-mode adjudicator", () => {
		const persisted = manifest();
		const identity = {
			roster: structuredClone(persisted.roster),
			planner: structuredClone(persisted.planner),
			adjudicator: structuredClone(persisted.adjudicator),
		};
		persisted.adjudicator.resolvedModel = "openai/gpt-6:new-main";
		persisted.adjudicator.effort = null;
		expect(councilResumeMismatches(persisted, identity)).toEqual([]);

		for (const field of ["role", "order", "requestedSelector", "resolvedModel", "effort", "lens"] as const) {
			const incompatible = structuredClone(identity);
			const member = incompatible.roster[0]!;
			if (field === "order") member.order++;
			else if (field === "effort") member.effort = null;
			else member[field] = `${member[field]}-changed`;
			expect(councilResumeMismatches(persisted, incompatible)).toEqual(["roster/planner"]);
		}

		for (const field of ["requestedSelector", "resolvedModel", "effort"] as const) {
			const incompatible = structuredClone(identity);
			if (field === "effort") incompatible.planner.effort = null;
			else incompatible.planner[field] = `${incompatible.planner[field]}-changed`;
			expect(councilResumeMismatches(persisted, incompatible)).toEqual(["roster/planner"]);
		}
	});

	it("attributes a changed round pin to the roster and compares the adjudicator whenever either side is delegated", () => {
		const persisted = perRoundManifest();
		const identity = {
			roster: structuredClone(persisted.roster),
			planner: structuredClone(persisted.planner),
			adjudicator: structuredClone(persisted.adjudicator),
		};
		expect(councilResumeMismatches(persisted, identity)).toEqual([]);

		const movedRound = structuredClone(identity);
		movedRound.roster[1]!.rounds = [1];
		expect(councilResumeMismatches(persisted, movedRound)).toEqual(["roster/planner"]);

		const otherAdjudicatorModel = structuredClone(identity);
		otherAdjudicatorModel.adjudicator.resolvedModel = "anthropic/claude-fable-5:high";
		expect(councilResumeMismatches(persisted, otherAdjudicatorModel)).toEqual(["adjudicator"]);

		const mainRun = manifest();
		const mainIdentity = {
			roster: structuredClone(mainRun.roster),
			planner: structuredClone(mainRun.planner),
			adjudicator: structuredClone(mainRun.adjudicator),
		};
		// A mode flip changes who spends and how the verdict is produced, so it blocks in both directions.
		expect(
			councilResumeMismatches(persisted, { ...identity, adjudicator: structuredClone(mainRun.adjudicator) }),
		).toEqual(["adjudicator"]);
		expect(
			councilResumeMismatches(mainRun, { ...mainIdentity, adjudicator: structuredClone(persisted.adjudicator) }),
		).toEqual(["adjudicator"]);

		// Neither side delegated: the live Main model is informational and never blocks a resume.
		const changedMain = structuredClone(mainRun.adjudicator);
		changedMain.resolvedModel = "openai/gpt-6:new-main";
		expect(councilResumeMismatches(mainRun, { ...mainIdentity, adjudicator: changedMain })).toEqual([]);
	});
});

describe("council resumability", () => {
	it("refuses exactly the terminal classes /council resume refuses", () => {
		const cases: Array<[boolean, Pick<CouncilManifest, "state" | "failure">]> = [
			[true, { state: "interrupted" }],
			[true, { state: "dispatching" }],
			[true, { state: "reviewing" }],
			[true, { state: "failed", failure: { phase: "review", reason: "a member crashed" } }],
			[true, { state: "failed", failure: { phase: "publication", reason: "disk full", code: "ENOSPC" } }],
			[false, { state: "completed" }],
			[false, { state: "completed-degraded" }],
			[false, { state: "failed", failure: { phase: "planner-schema", reason: "invalid planner result" } }],
			[false, { state: "failed", failure: { phase: "publication", reason: "collision", code: "EEXIST" } }],
		];
		for (const [resumable, candidate] of cases) {
			expect(isCouncilResumableManifest({ ...candidate, roster: [] })).toBe(resumable);
		}

		expect(isCouncilResumableManifest(parseCouncilManifest(completedManifest()))).toBeFalse();
		expect(
			isCouncilResumableManifest(
				normalizeRecoveredCouncilManifest(parseCouncilManifest(manifest()), "2026-08-05T12:05:00.000Z"),
			),
		).toBeTrue();
	});
});

describe("council transcript pointers", () => {
	it("keeps agentIds optional so manifests written before transcript pointers still parse", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(manifest())));
		expect(parsed.rounds[0]!.members[0]!.agentIds).toBeUndefined();
		expect(parsed.planner.agentIds).toBeUndefined();
	});

	it("round-trips member and planner transcript pointers", () => {
		const value = completedManifest();
		value.rounds[0]!.members[0]!.agentIds = ["Councilcouncil1r1"];
		value.planner.agentIds = ["Councilplanner-01"];

		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(value)));
		expect(parsed.rounds[0]!.members[0]!.agentIds).toEqual(["Councilcouncil1r1"]);
		expect(parsed.planner.agentIds).toEqual(["Councilplanner-01"]);
	});

	it("accepts one pointer per attempt on a re-run slot and a checkpointed row that has not reserved yet", () => {
		const resumed = completedManifest();
		resumed.rounds[0]!.members[0]!.attempts = 2;
		resumed.rounds[0]!.members[0]!.agentIds = ["Councilcouncil1r1", "Councilcouncil1r1b"];
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(resumed))).rounds[0]!.members[0]!.agentIds).toHaveLength(2);

		// `#runRound` checkpoints status=running with the incremented attempt before the id is reserved.
		const checkpointed = manifest();
		checkpointed.rounds[0]!.members[0]!.attempts = 2;
		checkpointed.rounds[0]!.members[0]!.agentIds = ["Councilcouncil1r1"];
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(checkpointed)))).toBeDefined();
	});

	it("rejects duplicate, malformed, over-cap, over-attempt, and pending transcript pointers", () => {
		const duplicate = completedManifest();
		duplicate.rounds[0]!.members[0]!.attempts = 2;
		duplicate.rounds[0]!.members[0]!.agentIds = ["Councilcouncil1r1", "Councilcouncil1r1"];
		expectCorrupt(duplicate, "agentIds[1]");

		for (const malformed of ["Council/council1", "", "x".repeat(49)]) {
			const value = completedManifest();
			value.rounds[0]!.members[0]!.agentIds = [malformed];
			expectCorrupt(value, "agentIds[0]");
		}

		const overCap = completedManifest();
		const ids = Array.from({ length: COUNCIL_AGENT_ID_LIMIT + 1 }, (_unused, index) => `Councilcouncil1r${index}`);
		overCap.rounds[0]!.members[0]!.attempts = ids.length;
		overCap.rounds[0]!.members[0]!.agentIds = ids;
		expectCorrupt(overCap, "agentIds");

		const overAttempts = completedManifest();
		overAttempts.rounds[0]!.members[0]!.agentIds = ["Councilcouncil1r1", "Councilcouncil1r1b"];
		expectCorrupt(overAttempts, "agentIds");

		const pending = twoRoundManifest();
		pending.rounds[1]!.members[0]!.agentIds = ["Councilcouncil1r2"];
		expectCorrupt(pending, "agentIds");

		const planner = completedManifest();
		planner.planner.agentIds = ["Councilplanner", "Councilplanner"];
		expectCorrupt(planner, "planner.agentIds[1]");
	});
});

describe("council publishing state", () => {
	it("parses publishing as an active, resumable state", () => {
		const value = manifest();
		value.state = "publishing";
		expect(parseCouncilManifest(JSON.parse(JSON.stringify(value))).state).toBe("publishing");
		expect(isCouncilTerminalState("publishing")).toBeFalse();
		expect(isCouncilResumableManifest({ state: "publishing", roster: [] })).toBeTrue();
	});
});

/**
 * A roster recorded before the active-reviewer ceiling existed. Every structural invariant still
 * holds: the config slots, the roster, and the round-1 slots agree, so the payload is readable —
 * only continuing it is blocked.
 */
function oversizedManifest(count: number = COUNCIL_MAX_ACTIVE_REVIEWERS + 1): CouncilManifest {
	const base = manifest();
	const configMember = base.config.members[0]!;
	const rosterMember = base.roster[0]!;
	const roundMember = base.rounds[0]!.members[0]!;
	const role = (index: number) => `council${index + 1}`;
	base.config.members = Array.from({ length: count }, (_unused, index) => ({
		...configMember,
		role: role(index),
		order: index,
	}));
	base.roster = Array.from({ length: count }, (_unused, index) => ({
		...structuredClone(rosterMember),
		role: role(index),
		order: index,
	}));
	base.rounds[0]!.members = Array.from({ length: count }, (_unused, index) => ({
		...structuredClone(roundMember),
		role: role(index),
		order: index,
	}));
	return base;
}

describe("council oversized persisted rosters", () => {
	it("still parses and hydrates a roster recorded above the active reviewer limit", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())));

		// Status, history, HUD, stats, and summary hydration all read this payload; it is not corrupt.
		expect(parsed.roster).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS + 1);
		expect(parsed.rounds[0]!.members).toHaveLength(COUNCIL_MAX_ACTIVE_REVIEWERS + 1);
		expect(parsed.state).toBe("reviewing");
		expect(councilManifestActiveReviewerCount(parsed)).toBe(COUNCIL_MAX_ACTIVE_REVIEWERS + 1);
	});

	it("excludes an oversized run from resume selection and from the ordinary resume hint", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())));

		// Its state still has work left — the roster is what makes it unusable.
		expect(isCouncilResumableRunState(parsed)).toBeTrue();
		expect(isCouncilResumableManifest(parsed)).toBeFalse();
	});

	it("names the run, the observed count, the limit, and the recovery", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())));

		expect(councilResumeRosterLimitRefusal(parsed)).toBe(
			"Council run run-1 has 65 active reviewers, above the 64-reviewer limit an adjudication can grade, so it cannot be resumed. Reduce the roster with /council config (Model Hub -> Roles & Council) and start a new run.",
		);
	});

	it("stays silent at exactly the limit and for a run that was already terminal", () => {
		const atLimit = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest(COUNCIL_MAX_ACTIVE_REVIEWERS))));

		expect(isCouncilResumableManifest(atLimit)).toBeTrue();
		expect(isCouncilRosterOverResumeLimit(atLimit)).toBeFalse();
		expect(councilResumeRosterLimitRefusal(atLimit)).toBeUndefined();

		// A completed oversized run keeps "already completed; nothing to resume" instead of being
		// relabelled with a roster complaint it can do nothing about — and stays selectable as the
		// terminal fallback it has always been.
		const completed = { runId: "run-1", state: "completed", roster: oversizedManifest().roster } as const;
		expect(isCouncilRosterOverResumeLimit(completed)).toBeFalse();
		expect(councilResumeRosterLimitRefusal(completed)).toBeUndefined();
		expect(isCouncilResumableManifest(completed)).toBeFalse();
	});

	it("is not a resume candidate at any selection priority", () => {
		const earlier = "2026-08-05T11:00:00.000Z";
		const eligibleValue = manifest();
		eligibleValue.timestamps = { createdAt: earlier, updatedAt: earlier, startedAt: earlier };
		eligibleValue.rounds[0]!.startedAt = earlier;
		eligibleValue.rounds[0]!.members[0]!.startedAt = earlier;
		eligibleValue.planVersions[0]!.createdAt = earlier;
		const eligible = parseCouncilManifest(JSON.parse(JSON.stringify(eligibleValue)));
		const oversized = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())));
		const newestFirst = [oversized, eligible].sort(
			(a, b) => Date.parse(b.timestamps.createdAt) - Date.parse(a.timestamps.createdAt),
		);

		expect(newestFirst[0]).toBe(oversized);
		// Neither the eligible pass nor the terminal fallback behind it may pick the oversized run up,
		// so it can never shadow the older run a no-id resume could actually finish.
		expect(newestFirst.find(isCouncilResumableManifest)).toBe(eligible);
		expect(newestFirst.find(candidate => !isCouncilRosterOverResumeLimit(candidate))).toBe(eligible);
	});

	it("leaves nothing selectable when every stored run is oversized, and still explains why", () => {
		const stored = [parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())))];

		expect(stored.find(isCouncilResumableManifest)).toBeUndefined();
		expect(stored.find(candidate => !isCouncilRosterOverResumeLimit(candidate))).toBeUndefined();
		// Nothing is selected, but the run is neither absent nor corrupt: the limit is what gets said.
		expect(isCouncilResumableRunState(stored[0]!)).toBeTrue();
		expect(councilResumeRosterLimitRefusal(stored[0]!)).toContain("65 active reviewers");
	});

	it("does not count disabled or round-parked slots toward the limit", () => {
		const parsed = parseCouncilManifest(JSON.parse(JSON.stringify(oversizedManifest())));
		const roster = structuredClone(parsed.roster);
		roster[0]!.enabled = false;
		roster[1]!.rounds = [];

		expect(councilManifestActiveReviewerCount({ roster })).toBe(COUNCIL_MAX_ACTIVE_REVIEWERS - 1);
		expect(isCouncilResumableManifest({ state: "reviewing", roster })).toBeTrue();
	});
});
