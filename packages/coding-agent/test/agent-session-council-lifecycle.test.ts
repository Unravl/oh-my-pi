import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CouncilCoordinator, CouncilCoordinatorHost } from "@oh-my-pi/pi-coding-agent/council/coordinator";
import {
	getCouncilCoordinator,
	peekCouncilCoordinatorForSession,
	quiesceAndReleaseCouncilForSessionTransition,
	resetCouncilCoordinatorsForTests,
} from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { CouncilDispatchPlan } from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as preflight from "@oh-my-pi/pi-coding-agent/council/preflight";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import { CouncilStorage } from "@oh-my-pi/pi-coding-agent/council/storage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

interface TransitionGate {
	entered: Promise<void>;
	release(): void;
}

describe("AgentSession Council lifecycle seam", () => {
	let sharedDir: TempDir;
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@omp-council-lifecycle-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled model");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-council-lifecycle-");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		sessionManager.appendMessage({ role: "user", content: "source session", timestamp: 1 });
		await sessionManager.flush();
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["test"], tools: [], messages: [] },
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			session.setSessionTransitionReconciler(null);
			await session.dispose();
			session = undefined;
		}
		await tempDir.remove();
	});

	function installTransitionGate(onRelease?: () => void): TransitionGate {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const current = session;
		if (!current) throw new Error("Expected active session");
		current.setSessionTransitionReconciler(async () => {
			entered.resolve();
			await release.promise;
			onRelease?.();
		});
		return { entered: entered.promise, release: release.resolve };
	}

	it("settles planning cleanup before /new opens target storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionId = sessionManager.getSessionId();
		const oldHandler = async () => ({ content: [{ type: "text" as const, text: "old" }] });
		const newHandler = async () => ({ content: [{ type: "text" as const, text: "new" }] });
		current.setCouncilHandler(oldHandler);
		const newSession = vi.spyOn(sessionManager, "newSession");
		const gate = installTransitionGate(() => {
			sessionManager.appendMessage({ role: "user", content: "late old Council prompt", timestamp: 2 });
			sessionManager.appendCustomMessageEntry("council-summary", "late old Council journal and summary", false);
			current.setCouncilHandler(null);
		});

		const transition = current.newSession();
		await gate.entered;
		expect(newSession).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
		expect(JSON.stringify(sessionManager.getEntries())).not.toContain("late old Council");
		current.setCouncilHandler(newHandler);
		await Promise.resolve();
		expect(current.peekCouncilHandler()).toBe(newHandler);
	});

	it("settles reviewing work before a session switch loads the target", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendMessage({ role: "user", content: "target session", timestamp: 3 });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await target.close();
		const oldSessionId = sessionManager.getSessionId();
		const setSessionFile = vi.spyOn(sessionManager, "setSessionFile");
		const gate = installTransitionGate();

		const transition = current.switchSession(targetFile);
		await gate.entered;
		expect(setSessionFile).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles reviewing work before fork changes the session identity", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionId = sessionManager.getSessionId();
		const fork = vi.spyOn(sessionManager, "fork");
		const gate = installTransitionGate();

		const transition = current.fork();
		await gate.entered;
		expect(fork).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect(await transition).toBeTrue();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles reviewing work before branching changes the session identity", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const sourceEntry = sessionManager.getBranch().find(entry => entry.type === "message");
		if (!sourceEntry) throw new Error("Expected source message");
		const oldSessionId = sessionManager.getSessionId();
		const newSession = vi.spyOn(sessionManager, "newSession");
		const gate = installTransitionGate();

		const transition = current.branch(sourceEntry.id);
		await gate.entered;
		expect(newSession).not.toHaveBeenCalled();
		expect(sessionManager.getSessionId()).toBe(oldSessionId);

		gate.release();
		expect((await transition).cancelled).toBeFalse();
		expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
	});

	it("settles planning work before /move relocates session storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionFile = sessionManager.getSessionFile();
		const moveTo = vi.spyOn(sessionManager, "moveTo");
		const gate = installTransitionGate();
		const targetCwd = path.join(tempDir.path(), "moved-worktree");

		const transition = current.moveSession(targetCwd);
		await gate.entered;
		expect(moveTo).not.toHaveBeenCalled();
		expect(sessionManager.getSessionFile()).toBe(oldSessionFile);

		gate.release();
		await transition;
		expect(moveTo).toHaveBeenCalledTimes(1);
		expect(sessionManager.getCwd()).toBe(targetCwd);
	});

	it("does not relocate storage when Council quiescence reaches its bounded deadline", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const oldSessionFile = sessionManager.getSessionFile();
		const oldCwd = sessionManager.getCwd();
		const moveTo = vi.spyOn(sessionManager, "moveTo");
		current.setSessionTransitionReconciler(async () => {
			throw new Error("Council cancellation did not settle before the transition deadline");
		});

		await expect(current.moveSession(path.join(tempDir.path(), "unsafe-target"))).rejects.toThrow(
			"Council cancellation did not settle before the transition deadline",
		);
		expect(moveTo).not.toHaveBeenCalled();
		expect(sessionManager.getSessionFile()).toBe(oldSessionFile);
		expect(sessionManager.getCwd()).toBe(oldCwd);
	});

	it("settles reviewing work before dispose closes storage", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const close = vi.spyOn(sessionManager, "close");
		const gate = installTransitionGate();

		const disposal = current.dispose();
		await gate.entered;
		expect(current.isDisposed).toBeTrue();
		expect(close).not.toHaveBeenCalled();

		gate.release();
		await disposal;
		expect(close).toHaveBeenCalledTimes(1);
		session = undefined;
	});

	it("finishes terminal teardown and rethrows when the reconciler rejects during dispose", async () => {
		const current = session;
		if (!current) throw new Error("Expected active session");
		const close = vi.spyOn(sessionManager, "close");
		const abort = vi.spyOn(current.agent, "abort");
		const failure = new Error("Council cancellation did not settle before the transition deadline");
		current.setSessionTransitionReconciler(async () => {
			throw failure;
		});

		await expect(current.dispose()).rejects.toThrow(failure.message);

		// A transition failure is not a licence to skip teardown: the agent was
		// aborted and storage was closed (`close()` is the last teardown step, so
		// reaching it proves everything before it ran) before the error surfaced.
		expect(abort).toHaveBeenCalled();
		expect(close).toHaveBeenCalledTimes(1);
		expect(current.isDisposed).toBeTrue();

		// Disposal stays latched: a second call replays the failure without tearing down twice.
		await expect(current.dispose()).rejects.toThrow(failure.message);
		expect(close).toHaveBeenCalledTimes(1);
		session = undefined;
	});

	/**
	 * The production reconciler, not a gate: these exercise
	 * `quiesceAndReleaseCouncilForSessionTransition` through real `AgentSession`
	 * transitions and assert what the registry looks like afterwards. Host wiring
	 * (TUI/ACP/RPC) installs exactly this callback.
	 */
	describe("with the production Council reconciler installed", () => {
		// `createCouncilStorage` validates that the local-protocol and manager session
		// identities agree, so the stub has to track the live manager id.
		const toolSession = {
			localProtocolOptions: { getSessionId: () => sessionManager.getSessionId() },
			get sessionManager() {
				return sessionManager;
			},
		} as unknown as ToolSession;

		beforeEach(() => {
			resetCouncilCoordinatorsForTests();
			const current = session;
			if (!current) throw new Error("Expected active session");
			current.setSessionTransitionReconciler(() => quiesceAndReleaseCouncilForSessionTransition(current));
		});

		afterEach(() => {
			mock.restore();
			resetCouncilCoordinatorsForTests();
		});

		/** Register a coordinator bound to the live session under its current id. */
		function registerCoordinator(): CouncilCoordinator {
			const current = session;
			if (!current) throw new Error("Expected active session");
			return getCouncilCoordinator({
				session: current,
				toolSession,
				sessionManager,
				settings: current.settings,
				modelRegistry,
			} as unknown as CouncilCoordinatorHost);
		}

		/**
		 * Park preflight so a coordinator sits in its setup phase: the window where
		 * a run has an owner and an abort controller but no manifest yet.
		 */
		function blockPreflight(): { entered: Promise<void>; abandon: (error: Error) => void } {
			const entered = Promise.withResolvers<void>();
			const blocked = Promise.withResolvers<CouncilDispatchPlan>();
			vi.spyOn(preflight, "preflightCouncilDispatch").mockImplementation((_host, _task, options) => {
				entered.resolve();
				options?.signal?.addEventListener("abort", () => blocked.reject(options.signal?.reason), { once: true });
				return blocked.promise;
			});
			return { entered: entered.promise, abandon: blocked.reject };
		}

		async function flushMicrotasks(): Promise<void> {
			for (let pass = 0; pass < 20; pass++) await Promise.resolve();
		}

		it("leaves the registry empty when a Council-free session changes identity", async () => {
			const current = session;
			if (!current) throw new Error("Expected active session");
			const oldSessionId = sessionManager.getSessionId();

			expect(await current.newSession()).toBeTrue();

			const newSessionId = sessionManager.getSessionId();
			expect(newSessionId).not.toBe(oldSessionId);
			// The reconciler must never construct an owner for a session that never ran one.
			expect(peekCouncilCoordinatorForSession(current, oldSessionId)).toBeUndefined();
			expect(peekCouncilCoordinatorForSession(current, newSessionId)).toBeUndefined();
		});

		it("cancels a setup-phase start and releases the retired session's coordinator", async () => {
			const current = session;
			if (!current) throw new Error("Expected active session");
			const oldSessionId = sessionManager.getSessionId();
			const coordinator = registerCoordinator();
			const preflightGate = blockPreflight();
			const startOutcome = coordinator.start("audit the council subsystem").then(
				() => "resolved",
				() => "rejected",
			);
			await preflightGate.entered;
			expect(coordinator.setupInFlight).toBeTrue();

			expect(await current.newSession()).toBeTrue();

			// Aborting setup is what let the transition proceed; nothing was left running.
			expect(await startOutcome).toBe("rejected");
			expect(coordinator.setupInFlight).toBeFalse();
			expect(coordinator.executionInFlight).toBeFalse();
			expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
			expect(peekCouncilCoordinatorForSession(current, oldSessionId)).toBeUndefined();
			expect(peekCouncilCoordinatorForSession(current, sessionManager.getSessionId())).toBeUndefined();
		});

		it("cancels a setup-phase resume and releases the retired session's coordinator", async () => {
			const current = session;
			if (!current) throw new Error("Expected active session");
			const oldSessionId = sessionManager.getSessionId();
			const coordinator = registerCoordinator();
			const resumable = {
				runId: "run-lifecycle",
				state: "reviewing",
				roster: [],
				task: "resume the council subsystem audit",
				outputPath: "plans/run-lifecycle.md",
				timestamps: { createdAt: new Date().toISOString() },
			} as unknown as CouncilManifest;
			vi.spyOn(CouncilStorage.prototype, "list").mockResolvedValue([resumable]);
			const preflightGate = blockPreflight();
			const resumeOutcome = coordinator.resume().then(
				() => "resolved",
				() => "rejected",
			);
			await preflightGate.entered;
			expect(coordinator.setupInFlight).toBeTrue();

			expect(await current.fork()).toBeTrue();

			expect(await resumeOutcome).toBe("rejected");
			expect(coordinator.executionInFlight).toBeFalse();
			expect(sessionManager.getSessionId()).not.toBe(oldSessionId);
			expect(peekCouncilCoordinatorForSession(current, oldSessionId)).toBeUndefined();
		});

		it("releases a coordinator on every identity change, not just the first", async () => {
			const current = session;
			if (!current) throw new Error("Expected active session");
			const firstSessionId = sessionManager.getSessionId();
			const first = registerCoordinator();

			expect(await current.newSession()).toBeTrue();
			const secondSessionId = sessionManager.getSessionId();
			expect(peekCouncilCoordinatorForSession(current, firstSessionId)).toBeUndefined();

			// A fresh owner under the new id, then another transition: the release must
			// key off the id captured at quiesce time, not the first one ever seen.
			const second = registerCoordinator();
			expect(second).not.toBe(first);
			expect(await current.newSession()).toBeTrue();
			const thirdSessionId = sessionManager.getSessionId();
			expect(peekCouncilCoordinatorForSession(current, secondSessionId)).toBeUndefined();

			registerCoordinator();
			expect(await current.fork()).toBeTrue();
			expect(peekCouncilCoordinatorForSession(current, thirdSessionId)).toBeUndefined();
			expect(peekCouncilCoordinatorForSession(current, sessionManager.getSessionId())).toBeUndefined();
		});

		it("keeps the old identity and its coordinator when cancellation times out, releasing after settlement", async () => {
			const current = session;
			if (!current) throw new Error("Expected active session");
			const oldSessionId = sessionManager.getSessionId();
			const coordinator = registerCoordinator();
			const preflightGate = blockPreflight();
			const startOutcome = coordinator.start("uncancellable council work").then(
				() => "resolved",
				() => "rejected",
			);
			await preflightGate.entered;
			vi.spyOn(coordinator, "cancelForSessionTransition").mockRejectedValue(
				new Error("Council cancellation timed out after 5000ms"),
			);

			await expect(current.newSession()).rejects.toThrow("Council cancellation timed out after 5000ms");

			// Refusing the transition is the whole point: mutating the id here would
			// strand a still-running council under a session that no longer exists.
			expect(sessionManager.getSessionId()).toBe(oldSessionId);
			expect(peekCouncilCoordinatorForSession(current, oldSessionId)).toBe(coordinator);

			preflightGate.abandon(new Error("preflight abandoned"));
			expect(await startOutcome).toBe("rejected");
			await coordinator.settled();
			await flushMicrotasks();

			// Release was deferred, not skipped, so the entry cannot leak forever.
			expect(peekCouncilCoordinatorForSession(current, oldSessionId)).toBeUndefined();
		});
	});
});
