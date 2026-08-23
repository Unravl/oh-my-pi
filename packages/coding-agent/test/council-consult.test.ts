import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runCouncilConsult } from "@oh-my-pi/pi-coding-agent/council/consult";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import * as instructions from "@oh-my-pi/pi-coding-agent/council/instructions";
import {
	CouncilDispatchError,
	type CouncilPreflightHost,
	preflightCouncilConsult,
} from "@oh-my-pi/pi-coding-agent/council/preflight";
import { COUNCIL_CONSULT_SCHEMA } from "@oh-my-pi/pi-coding-agent/council/schema";
import type {
	EffectiveSubagentPolicy,
	StructuredSubagentRequest,
	StructuredSubagentResult,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as subagents from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

const cwd = fs.realpathSync(process.cwd());

function model(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.High] },
	} as unknown as Model<Api>;
}

const one = model("review", "one");
const two = model("review", "two");

const instructionSnapshot = {
	repoRoot: cwd,
	contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "rules", depth: 0 }],
	files: [{ path: path.join(cwd, "AGENTS.md"), sha256: sha256CouncilContent("rules") }],
	totalBytes: 5,
};

function host(options?: {
	members?: Array<{ role: string; enabled: boolean; round?: 1 | 2 }>;
	rounds?: 1 | 2;
	advisorReviewers?: boolean;
}): CouncilPreflightHost {
	const settings = Settings.isolated({
		"council.members": options?.members ?? [
			{ role: "council1", enabled: true },
			{ role: "council2", enabled: true },
		],
		...(options?.rounds === undefined ? {} : { "council.rounds": options.rounds }),
		...(options?.advisorReviewers === undefined ? {} : { "council.advisor.reviewers": options.advisorReviewers }),
		defaultThinkingLevel: "high",
		modelRoles: { council1: "review/one:high", council2: "review/two:high", slow: "review/one:high" },
	});
	const toolSession = {
		cwd,
		hasUI: false,
		settings,
		// A parent schema is present on purpose: a consult passes its own schema explicitly, so the
		// reviewers must never inherit this one.
		outputSchema: { type: "object", properties: { unrelated: { type: "string" } } },
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		localProtocolOptions: { getArtifactsDir: () => null, getSessionId: () => "session-1" },
		sessionManager: { getSessionId: () => "session-1" },
	} as unknown as ToolSession;
	return {
		toolSession,
		session: {
			model: model("main", "active"),
			thinkingLevel: undefined,
			getActiveToolNames: () => ["read", "write"],
		} as unknown as CouncilPreflightHost["session"],
		settings,
		modelRegistry: {
			getApiKey: mock(async () => "test-key"),
			getAvailable: () => [],
		} as unknown as CouncilPreflightHost["modelRegistry"],
		sessionManager: { getCwd: () => cwd, getSessionId: () => "session-1" },
	};
}

/** A settled child result shaped exactly as far as the consult runner reads it. */
function childResult(options: {
	answer?: string;
	exitCode?: number;
	stderr?: string;
	resolvedModel?: string;
	requests?: number;
	tokens?: number;
	cost?: number;
}): StructuredSubagentResult {
	return {
		result: {
			exitCode: options.exitCode ?? 0,
			stderr: options.stderr ?? "",
			output: options.answer ?? "",
			requests: options.requests ?? 1,
			tokens: options.tokens ?? 100,
			usage: { cost: { total: options.cost ?? 0.5 } },
			resolvedModel: options.resolvedModel,
			structuredOutput: options.answer === undefined ? undefined : { data: { answer: options.answer } },
		},
	} as unknown as StructuredSubagentResult;
}

let runSpy: Mock<typeof subagents.runStructuredSubagent>;

beforeEach(() => {
	spyOn(modelResolver, "resolveCliModel").mockImplementation(options => ({
		model: options.cliModel?.includes("two") ? two : one,
		selector: options.cliModel?.includes("two") ? "review/two" : "review/one",
		thinkingLevel: Effort.High,
		warning: undefined,
		error: undefined,
	}));
	spyOn(git.repo, "root").mockResolvedValue(cwd);
	spyOn(instructions, "captureCouncilInstructionSnapshot").mockResolvedValue(instructionSnapshot);
	spyOn(subagents, "resolveEffectiveSubagentPolicy").mockImplementation(
		async request => ({ agentName: request.agent }) as EffectiveSubagentPolicy,
	);
	runSpy = spyOn(subagents, "runStructuredSubagent");
	spyOn(subagents, "reserveStructuredSubagentId").mockImplementation(async (_session, identity) =>
		identity?.label?.includes("Reviewer 2") ? "Agent2" : "Agent1",
	);
});

afterEach(() => {
	mock.restore();
});

describe("council consult preflight", () => {
	it("confines every reviewer read-only on its own pinned model with an explicit answer schema", async () => {
		const plan = await preflightCouncilConsult(host(), "Manifest field or filename stem?");

		expect(plan.members.map(member => member.role)).toEqual(["council1", "council2"]);
		expect(plan.requests.map(request => request.model)).toEqual(["review/one:high", "review/two:high"]);
		for (const request of plan.requests) {
			expect(request.agent).toBe("council-consultant");
			expect(request.tools).toEqual(["read", "grep", "glob", "lsp", "ast_grep"]);
			expect(request.restrictToolNames).toBeTrue();
			expect(request.pinModel).toBeTrue();
			expect(request.enableIrc).toBeFalse();
			expect(request.skills).toEqual([]);
			// The parent session carries an unrelated output schema; passing the consult schema
			// explicitly is what stops the reviewers inheriting it and failing validation wholesale.
			expect(request.outputSchema).toBe(COUNCIL_CONSULT_SCHEMA);
		}
	});

	it("refuses an unassigned roster slot before launching any reviewer", async () => {
		const unassigned = host({
			members: [
				{ role: "council1", enabled: true },
				{ role: "ghost", enabled: true },
			],
		});

		await expect(preflightCouncilConsult(unassigned, "Anything?")).rejects.toMatchObject({
			code: "COUNCIL_MEMBER_MODEL_INVALID",
		});
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("refuses a whitespace-only question", async () => {
		const error = await preflightCouncilConsult(host(), "   ").catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(CouncilDispatchError);
		expect((error as CouncilDispatchError).code).toBe("COUNCIL_TASK_INVALID");
		expect((error as CouncilDispatchError).spending).toBeFalse();
	});

	it("consults every enabled member regardless of round pins, because a consult runs no rounds", async () => {
		// `round` is a *review-round schedule*. A consult has no rounds for a pin to schedule, so a pin
		// must not silently drop a model the operator enabled. `council2` would be inert in a dispatch
		// at `rounds: 1`; here it answers.
		const plan = await preflightCouncilConsult(
			host({
				members: [
					{ role: "council1", enabled: true },
					{ role: "council2", enabled: true, round: 2 },
				],
			}),
			"Which option?",
		);

		expect(plan.members.map(member => member.role)).toEqual(["council1", "council2"]);
		expect(plan.requests).toHaveLength(2);
		expect(plan.warnings).toEqual([]);
	});

	it("puts an omitted round in play and never attaches the shared advisor", async () => {
		// Two separate invariants that both bit this feature:
		//  1. An omitted `round` means EVERY configured round, so such a member is always in round 1.
		//  2. The `advisor` role is one shared model. Watching N reviewers with it correlates N answers
		//     whose only value is independence, so a consult never attaches it — even with the operator's
		//     `council.advisor.reviewers` explicitly on.
		const plan = await preflightCouncilConsult(
			host({
				members: [
					{ role: "council1", enabled: true },
					{ role: "council2", enabled: true, round: 1 },
				],
				rounds: 2,
				advisorReviewers: true,
			}),
			"Which option?",
		);

		expect(plan.members.find(member => member.role === "council1")?.rounds).toEqual([1, 2]);
		expect(plan.members.find(member => member.role === "council2")?.rounds).toEqual([1]);
		expect(plan.members.map(member => member.advisor)).toEqual([false, false]);
		expect(plan.requests.map(request => request.advisor)).toEqual([false, false]);
	});
});

describe("runCouncilConsult", () => {
	it("returns the answers that landed and degrades a single failed reviewer to a warning", async () => {
		runSpy.mockImplementation(async (request: StructuredSubagentRequest) =>
			request.model === "review/two:high"
				? childResult({ exitCode: 1, stderr: "provider refused", cost: 0.25 })
				: childResult({ answer: "Use the manifest field.", cost: 0.75 }),
		);

		const result = await runCouncilConsult(host(), "Manifest field or filename stem?");

		expect(result.replies.map(reply => reply.answer)).toEqual(["Use the manifest field.", undefined]);
		expect(result.replies.map(reply => reply.label)).toEqual(["Reviewer 1", "Reviewer 2"]);
		expect(result.replies[1]?.failure).toBe("provider refused");
		expect(result.warnings).toEqual(["Reviewer 2 (review/two): provider refused"]);
		// A failed reviewer is still billed, and the aggregate has to reconcile with the per-reply rows.
		expect(result.usage.cost).toBeCloseTo(1, 10);
		expect(result.usage.requests).toBe(2);
		// Transcript pointers survive a failure; that is where the operator looks next.
		expect(result.replies.map(reply => reply.agentId)).toEqual(["Agent1", "Agent2"]);
	});

	it("fails the consult only when no reviewer answered, naming every transcript", async () => {
		runSpy.mockResolvedValue(childResult({ exitCode: 1, stderr: "provider refused" }));

		await expect(runCouncilConsult(host(), "Manifest field or filename stem?")).rejects.toThrow(
			/Every council reviewer failed to answer.*history:\/\/Agent1.*history:\/\/Agent2/s,
		);
	});

	it("treats a reviewer that drifted off its pinned model as failed rather than substituted", async () => {
		runSpy.mockImplementation(async (request: StructuredSubagentRequest) =>
			request.model === "review/two:high"
				? childResult({ answer: "cheap answer", resolvedModel: "review/three" })
				: childResult({ answer: "Use the manifest field.", resolvedModel: "review/one" }),
		);

		const result = await runCouncilConsult(host(), "Manifest field or filename stem?");

		expect(result.replies[0]?.answer).toBe("Use the manifest field.");
		expect(result.replies[1]?.answer).toBeUndefined();
		expect(result.replies[1]?.failure).toBe("resolved to review/three instead of its pinned review/two");
	});

	it("rejects an answer that does not satisfy the consult schema", async () => {
		runSpy.mockImplementation(async (request: StructuredSubagentRequest) =>
			request.model === "review/two:high"
				? ({
						result: {
							exitCode: 0,
							stderr: "",
							output: "",
							requests: 1,
							tokens: 10,
							structuredOutput: { data: { findings: [] } },
						},
					} as unknown as StructuredSubagentResult)
				: childResult({ answer: "Use the manifest field." }),
		);

		const result = await runCouncilConsult(host(), "Manifest field or filename stem?");

		expect(result.replies[1]?.answer).toBeUndefined();
		expect(result.replies[1]?.failure).toContain("Council consult answer is invalid");
	});

	it("propagates a caller abort instead of reporting it as reviewers declining", async () => {
		const controller = new AbortController();
		runSpy.mockImplementation(async () => {
			controller.abort();
			throw new Error("aborted");
		});

		await expect(
			runCouncilConsult(host(), "Manifest field or filename stem?", { signal: controller.signal }),
		).rejects.toThrow("aborted");
	});
});
