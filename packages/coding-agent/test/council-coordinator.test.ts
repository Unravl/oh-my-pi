import { afterEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	CouncilCoordinator,
	type CouncilCoordinatorHost,
	type CouncilCoordinatorSnapshot,
	type CouncilKickoffPreview,
	formatCouncilKickoff,
	getCouncilCoordinator,
	peekCouncilCoordinatorForSession,
	quiesceAndReleaseCouncilForSessionTransition,
	releaseCouncilCoordinator,
	resetCouncilCoordinatorsForTests,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import {
	COUNCIL_RUN_MESSAGE_TYPE,
	COUNCIL_SUMMARY_MESSAGE_TYPE,
	type CouncilRunEventKind,
} from "@oh-my-pi/pi-coding-agent/council/events";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import type { CouncilDispatchPlan } from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as preflight from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as publication from "@oh-my-pi/pi-coding-agent/council/publication";
import {
	COUNCIL_ADJUDICATION_INJECTION_CAP,
	councilSlotPrefix,
	validateIncomingCouncilReport,
} from "@oh-my-pi/pi-coding-agent/council/schema";
import {
	COUNCIL_MANIFEST_VERSION,
	type CouncilManifest,
	parseCouncilManifest,
} from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilStorage } from "@oh-my-pi/pi-coding-agent/council/storage";
import type {
	StructuredSubagentRequest,
	StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as subagents from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { CouncilAdjudicationHandler } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { TempDir } from "@oh-my-pi/pi-utils";

const PLAN = [
	"## Context",
	"Repository evidence.",
	"## Approach",
	"1. Make the change.",
	"## Critical files & anchors",
	"`src/example.ts`: established invariant.",
	"## Verification",
	"Exercise the changed path.",
	"## Assumptions & contingencies",
	"No unresolved assumptions.",
].join("\n\n");

const plannerModel = { provider: "planner", id: "fixed" } as Model<Api>;
const mainModel = { provider: "main", id: "fixed" } as Model<Api>;

interface AdjudicationTestState {
	pending?: Promise<void>;
	skipHandler: boolean;
	onPrompt?: () => void;
	onAbort?: () => void;
	busyFailures?: number;
	busyPending?: Promise<void>;
	onBusyAttempt?: () => void;
	plan?: string;
	afterAcceptedError?: Error;
}

interface SummaryTestState {
	failures: number;
	attempts: number;
	declines?: number;
	pending?: Promise<void>;
	onAttempt?: () => void;
}

/** Shape of one durable custom message as the coordinator hands it to the session. */
interface DeliveredCustomMessage {
	customType: string;
	content: string;
	details?: Record<string, unknown>;
}

interface Harness {
	host: CouncilCoordinatorHost;
	dispatch: CouncilDispatchPlan;
	toolSession: ToolSession;
	/** Canonical session `local://` root every council artifact and the published plan share. */
	planRoot: string;
	summaries: DeliveredCustomMessage[];
	/** Durable `council-run` lifecycle events, in delivery order. */
	lifecycleEvents: DeliveredCustomMessage[];
	/** `sendCustomMessage` options recorded for each accepted `council-summary` delivery. */
	summaryOptions: { deliverAs?: string }[];
	/** `CouncilCoordinatorHost.presentCouncilSummary` calls, in order. */
	presentations: { runId: string; deferred: boolean; content: string; details: Record<string, unknown> }[];
	/** Flip the session's streaming flag the way an in-flight user turn would. */
	setStreaming: (value: boolean) => void;
	prompts: string[];
	summaryState: SummaryTestState;
	adjudicationState: AdjudicationTestState;
	journal: CouncilManifest[];
}

const temporaryDirectories: TempDir[] = [];

afterEach(async () => {
	vi.useRealTimers();
	mock.restore();
	resetCouncilCoordinatorsForTests();
	await Promise.all(temporaryDirectories.splice(0).map(directory => directory.remove()));
});

function memberModel(role: string): Model<Api> {
	return { provider: "member", id: role } as Model<Api>;
}
function makeHarness(rounds: 1 | 2 = 1, roles = ["correctness", "architecture"]): Harness {
	const temp = TempDir.createSync("@pi-council-coordinator-");
	temporaryDirectories.push(temp);
	const repoRoot = temp.path();
	// The published plan now lands in the session `local://` cache, never the working tree, and every
	// containment check downstream compares against the canonical (realpath) form of that root.
	const planRoot = path.join(realpathSync(repoRoot), "artifacts", "local");
	const settings = Settings.isolated({ "task.maxConcurrency": 2 });
	const journal: CouncilManifest[] = [];
	let handler: CouncilAdjudicationHandler | undefined;
	const toolSession = {
		cwd: repoRoot,
		settings,
		localProtocolOptions: {
			getArtifactsDir: () => temp.join("artifacts"),
			getSessionId: () => "session-one",
		},
		sessionManager: {
			getSessionId: () => "session-one",
			appendCustomEntry: (_type: string, data: unknown) => {
				journal.push(parseCouncilManifest(structuredClone(data)));
				return `${journal.length}`;
			},
		},
		peekCouncilHandler: () => handler ?? undefined,
		setCouncilHandler: (value: CouncilAdjudicationHandler | null) => {
			handler = value ?? undefined;
		},
	} as unknown as ToolSession;
	const summaries: DeliveredCustomMessage[] = [];
	const lifecycleEvents: DeliveredCustomMessage[] = [];
	const summaryOptions: { deliverAs?: string }[] = [];
	const presentations: { runId: string; deferred: boolean; content: string; details: Record<string, unknown> }[] = [];
	const prompts: string[] = [];
	const summaryState: SummaryTestState = { failures: 0, attempts: 0 };
	const adjudicationState: AdjudicationTestState = { skipHandler: false };
	const session = {
		model: mainModel,
		thinkingLevel: undefined,
		isStreaming: false,
		messages: [] as AgentMessage[],
		getActiveToolNames: () => ["read", "write"],
		waitForIdle: mock(async () => {}),
		abort: mock(async () => adjudicationState.onAbort?.()),
		promptCustomMessage: mock(async (message: { content: string }, options?: { onPromptStart?: () => void }) => {
			prompts.push(message.content);
			adjudicationState.onPrompt?.();
			if ((adjudicationState.busyFailures ?? 0) > 0) {
				adjudicationState.onBusyAttempt?.();
				if (adjudicationState.busyPending) await adjudicationState.busyPending;
				adjudicationState.busyFailures = (adjudicationState.busyFailures ?? 1) - 1;
				throw new AgentBusyError();
			}
			options?.onPromptStart?.();
			if (adjudicationState.pending) await adjudicationState.pending;
			if (adjudicationState.skipHandler) return;
			const active = toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const ids = [...message.content.matchAll(/"id":"([A-Z]+\d+)"/g)].map(match => match[1]!);
			// Every reporting slot owes a grade; the slots are the ones the assignment injected.
			const slots = [...new Set([...message.content.matchAll(/"slot":(\d+)/g)].map(match => Number(match[1])))];
			const result = await active(
				JSON.stringify({
					plan: adjudicationState.plan ?? PLAN,
					dispositions: ids.map(id => ({ id, disposition: "accepted", reason: "Supported", step: "Approach 1" })),
					grades: slots.map(slot => ({ slot, grade: "A", reason: "Verified high-severity findings" })),
				}),
			);
			if (result.isError) throw new Error("Test adjudication was rejected");
			if (adjudicationState.afterAcceptedError) throw adjudicationState.afterAcceptedError;
		}),
		sendCustomMessage: mock(
			async (
				message: DeliveredCustomMessage,
				options?: { deliverAs?: string; expectedSessionId?: string; deliveryReceipt?: { delivered: boolean } },
			) => {
				// Lifecycle events ride the same sink as the summary card but are a separate durable
				// stream: they must not consume the card's retry/decline fixtures.
				if (message.customType === COUNCIL_RUN_MESSAGE_TYPE) {
					if (options?.expectedSessionId && sessionManager.getSessionId() !== options.expectedSessionId) {
						return false;
					}
					lifecycleEvents.push(message);
					if (options?.deliveryReceipt) options.deliveryReceipt.delivered = true;
					return false;
				}
				summaryState.attempts++;
				summaryState.onAttempt?.();
				if (summaryState.pending) await summaryState.pending;
				if ((summaryState.declines ?? 0) > 0) {
					summaryState.declines = (summaryState.declines ?? 1) - 1;
					return false;
				}
				if (options?.expectedSessionId && sessionManager.getSessionId() !== options.expectedSessionId) return false;
				if (summaryState.failures > 0) {
					summaryState.failures--;
					throw new Error("transient summary failure");
				}
				summaries.push(message);
				summaryOptions.push({ deliverAs: options?.deliverAs });
				if (options?.deliveryReceipt) options.deliveryReceipt.delivered = true;
				return false;
			},
		),
		get sessionManager() {
			return sessionManager;
		},
	};
	const sessionManager = {
		getSessionId: () => "session-one",
		getCwd: () => repoRoot,
	};
	const configMembers = roles.map((role, order) => ({ role, enabled: true, order }));
	const memberRounds = Array.from({ length: rounds }, (_, index) => index + 1);
	const members = configMembers.map(member => ({
		...member,
		requestedSelector: `member/${member.role}`,
		resolvedSelector: `member/${member.role}`,
		model: memberModel(member.role),
		effort: undefined,
		lens: `Inspect ${member.role}`,
		rounds: memberRounds,
		advisor: false,
	}));
	const instructions = { repoRoot, contextFiles: [], files: [], totalBytes: 0 };
	const dispatch = {
		task: "Implement council coordination",
		cwd: repoRoot,
		repoRoot,
		sessionId: "session-one",
		origin: "command" as const,
		publicationTarget: {
			planRoot,
			slug: "implement-council-coordination",
			fileName: "council-implement-council-coordination-plan.md",
			relativePath: "council-implement-council-coordination-plan.md",
			absolutePath: path.join(planRoot, "council-implement-council-coordination-plan.md"),
		},
		config: { rounds, members: configMembers, advisor: { planner: false, reviewers: false, adjudicator: false } },
		rounds,
		roster: configMembers,
		members,
		inert: [],
		planner: {
			role: "slow",
			requestedSelector: "planner/fixed",
			resolvedSelector: "planner/fixed",
			model: plannerModel,
			effort: undefined,
			advisor: false,
		},
		adjudicator: { mode: "main" as const, selector: "main/fixed", model: mainModel, effort: undefined },
		instructions,
		warnings: [],
		degraded: false,
		plannerRequest: {
			session: toolSession,
			invocationKind: "task",
			assignment: "placeholder",
			agent: "council-planner",
			model: "planner/fixed",
			tools: ["read", "grep", "glob", "lsp", "ast_grep"],
			restrictToolNames: true,
			inheritContextFiles: true,
			additionalContextFiles: [],
			skills: [],
			rules: [],
			autoloadSkills: [],
			pinModel: true,
			outputSchema: {},
			schemaMode: "strict",
			enableIrc: false,
		},
		memberRequests: members.map(member => ({
			session: toolSession,
			invocationKind: "task" as const,
			assignment: "placeholder",
			agent: "council-member" as const,
			model: member.resolvedSelector,
			tools: ["read", "grep", "glob", "lsp", "ast_grep"],
			restrictToolNames: true,
			inheritContextFiles: true,
			additionalContextFiles: [],
			skills: [],
			rules: [],
			autoloadSkills: [],
			pinModel: true,
			outputSchema: {},
			schemaMode: "strict" as const,
			enableIrc: false,
		})),
	} satisfies CouncilDispatchPlan;
	const host = {
		session,
		toolSession,
		sessionManager,
		settings,
		modelRegistry: { getApiKey: mock(async () => "test-key") },
		now: () => new Date().toISOString(),
		presentCouncilSummary: (delivery: {
			runId: string;
			deferred: boolean;
			content: string;
			details: Record<string, unknown>;
		}) => {
			presentations.push(delivery);
		},
		runId: "run-one",
	} as unknown as CouncilCoordinatorHost;
	return {
		host,
		dispatch,
		toolSession,
		planRoot,
		summaries,
		lifecycleEvents,
		summaryOptions,
		presentations,
		setStreaming: (value: boolean) => {
			session.isStreaming = value;
		},
		summaryState,
		adjudicationState,
		prompts,
		journal,
	};
}

function structuredResult(
	request: StructuredSubagentRequest,
	data: unknown,
	options?: { exitCode?: number },
): StructuredSubagentResult {
	const model = Array.isArray(request.model) ? request.model[0]! : request.model!;
	return {
		result: {
			index: request.index ?? 0,
			id: request.identity?.label ?? "child",
			agent: request.agent ?? "task",
			agentSource: "bundled",
			task: request.assignment,
			assignment: request.assignment,
			exitCode: options?.exitCode ?? 0,
			output: JSON.stringify(data),
			stderr: options?.exitCode ? "schema violation" : "",
			truncated: false,
			durationMs: 1,
			tokens: 10,
			requests: 1,
			resolvedModel: model,
			authFallbackUsed: false,
			structuredOutput: { source: "caller", mode: "strict", status: options?.exitCode ? "invalid" : "valid", data },
		},
		policy: {} as StructuredSubagentResult["policy"],
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "",
		temporaryArtifacts: true,
	};
}

function installDispatch(harness: Harness): void {
	spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
	spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
		const target = path.join(options.planRoot, ...options.outputPath.split("/"));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, options.content);
		return {
			path: options.outputPath,
			sha256: sha256CouncilContent(options.content),
			bytes: Buffer.byteLength(options.content),
			publishedAt: "2026-08-05T00:00:00.000Z",
			idempotent: false,
		};
	});
}

function modelIdentity(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Persist a durable manifest the coordinator never ran, so no-id resume selection can be exercised
 * against exact `createdAt`/`state`/`failure` combinations. Roster, planner, config, task, root, and
 * instruction snapshot are mirrored from the harness dispatch so `#assertResumeIdentity` accepts it.
 */
async function seedCouncilManifest(
	harness: Harness,
	options: {
		runId: string;
		createdAt: string;
		state: CouncilManifest["state"];
		outputPath: string;
		failure?: NonNullable<CouncilManifest["failure"]>;
	},
): Promise<CouncilManifest> {
	const storage = new CouncilStorage(harness.toolSession);
	const artifact = await storage.createArtifact(
		options.runId,
		"instructions.json",
		`${JSON.stringify(harness.dispatch.instructions)}\n`,
	);
	const terminal = options.state === "interrupted" || options.state === "failed";
	return storage.create(
		parseCouncilManifest({
			version: COUNCIL_MANIFEST_VERSION,
			runId: options.runId,
			sessionId: harness.dispatch.sessionId,
			mainAgentId: "main",
			state: options.state,
			task: harness.dispatch.task,
			repoRoot: harness.dispatch.repoRoot,
			outputPath: options.outputPath,
			timestamps: {
				createdAt: options.createdAt,
				updatedAt: options.createdAt,
				startedAt: options.createdAt,
				...(terminal ? { finishedAt: options.createdAt } : {}),
				...(options.state === "interrupted" ? { interruptedAt: options.createdAt } : {}),
			},
			config: structuredClone(harness.dispatch.config),
			roster: harness.dispatch.members.map(member => ({
				role: member.role,
				enabled: true,
				order: member.order,
				requestedSelector: member.requestedSelector,
				resolvedModel: modelIdentity(member.model),
				effort: member.effort ?? null,
				lens: member.lens,
				rounds: [...member.rounds],
				advisor: member.advisor,
			})),
			planner: {
				role: harness.dispatch.planner.role,
				requestedSelector: harness.dispatch.planner.requestedSelector,
				resolvedModel: modelIdentity(harness.dispatch.planner.model),
				effort: harness.dispatch.planner.effort ?? null,
				advisor: harness.dispatch.planner.advisor,
			},
			adjudicator: {
				mode: "main",
				requestedSelector: "@main",
				resolvedModel: modelIdentity(mainModel),
				effort: null,
				advisor: false,
				capturedAt: options.createdAt,
				instructionSha256: artifact.sha256,
			},
			instructionSnapshot: { artifact, sha256: artifact.sha256 },
			rounds: Array.from({ length: harness.dispatch.rounds }, (_unused, index) => ({
				round: index + 1,
				status: "pending",
				startedAt: null,
				finishedAt: null,
				members: harness.dispatch.members.map(member => ({
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
				})),
			})),
			planVersions: [],
			usage: { requests: 0, tokens: 0, cost: 0 },
			adjudicationBudget: { injectedChars: 0, cap: COUNCIL_ADJUDICATION_INJECTION_CAP },
			warnings: [],
			degraded: false,
			...(options.failure ? { failure: options.failure } : {}),
		}),
	);
}

/** One assistant message of Main spend, shaped exactly as `#chargeMainTurn` reads it. */
function adjudicationTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "council adjudication turn" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixed",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 7,
			cacheWrite: 3,
			totalTokens: 130,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("CouncilCoordinator", () => {
	it("preflights before spend and creates no storage when preflight blocks", async () => {
		const harness = makeHarness();
		const blocker = new Error("blocked before spend");
		spyOn(preflight, "preflightCouncilDispatch").mockRejectedValue(blocker);
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.start("blocked task")).rejects.toBe(blocker);
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("persists dispatch warnings in every coordinator snapshot and terminal summary", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const duplicateWarning = "Council roles correctness and architecture resolve to the same model.";
		harness.dispatch.warnings = [duplicateWarning];
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = await coordinator.start(harness.dispatch.task);
		expect(started.warnings).toEqual([duplicateWarning]);
		await coordinator.completion;
		expect(coordinator.snapshot?.warnings).toEqual([duplicateWarning]);
		expect(JSON.stringify(harness.summaries[0])).toContain(duplicateWarning);
	});

	it("uses an unprefixed UUID as the default run identity", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.host.runId = undefined;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = await coordinator.start(harness.dispatch.task);
		expect(started.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(started.runId).not.toStartWith("council-");
		await coordinator.completion;
	});

	it("refreshes Main identity from the model that owns adjudication", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const switchedMain = memberModel("correctness");
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			(harness.host.session as { model: Model<Api> }).model = switchedMain;
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.adjudicator.resolvedModel).toBe("member/correctness");
		expect(coordinator.snapshot?.warnings).toEqual([]);
		expect(coordinator.snapshot?.state).toBe("completed");
	});
	it("retries Main acquisition when effective effort changes before ownership", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const reasoningMain = {
			provider: "main",
			id: "reasoning",
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "high"] },
		} as unknown as Model<Api>;
		const mutableSession = harness.host.session as unknown as {
			model: Model<Api>;
			thinkingLevel: "low" | "high";
		};
		mutableSession.model = reasoningMain;
		mutableSession.thinkingLevel = "low";
		let acquisitions = 0;
		harness.adjudicationState.onPrompt = () => {
			if (acquisitions++ === 0) mutableSession.thinkingLevel = "high";
		};
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts).toHaveLength(2);
		expect(coordinator.snapshot?.adjudicator).toMatchObject({
			resolvedModel: "main/reasoning",
			effort: "high",
		});
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("fails before prompting when the live adjudication model lacks required capabilities", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const unavailable = { provider: "offline", id: "no-tools", supportsTools: false } as Model<Api>;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			(harness.host.session as { model: Model<Api> }).model = unavailable;
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts).toHaveLength(0);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.reason).toContain("does not support tools");
	});

	it("rejects a stale adjudication handler before manifest creation or model spend", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		harness.toolSession.setCouncilHandler?.(async () => ({
			content: [{ type: "text", text: "stale handler" }],
		}));
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.start(harness.dispatch.task)).rejects.toThrow("already active");
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("aborts a pending preflight before storage or model spend", async () => {
		const harness = makeHarness();
		const preflightPending = Promise.withResolvers<CouncilDispatchPlan>();
		spyOn(preflight, "preflightCouncilDispatch").mockReturnValue(preflightPending.promise);
		const run = spyOn(subagents, "runStructuredSubagent");
		const coordinator = new CouncilCoordinator(harness.host);
		const starting = coordinator.start(harness.dispatch.task);
		expect(coordinator.executionInFlight).toBe(true);

		let startError: unknown;
		const observedStart = starting.catch(error => {
			startError = error;
		});
		const cancelling = coordinator.cancelForSessionTransition();
		preflightPending.resolve(harness.dispatch);

		await Promise.all([observedStart, cancelling]);
		expect(startError).toMatchObject({ name: "AbortError" });
		expect(coordinator.executionInFlight).toBe(false);
		expect(run).not.toHaveBeenCalled();
		expect(harness.journal).toHaveLength(0);
		expect(coordinator.snapshot).toBeUndefined();
	});

	it("terminalizes a setup cancellation after manifest creation and leaves the next start unblocked", async () => {
		const harness = makeHarness(1, ["correctness"]);
		let run = 0;
		harness.host.runId = () => `run-${++run}`;
		installDispatch(harness);
		const createPersisted = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<void>();
		let deferFirstCreate = true;
		const create = CouncilStorage.prototype.create;
		spyOn(CouncilStorage.prototype, "create").mockImplementation(async function (
			this: CouncilStorage,
			manifest: CouncilManifest,
		) {
			const created = await create.call(this, manifest);
			if (deferFirstCreate) {
				deferFirstCreate = false;
				createPersisted.resolve();
				await releaseCreate.promise;
			}
			return created;
		});
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		let startError: unknown;
		const starting = coordinator.start(harness.dispatch.task).catch(error => {
			startError = error;
		});
		await createPersisted.promise;

		const cancellation = coordinator.cancelForSessionTransition();
		releaseCreate.resolve();
		await Promise.all([starting, cancellation]);
		expect(startError).toMatchObject({ name: "AbortError" });
		expect(coordinator.snapshot?.state).toBe("interrupted");

		const next = await coordinator.start(harness.dispatch.task);
		expect(next.runId).toBe("run-2");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("keeps an operational planner failure resumable instead of misclassifying missing output as schema failure", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const instructionFile = {
			path: path.join(harness.dispatch.repoRoot, "AGENTS.md"),
			content: "persisted council instructions",
			depth: 0,
		};
		harness.dispatch.instructions = {
			repoRoot: harness.dispatch.repoRoot,
			contextFiles: [instructionFile],
			files: [{ path: instructionFile.path, sha256: sha256CouncilContent(instructionFile.content) }],
			totalBytes: Buffer.byteLength(instructionFile.content),
		};
		installDispatch(harness);
		let plannerFailed = false;
		const resumedContexts: unknown[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				if (!plannerFailed) {
					plannerFailed = true;
					return structuredResult(request, undefined, { exitCode: 1 });
				}
				resumedContexts.push(structuredClone(request.additionalContextFiles));
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			resumedContexts.push(structuredClone(request.additionalContextFiles));
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure?.phase).toBe("planner");
		harness.dispatch.plannerRequest.additionalContextFiles = [
			{ path: instructionFile.path, content: "stale request context", depth: 0 },
		];
		for (const request of harness.dispatch.memberRequests) {
			request.additionalContextFiles = [{ path: instructionFile.path, content: "stale request context", depth: 0 }];
		}
		await coordinator.resume("run-one");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(resumedContexts).toEqual([[instructionFile], [instructionFile]]);
	});

	it.each(["planner", "member", "round"] as const)(
		"adopts a %s artifact crash window without duplicating its model call",
		async phase => {
			const harness = makeHarness(1, ["correctness"]);
			installDispatch(harness);
			let plannerCalls = 0;
			let memberCalls = 0;
			spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
				if (request.agent === "council-planner") {
					plannerCalls++;
					return structuredResult(request, {
						plan: PLAN,
						assumptions: [],
						blockers: [],
						evidenceVersion: "1.0.0",
					});
				}
				memberCalls++;
				return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
			});
			const completed = new CouncilCoordinator(harness.host);
			await completed.start(harness.dispatch.task);
			await completed.completion;

			const rewind = [...harness.journal].reverse().find(candidate => {
				if (phase === "planner") return candidate.planVersions.length === 0 && candidate.state === "planning";
				if (phase === "member") {
					const member = candidate.rounds[0]?.members[0];
					return (
						candidate.planVersions.length === 1 &&
						member?.status === "running" &&
						member.resolvedModel !== null &&
						member.artifact === null
					);
				}
				return candidate.planVersions.length === 1 && candidate.rounds[0]?.status === "settled";
			});
			if (!rewind) throw new Error(`Missing ${phase} crash-window manifest fixture`);
			const storage = new CouncilStorage(harness.toolSession);
			await storage.checkpoint(structuredClone(rewind));
			const artifactsDirectory = harness.toolSession.localProtocolOptions!.getArtifactsDir!();
			if (!artifactsDirectory) throw new Error("Council test harness has no artifacts directory");
			const localRoot = path.join(artifactsDirectory, "local");
			if (phase === "planner") {
				await fs.rm(path.join(localRoot, "council-run-one-correctness-r1.json"), { force: true });
			}
			if (phase !== "round") {
				await fs.rm(path.join(localRoot, "council-run-one-round1.md"), { force: true });
				await fs.rm(harness.dispatch.publicationTarget.absolutePath, { force: true });
			}
			plannerCalls = 0;
			memberCalls = 0;
			harness.prompts.length = 0;

			const resumed = new CouncilCoordinator(harness.host);
			await resumed.resume("run-one");
			await resumed.completion;

			expect(plannerCalls).toBe(0);
			expect(memberCalls).toBe(phase === "planner" ? 1 : 0);
			expect(harness.prompts).toHaveLength(phase === "round" ? 0 : 1);
			expect(resumed.snapshot?.state).toBe("completed");
		},
	);

	it("keeps strict-invalid planner output terminal even when strict finalization sets exit code one", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, {}, { exitCode: 1 })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure?.phase).toBe("planner-schema");
		await expect(coordinator.resume("run-one")).rejects.toThrow("cannot be resumed");
	});

	it("single-flights concurrent starts before preflight or storage allocation", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const first = coordinator.start(harness.dispatch.task);
		const competing = coordinator.start(harness.dispatch.task);
		await expect(competing).rejects.toThrow("still settling");
		await first;
		await coordinator.completion;

		expect(preflight.preflightCouncilDispatch).toHaveBeenCalledTimes(1);
		expect(run.mock.calls.filter(([request]) => request.agent === "council-planner")).toHaveLength(1);
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("fails an escape-heavy planner basis before dispatching any member", async () => {
		const harness = makeHarness(1, ["correctness", "architecture"]);
		installDispatch(harness);
		let memberCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent !== "council-planner") {
				memberCalls++;
				return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
			}
			return structuredResult(request, {
				// The plan must stay inside COUNCIL_PLAN_CHAR_LIMIT (so the schema accepts
				// it) while its JSON-escaped form blows COUNCIL_ADJUDICATION_INJECTION_CAP.
				// `"\` only doubles under escaping, which can no longer span that gap;
				// control characters expand 6x (`\u0001`), the true worst case.
				plan: `${PLAN}\n${"\u0001".repeat(100_000)}`,
				assumptions: [],
				blockers: [],
				evidenceVersion: "1.0.0",
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(memberCalls).toBe(0);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.reason).toContain("fixed context exceeds");
	});

	it("checkpoints the planner before concurrent pinned and confined members, then publishes once", async () => {
		const harness = makeHarness();
		installDispatch(harness);
		const calls: StructuredSubagentRequest[] = [];
		let activeMembers = 0;
		let maximumActiveMembers = 0;
		const allMembersStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			calls.push(request);
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			activeMembers++;
			maximumActiveMembers = Math.max(maximumActiveMembers, activeMembers);
			if (activeMembers === harness.dispatch.members.length) allMembersStarted.resolve();
			await allMembersStarted.promise;
			activeMembers--;
			return structuredResult(request, {
				readiness: "revise",
				findings: [
					{
						classification: "must-fix",
						severity: "high",
						confidence: "high",
						evidence: [
							{ path: "src/example.ts", observation: "The existing path establishes the required invariant." },
						],
						impact: "Incorrect behavior",
						required: true,
						recommendation: "Use the established path",
						rejectedAssumptions: [],
						verification: ["Exercise the path"],
					},
				],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.failure).toBeUndefined();
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(calls[0]?.agent).toBe("council-planner");
		expect(maximumActiveMembers).toBe(2);
		for (const request of calls) {
			expect(request.pinModel).toBe(true);
			expect(request.identity?.inspectOnly).toBe(true);
			expect(request.restrictToolNames).toBe(true);
			expect(request.skills).toEqual([]);
			expect(request.rules).toEqual([]);
			expect(request.autoloadSkills).toEqual([]);
			expect(request.signal).toBeDefined();
		}
		const draftCheckpoint = harness.journal.findIndex(entry => entry.planVersions.length === 1);
		const memberCheckpoint = harness.journal.findIndex(entry =>
			entry.rounds[0]?.members.some(member => member.attempts > 0),
		);
		expect(draftCheckpoint).toBeGreaterThanOrEqual(0);
		expect(memberCheckpoint).toBeGreaterThan(draftCheckpoint);
		expect(coordinator.snapshot?.rounds[0]?.members.map(member => member.findingIds)).toEqual([["A1"], ["B1"]]);
		expect(harness.summaries).toHaveLength(1);
	});

	it("degrades under oversized aggregate member errors without exceeding adjudication injection bounds", async () => {
		const roles = Array.from({ length: 80 }, (_, index) => `reviewer${index}`);
		const harness = makeHarness(1, roles);
		installDispatch(harness);
		const oversizedReason = `provider failure ${"x".repeat(2_000)}`;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			throw new Error(oversizedReason);
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed-degraded");
		expect(harness.prompts).toHaveLength(1);
		expect(harness.prompts[0]!.length).toBeLessThanOrEqual(COUNCIL_ADJUDICATION_INJECTION_CAP);
		expect(harness.prompts[0]).toContain("Member reviewer0 (slot 1) failed:");
		expect(harness.prompts[0]).not.toContain(oversizedReason);
	});

	it("retries one malformed member payload and keeps deterministic global IDs across two rounds", async () => {
		const harness = makeHarness(2, ["correctness"]);
		installDispatch(harness);
		let plannerCalls = 0;
		let malformedReturned = false;
		const memberAssignments: string[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				plannerCalls++;
				return structuredResult(request, {
					plan: PLAN,
					assumptions: ["one"],
					blockers: [],
					evidenceVersion: "1.0.0",
				});
			}
			memberAssignments.push(request.assignment);
			if (!malformedReturned) {
				malformedReturned = true;
				return structuredResult(request, {}, { exitCode: 1 });
			}
			return structuredResult(request, {
				readiness: "ready",
				findings: [
					{
						classification: "improvement",
						severity: "low",
						confidence: "high",
						evidence: [
							{ path: "src/example.ts", observation: "The plan should name the established invariant." },
						],
						impact: "Clarity",
						required: false,
						recommendation: "Name the invariant",
						rejectedAssumptions: [],
						verification: ["Read the final plan"],
					},
				],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.prompts.every(value => value.length <= COUNCIL_ADJUDICATION_INJECTION_CAP)).toBe(true);
		expect(
			harness.prompts.every(value => value.includes(`# Canonical repository root\n${harness.dispatch.repoRoot}`)),
		).toBe(true);
		// Round two carries the eligible duplicate targets from round one, and nothing else about
		// how they were judged: a delegated adjudicator never saw the prior turn.
		expect(harness.prompts[1]).toContain('"priorCanonicalFindingIds":["A1"]');
		expect(harness.prompts[1]).not.toContain('"reason":"Supported"');
		expect(plannerCalls).toBe(1);

		expect(memberAssignments).toHaveLength(3);
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.attempts).toBe(2);
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.findingIds).toEqual(["A1"]);
		expect(coordinator.snapshot?.rounds[1]?.members[0]?.findingIds).toEqual(["B1"]);
		expect(memberAssignments.at(-1)).toContain(PLAN);
		expect(harness.prompts).toHaveLength(2);
		expect(harness.summaries).toHaveLength(1);
	});
	it("does not spend the schema retry on a provider failure with partial output", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		let memberCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberCalls++;
			const failed = structuredResult(request, { partial: "provider text" }, { exitCode: 1 });
			failed.result.error = "provider unavailable";
			failed.result.structuredOutput = {
				source: "caller",
				mode: "strict",
				status: "unavailable",
				data: { partial: "provider text" },
				error: "provider unavailable",
			};
			return failed;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(memberCalls).toBe(1);
		expect(coordinator.snapshot?.rounds[0]?.members[0]).toMatchObject({
			attempts: 1,
			status: "failed",
			failureReason: "provider unavailable",
		});
		expect(coordinator.snapshot?.state).toBe("completed-degraded");
	});

	it("rejects a round-two duplicate target that was itself a prior duplicate", async () => {
		const harness = makeHarness(2, ["correctness"]);
		installDispatch(harness);
		let memberRound = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberRound++;
			const finding = {
				classification: "must-fix",
				severity: "high",
				confidence: "high",
				evidence: [
					{ path: "src/example.ts", observation: "The implementation violates the established invariant." },
				],
				impact: "Incorrect behavior",
				required: true,
				recommendation: "Restore the invariant",
				rejectedAssumptions: [],
				verification: ["Exercise the path"],
			};
			return structuredResult(request, {
				readiness: "revise",
				findings: memberRound === 1 ? [finding, { ...finding, impact: "Duplicate impact" }] : [finding],
				strengths: [],
				missingContext: [],
			});
		});
		let roundOneAccepted = false;
		const rejectionMessages: string[] = [];
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (message, options) => {
			if (typeof message.content !== "string") throw new Error("Expected a plain-text adjudication prompt");
			harness.prompts.push(message.content);
			options?.onPromptStart?.();
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const grades = [{ slot: 1, grade: "A", reason: "Verified high-severity findings" }];
			const payload = roundOneAccepted
				? {
						plan: PLAN,
						dispositions: [
							{
								id: "B1",
								disposition: "duplicate",
								reason: "Same root cause.",
								step: "Approach 1",
								duplicateOf: "A1",
							},
						],
						grades,
					}
				: {
						plan: PLAN,
						dispositions: [
							{
								id: "A1",
								disposition: "duplicate",
								reason: "Same root cause.",
								step: "Approach 1",
								duplicateOf: "A2",
							},
							{ id: "A2", disposition: "accepted", reason: "Supported", step: "Approach 1" },
						],
						grades,
					};
			const result = await active(JSON.stringify(payload));
			if (result.isError) rejectionMessages.push(JSON.stringify(result.content));
			else roundOneAccepted = true;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(roundOneAccepted).toBeTrue();
		expect(rejectionMessages).toEqual([
			expect.stringContaining("unknown duplicate target A1"),
			expect.stringContaining("unknown duplicate target A1"),
		]);
		// `A1` was itself dispositioned `duplicate`, so it never enters the eligible target list the
		// round-two assignment publishes; only the canonical `A2` does.
		expect(harness.prompts[1]).toContain('"priorCanonicalFindingIds":["A2"]');
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();
	});
	it("resumes succeeded artifacts, reruns cancelled slots, and preserves failed slots", async () => {
		const harness = makeHarness(1, ["success", "failed", "cancelled"]);
		installDispatch(harness);
		const calls = new Map<string, number>();
		let resuming = false;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				calls.set("planner", (calls.get("planner") ?? 0) + 1);
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			const role = String(request.model).slice("member/".length);
			calls.set(role, (calls.get(role) ?? 0) + 1);
			if (role === "failed") {
				const failed = structuredResult(request, undefined, { exitCode: 1 });
				failed.result.structuredOutput = { source: "caller", mode: "strict", status: "unavailable" };
				return failed;
			}
			if (role === "cancelled" && !resuming) {
				const pending = Promise.withResolvers<StructuredSubagentResult>();
				const abort = () => {
					const error = new Error("cancelled member");
					error.name = "AbortError";
					pending.reject(error);
				};
				request.signal?.addEventListener("abort", abort, { once: true });
				return pending.promise;
			}
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);
		const terminalSlots = Promise.withResolvers<void>();
		const unsubscribe = coordinator.subscribe(snapshot => {
			const members = snapshot.manifest.rounds[0]?.members;
			if (
				members?.[0]?.status === "succeeded" &&
				members[1]?.status === "failed" &&
				members[2]?.status === "running"
			) {
				terminalSlots.resolve();
			}
		});
		await coordinator.start(harness.dispatch.task);
		await terminalSlots.promise;
		const interrupted = await coordinator.cancel();
		unsubscribe();
		expect(interrupted.rounds[0]?.members.map(member => member.status)).toEqual(["succeeded", "failed", "cancelled"]);

		resuming = true;
		const resumed = coordinator.resume("run-one");
		const competingResume = coordinator.resume("run-one");
		await expect(competingResume).rejects.toThrow("still settling");
		await resumed;
		await coordinator.completion;

		expect(calls.get("planner")).toBe(1);
		expect(calls.get("success")).toBe(1);
		expect(calls.get("failed")).toBe(1);
		expect(calls.get("cancelled")).toBe(2);
		expect(coordinator.snapshot?.state).toBe("completed-degraded");
	});

	it("aborts an in-flight child before a deferred cancelling checkpoint resolves", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const checkpointPending = Promise.withResolvers<CouncilManifest>();
		let deferredCheckpoint: CouncilManifest | undefined;
		let deferCancellingCheckpoint = false;
		const checkpoint = CouncilStorage.prototype.checkpoint;
		spyOn(CouncilStorage.prototype, "checkpoint").mockImplementation(function (
			this: CouncilStorage,
			manifest: CouncilManifest,
		) {
			if (deferCancellingCheckpoint && manifest.state === "cancelling") {
				deferredCheckpoint = structuredClone(manifest);
				return checkpointPending.promise;
			}
			return checkpoint.call(this, manifest);
		});
		const memberStarted = Promise.withResolvers<void>();
		const childAborted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			const pending = Promise.withResolvers<StructuredSubagentResult>();
			request.signal?.addEventListener(
				"abort",
				() => {
					childAborted.resolve();
					const error = new Error("cancelled member");
					error.name = "AbortError";
					pending.reject(error);
				},
				{ once: true },
			);
			return pending.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		deferCancellingCheckpoint = true;

		const cancellation = coordinator.cancel();
		await childAborted.promise;
		expect(coordinator.snapshot?.state).toBe("cancelling");
		if (!deferredCheckpoint) throw new Error("Expected deferred cancelling checkpoint");
		checkpointPending.resolve(deferredCheckpoint);
		const cancelled = await cancellation;

		expect(cancelled.state).toBe("interrupted");
	});

	it("clears timed-out reviewer telemetry before emitting the terminal interrupted snapshot", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		const releaseMember = Promise.withResolvers<StructuredSubagentResult>();
		let memberRequest: StructuredSubagentRequest | undefined;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberRequest = request;
			request.onProgress?.({
				index: request.index ?? 1,
				id: request.identity?.label ?? "reviewer",
				agent: "council-member",
				agentSource: "bundled",
				status: "running",
				task: request.assignment,
				assignment: request.assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 10,
				cost: 0,
				durationMs: 1,
			});
			memberStarted.resolve();
			return releaseMember.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		expect(coordinator.coordinatorSnapshot?.members).toHaveLength(1);

		const cancellation = coordinator.cancel();
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_001);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		const cancelled = await cancellation;

		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.manifest.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
		expect(coordinator.coordinatorSnapshot?.manifest.rounds[0]?.members[0]?.status).toBe("interrupted");

		if (!memberRequest) throw new Error("Expected member request");
		releaseMember.resolve(
			structuredResult(memberRequest, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			}),
		);
		await coordinator.completion;
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
	});

	it("checkpoints returned child usage before settling cancellation", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			const pending = Promise.withResolvers<StructuredSubagentResult>();
			request.signal?.addEventListener(
				"abort",
				() => {
					const result = structuredResult(request, undefined, { exitCode: 1 });
					result.result.aborted = true;
					result.result.tokens = 37;
					result.result.requests = 2;
					pending.resolve(result);
				},
				{ once: true },
			);
			return pending.promise;
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;

		const cancelled = await coordinator.cancel();

		expect(cancelled.state).toBe("interrupted");
		expect(cancelled.usage.requests).toBe(3);
		expect(cancelled.usage.tokens).toBe(47);
	});
	it("keeps a validated adjudication when the provider fails after the tool write", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.adjudicationState.afterAcceptedError = new Error("provider failed after accepted tool result");
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(harness.prompts).toHaveLength(1);
		expect(coordinator.snapshot?.published).toBeDefined();
	});

	it("rejects adjudication payloads until the Council Main turn owns the prompt", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const idleEntered = Promise.withResolvers<void>();
		const releaseIdle = Promise.withResolvers<void>();
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.host.session.waitForIdle = mock(async () => {
			idleEntered.resolve();
			await releaseIdle.promise;
		});
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await idleEntered.promise;
		const installed = harness.toolSession.peekCouncilHandler?.();
		if (!installed) throw new Error("Expected installed Council handler");
		// The reviewer reported (`ready`, no findings), so its slot still owes a grade.
		const payload = JSON.stringify({
			plan: PLAN,
			dispositions: [],
			grades: [{ slot: 1, grade: "B", reason: "No defects found and none missed" }],
		});

		const beforeOwnership = await installed(payload);
		expect(beforeOwnership.isError).toBeTrue();
		releaseIdle.resolve();
		await promptEntered.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(true);
		const afterOwnership = await installed(payload);
		expect(afterOwnership.isError).not.toBeTrue();
		releasePrompt.resolve();
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it("does not claim or abort an unrelated turn that wins the idle-to-prompt race", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const busyAttempted = Promise.withResolvers<void>();
		const releaseBusy = Promise.withResolvers<void>();
		harness.adjudicationState.busyFailures = 1;
		harness.adjudicationState.busyPending = releaseBusy.promise;
		harness.adjudicationState.onBusyAttempt = busyAttempted.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await busyAttempted.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(false);

		const cancellation = coordinator.cancel();
		releaseBusy.resolve();
		const cancelled = await cancellation;

		expect(harness.host.session.abort).not.toHaveBeenCalled();
		expect(cancelled.state).toBe("interrupted");
	});

	it("aborts an owned Main turn reserved before its custom message is appended", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		harness.adjudicationState.onAbort = releasePrompt.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(true);

		const cancelled = await coordinator.cancel();

		expect(harness.host.session.abort).toHaveBeenCalledTimes(1);
		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.snapshot?.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.mainTurnOwned).toBe(false);
	});

	it("rejects a session transition when an owned Main turn misses the cancellation deadline", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;

		const transition = coordinator.cancelForSessionTransition();
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_001);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		await expect(transition).rejects.toThrow("Council cancellation timed out");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();

		releasePrompt.resolve();
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("interrupted");
		expect(publication.publishCouncilPlan).not.toHaveBeenCalled();
	});

	it("keeps an interrupted snapshot immutable when a non-cooperative Main turn returns late", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		const promptEntered = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const cancelling = Promise.withResolvers<void>();
		harness.adjudicationState.pending = releasePrompt.promise;
		harness.adjudicationState.skipHandler = true;
		harness.adjudicationState.onPrompt = promptEntered.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		const unsubscribe = coordinator.subscribe(snapshot => {
			if (snapshot.manifest.state === "cancelling") cancelling.resolve();
		});
		await coordinator.start(harness.dispatch.task);
		await promptEntered.promise;

		const cancellation = coordinator.cancel();
		await cancelling.promise;
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_000);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		const cancelled = await cancellation;
		const terminalSnapshot = structuredClone(coordinator.snapshot);
		const terminalJournalLength = harness.journal.length;
		harness.host.sessionManager.getSessionId = () => "session-two";
		const nextSessionHandler: CouncilAdjudicationHandler = async () => ({
			content: [{ type: "text", text: "next session" }],
		});
		harness.toolSession.setCouncilHandler?.(nextSessionHandler);

		releasePrompt.resolve();
		await coordinator.completion;
		unsubscribe();

		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.snapshot).toEqual(terminalSnapshot);
		expect(harness.journal).toHaveLength(terminalJournalLength);
		expect(coordinator.snapshot?.planVersions.map(version => version.kind)).toEqual(["draft"]);
		expect(coordinator.snapshot?.published).toBeUndefined();
		expect(harness.toolSession.peekCouncilHandler?.()).toBe(nextSessionHandler);
		expect(harness.summaries).toHaveLength(0);
	});

	it("does not duplicate a confirmed queued summary when sendCustomMessage reports no started turn", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(1);
		await Promise.all([coordinator.status(), coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(1);
	});

	it("omits a summary whose async delivery crosses into another session", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const summaryStarted = Promise.withResolvers<void>();
		const releaseSummary = Promise.withResolvers<void>();
		harness.summaryState.onAttempt = summaryStarted.resolve;
		harness.summaryState.pending = releaseSummary.promise;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await summaryStarted.promise;

		harness.host.sessionManager.getSessionId = () => "session-two";
		releaseSummary.resolve();

		await coordinator.completion;
		expect(harness.summaries).toHaveLength(0);
		expect(harness.summaryState.attempts).toBe(1);

		harness.summaryState.pending = undefined;
		harness.summaryState.onAttempt = undefined;
		harness.host.sessionManager.getSessionId = () => "session-one";
		await Promise.all([coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});
	it("retries an unconfirmed terminal summary without duplicating the confirmed delivery", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.declines = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaryState.attempts).toBe(1);
		expect(harness.summaries).toHaveLength(0);
		await Promise.all([coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});

	it("retries a failed terminal summary through concurrent status calls without duplicating success", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.failures = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.summaries).toHaveLength(0);
		await Promise.all([coordinator.status(), coordinator.status(), coordinator.status()]);
		expect(harness.summaryState.attempts).toBe(2);
		expect(harness.summaries).toHaveLength(1);
		await coordinator.status();
		expect(harness.summaryState.attempts).toBe(2);
	});

	it("blocks a new run until terminal summary delivery finishes", async () => {
		const harness = makeHarness(1, ["correctness"]);
		let run = 0;
		harness.host.runId = () => `run-${++run}`;
		const summaryAttempted = Promise.withResolvers<void>();
		const releaseSummary = Promise.withResolvers<void>();
		harness.summaryState.pending = releaseSummary.promise;
		harness.summaryState.onAttempt = summaryAttempted.resolve;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);

		const coordinator = getCouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await summaryAttempted.promise;
		expect(coordinator.snapshot?.state).toBe("completed");
		const reboundDuringSummary = getCouncilCoordinator({
			...harness.host,
			session: { ...harness.host.session } as typeof harness.host.session,
		});
		expect(reboundDuringSummary).toBe(coordinator);

		await expect(coordinator.start(harness.dispatch.task)).rejects.toThrow("still settling");

		releaseSummary.resolve();
		await coordinator.completion;
		harness.summaryState.pending = undefined;
		harness.summaryState.onAttempt = undefined;
		const second = await coordinator.start(harness.dispatch.task);
		expect(second.runId).toBe("run-2");
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("completed");
	});
	it("replaces an inactive same-ID coordinator when restored session surfaces change", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.summaryState.failures = 1;
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const original = getCouncilCoordinator(harness.host);
		await original.start(harness.dispatch.task);
		await original.completion;
		expect(harness.summaries).toHaveLength(0);

		const restoredSummaries: unknown[] = [];
		const restoredSession = {
			...harness.host.session,
			sendCustomMessage: mock(async (message: unknown, options?: { deliveryReceipt?: { delivered: boolean } }) => {
				restoredSummaries.push(message);
				if (options?.deliveryReceipt) options.deliveryReceipt.delivered = true;
				return false;
			}),
		} as unknown as typeof harness.host.session;
		const replacement = getCouncilCoordinator({ ...harness.host, session: restoredSession });
		expect(replacement).not.toBe(original);
		const status = await replacement.status();
		const snapshots: CouncilCoordinatorSnapshot[] = [];
		const unsubscribe = replacement.subscribe(snapshot => snapshots.push(snapshot));

		expect(status?.state).toBe("completed");
		expect(restoredSummaries).toHaveLength(1);
		expect(snapshots[0]?.manifest.runId).toBe("run-one");
		unsubscribe();
	});

	it("terminalizes an occupied promised path before rerunning an interrupted reviewer", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		let resuming = false;
		let childCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			childCalls++;
			if (resuming) throw new Error("resume must not dispatch a child");
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			return await new Promise<StructuredSubagentResult>((_resolve, reject) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						const error = new Error("cancelled reviewer");
						error.name = "AbortError";
						reject(error);
					},
					{ once: true },
				);
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		const interrupted = await coordinator.cancel();
		expect(interrupted.planVersions.map(version => version.kind)).toEqual(["draft"]);
		const target = path.join(harness.planRoot, ...interrupted.outputPath.split("/"));
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(target, "external collision");

		resuming = true;
		await expect(coordinator.resume(interrupted.runId)).rejects.toThrow("publication target already exists");

		expect(childCalls).toBe(2);
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.code).toBe("EEXIST");
	});

	it("resumes against its occupied promised path and terminalizes the collision without rerunning children", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const realPublish = publication.publishCouncilPlan;
		const publicationEntered = Promise.withResolvers<void>();
		let firstPublication = true;
		const preflightSpy = spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
			if (!firstPublication) return realPublish(options);
			firstPublication = false;
			publicationEntered.resolve();
			await new Promise<void>((_resolve, reject) => {
				options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
			throw new Error("unreachable");
		});
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await publicationEntered.promise;
		const interrupted = await coordinator.cancel();
		expect(interrupted.state).toBe("interrupted");
		const childCalls = run.mock.calls.length;
		const promisedPath = interrupted.outputPath;
		const absolutePromisedPath = path.join(harness.planRoot, ...promisedPath.split("/"));
		await fs.mkdir(path.dirname(absolutePromisedPath), { recursive: true });
		await Bun.write(absolutePromisedPath, "unrelated occupant");

		await expect(coordinator.resume(interrupted.runId)).rejects.toThrow("publication target already exists");

		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.code).toBe("EEXIST");
		expect(coordinator.snapshot?.outputPath).toBe(promisedPath);
		expect(run).toHaveBeenCalledTimes(childCalls);
		// Resume revalidates the same immutable path, hands preflight the run signal so a cancel during
		// setup reaches whatever preflight is waiting on, and replays the persisted origin so the
		// adjudication policy cannot drift between the original run and its continuation.
		expect(preflightSpy.mock.calls[1]?.[2]).toEqual({
			promisedOutputPath: promisedPath,
			signal: expect.any(AbortSignal),
			origin: "command",
		});
	});

	it("preserves a final trailing newline through publication crash identity recovery", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const trailingPlan = `${PLAN}\n`;
		harness.adjudicationState.plan = trailingPlan;
		spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		const publishedContents: string[] = [];
		let crashAfterPublish = true;
		spyOn(publication, "publishCouncilPlan").mockImplementation(async options => {
			publishedContents.push(options.content);
			const target = path.join(options.planRoot, ...options.outputPath.split("/"));
			await fs.mkdir(path.dirname(target), { recursive: true });
			await Bun.write(target, options.content);
			if (crashAfterPublish) {
				crashAfterPublish = false;
				throw new Error("simulated crash after atomic publication");
			}
			return {
				path: options.outputPath,
				sha256: sha256CouncilContent(options.content),
				bytes: Buffer.byteLength(options.content),
				publishedAt: "2026-08-05T00:00:00.000Z",
				idempotent: true,
			};
		});
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(await Bun.file(harness.dispatch.publicationTarget.absolutePath).text()).toBe(trailingPlan);

		harness.dispatch.publicationTarget = {
			...harness.dispatch.publicationTarget,
			slug: "different-fresh-target",
			fileName: "council-different-fresh-target-plan.md",
			relativePath: "council-different-fresh-target-plan.md",
			absolutePath: path.join(harness.planRoot, "council-different-fresh-target-plan.md"),
		};
		await coordinator.resume("run-one");
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(publishedContents).toEqual([trailingPlan, trailingPlan]);
		expect(coordinator.snapshot?.published?.sha256).toBe(sha256CouncilContent(trailingPlan));
	});

	it("keys shared coordinators by session and immediately hydrates subscribers with cloned snapshots", async () => {
		const harness = makeHarness();
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = getCouncilCoordinator(harness.host);
		expect(getCouncilCoordinator({ ...harness.host, sessionManager: harness.host.sessionManager })).toBe(coordinator);
		await coordinator.start(harness.dispatch.task);
		const snapshots: CouncilCoordinatorSnapshot[] = [];
		const unsubscribe = coordinator.subscribe(snapshot => snapshots.push(snapshot));
		expect(snapshots).toHaveLength(1);
		snapshots[0]!.manifest.task = "mutated listener copy";
		expect(coordinator.snapshot?.task).toBe(harness.dispatch.task);
		unsubscribe();
		await coordinator.completion;
		expect(snapshots).toHaveLength(1);
	});

	it("resumes the newest resumable run instead of a newer completed one", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const stale = await seedCouncilManifest(harness, {
			runId: "stale-interrupted",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "interrupted",
			outputPath: "council-stale-interrupted-plan.md",
		});
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;
		expect(coordinator.snapshot?.runId).toBe("run-one");
		expect(coordinator.snapshot?.state).toBe("completed");

		const resumed = await coordinator.resume();

		expect(resumed.runId).toBe(stale.runId);
		await coordinator.completion;
		expect(coordinator.snapshot?.runId).toBe("stale-interrupted");
		expect(coordinator.snapshot?.state).toBe("completed");
	});

	it.each([
		["a structurally invalid planner result", { phase: "planner-schema", reason: "planner schema violation" }],
		["a publication collision", { phase: "publication", reason: "target occupied", code: "EEXIST" }],
	] as ReadonlyArray<[string, NonNullable<CouncilManifest["failure"]>]>)(
		"resumes an older interrupted run instead of %s that failed later",
		async (_label, failure) => {
			const harness = makeHarness(1, ["correctness"]);
			installDispatch(harness);
			spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
				request.agent === "council-planner"
					? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
					: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
			);
			await seedCouncilManifest(harness, {
				runId: "older-interrupted",
				createdAt: "2026-01-01T00:00:00.000Z",
				state: "interrupted",
				outputPath: "council-older-interrupted-plan.md",
			});
			await seedCouncilManifest(harness, {
				runId: "newer-terminal",
				createdAt: "2026-02-01T00:00:00.000Z",
				state: "failed",
				outputPath: "council-newer-terminal-plan.md",
				failure,
			});
			const coordinator = new CouncilCoordinator(harness.host);

			const resumed = await coordinator.resume();

			expect(resumed.runId).toBe("older-interrupted");
			await coordinator.completion;
			expect(coordinator.snapshot?.state).toBe("completed");
			expect(coordinator.snapshot?.outputPath).toBe("council-older-interrupted-plan.md");
		},
	);

	it("refuses an explicit planner-schema runId before any preflight or child spend", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const preflightSpy = spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		const run = spyOn(subagents, "runStructuredSubagent");
		await seedCouncilManifest(harness, {
			runId: "schema-terminal",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "failed",
			outputPath: "council-schema-terminal-plan.md",
			failure: { phase: "planner-schema", reason: "planner schema violation" },
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.resume("schema-terminal")).rejects.toThrow(
			"A structurally invalid council planner result is terminal and cannot be resumed",
		);
		expect(preflightSpy).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(coordinator.executionInFlight).toBe(false);
	});

	it("refuses an explicit EEXIST runId before any preflight or child spend", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const preflightSpy = spyOn(preflight, "preflightCouncilDispatch").mockResolvedValue(harness.dispatch);
		const run = spyOn(subagents, "runStructuredSubagent");
		await seedCouncilManifest(harness, {
			runId: "collision-terminal",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "failed",
			outputPath: "council-collision-terminal-plan.md",
			failure: { phase: "publication", reason: "target occupied", code: "EEXIST" },
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.resume("collision-terminal")).rejects.toThrow(
			"A council publication collision is terminal and cannot be resumed",
		);
		expect(preflightSpy).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(coordinator.executionInFlight).toBe(false);
	});

	it("early-returns a completed manifest for an explicit runId without starting execution", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;
		const completed = coordinator.snapshot;
		expect(completed).toBeDefined();
		if (!completed) throw new Error("Expected a completed council snapshot");
		const completedSnapshot = structuredClone(completed);
		const childCalls = run.mock.calls.length;
		const journalLength = harness.journal.length;

		const returned = await coordinator.resume("run-one");

		expect(returned).toEqual(completedSnapshot);
		expect(run).toHaveBeenCalledTimes(childCalls);
		expect(harness.journal).toHaveLength(journalLength);
		expect(coordinator.executionInFlight).toBe(false);
	});

	it("charges both attempts of a forced Main repair turn to adjudicatorUsage and the run aggregate", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		let attempts = 0;
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			options?.onPromptStart?.();
			harness.host.session.messages.push(adjudicationTurn());
			attempts++;
			// The first turn ends without writing a payload, which is exactly what the repair turn exists
			// for; both turns still appended an assistant message and must both be billed.
			if (attempts === 1) return;
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const result = await active(
				JSON.stringify({
					plan: PLAN,
					dispositions: [],
					grades: [{ slot: 1, grade: "B", reason: "No defects found and none missed" }],
				}),
			);
			if (result.isError) throw new Error("Test adjudication was rejected");
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(attempts).toBe(2);
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(coordinator.snapshot?.adjudicatorUsage).toEqual({ requests: 2, tokens: 246, cost: 0.5 });
		// One planner request plus one member request, plus both adjudication turns.
		expect(coordinator.snapshot?.usage.requests).toBe(4);
	});

	it("accumulates both member attempts in the slot bucket and records planner usage", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		let memberCalls = 0;
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				const planner = structuredResult(request, {
					plan: PLAN,
					assumptions: [],
					blockers: [],
					evidenceVersion: "1.0.0",
				});
				planner.result.requests = 3;
				planner.result.tokens = 30;
				return planner;
			}
			memberCalls++;
			if (memberCalls === 1) {
				const malformed = structuredResult(request, {}, { exitCode: 1 });
				malformed.result.requests = 2;
				malformed.result.tokens = 20;
				return malformed;
			}
			const report = structuredResult(request, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			});
			report.result.requests = 5;
			report.result.tokens = 50;
			return report;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(memberCalls).toBe(2);
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(coordinator.snapshot?.rounds[0]?.members[0]).toMatchObject({ attempts: 2, status: "succeeded" });
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.usage).toEqual({ requests: 7, tokens: 70, cost: 0 });
		expect(coordinator.snapshot?.plannerUsage).toEqual({ requests: 3, tokens: 30, cost: 0 });
		expect(coordinator.snapshot?.usage).toMatchObject({ requests: 10, tokens: 100 });
	});

	it("releases an idle cached coordinator and leaves an executing one bound", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const idle = getCouncilCoordinator(harness.host);
		releaseCouncilCoordinator("session-one");
		const replacement = getCouncilCoordinator(harness.host);
		expect(replacement).not.toBe(idle);

		const memberStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			const pending = Promise.withResolvers<StructuredSubagentResult>();
			request.signal?.addEventListener(
				"abort",
				() => {
					const error = new Error("cancelled member");
					error.name = "AbortError";
					pending.reject(error);
				},
				{ once: true },
			);
			return pending.promise;
		});
		await replacement.start(harness.dispatch.task);
		await memberStarted.promise;
		expect(replacement.executionInFlight).toBe(true);

		releaseCouncilCoordinator("session-one");

		expect(getCouncilCoordinator(harness.host)).toBe(replacement);
		expect((await replacement.cancel()).state).toBe("interrupted");
	});

	it("hands presentation the run id and roster before the first child launches", async () => {
		const harness = makeHarness(2, ["correctness", "architecture"]);
		installDispatch(harness);
		const previewed = Promise.withResolvers<void>();
		const releasePreview = Promise.withResolvers<void>();
		const previews: CouncilKickoffPreview[] = [];
		harness.host.onKickoff = async preview => {
			previews.push(preview);
			previewed.resolve();
			await releasePreview.promise;
		};
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = coordinator.start(harness.dispatch.task);
		await previewed.promise;

		expect(previews).toEqual([
			{
				runId: "run-one",
				resumed: false,
				plannerModel: "planner/fixed",
				adjudicator: { mode: "main", model: "main/fixed" },
				members: [
					{ role: "correctness", model: "member/correctness", rounds: [1, 2] },
					{ role: "architecture", model: "member/architecture", rounds: [1, 2] },
				],
				rounds: 2,
			},
		]);
		// The manifest is already durable, but nothing has been paid for yet.
		expect(run).not.toHaveBeenCalled();

		releasePreview.resolve();
		await started;
		await coordinator.completion;
		expect(run).toHaveBeenCalled();
	});

	it("starts the run exactly once when the kickoff preview rejects", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		harness.host.onKickoff = async () => {
			throw new Error("presentation is unavailable");
		};
		const run = spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		const started = await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(started.runId).toBe("run-one");
		expect(coordinator.snapshot?.state).toBe("completed");
		expect(run.mock.calls.filter(([request]) => request.agent === "council-planner")).toHaveLength(1);
	});

	it("marks the kickoff preview as resumed when continuing an interrupted run", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		await seedCouncilManifest(harness, {
			runId: "interrupted-run",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "interrupted",
			outputPath: "council-interrupted-run-plan.md",
		});
		const previews: CouncilKickoffPreview[] = [];
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.resume("interrupted-run", { onKickoff: preview => void previews.push(preview) });
		await coordinator.completion;

		expect(previews).toEqual([
			{
				runId: "interrupted-run",
				resumed: true,
				plannerModel: "planner/fixed",
				adjudicator: { mode: "main", model: "main/fixed" },
				members: [{ role: "correctness", model: "member/correctness", rounds: [1] }],
				rounds: 1,
			},
		]);
	});

	it("lists recent runs when an explicit resume id has no manifest", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		await seedCouncilManifest(harness, {
			runId: "older-completed",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "interrupted",
			outputPath: "council-older-completed-plan.md",
		});
		await seedCouncilManifest(harness, {
			runId: "newer-terminal",
			createdAt: "2026-02-01T00:00:00.000Z",
			state: "failed",
			outputPath: "council-newer-terminal-plan.md",
			failure: { phase: "planner-schema", reason: "planner schema violation" },
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.resume("missing-run")).rejects.toThrow(
			"Recent: newer-terminal (failed), older-completed (interrupted, resumable).",
		);
	});

	it("refuses a resume in plain language and names the recovery command", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		await seedCouncilManifest(harness, {
			runId: "drifted-run",
			createdAt: "2026-01-01T00:00:00.000Z",
			state: "interrupted",
			outputPath: "council-drifted-run-plan.md",
		});
		harness.dispatch.task = "A different task entirely";
		const coordinator = new CouncilCoordinator(harness.host);

		await expect(coordinator.resume("drifted-run")).rejects.toThrow(
			"Council resume refused: the task text differs. Start a new run with /council <task>.",
		);
	});

	it("publishes Main's in-flight adjudication spend and charges it exactly once", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const turnEntered = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			options?.onPromptStart?.();
			// Assistant messages land at `message_end`, so the slice grows *during* the turn.
			harness.host.session.messages.push(adjudicationTurn());
			turnEntered.resolve();
			await releaseTurn.promise;
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const result = await active(JSON.stringify({ plan: PLAN, dispositions: [] }));
			if (result.isError) throw new Error("Test adjudication was rejected");
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await turnEntered.promise;
		vi.advanceTimersByTime(500);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();

		// Reserved Main coordinates: round 0, order -2, one below the planner's -1.
		const live = coordinator.coordinatorSnapshot?.members.find(member => member.order === -2);
		expect(live).toMatchObject({ round: 0, role: "main", status: "running", requests: 1, tokens: 123, cost: 0.25 });
		// Live only: the durable aggregate still holds just the planner and the one reviewer.
		expect(coordinator.snapshot?.usage.requests).toBe(2);

		releaseTurn.resolve();
		await coordinator.completion;

		expect(coordinator.snapshot?.adjudicatorUsage).toEqual({ requests: 1, tokens: 123, cost: 0.25 });
		expect(coordinator.snapshot?.usage.requests).toBe(3);
		expect(coordinator.coordinatorSnapshot?.members.some(member => member.order === -2)).toBe(false);
	});

	it("never emits an adjudication snapshot that has neither live nor durable spend", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const turnEntered = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			options?.onPromptStart?.();
			harness.host.session.messages.push(adjudicationTurn());
			turnEntered.resolve();
			await releaseTurn.promise;
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const result = await active(JSON.stringify({ plan: PLAN, dispositions: [] }));
			if (result.isError) throw new Error("Test adjudication was rejected");
		});
		const coordinator = new CouncilCoordinator(harness.host);
		// The pane reads the adjudicator's spend from the live row plus the durable bucket. Once the
		// turn has been sampled, every later emission must carry at least one of them: an emission
		// with neither is the blank frame the operator sees at the moment adjudication settles.
		const blanksAfterSpend: string[] = [];
		let spendSeen = false;
		const unsubscribe = coordinator.subscribe(snapshot => {
			const live = snapshot.members.find(member => member.order === -2);
			const durable = snapshot.manifest.adjudicatorUsage;
			const total = (live?.requests ?? 0) + (durable?.requests ?? 0);
			if (total > 0) spendSeen = true;
			else if (spendSeen) blanksAfterSpend.push(snapshot.manifest.state);
		});

		await coordinator.start(harness.dispatch.task);
		await turnEntered.promise;
		vi.advanceTimersByTime(500);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		expect(spendSeen).toBeTrue();

		releaseTurn.resolve();
		await coordinator.completion;
		unsubscribe();

		expect(blanksAfterSpend).toEqual([]);
		expect(coordinator.snapshot?.adjudicatorUsage).toEqual({ requests: 1, tokens: 123, cost: 0.25 });
		expect(coordinator.coordinatorSnapshot?.members.some(member => member.order === -2)).toBe(false);
	});

	it("scopes live Main telemetry to one adjudication turn across a forced repair", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let attempt = 0;
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			const index = attempt++;
			options?.onPromptStart?.();
			harness.host.session.messages.push(adjudicationTurn());
			entered[index]!.resolve();
			await release[index]!.promise;
			// The first turn ends without a payload, which is what the repair turn exists for.
			if (index === 0) return;
			const active = harness.toolSession.peekCouncilHandler?.();
			if (!active) throw new Error("Expected an adjudication handler");
			const result = await active(JSON.stringify({ plan: PLAN, dispositions: [] }));
			if (result.isError) throw new Error("Test adjudication was rejected");
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await entered[0]!.promise;
		vi.advanceTimersByTime(500);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		expect(coordinator.coordinatorSnapshot?.members.find(member => member.order === -2)).toMatchObject({
			requests: 1,
		});
		release[0]!.resolve();

		await entered[1]!.promise;
		vi.advanceTimersByTime(500);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		// The repair turn samples its own message slice under a new generation, so the live row shows
		// one request — not both turns, whose first half the durable charge already booked.
		expect(coordinator.coordinatorSnapshot?.members.find(member => member.order === -2)).toMatchObject({
			requests: 1,
		});
		release[1]!.resolve();

		await coordinator.completion;
		expect(attempt).toBe(2);
		expect(coordinator.snapshot?.adjudicatorUsage).toEqual({ requests: 2, tokens: 246, cost: 0.5 });
		expect(coordinator.coordinatorSnapshot?.members.some(member => member.order === -2)).toBe(false);
	});

	it("drops the live Main row when adjudication is cancelled", async () => {
		vi.useFakeTimers();
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const turnEntered = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		spyOn(harness.host.session, "abort").mockImplementation(async () => {
			releaseTurn.resolve();
		});
		spyOn(harness.host.session, "promptCustomMessage").mockImplementation(async (_message, options) => {
			options?.onPromptStart?.();
			harness.host.session.messages.push(adjudicationTurn());
			turnEntered.resolve();
			await releaseTurn.promise;
			const aborted = new Error("Council run cancelled");
			aborted.name = "AbortError";
			throw aborted;
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await turnEntered.promise;
		vi.advanceTimersByTime(500);
		for (let flush = 0; flush < 10; flush++) await Promise.resolve();
		expect(coordinator.coordinatorSnapshot?.members.find(member => member.order === -2)).toBeDefined();

		const cancellation = coordinator.cancel();
		for (let flush = 0; flush < 20; flush++) await Promise.resolve();
		vi.advanceTimersByTime(5_001);
		for (let flush = 0; flush < 20; flush++) await Promise.resolve();
		const cancelled = await cancellation;

		expect(cancelled.state).toBe("interrupted");
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
	});

	it("persists one durable lifecycle event per key across kickoff, both rounds, and the terminal exit", async () => {
		// Two reviewers per round is the case that suppresses the transcript mirror, so the durable
		// round events are the only record that the round happened.
		const harness = makeHarness(2, ["correctness", "architecture"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;
		// Repeated hydration re-enters the terminal path; the idempotency key must absorb it.
		await Promise.all([coordinator.status(), coordinator.status()]);

		const keys = harness.lifecycleEvents.map(event => `${event.details?.eventKind}:${event.details?.round ?? ""}`);
		expect(keys).toEqual([
			"kickoff:",
			"round-start:1",
			"round-settle:1",
			"round-start:2",
			"round-settle:2",
			"terminal:",
		]);
		expect(new Set(keys).size).toBe(keys.length);
		expect(harness.lifecycleEvents.every(event => event.details?.runId === coordinator.snapshot?.runId)).toBe(true);

		const settle = harness.lifecycleEvents[2]!;
		expect(settle.content).toBe("Council round 1 settled: 2/2 reviewers succeeded, 0 findings.");
		const terminal = harness.lifecycleEvents[5]!;
		expect(terminal.content).toContain("terminal, start a new run");
		expect(terminal.content).toContain("Final: local://");
		// The projection rides as JSON data, not rendered rows, so the card lays it out at the live
		// frame width and a round trip through the session file changes nothing.
		const stats = terminal.details?.stats;
		expect(stats).toMatchObject({
			runId: coordinator.snapshot!.runId,
			state: "completed",
			reviewersTotal: 2,
			reviewersSucceeded: 2,
		});
		expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
	});

	it("orders a cancellation ahead of exactly one terminal event naming the resume command", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			return await new Promise<StructuredSubagentResult>((_resolve, reject) => {
				request.signal?.addEventListener(
					"abort",
					() => {
						const error = new Error("cancelled reviewer");
						error.name = "AbortError";
						reject(error);
					},
					{ once: true },
				);
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		const cancelled = await coordinator.cancel();
		await Promise.all([coordinator.status(), coordinator.status()]);

		expect(cancelled.state).toBe("interrupted");
		const kinds = harness.lifecycleEvents.map(event => event.details?.eventKind);
		expect(kinds.filter(kind => kind === "terminal")).toHaveLength(1);
		expect(kinds.indexOf("cancel")).toBeLessThan(kinds.indexOf("terminal"));
		const terminal = harness.lifecycleEvents.at(-1)!;
		expect(terminal.content).toContain(`resumable: /council resume ${cancelled.runId}`);
		expect(terminal.content).toContain("interrupted");
	});

	it("mirrors the summary card live when the run settles while Main streams, without queueing it twice", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		// A user turn opens while the council is still running, so the durable copy is held for the
		// next turn and nothing paints unless the coordinator asks for a live-only mirror.
		harness.setStreaming(true);
		await coordinator.completion;

		expect(harness.summaries).toHaveLength(1);
		// Never a steer and never a follow-up: both would splice the card into the streaming turn.
		expect(harness.summaryOptions).toEqual([{ deliverAs: "nextTurn" }]);
		expect(harness.presentations).toHaveLength(1);
		expect(harness.presentations[0]?.deferred).toBe(true);
		expect(harness.presentations[0]?.runId).toBe(coordinator.snapshot!.runId);
		expect(harness.presentations[0]?.content).toBe(harness.summaries[0]!.content);

		// The queued copy lands at the next turn and is scanned by `alreadyPersisted`, so a coordinator
		// rebuilt over the same session emits no second card.
		harness.setStreaming(false);
		harness.host.session.messages.push({
			role: "custom",
			customType: "council-summary",
			content: harness.summaries[0]!.content,
			display: true,
			details: { runId: coordinator.snapshot!.runId },
			timestamp: 1,
		});
		const reloaded = new CouncilCoordinator(harness.host);
		await reloaded.status();
		await reloaded.status();

		expect(harness.summaries).toHaveLength(1);
		expect(harness.presentations).toHaveLength(1);
	});

	it("paints an idle summary delivery rather than leaving it invisible until the next repaint", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(harness.presentations).toEqual([
			{
				runId: coordinator.snapshot!.runId,
				deferred: false,
				content: harness.summaries[0]?.content,
				details: expect.objectContaining({ runId: coordinator.snapshot!.runId }),
			},
		]);
	});

	it("launches only the reviewers a round is staffed with and never files a record for the others", async () => {
		const harness = makeHarness(2, ["firstonly", "secondonly"]);
		installDispatch(harness);
		// Disjoint rounds: the first member serves round 1, the second serves round 2.
		harness.dispatch.config.members[0]!.round = 1;
		harness.dispatch.config.members[1]!.round = 2;
		harness.dispatch.roster[0]!.round = 1;
		harness.dispatch.roster[1]!.round = 2;
		harness.dispatch.members[0]!.rounds = [1];
		harness.dispatch.members[1]!.rounds = [2];
		const launches: { round: number; role: string }[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			const label = request.identity?.label ?? "";
			launches.push({ round: Number(label.slice(-1)), role: label.split(" ")[1]! });
			return structuredResult(request, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		// The child label carries the stable operator label; the durable record below keeps the raw id.
		expect(launches).toEqual([
			{ round: 1, role: "Firstonly" },
			{ round: 2, role: "Secondonly" },
		]);
		// A reviewer pinned to the other round is absent from the record entirely, so it can never sit
		// permanently `pending` in the HUD or be counted as a reviewer that did not deliver.
		expect(coordinator.snapshot?.rounds[0]?.members.map(member => member.role)).toEqual(["firstonly"]);
		expect(coordinator.snapshot?.rounds[1]?.members.map(member => member.role)).toEqual(["secondonly"]);
	});

	it("labels a reviewer with its roster index everywhere, even behind a disabled config slot", async () => {
		const harness = makeHarness(1, ["skipped", "reporter", "failer"]);
		installDispatch(harness);
		// The first config slot is disabled, so `order` and roster index diverge from here on.
		harness.dispatch.config.members[0]!.enabled = false;
		harness.dispatch.roster[0]!.enabled = false;
		harness.dispatch.members = harness.dispatch.members.slice(1);
		harness.dispatch.memberRequests = harness.dispatch.memberRequests.slice(1);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			if (request.identity?.label?.includes("Failer")) {
				const failed = structuredResult(request, {}, { exitCode: 1 });
				failed.result.error = "provider unavailable";
				return failed;
			}
			return structuredResult(request, {
				readiness: "revise",
				findings: [
					{
						classification: "must-fix",
						severity: "high",
						confidence: "high",
						evidence: [{ path: "src/example.ts", observation: "The plan drops the established invariant." }],
						impact: "Correctness",
						required: true,
						recommendation: "Restore the invariant",
						rejectedAssumptions: [],
						verification: ["Read the final plan"],
					},
				],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		const assignment = harness.prompts[0]!;
		// One slot definition: `reporter` is roster index 0 (slot 1), `failer` is roster index 1
		// (slot 2). Its config `order` is 1 and 2, so an order-derived slot would say 2 and 3.
		expect(assignment).toContain("Member failer (slot 2) failed:");
		expect(assignment).toContain('"slot":1,"readiness":"revise"');
		expect(assignment).toContain('"slot":1,"readiness":"revise","finding"');
		expect(assignment).not.toContain('"slot":3');
		// The finding-id prefix is derived from the same roster index: slot 1 owns the `A` namespace.
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.findingIds).toEqual(["A1"]);
	});

	it("settles a delegated adjudication from a child yield without taking a Main turn", async () => {
		const harness = makeHarness(1, ["correctness"]);
		const adjudicatorModel = { provider: "judge", id: "opus" } as Model<Api>;
		harness.dispatch.adjudicator = {
			mode: "delegated",
			requestedSelector: "judge/opus",
			resolvedSelector: "judge/opus",
			model: adjudicatorModel,
			effort: undefined,
			advisor: false,
		};
		harness.dispatch.adjudicatorRequest = {
			...harness.dispatch.plannerRequest,
			agent: "council-adjudicator",
			model: "judge/opus",
		};
		installDispatch(harness);
		const adjudicatorCalls: string[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			if (request.agent === "council-adjudicator") {
				adjudicatorCalls.push(request.assignment);
				const ids = [...request.assignment.matchAll(/"id":"([A-Z]+\d+)"/g)].map(match => match[1]!);
				const slots = [
					...new Set([...request.assignment.matchAll(/"slot":(\d+)/g)].map(match => Number(match[1]))),
				];
				const result = structuredResult(request, {
					plan: PLAN,
					dispositions: ids.map(id => ({
						id,
						disposition: "accepted",
						reason: "Supported",
						step: "Approach 1",
					})),
					grades: slots.map(slot => ({ slot, grade: "A", reason: "Verified high-severity findings" })),
				});
				result.result.requests = 4;
				result.result.tokens = 900;
				return result;
			}
			return structuredResult(request, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(adjudicatorCalls).toHaveLength(1);
		// Main is never prompted and the `xd://council` surface is never installed.
		expect(harness.prompts).toEqual([]);
		expect(harness.toolSession.peekCouncilHandler?.()).toBeUndefined();
		// The run never passes through `awaiting-main`; the delegated child is charged instead.
		expect(harness.journal.some(entry => entry.state === "awaiting-main")).toBeFalse();
		expect(harness.journal.some(entry => entry.state === "adjudicating")).toBeTrue();
		expect(coordinator.snapshot?.adjudicatorUsage).toEqual({ requests: 4, tokens: 900, cost: 0 });
		expect(coordinator.snapshot?.adjudicator).toMatchObject({
			mode: "delegated",
			requestedSelector: "judge/opus",
			resolvedModel: "judge/opus",
		});
		// Its transcript pointer is durable, and its live row is cleared once it settles.
		expect(coordinator.snapshot?.adjudicator.agentIds).toHaveLength(1);
		expect(coordinator.coordinatorSnapshot?.members).toEqual([]);
		expect(coordinator.coordinatorSnapshot?.soloChild).toBeUndefined();
	});

	it("refuses a delegated adjudication that never yields a valid payload, after exactly one repair", async () => {
		const harness = makeHarness(1, ["correctness"]);
		harness.dispatch.adjudicator = {
			mode: "delegated",
			requestedSelector: "judge/opus",
			resolvedSelector: "judge/opus",
			model: { provider: "judge", id: "opus" } as Model<Api>,
			effort: undefined,
			advisor: false,
		};
		harness.dispatch.adjudicatorRequest = {
			...harness.dispatch.plannerRequest,
			agent: "council-adjudicator",
			model: "judge/opus",
		};
		installDispatch(harness);
		const adjudicatorAssignments: string[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			if (request.agent === "council-adjudicator") {
				adjudicatorAssignments.push(request.assignment);
				return structuredResult(request, { plan: PLAN }, { exitCode: 1 });
			}
			return structuredResult(request, {
				readiness: "ready",
				findings: [],
				strengths: [],
				missingContext: [],
			});
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		expect(adjudicatorAssignments).toHaveLength(2);
		expect(adjudicatorAssignments[1]).toContain("You MUST terminal-yield exactly one corrected JSON adjudication");
		expect(coordinator.snapshot?.state).toBe("failed");
		expect(coordinator.snapshot?.failure?.code).toBe("COUNCIL_ADJUDICATION_MISSING");
	});

	it("prefixes finding ids with the same slot namespace the report validator enforces", async () => {
		const harness = makeHarness(2, ["correctness", "architecture"]);
		installDispatch(harness);
		const report = {
			readiness: "revise",
			findings: [
				{
					classification: "must-fix",
					severity: "high",
					confidence: "high",
					evidence: [{ path: "src/example.ts", observation: "The plan drops the established invariant." }],
					impact: "Correctness",
					required: true,
					recommendation: "Restore the invariant",
					rejectedAssumptions: [],
					verification: ["Read the final plan"],
				},
			],
			strengths: [],
			missingContext: [],
		};
		const promptPrefixes = new Map<string, string>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			promptPrefixes.set(
				request.identity?.label ?? "",
				/# Coordinator finding ID prefix\n(\S+)\n/.exec(request.assignment)?.[1] ?? "",
			);
			return structuredResult(request, report);
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		// Global slot is `(round - 1) * roster.length + rosterIndex`, so round 2's second reviewer owns
		// slot index 3. The prompt tells the child which namespace to expect; the validator renumbers
		// what comes back. Both must derive it from `councilSlotPrefix` or a reviewer's findings become
		// unaddressable in adjudication.
		expect(promptPrefixes.get("Council Correctness r1")).toBe(councilSlotPrefix(0));
		expect(promptPrefixes.get("Council Architecture r2")).toBe(councilSlotPrefix(3));
		expect(validateIncomingCouncilReport(report, 3).findings[0]?.id).toBe(
			`${promptPrefixes.get("Council Architecture r2")}1`,
		);
		expect(coordinator.snapshot?.rounds[1]?.members[1]?.findingIds).toEqual(["D1"]);
		expect(coordinator.snapshot?.rounds[0]?.members[0]?.findingIds).toEqual(["A1"]);
	});

	it("stamps the shared durable message types on live cards and on the rebuilt duplicate scan", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request =>
			request.agent === "council-planner"
				? structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" })
				: structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] }),
		);
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		// The harness sorts the two durable streams by `customType` alone, so a run event stamped with
		// anything but the shared constant would be counted as a summary card instead.
		expect(harness.lifecycleEvents.map(event => event.customType)).toEqual(
			harness.lifecycleEvents.map(() => COUNCIL_RUN_MESSAGE_TYPE),
		);
		expect(harness.summaries.map(summary => summary.customType)).toEqual([COUNCIL_SUMMARY_MESSAGE_TYPE]);
		const expectedKinds: CouncilRunEventKind[] = ["kickoff", "round-start", "round-settle", "terminal"];
		expect(harness.lifecycleEvents.map(event => event.details?.eventKind)).toEqual(expectedKinds);
		expect(harness.summaries[0]?.details).toEqual({
			runId: coordinator.snapshot!.runId,
			manifestUrl: expect.stringContaining("manifest.json"),
			finalUrl: `local://${coordinator.snapshot!.outputPath}`,
		});

		// Rebuilt path: the persisted card is recognised by the same constant, so hydration adds none.
		harness.host.session.messages.push({
			role: "custom",
			customType: COUNCIL_SUMMARY_MESSAGE_TYPE,
			content: harness.summaries[0]!.content,
			display: true,
			details: { runId: coordinator.snapshot!.runId },
			timestamp: 1,
		});
		const reloaded = new CouncilCoordinator(harness.host);
		await reloaded.status();

		expect(harness.summaries).toHaveLength(1);
	});

	it("renders stable reviewer labels on durable cards and children while keeping raw role ids durable", async () => {
		const harness = makeHarness(1, ["council1", "council2"]);
		installDispatch(harness);
		const childLabels: string[] = [];
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			childLabels.push(request.identity?.label ?? "");
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = new CouncilCoordinator(harness.host);

		await coordinator.start(harness.dispatch.task);
		await coordinator.completion;

		const kickoff = harness.lifecycleEvents[0]!;
		expect(kickoff.content).toContain("[Reviewer 1=member/council1, Reviewer 2=member/council2]");
		expect(childLabels.toSorted()).toEqual(["Council Reviewer 1 r1", "Council Reviewer 2 r1"]);
		// No later card names a reviewer, and none of them leaks the durable id into operator prose.
		expect(harness.lifecycleEvents.slice(1).some(event => event.content.includes("council1"))).toBeFalse();
		// Durable identity stays raw: manifest roster, round records, and per-reviewer artifact names.
		expect(coordinator.snapshot?.roster.map(member => member.role)).toEqual(["council1", "council2"]);
		expect(coordinator.snapshot?.rounds[0]?.members.map(member => member.role)).toEqual(["council1", "council2"]);
		const artifactsDirectory = harness.toolSession.localProtocolOptions!.getArtifactsDir!();
		const artifact = path.join(
			artifactsDirectory!,
			"local",
			`council-${coordinator.snapshot!.runId}-council1-r1.json`,
		);
		expect(await Bun.file(artifact).exists()).toBeTrue();
	});

	it("peeks only a matching binding and never constructs a coordinator", () => {
		const harness = makeHarness(1, ["correctness"]);
		const other = makeHarness(1, ["correctness"]);

		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBeUndefined();
		const coordinator = getCouncilCoordinator(harness.host);
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBe(coordinator);
		// A different `AgentSession` under the same id is a miss: that entry belongs to another binding,
		// and handing it over would let a stale host cancel or release someone else's run.
		expect(peekCouncilCoordinatorForSession(other.host.session, "session-one")).toBeUndefined();
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-two")).toBeUndefined();
		// Neither miss registered anything: the bound id still resolves to the original instance.
		expect(getCouncilCoordinator(harness.host)).toBe(coordinator);
		releaseCouncilCoordinator("session-one");
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBeUndefined();
	});

	it("makes a council-free session transition a no-op that leaves the registry empty", async () => {
		const harness = makeHarness(1, ["correctness"]);

		await quiesceAndReleaseCouncilForSessionTransition(harness.host.session);

		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBeUndefined();
	});

	it("releases the registry key a coordinator is bound to even after the session id has moved on", async () => {
		const harness = makeHarness(1, ["correctness"]);
		let reportedId = "old-id";
		const sessionManager = { getSessionId: () => reportedId, getCwd: () => harness.dispatch.cwd };
		const session = { ...harness.host.session, sessionManager } as unknown as typeof harness.host.session;
		const coordinator = getCouncilCoordinator({
			...harness.host,
			session,
			sessionManager,
		} as unknown as CouncilCoordinatorHost);
		expect(peekCouncilCoordinatorForSession(session, "old-id")).toBe(coordinator);
		// A host that advances its own id before running the reconciler: keying the release off the
		// current id would silently no-op and leave `old-id` holding this council forever.
		reportedId = "new-id";

		await quiesceAndReleaseCouncilForSessionTransition(session);

		expect(peekCouncilCoordinatorForSession(session, "old-id")).toBeUndefined();
		expect(peekCouncilCoordinatorForSession(session, "new-id")).toBeUndefined();
	});

	it("holds the registry entry through cancellation and releases it once the run settles", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		const releaseMember = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			await releaseMember.promise;
			const cancelled = new Error("cancelled reviewer");
			cancelled.name = "AbortError";
			throw cancelled;
		});
		const coordinator = getCouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;

		const transition = quiesceAndReleaseCouncilForSessionTransition(harness.host.session);
		for (let flush = 0; flush < 20; flush++) await Promise.resolve();
		// Still executing: releasing here would strand a live run with no owner for its own session.
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBe(coordinator);
		releaseMember.resolve();
		await transition;

		expect(coordinator.executionInFlight).toBeFalse();
		expect(coordinator.snapshot?.state).toBe("interrupted");
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBeUndefined();
	});

	it("retains and rethrows on a cancellation timeout, then releases once the run finally settles", async () => {
		const harness = makeHarness(1, ["correctness"]);
		installDispatch(harness);
		const memberStarted = Promise.withResolvers<void>();
		const releaseMember = Promise.withResolvers<void>();
		spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			if (request.agent === "council-planner") {
				return structuredResult(request, { plan: PLAN, assumptions: [], blockers: [], evidenceVersion: "1.0.0" });
			}
			memberStarted.resolve();
			await releaseMember.promise;
			return structuredResult(request, { readiness: "ready", findings: [], strengths: [], missingContext: [] });
		});
		const coordinator = getCouncilCoordinator(harness.host);
		await coordinator.start(harness.dispatch.task);
		await memberStarted.promise;
		spyOn(coordinator, "cancelForSessionTransition").mockRejectedValue(
			new Error("Council cancellation timed out after 5000ms"),
		);

		await expect(quiesceAndReleaseCouncilForSessionTransition(harness.host.session)).rejects.toThrow(
			"Council cancellation timed out after 5000ms",
		);
		// The old identity keeps its owner, so a transition that refuses cannot orphan a running council.
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBe(coordinator);

		releaseMember.resolve();
		await coordinator.completion;
		await coordinator.settled();
		for (let flush = 0; flush < 20; flush++) await Promise.resolve();

		expect(coordinator.snapshot?.state).toBe("completed");
		expect(peekCouncilCoordinatorForSession(harness.host.session, "session-one")).toBeUndefined();
	});
});

describe("formatCouncilKickoff", () => {
	const preview: CouncilKickoffPreview = {
		runId: "run-one",
		resumed: false,
		plannerModel: "planner/slow",
		plannerAdvisorModel: "advisor/watch",
		adjudicator: { mode: "delegated", model: "judge/one", advisorModel: "advisor/watch" },
		members: [
			{ role: "council1", model: "review/one", rounds: [1, 2], advisorModel: "advisor/watch" },
			{ role: "council2", model: "review/two", rounds: [2] },
		],
		rounds: 2,
	};

	it("names every model a run will bill, advisors included, per round", () => {
		// This is the pre-spend line: it is the last thing a reader sees before money is spent, and it
		// is shared by `/council` and the `convene` tool precisely so neither can understate the cost.
		// An advisor is a *second* model charged to the role it watches, so dropping `++` would report a
		// three-model run as costing two.
		expect(formatCouncilKickoff(preview)).toBe(
			"Starting run-one: planner=planner/slow ++advisor/watch, adjudicator=judge/one (delegated) ++advisor/watch, " +
				"round 1: [Reviewer 1=review/one ++advisor/watch], " +
				"round 2: [Reviewer 1=review/one ++advisor/watch, Reviewer 2=review/two].",
		);
	});

	it("omits the advisor marker when no advisor is attached and says Resuming on a resume", () => {
		const bare = formatCouncilKickoff({
			...preview,
			resumed: true,
			plannerAdvisorModel: undefined,
			adjudicator: { mode: "main", model: "main/active" },
			members: [{ role: "council1", model: "review/one", rounds: [1] }],
			rounds: 1,
		});

		expect(bare).toBe(
			"Resuming run-one: planner=planner/slow, adjudicator=main/active (main), round 1: [Reviewer 1=review/one].",
		);
		expect(bare).not.toContain("++");
	});

	it("strips control sequences a provider model string could smuggle into the line", () => {
		expect(formatCouncilKickoff({ ...preview, plannerModel: "planner/\u001b[31mslow\u001b[0m" })).toContain(
			"planner=planner/slow ++advisor/watch",
		);
	});
});
