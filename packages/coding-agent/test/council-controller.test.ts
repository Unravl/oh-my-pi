import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CouncilCoordinator,
	type CouncilCoordinatorHost,
	type CouncilCoordinatorSnapshot,
	type CouncilMemberLiveProgress,
	getCouncilCoordinator,
	resetCouncilCoordinatorsForTests,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import { COUNCIL_ADJUDICATOR_PROGRESS_ORDER } from "@oh-my-pi/pi-coding-agent/council/events";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilPaneComponent } from "@oh-my-pi/pi-coding-agent/modes/components/council-pane";
import {
	CouncilController,
	projectCouncilPaneSnapshot,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/council-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const NOW = "2026-08-05T12:00:00.000Z";

function manifest(state: CouncilManifest["state"] = "reviewing"): CouncilManifest {
	return {
		version: 2,
		runId: "run-1",
		sessionId: "session-1",
		mainAgentId: "Main",
		state,
		task: "Review the implementation",
		repoRoot: "/repo",
		outputPath: "council-review-the-implementation-plan.md",
		timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: NOW },
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
			capturedAt: NOW,
		},
		instructionSnapshot: {
			artifact: {
				url: "local://council-run-1-instructions.json",
				sha256: "1".repeat(64),
				bytes: 128,
			},
			sha256: "1".repeat(64),
		},
		rounds: [
			{
				round: 1,
				status: "running",
				startedAt: NOW,
				finishedAt: null,
				members: [
					{
						role: "council1",
						order: 0,
						status: "running",
						attempts: 2,
						startedAt: NOW,
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
				createdAt: NOW,
			},
		],
		usage: { requests: 2, tokens: 100, cost: 0.25 },
		adjudicationBudget: { injectedChars: 100, cap: 1_000 },
		warnings: [],
		degraded: false,
	};
}

function coordinatorSnapshot(
	state: CouncilManifest["state"] = "reviewing",
	mainTurnOwned = state === "adjudicating",
): CouncilCoordinatorSnapshot {
	const progress: CouncilMemberLiveProgress = {
		agentId: "council-council1-r1",
		round: 1,
		role: "council1",
		order: 0,
		attempt: 2,
		status: "running",
		lastIntent: "Inspecting the failure path",
		currentTool: "read",
		currentToolArgs: "src/service.ts:10-20",
		recentOutput: ["Found an unchecked transition"],
		requests: 3,
		tokens: 4_500,
		cost: 0.031,
		retryState: {
			attempt: 2,
			maxAttempts: 3,
			delayMs: 500,
			errorMessage: "rate limited",
			startedAtMs: Date.parse(NOW),
		},
	};
	return { manifest: manifest(state), members: [progress], mainTurnOwned };
}

/** Terminal, published fixture: the exact shape that arms the plan-approval handoff. */
function publishedManifest(): CouncilManifest {
	const settled = manifest("completed");
	settled.timestamps.finishedAt = NOW;
	settled.rounds[0]!.status = "settled";
	settled.rounds[0]!.finishedAt = NOW;
	settled.rounds[0]!.members[0]!.status = "succeeded";
	settled.rounds[0]!.members[0]!.finishedAt = NOW;
	settled.published = { path: settled.outputPath, sha256: "b".repeat(64), bytes: 2_048, publishedAt: NOW };
	return settled;
}

function terminalSnapshot(): CouncilCoordinatorSnapshot {
	return { manifest: publishedManifest(), members: [], mainTurnOwned: false };
}

/** Drain the promise chains the approval path threads through; no timers are involved. */
async function flushMicrotasks(turns = 40): Promise<void> {
	for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

/**
 * Controller harness wired for the plan-approval path: a real `ToolSession`-shaped double so
 * `createCouncilStorage` constructs, plus one coordinator double per session id.
 */
function councilHarness(
	options: {
		planMode?: { ok: true } | { ok: false; reason: string };
		messages?: unknown[];
		firstSnapshot?: CouncilCoordinatorSnapshot;
		completion?: Promise<void>;
		resumable?: CouncilManifest;
	} = {},
) {
	const state = { sessionId: "session-1" };
	const toolSessions = new Map<string, object>();
	function toolSessionFor(sessionId: string): object {
		const existing = toolSessions.get(sessionId);
		if (existing) return existing;
		const created = {
			localProtocolOptions: { getArtifactsDir: (): string | null => null, getSessionId: () => sessionId },
			sessionManager: { getSessionId: () => sessionId },
		};
		toolSessions.set(sessionId, created);
		return created;
	}

	const listeners = new Map<string, Array<(next: CouncilCoordinatorSnapshot) => void>>();
	const coordinators = new Map<string, CouncilCoordinator>();
	function coordinatorFor(sessionId: string): CouncilCoordinator {
		const existing = coordinators.get(sessionId);
		if (existing) return existing;
		const initial =
			sessionId === "session-1" && options.firstSnapshot ? options.firstSnapshot : coordinatorSnapshot("reviewing");
		const bound: Array<(next: CouncilCoordinatorSnapshot) => void> = [];
		listeners.set(sessionId, bound);
		const created = {
			snapshot: initial.manifest,
			coordinatorSnapshot: initial,
			completion: sessionId === "session-1" ? options.completion : undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				bound.push(listener);
				listener(initial);
				return vi.fn();
			}),
			status: vi.fn(async () => initial.manifest),
			resumableStatus: vi.fn(async () => (sessionId === "session-1" ? options.resumable : undefined)),
			cancelForSessionTransition: vi.fn(async () => initial.manifest),
		} as unknown as CouncilCoordinator;
		coordinators.set(sessionId, created);
		return created;
	}

	const getCoordinator = vi.fn((host: CouncilCoordinatorHost) => coordinatorFor(host.sessionManager.getSessionId()));
	const messages: unknown[] = options.messages ?? [];
	const sendCustomMessage = vi.fn(
		async (entry: { customType: string; display: boolean; content: string; details: { runId: string } }) => {
			messages.push({ role: "custom", customType: entry.customType, details: entry.details });
		},
	);
	const planMode: { ok: true } | { ok: false; reason: string } = options.planMode ?? { ok: true };
	const ensureCouncilPlanMode = vi.fn(async () => planMode);
	const handlePlanApproval = vi.fn(
		async (_details: PlanApprovalDetails, _options?: { header?: readonly string[] }) => {},
	);
	const showStatus = vi.fn((_message: string, _options?: { dim?: boolean }) => {});
	const showError = vi.fn((_message: string) => {});
	const present = vi.fn((_content: unknown) => {});
	const pane = new CouncilPaneComponent({
		tui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		getTerminalRows: () => 40,
		getEditorMaxHeight: () => 12,
		now: () => Date.parse(NOW),
	});
	const controller = new CouncilController(
		{
			session: {
				getToolSession: () => toolSessionFor(state.sessionId),
				modelRegistry: { marker: "registry" },
				get messages() {
					return messages;
				},
				sendCustomMessage,
			},
			sessionManager: { getSessionId: () => state.sessionId },
			settings: { get: () => undefined },
			ui: {
				addInputListener: vi.fn(() => vi.fn()),
				requestRender: vi.fn(),
				requestComponentRender: vi.fn(),
				terminal: { columns: 100 },
			},
			councilPane: pane,
			planModeEnabled: true,
			showError,
			showStatus,
			present,
			ensureCouncilPlanMode,
			handlePlanApproval,
		} as unknown as InteractiveModeContext,
		{ getCoordinator },
	);

	return {
		controller,
		getCoordinator,
		sendCustomMessage,
		ensureCouncilPlanMode,
		handlePlanApproval,
		showStatus,
		showError,
		toolSessionFor,
		setSessionId(sessionId: string): void {
			state.sessionId = sessionId;
		},
		emit(next: CouncilCoordinatorSnapshot): void {
			for (const listener of listeners.get(state.sessionId) ?? []) listener(next);
		},
	};
}

describe("CouncilController", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetCouncilCoordinatorsForTests();
	});

	it("projects planner, reviewer, and adjudicator rows in a fixed order without mutating the snapshot", () => {
		const input = coordinatorSnapshot();
		const before = structuredClone(input);
		const projected = projectCouncilPaneSnapshot(input);
		expect(input).toEqual(before);
		expect(projected.rows.map(item => item.label)).toEqual(["Planner", "Reviewer 1", "Adjudicator"]);
		expect(projected.rows[0]?.model).toBe("openai/gpt-5.6-sol:max");
		expect(projected.rows[2]?.model).toBe("anthropic/claude-opus-4.1:high");
		expect(projected.rows[1]).toMatchObject({
			status: "retry",
			attempts: 2,
			currentTool: "read",
			currentToolArgs: "src/service.ts:10-20",
			requests: 3,
			tokens: 4_500,
			cost: 0.031,
		});
	});
	it("shows the reviewer's pinned model without the effort the next column already carries", () => {
		const input = coordinatorSnapshot();
		// What the child actually resolved to: the pinned identity plus its thinking selector.
		input.manifest.rounds[0]!.members[0]!.resolvedModel = "openai/gpt-5.6-sol:max:xhigh";

		const projected = projectCouncilPaneSnapshot(input);

		expect(projected.rows[1]).toMatchObject({ model: "openai/gpt-5.6-sol:max", effort: "max" });
	});
	it("marks the adjudicator row when a live advisor watches Main's turns", () => {
		const input = coordinatorSnapshot();
		expect(projectCouncilPaneSnapshot(input).rows[2]?.advisor).toBe(false);
		expect(projectCouncilPaneSnapshot(input, { adjudicatorAdvisor: true }).rows[2]?.advisor).toBe(true);
		// A reviewer's advisor is durable and opt-in per role; this fixture leaves it off.
		expect(projectCouncilPaneSnapshot(input, { adjudicatorAdvisor: true }).rows[1]?.advisor).toBe(false);
	});

	it("keeps a settled role's spend on its row after live telemetry is released", () => {
		const input = coordinatorSnapshot();
		// What the coordinator does when an agent finishes: write the durable bucket, drop the live row.
		input.members = [];
		const record = input.manifest.rounds[0]!.members[0]!;
		record.status = "succeeded";
		record.usage = { requests: 5, tokens: 9_000, cost: 0.42 };
		input.manifest.plannerUsage = { requests: 2, tokens: 1_500, cost: 0.05 };
		input.manifest.adjudicatorUsage = { requests: 1, tokens: 800, cost: 0.02 };

		const rows = projectCouncilPaneSnapshot(input).rows;

		expect(rows[0]).toMatchObject({ label: "Planner", requests: 2, tokens: 1_500, cost: 0.05 });
		expect(rows[1]).toMatchObject({ label: "Reviewer 1", requests: 5, tokens: 9_000, cost: 0.42 });
		expect(rows[2]).toMatchObject({ label: "Adjudicator", requests: 1, tokens: 800, cost: 0.02 });
	});

	it("leaves a row that has spent nothing blank instead of reporting a zeroed total", () => {
		const input = coordinatorSnapshot();
		input.members = [];

		const row = projectCouncilPaneSnapshot(input).rows[1];

		expect(row).toMatchObject({ label: "Reviewer 1" });
		expect(row?.requests).toBeUndefined();
		expect(row?.tokens).toBeUndefined();
		expect(row?.cost).toBeUndefined();
	});

	it("adds a reviewer's settled rounds to the live sample of the round it is still running", () => {
		const input = coordinatorSnapshot();
		input.manifest.roster[0]!.rounds = [1, 2];
		const roundOne = input.manifest.rounds[0]!;
		roundOne.status = "settled";
		roundOne.members[0]!.status = "succeeded";
		roundOne.members[0]!.usage = { requests: 5, tokens: 9_000, cost: 0.42 };
		input.manifest.rounds.push({
			...roundOne,
			round: 2,
			status: "running",
			members: [{ ...roundOne.members[0]!, status: "running", usage: undefined }],
		});
		// Live telemetry for round 2 only; round 1's spend must survive beside it.
		input.members = [{ ...input.members[0]!, round: 2, requests: 3, tokens: 4_500, cost: 0.031 }];

		const row = projectCouncilPaneSnapshot(input).rows[1];

		expect(row).toMatchObject({ label: "Reviewer 1", requests: 8, tokens: 13_500 });
		expect(row?.cost).toBeCloseTo(0.451, 5);
	});

	it("adds the adjudicator's earlier rounds to the turn it is judging now", () => {
		const input = coordinatorSnapshot("adjudicating");
		// Round 1's adjudication is already charged; `adjudicatorUsage` accumulates across turns.
		input.manifest.adjudicatorUsage = { requests: 4, tokens: 6_000, cost: 0.2 };
		// Round 2's turn is live. The coordinator drops the live row before charging the durable
		// bucket, so the two never describe the same turn and must be summed, never replaced.
		input.members = [
			{
				...input.members[0]!,
				round: 0,
				role: "main",
				order: -2,
				requests: 2,
				tokens: 1_000,
				cost: 0.05,
			},
		];

		const row = projectCouncilPaneSnapshot(input).rows[2];

		expect(row).toMatchObject({ label: "Adjudicator", requests: 6, tokens: 7_000 });
		expect(row?.cost).toBeCloseTo(0.25, 5);
	});

	it("adds the planner's durable charge to a relaunched planner's live sample", () => {
		const input = coordinatorSnapshot();
		input.manifest.plannerUsage = { requests: 3, tokens: 2_000, cost: 0.1 };
		input.members = [
			{ ...input.members[0]!, round: 0, role: "planner", order: -1, requests: 1, tokens: 500, cost: 0.02 },
		];

		const row = projectCouncilPaneSnapshot(input).rows[0];

		expect(row).toMatchObject({ label: "Planner", requests: 4, tokens: 2_500 });
		expect(row?.cost).toBeCloseTo(0.12, 5);
	});
	it("projects awaiting-main as a waiting adjudicator row that explains itself", () => {
		const input = coordinatorSnapshot();
		input.manifest.state = "awaiting-main";
		const projected = projectCouncilPaneSnapshot(input);
		expect(projected.rows[2]).toMatchObject({
			label: "Adjudicator",
			status: "waiting",
			lastIntent: "Council resumes when your current turn ends.",
		});
		expect(projected.rows).toHaveLength(3);
	});
	it("fills the adjudicator row from the reserved live-telemetry coordinates during adjudication", () => {
		const input = coordinatorSnapshot("adjudicating");
		input.members = [
			...input.members,
			{
				agentId: "Main",
				round: 0,
				role: "main",
				order: COUNCIL_ADJUDICATOR_PROGRESS_ORDER,
				attempt: 1,
				status: "running",
				recentOutput: [],
				requests: 2,
				tokens: 8_100,
				cost: 0.42,
			},
		];

		const projected = projectCouncilPaneSnapshot(input);

		expect(projected.rows[2]).toMatchObject({
			label: "Adjudicator",
			status: "running",
			requests: 2,
			tokens: 8_100,
			cost: 0.42,
		});
		// The sentinel is the adjudicator's row, never an extra roster row.
		expect(projected.rows.map(row => row.label)).toEqual(["Planner", "Reviewer 1", "Adjudicator"]);
	});
	it("keeps the adjudicator row settled while the plan is being published", () => {
		const input = coordinatorSnapshot("publishing");
		input.members = [];

		const projected = projectCouncilPaneSnapshot(input);

		// Main's adjudication is finished by then; a `default` branch used to regress it to queued.
		expect(projected.rows[2]).toMatchObject({ label: "Adjudicator", status: "succeeded" });
	});
	it("projects bounded sanitized manifest and auth-fallback warnings into the live pane", () => {
		const input = coordinatorSnapshot();
		// Warnings are the subject here; live member detail lines would only crowd the bounded body.
		input.members = [];
		input.manifest.warnings = [
			`\u001b[31mduplicate\tmodel\n${"界".repeat(100)}MANIFEST_WARNING_TAIL`,
			...Array.from({ length: 6 }, (_, index) => `manifest warning ${index + 2}`),
		];
		input.manifest.rounds[0]!.members[0]!.authFallbackUsed = true;

		const projected = projectCouncilPaneSnapshot(input);
		const warnings = [...(projected.warnings ?? [])];
		expect(warnings).toHaveLength(6);
		// Durable role ids are `councilN`; every operator-facing row shows the stable `Reviewer N`.
		expect(warnings).toContain("Reviewer 1 used an authentication fallback");
		expect(warnings.some(warning => warning.includes("council1"))).toBeFalse();
		expect(warnings.some(warning => warning.includes("duplicate model"))).toBeTrue();
		for (const warning of warnings) {
			expect(warning).not.toContain("\t");
			expect(warning).not.toContain("\n");
			expect(warning).not.toContain("\u001b");
			expect(Bun.stringWidth(warning)).toBeLessThanOrEqual(80);
		}
		expect(warnings.join(" ")).not.toContain("MANIFEST_WARNING_TAIL");

		const pane = new CouncilPaneComponent({
			tui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
			getTerminalRows: () => 40,
			getEditorMaxHeight: () => 12,
			now: () => Date.parse(NOW),
		});
		pane.update(projected);
		const collapsed = Bun.stripANSI(pane.render(140).join("\n"));
		expect(collapsed).not.toContain("6w");
		// Collapsed keeps the count, not the text: warning bodies live in the expanded pane.
		expect(collapsed).toContain("+6 warnings");
		expect(collapsed).not.toContain("manifest warning 2");
		pane.setExpanded(true);
		const expanded = Bun.stripANSI(pane.render(140).join("\n"));
		expect(expanded).toContain("6 warnings");
		expect(expanded).toContain("manifest warning 2");
	});
	it("selects the lifecycle-owned round across planning, review, adjudication, and transition", () => {
		const stages: Array<{
			state: CouncilManifest["state"];
			firstStatus: CouncilManifest["rounds"][number]["status"];
			expectedRound: number;
			hasRoundOneTelemetry: boolean;
			roundOnePublished: boolean;
		}> = [
			{
				state: "planning",
				firstStatus: "pending",
				expectedRound: 1,
				hasRoundOneTelemetry: false,
				roundOnePublished: false,
			},
			{
				state: "reviewing",
				firstStatus: "running",
				expectedRound: 1,
				hasRoundOneTelemetry: true,
				roundOnePublished: false,
			},
			{
				state: "adjudicating",
				firstStatus: "settled",
				expectedRound: 1,
				hasRoundOneTelemetry: true,
				roundOnePublished: false,
			},
			{
				state: "round-transition",
				firstStatus: "settled",
				expectedRound: 2,
				hasRoundOneTelemetry: false,
				roundOnePublished: true,
			},
		];

		for (const stage of stages) {
			const input = coordinatorSnapshot(stage.state);
			const first = input.manifest.rounds[0]!;
			first.status = stage.firstStatus;
			first.finishedAt = stage.firstStatus === "settled" ? NOW : null;
			if (stage.firstStatus === "pending") {
				first.members[0]!.status = "pending";
				first.members[0]!.attempts = 0;
			}
			const second = structuredClone(first);
			second.round = 2;
			second.status = "pending";
			second.startedAt = null;
			second.finishedAt = null;
			second.members[0]!.status = "pending";
			second.members[0]!.attempts = 0;
			second.members[0]!.startedAt = null;
			second.members[0]!.finishedAt = null;
			input.manifest.rounds = [first, second];
			input.manifest.config.rounds = 2;
			input.members = stage.hasRoundOneTelemetry ? [{ ...input.members[0]!, currentTool: "round-one-tool" }] : [];
			if (stage.state === "planning") {
				input.manifest.planVersions = [];
			} else if (stage.roundOnePublished) {
				const draft = input.manifest.planVersions[0]!;
				input.manifest.planVersions = [draft, { ...draft, version: 2, round: 1, kind: "round" }];
			}

			const projected = projectCouncilPaneSnapshot(input);
			expect(projected.round).toBe(stage.expectedRound);
			if (stage.hasRoundOneTelemetry) {
				expect(projected.rows[1]?.currentTool).toBe("round-one-tool");
			} else {
				expect(projected.rows[1]?.currentTool).toBeUndefined();
			}
		}
	});
	it("keeps an interrupted unresolved round selected during resume hydration", () => {
		const input = coordinatorSnapshot("reviewing");
		const first = input.manifest.rounds[0]!;
		first.status = "interrupted";
		first.finishedAt = NOW;
		first.members[0]!.status = "interrupted";
		first.members[0]!.finishedAt = NOW;
		const second = structuredClone(first);
		second.round = 2;
		second.status = "pending";
		second.startedAt = null;
		second.finishedAt = null;
		second.members[0]!.status = "pending";
		second.members[0]!.attempts = 0;
		second.members[0]!.startedAt = null;
		second.members[0]!.finishedAt = null;
		input.manifest.rounds = [first, second];
		input.manifest.config.rounds = 2;
		input.members = [];

		const projected = projectCouncilPaneSnapshot(input);
		expect(projected.round).toBe(1);
		expect(projected.rows[1]?.status).toBe("interrupted");
	});

	it("uses the exact live host, subscribes once, repaints ticks locally, cancels, and detaches", async () => {
		const active = coordinatorSnapshot("adjudicating");
		let listener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		const unsubscribe = vi.fn();
		const inputUnsubscribe = vi.fn();
		const cancelGate = Promise.withResolvers<void>();
		const cancel = vi.fn(async () => {
			await cancelGate.promise;
		});
		const status = vi.fn(async () => active.manifest);
		const coordinator = {
			snapshot: active.manifest,
			coordinatorSnapshot: active,
			completion: undefined,
			subscribe: vi.fn((next: (value: CouncilCoordinatorSnapshot) => void) => {
				listener = next;
				next(active);
				return unsubscribe;
			}),
			status,
			resumableStatus: vi.fn(async () => undefined),
			cancel,
			cancelForSessionTransition: cancel,
		} as unknown as CouncilCoordinator;
		let coordinatorHost: CouncilCoordinatorHost | undefined;
		const getCoordinator = vi.fn((host: CouncilCoordinatorHost) => {
			coordinatorHost = host;
			return coordinator;
		});
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];
		const toolSession = { marker: "live-tool-session" };
		const sessionManager = { getSessionId: () => "session-1" };
		const settings = { marker: "settings" };
		const modelRegistry = { marker: "registry" };
		const session = { getToolSession: () => toolSession, modelRegistry, messages: [], sendCustomMessage: vi.fn() };
		const ui = {
			requestRender,
			requestComponentRender,
			addInputListener: vi.fn((input: (data: string) => { consume?: boolean } | undefined) => {
				inputListeners.push(input);
				return inputUnsubscribe;
			}),
		};
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
			now: () => Date.parse(NOW),
		});
		const showError = vi.fn();
		const controller = new CouncilController(
			{
				session,
				sessionManager,
				settings,
				ui,
				councilPane: pane,
				planModeEnabled: true,
				showError,
				showStatus: vi.fn(),
				present: vi.fn(),
				ensureCouncilPlanMode: vi.fn(async () => ({ ok: true }) as const),
				handlePlanApproval: vi.fn(async () => {}),
			} as unknown as InteractiveModeContext,
			{ getCoordinator },
		);

		controller.attach();
		controller.attach();
		expect(getCoordinator).toHaveBeenCalledTimes(1);
		expect(coordinatorHost).toMatchObject({
			session,
			toolSession,
			sessionManager,
			settings,
			modelRegistry,
		});
		expect(controller.hasActiveCouncil()).toBeTrue();
		expect(controller.isCouncilAdjudicating()).toBeTrue();
		listener?.({ ...active, mainTurnOwned: false });
		expect(controller.isCouncilAdjudicating()).toBeFalse();
		listener?.({ ...active, mainTurnOwned: true });
		expect(controller.isCouncilAdjudicating()).toBeTrue();
		expect(pane.render(120).length).toBeGreaterThan(0);

		requestRender.mockClear();
		requestComponentRender.mockClear();
		vi.advanceTimersByTime(1_000);
		expect(requestComponentRender).toHaveBeenCalledWith(pane);
		expect(requestRender).not.toHaveBeenCalled();

		let transitionSettled = false;
		const transitionCancellation = controller.quiesceForSessionTransition().then(() => {
			transitionSettled = true;
		});
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(controller.isCouncilAdjudicating()).toBeFalse();
		listener?.({ ...active, manifest: manifest("completed") });
		expect(controller.cancelCouncilRun()).toBeFalse();
		let concurrentTransitionSettled = false;
		const concurrentTransitionCancellation = controller.quiesceForSessionTransition().then(() => {
			concurrentTransitionSettled = true;
		});
		await Promise.resolve();
		expect(transitionSettled).toBeFalse();
		expect(concurrentTransitionSettled).toBeFalse();
		cancelGate.resolve();
		await Promise.all([transitionCancellation, concurrentTransitionCancellation]);
		expect(transitionSettled).toBeTrue();
		expect(concurrentTransitionSettled).toBeTrue();

		listener?.({ ...active, manifest: manifest("completed") });
		expect(controller.hasActiveCouncil()).toBeFalse();
		await controller.quiesceForSessionTransition();
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(pane.render(120)).toEqual([]);
		controller.dispose();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(inputUnsubscribe).toHaveBeenCalledTimes(1);
		expect(showError).not.toHaveBeenCalled();
	});
	it("treats preflight-only execution as active and blocks transition until cancellation settles", async () => {
		let executionInFlight = true;
		const cancelGate = Promise.withResolvers<void>();
		const cancelForSessionTransition = vi.fn(async () => {
			await cancelGate.promise;
			executionInFlight = false;
		});
		const coordinator = {
			get executionInFlight() {
				return executionInFlight;
			},
			snapshot: undefined,
			coordinatorSnapshot: undefined,
			completion: undefined,
			subscribe: vi.fn(() => vi.fn()),
			status: vi.fn(async () => undefined),
			resumableStatus: vi.fn(async () => undefined),
			cancelForSessionTransition,
		} as unknown as CouncilCoordinator;
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
		});
		const controller = new CouncilController(
			{
				session: { getToolSession: () => ({}), modelRegistry: {}, messages: [], sendCustomMessage: vi.fn() },
				sessionManager: { getSessionId: () => "session-preflight" },
				settings: {},
				ui: { addInputListener: vi.fn(() => vi.fn()), requestRender, requestComponentRender },
				councilPane: pane,
				planModeEnabled: true,
				showError: vi.fn(),
				showStatus: vi.fn(),
				present: vi.fn(),
				ensureCouncilPlanMode: vi.fn(async () => ({ ok: true }) as const),
				handlePlanApproval: vi.fn(async () => {}),
			} as unknown as InteractiveModeContext,
			{ getCoordinator: () => coordinator },
		);
		controller.attach();
		expect(controller.hasActiveCouncil()).toBeTrue();

		let storageMoved = false;
		const transition = controller.quiesceForSessionTransition().then(() => {
			storageMoved = true;
		});
		expect(cancelForSessionTransition).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(storageMoved).toBeFalse();

		cancelGate.resolve();
		await transition;
		expect(storageMoved).toBeTrue();
		expect(controller.hasActiveCouncil()).toBeFalse();
		controller.dispose();
	});
	it("rebinds by session generation without leaking old emissions or input listeners", async () => {
		let sessionId = "session-1";
		const oldSnapshot = coordinatorSnapshot("reviewing");
		oldSnapshot.manifest.outputPath = "council-old-session-plan.md";
		const newSnapshot = coordinatorSnapshot("adjudicating");
		newSnapshot.manifest.runId = "run-2";
		newSnapshot.manifest.sessionId = "session-2";
		newSnapshot.manifest.outputPath = "council-new-session-plan.md";
		const restoredSnapshot = coordinatorSnapshot("adjudicating");
		restoredSnapshot.manifest.runId = "run-3";
		restoredSnapshot.manifest.outputPath = "council-restored-session-plan.md";

		let oldListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let newListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let restoredListener: ((next: CouncilCoordinatorSnapshot) => void) | undefined;
		let releaseOldStatus!: () => void;
		const oldStatusGate = new Promise<void>(resolve => {
			releaseOldStatus = resolve;
		});
		const oldUnsubscribe = vi.fn();
		const newUnsubscribe = vi.fn();
		const restoredUnsubscribe = vi.fn();
		const inputUnsubscribe = vi.fn();
		const oldCancel = vi.fn(async () => manifest("interrupted"));
		const newCancel = vi.fn(async () => manifest("interrupted"));
		const restoredCancel = vi.fn(async () => manifest("interrupted"));
		const oldCoordinator = {
			snapshot: oldSnapshot.manifest,
			coordinatorSnapshot: oldSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				oldListener = listener;
				listener(oldSnapshot);
				return oldUnsubscribe;
			}),
			status: vi.fn(async () => {
				await oldStatusGate;
				oldListener?.(oldSnapshot);
				return oldSnapshot.manifest;
			}),
			resumableStatus: vi.fn(async () => undefined),
			cancel: oldCancel,
			cancelForSessionTransition: oldCancel,
		} as unknown as CouncilCoordinator;
		const newCoordinator = {
			snapshot: newSnapshot.manifest,
			coordinatorSnapshot: newSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				newListener = listener;
				listener(newSnapshot);
				return newUnsubscribe;
			}),
			status: vi.fn(async () => newSnapshot.manifest),
			resumableStatus: vi.fn(async () => undefined),
			cancel: newCancel,
			cancelForSessionTransition: newCancel,
		} as unknown as CouncilCoordinator;
		const restoredCoordinator = {
			snapshot: restoredSnapshot.manifest,
			coordinatorSnapshot: restoredSnapshot,
			completion: undefined,
			subscribe: vi.fn((listener: (value: CouncilCoordinatorSnapshot) => void) => {
				restoredListener = listener;
				listener(restoredSnapshot);
				return restoredUnsubscribe;
			}),
			status: vi.fn(async () => restoredSnapshot.manifest),
			resumableStatus: vi.fn(async () => undefined),
			cancel: restoredCancel,
			cancelForSessionTransition: restoredCancel,
		} as unknown as CouncilCoordinator;
		const coordinatorHosts: CouncilCoordinatorHost[] = [];
		const coordinatorByToolSession = new Map<object, CouncilCoordinator>();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const addInputListener = vi.fn(() => inputUnsubscribe);
		const oldToolSession = { marker: "a-old-tool-session" };
		const bToolSession = { marker: "b-tool-session" };
		const restoredToolSession = { marker: "a-restored-tool-session" };
		const modelRegistry = { marker: "registry" };
		const oldSession = {
			marker: "a-old-session",
			getToolSession: () => oldToolSession,
			modelRegistry,
			messages: [],
			sendCustomMessage: vi.fn(),
		};
		const bSession = {
			marker: "b-session",
			getToolSession: () => bToolSession,
			modelRegistry,
			messages: [],
			sendCustomMessage: vi.fn(),
		};
		const restoredSession = {
			marker: "a-restored-session",
			getToolSession: () => restoredToolSession,
			modelRegistry,
			messages: [],
			sendCustomMessage: vi.fn(),
		};
		let activeSession = oldSession;
		const sessionManager = { getSessionId: () => sessionId };
		coordinatorByToolSession.set(oldToolSession, oldCoordinator);
		coordinatorByToolSession.set(bToolSession, newCoordinator);
		coordinatorByToolSession.set(restoredToolSession, restoredCoordinator);
		const restoredHostLabels = new Map<object, string>([
			[restoredToolSession, "restored-tool"],
			[restoredSession, "restored-session"],
		]);
		const getCoordinator = vi.fn((host: CouncilCoordinatorHost) => {
			coordinatorHosts.push(host);
			const coordinator = coordinatorByToolSession.get(host.toolSession);
			if (!coordinator) throw new Error("Unexpected Council host");
			return coordinator;
		});
		const pane = new CouncilPaneComponent({
			tui: { requestRender, requestComponentRender },
			getTerminalRows: () => 24,
			getEditorMaxHeight: () => 12,
		});
		const controller = new CouncilController(
			{
				get session() {
					return activeSession;
				},
				sessionManager,
				settings: { marker: "settings" },
				ui: { addInputListener, requestRender, requestComponentRender },
				councilPane: pane,
				planModeEnabled: true,
				showError: vi.fn(),
				showStatus: vi.fn(),
				present: vi.fn(),
				ensureCouncilPlanMode: vi.fn(async () => ({ ok: true }) as const),
				handlePlanApproval: vi.fn(async () => {}),
			} as unknown as InteractiveModeContext,
			{ getCoordinator },
		);

		controller.attach();
		expect(pane.snapshot?.outputPath).toBe("council-old-session-plan.md");
		expect(addInputListener).toHaveBeenCalledTimes(1);

		sessionId = "session-2";
		activeSession = bSession;
		controller.rebindForSession();
		controller.rebindForSession();
		expect(oldUnsubscribe).toHaveBeenCalledTimes(1);
		expect(getCoordinator).toHaveBeenCalledTimes(2);
		expect(newCoordinator.subscribe).toHaveBeenCalledTimes(1);
		expect(addInputListener).toHaveBeenCalledTimes(1);
		expect(pane.snapshot?.outputPath).toBe("council-new-session-plan.md");

		oldListener?.(oldSnapshot);
		expect(pane.snapshot?.outputPath).toBe("council-new-session-plan.md");
		releaseOldStatus();
		await Promise.resolve();
		await Promise.resolve();
		expect(pane.snapshot?.outputPath).toBe("council-new-session-plan.md");

		sessionId = "session-1";
		activeSession = restoredSession;
		controller.rebindForSession();
		expect(newUnsubscribe).toHaveBeenCalledTimes(1);
		expect(getCoordinator).toHaveBeenCalledTimes(3);
		const restoredHost = coordinatorHosts[2];
		expect(restoredHost).toBeDefined();
		if (!restoredHost) throw new Error("Expected restored Council host");
		expect(restoredHostLabels.get(restoredHost.toolSession)).toBe("restored-tool");
		expect(restoredHostLabels.get(restoredHost.session)).toBe("restored-session");
		expect(restoredCoordinator.subscribe).toHaveBeenCalledTimes(1);
		expect(pane.snapshot?.outputPath).toBe("council-restored-session-plan.md");

		oldListener?.(oldSnapshot);
		newListener?.(newSnapshot);
		expect(pane.snapshot?.outputPath).toBe("council-restored-session-plan.md");
		expect(controller.cancelCouncilRun()).toBeTrue();
		expect(restoredCancel).toHaveBeenCalledTimes(1);
		expect(newCancel).not.toHaveBeenCalled();
		expect(oldCancel).not.toHaveBeenCalled();
		restoredListener?.({ ...restoredSnapshot, manifest: { ...restoredSnapshot.manifest, state: "completed" } });
		controller.dispose();
		expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
		expect(inputUnsubscribe).toHaveBeenCalledTimes(1);
	});
	it("fills the Planner row from the reserved round-0/order-(-1) live-progress entry", () => {
		const input = coordinatorSnapshot("planning");
		input.members = [
			{
				agentId: "council-planner-1",
				round: 0,
				role: "planner",
				order: -1,
				attempt: 1,
				status: "running",
				lastIntent: "Drafting the phased plan",
				currentTool: "write",
				currentToolArgs: "local://council-run-1-draft.md",
				recentOutput: ["Phase 1 drafted"],
				requests: 5,
				tokens: 9_100,
				cost: 0.42,
			},
		];

		const projected = projectCouncilPaneSnapshot(input);
		expect(projected.rows[0]?.label).toBe("Planner");
		expect(projected.rows[0]?.currentTool).toBe("write");
		expect(projected.rows[0]?.currentToolArgs).toBe("local://council-run-1-draft.md");
		expect(projected.rows[0]?.lastIntent).toBe("Drafting the phased plan");
		expect(projected.rows[0]?.recentOutput).toEqual(["Phase 1 drafted"]);
		expect(projected.rows[0]?.requests).toBe(5);
		expect(projected.rows[0]?.tokens).toBe(9_100);
		expect(projected.rows[0]?.cost).toBe(0.42);
	});

	it("opens the plan-approval overlay exactly once for a run that finished published in this binding", async () => {
		const harness = councilHarness();
		harness.controller.attach();
		await flushMicrotasks();

		const settled = terminalSnapshot();
		harness.emit(settled);
		await flushMicrotasks();
		harness.emit(settled);
		await flushMicrotasks();

		expect(harness.handlePlanApproval).toHaveBeenCalledTimes(1);
		const [details, overlayOptions] = harness.handlePlanApproval.mock.calls[0] ?? [];
		expect(details?.planFilePath).toBe("local://council-review-the-implementation-plan.md");
		expect(details?.title).toBe("review-the-implementation");
		expect(details?.planExists).toBeTrue();
		expect(overlayOptions?.header?.length ?? 0).toBeGreaterThan(0);
		harness.controller.dispose();
	});

	it("never opens the overlay for an agent-convened run, published or not", async () => {
		// The whole point of an agent-convened run: it answers the tool that asked for it. Offering the
		// operator an approval screen would abort their in-flight turn for a plan they never requested.
		const harness = councilHarness();
		harness.controller.attach();
		await flushMicrotasks();

		const agentRun = publishedManifest();
		agentRun.origin = "agent";
		agentRun.outputPath = "council-review-the-implementation-brief.md";
		agentRun.published = { ...agentRun.published!, path: agentRun.outputPath };
		harness.emit({ manifest: agentRun, members: [], mainTurnOwned: false });
		await flushMicrotasks();

		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		expect(harness.ensureCouncilPlanMode).not.toHaveBeenCalled();
		// No approval marker either: nothing was presented, so nothing is recorded as presented.
		expect(harness.sendCustomMessage).not.toHaveBeenCalled();
		harness.controller.dispose();
	});

	it("never opens the overlay when the very first snapshot is already terminal", async () => {
		const harness = councilHarness({ firstSnapshot: terminalSnapshot() });
		harness.controller.attach();
		await flushMicrotasks();

		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		expect(harness.ensureCouncilPlanMode).not.toHaveBeenCalled();
		expect(harness.sendCustomMessage).not.toHaveBeenCalled();
		harness.controller.dispose();
	});

	it("skips the overlay when a council-plan-approved marker for the run is already persisted", async () => {
		const harness = councilHarness({
			messages: [{ role: "custom", customType: "council-plan-approved", details: { runId: "run-1" } }],
		});
		harness.controller.attach();
		await flushMicrotasks();

		harness.emit(terminalSnapshot());
		await flushMicrotasks();

		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		expect(harness.ensureCouncilPlanMode).not.toHaveBeenCalled();
		harness.controller.dispose();
	});

	it("reports the plan-mode refusal reason and still records the approval marker", async () => {
		const reason = "plan mode is disabled in settings (plan.enabled)";
		const harness = councilHarness({ planMode: { ok: false, reason } });
		harness.controller.attach();
		await flushMicrotasks();

		harness.emit(terminalSnapshot());
		await flushMicrotasks();

		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		const statuses = harness.showStatus.mock.calls.map(call => String(call[0])).join("\n");
		expect(statuses).toContain(reason);
		expect(statuses).toContain("local://council-review-the-implementation-plan.md");
		expect(harness.sendCustomMessage).toHaveBeenCalledTimes(1);
		expect(harness.sendCustomMessage.mock.calls[0]?.[0]?.customType).toBe("council-plan-approved");
		expect(harness.sendCustomMessage.mock.calls[0]?.[0]?.details.runId).toBe("run-1");
		harness.controller.dispose();
	});

	it("drops a completion that settles after the binding moved on", async () => {
		const settle = Promise.withResolvers<void>();
		const settleAwaited = vi.spyOn(settle.promise, "catch");
		const harness = councilHarness({ completion: settle.promise });
		harness.controller.attach();
		await flushMicrotasks();

		harness.emit(terminalSnapshot());
		await flushMicrotasks();
		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		// Proves the approval genuinely parked on the pending completion instead of never starting.
		expect(settleAwaited).toHaveBeenCalled();

		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		try {
			harness.setSessionId("session-2");
			harness.controller.rebindForSession();
			settle.resolve();
			await flushMicrotasks();
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		expect(harness.ensureCouncilPlanMode).not.toHaveBeenCalled();
		expect(harness.showError).not.toHaveBeenCalled();
		expect(rejections).toEqual([]);
		harness.controller.dispose();
	});

	it("leaves the live terminal transition to the durable council-run event", async () => {
		const harness = councilHarness();
		harness.controller.attach();
		await flushMicrotasks();

		const interrupted: CouncilCoordinatorSnapshot = {
			manifest: manifest("interrupted"),
			members: [],
			mainTurnOwned: false,
		};
		harness.emit(interrupted);
		harness.emit(interrupted);
		await flushMicrotasks();

		// `showStatus` replaces consecutive lines rather than appending, so a second producer on this
		// transition would race the coordinator's terminal event. The controller stays quiet.
		const hints = harness.showStatus.mock.calls
			.map(call => String(call[0]))
			.filter(message => message.includes("/council resume run-1"));
		expect(hints).toEqual([]);
		expect(harness.handlePlanApproval).not.toHaveBeenCalled();
		harness.controller.dispose();
	});

	it("names the resume command once when a restored session hydrates an interrupted run", async () => {
		const harness = councilHarness({ resumable: manifest("interrupted") });
		harness.controller.attach();
		await flushMicrotasks();
		// Leaving the session and returning re-runs hydration; the per-run dedupe must still hold.
		harness.setSessionId("session-2");
		harness.controller.rebindForSession();
		await flushMicrotasks();
		harness.setSessionId("session-1");
		harness.controller.rebindForSession();
		await flushMicrotasks();

		const hints = harness.showStatus.mock.calls
			.map(call => String(call[0]))
			.filter(message => message.includes("/council resume run-1"));
		expect(hints).toHaveLength(1);
		expect(hints[0]).toContain("Council run-1 interrupted at interrupted");
		harness.controller.dispose();
	});

	it("releases the left-behind session's cached coordinator so returning rebuilds one", () => {
		resetCouncilCoordinatorsForTests();
		const probeHost = {
			session: { marker: "probe-session" },
			toolSession: { marker: "probe-tool-session" },
			sessionManager: { getSessionId: () => "session-1" },
			settings: { marker: "settings" },
			modelRegistry: { marker: "registry" },
		} as unknown as CouncilCoordinatorHost;
		const cached = getCouncilCoordinator(probeHost);
		expect(getCouncilCoordinator(probeHost)).toBe(cached);

		const harness = councilHarness();
		harness.controller.attach();
		expect(harness.getCoordinator).toHaveBeenCalledTimes(1);

		harness.setSessionId("session-2");
		harness.controller.rebindForSession();
		expect(harness.getCoordinator).toHaveBeenCalledTimes(2);
		expect(getCouncilCoordinator(probeHost)).not.toBe(cached);

		harness.setSessionId("session-1");
		harness.controller.rebindForSession();
		expect(harness.getCoordinator).toHaveBeenCalledTimes(3);
		const returningHost = harness.getCoordinator.mock.calls[2]?.[0];
		expect(Object.is(returningHost?.toolSession, harness.toolSessionFor("session-1"))).toBeTrue();
		harness.controller.dispose();
	});
});

describe("InteractiveMode Council root placement", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-council-pane-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 fixture model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetCouncilCoordinatorsForTests();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("mounts the blank Council pane directly after chat and before every other live container", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const chatIndex = mode.ui.children.indexOf(mode.chatContainer);
		expect(chatIndex).toBeGreaterThanOrEqual(0);
		expect(mode.ui.children[chatIndex + 1]).toBe(mode.councilPane);
		expect(mode.councilPane.render(100)).toEqual([]);
		expect(mode.ui.children.indexOf(mode.pendingMessagesContainer)).toBeGreaterThan(chatIndex + 1);
	});

	// `AgentSession.newSession()` fires only the transition reconciler, which merely quiesces Council;
	// the switch reconciler that rebinds the controller is deliberately never fired for `/new`. Without
	// a rebind at `clearTransientSessionUi()` — the choke point `/new` routes through *after* the id
	// changed — the controller stays subscribed to the retired session while `/council` mints a
	// coordinator under the new one, and the Council area never appears.
	it("rebinds Council onto the new session id when /new clears the transient UI", async () => {
		const toolSession = { marker: "stub-tool-session" };
		vi.spyOn(session, "getToolSession").mockReturnValue(toolSession as never);
		await mode.init({ suppressWelcomeIntro: true });
		const firstId = session.sessionManager.getSessionId();

		const hosts = new Map<string, CouncilCoordinatorHost>();
		const hostFor = (sessionId: string): CouncilCoordinatorHost => {
			const existing = hosts.get(sessionId);
			if (existing) return existing;
			const host = {
				session,
				toolSession,
				sessionManager: { getSessionId: () => sessionId, getCwd: () => tempDir.path() },
				settings: session.settings,
				modelRegistry: session.modelRegistry,
			} as unknown as CouncilCoordinatorHost;
			hosts.set(sessionId, host);
			return host;
		};
		const boundToFirst = getCouncilCoordinator(hostFor(firstId));

		await session.newSession();
		const secondId = session.sessionManager.getSessionId();
		expect(secondId).not.toBe(firstId);

		mode.clearTransientSessionUi();

		// Only `rebindForSession()` releases a session's cached coordinator, so a fresh instance for the
		// retired id proves the rebind ran against the new one.
		expect(getCouncilCoordinator(hostFor(firstId))).not.toBe(boundToFirst);
		const live = getCouncilCoordinator(hostFor(secondId));
		expect(getCouncilCoordinator(hostFor(secondId))).toBe(live);
	});
});
