import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CouncilConsultResult } from "@oh-my-pi/pi-coding-agent/council/consult";
import * as consult from "@oh-my-pi/pi-coding-agent/council/consult";
import type { CouncilCoordinatorHost } from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ConveneTool } from "@oh-my-pi/pi-coding-agent/tools/convene";

const councilHost = {} as unknown as CouncilCoordinatorHost;

function toolSession(options?: { taskDepth?: number; tool?: boolean; host?: CouncilCoordinatorHost }): ToolSession {
	return {
		settings: Settings.isolated(options?.tool === false ? { "council.tool": false } : {}),
		taskDepth: options?.taskDepth ?? 0,
		getCouncilHost: () => (Object.hasOwn(options ?? {}, "host") ? options?.host : councilHost),
	} as unknown as ToolSession;
}

function consultResult(replies: CouncilConsultResult["replies"], warnings: string[] = []): CouncilConsultResult {
	return {
		question: "Manifest field or filename stem?",
		repoRoot: "/repo",
		replies,
		warnings,
		usage: { requests: 2, tokens: 200, cost: 1.5 },
		durationMs: 12_000,
	};
}

let consultSpy: Mock<typeof consult.runCouncilConsult>;

beforeEach(() => {
	consultSpy = spyOn(consult, "runCouncilConsult");
});

afterEach(() => {
	mock.restore();
});

describe("ConveneTool", () => {
	it("is withheld only when council.tool is off", () => {
		expect(ConveneTool.createIf(toolSession())).toBeInstanceOf(ConveneTool);
		expect(ConveneTool.createIf(toolSession({ tool: false }))).toBeNull();
	});

	it("refuses a full run below the main session and points at consult", async () => {
		// A `task` fan-out could otherwise have every child convene its own full roster, and a child's
		// coordinator is invisible to the operator's pane with artifacts keyed to a session id
		// `/council resume` cannot reach.
		const tool = new ConveneTool(toolSession({ taskDepth: 1 }));

		await expect(tool.execute("call-1", { action: "plan", task: "Rework auth" })).rejects.toThrow(
			/runs only in the main session.*consult/s,
		);
		expect(consultSpy).not.toHaveBeenCalled();
	});

	it("consults from a subagent, which is the affordance children do get", async () => {
		consultSpy.mockResolvedValue(
			consultResult([
				{
					role: "council1",
					label: "Reviewer 1",
					model: "review/one",
					agentId: "Agent1",
					answer: "Use the manifest field.",
					usage: { requests: 1, tokens: 100, cost: 0.75 },
				},
			]),
		);
		const tool = new ConveneTool(toolSession({ taskDepth: 2 }));

		const result = await tool.execute("call-1", { action: "consult", task: "Manifest field or filename stem?" });

		expect(consultSpy).toHaveBeenCalledTimes(1);
		expect(result.details?.action).toBe("consult");
		expect(result.details?.answered).toBe(1);
	});

	it("labels every reviewer, keeps a failed one visible, and points at its transcript", async () => {
		consultSpy.mockResolvedValue(
			consultResult(
				[
					{
						role: "council1",
						label: "Reviewer 1",
						model: "review/one",
						agentId: "Agent1",
						answer: "Use the manifest field.",
						usage: { requests: 1, tokens: 100, cost: 0.75 },
					},
					{
						role: "council2",
						label: "Reviewer 2",
						model: "review/two",
						agentId: "Agent2",
						failure: "provider refused",
						usage: { requests: 1, tokens: 100, cost: 0.75 },
					},
				],
				["Reviewer 2 (review/two): provider refused"],
			),
		);
		const tool = new ConveneTool(toolSession());

		const result = await tool.execute("call-1", { action: "consult", task: "Manifest field or filename stem?" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("1 of 2 council reviewers answered in 12s");
		expect(text).toContain("## Reviewer 1 — review/one");
		expect(text).toContain("history://Agent1");
		expect(text).toContain("Use the manifest field.");
		expect(text).toContain("Did not answer: provider refused");
		expect(text).toContain("- Reviewer 2 (review/two): provider refused");
		// The caller must reconcile, not tally: a majority of ungrounded answers is still ungrounded.
		expect(text).toContain("reconcile the disagreement yourself");
		expect(result.details).toMatchObject({ action: "consult", answered: 1, launched: 2, cost: 1.5 });
	});

	it("strips terminal control sequences out of a reviewer's answer", async () => {
		// Answers are provider-authored text landing in a terminal transcript; ANSI would corrupt the
		// frame and a control character would break the rendered block.
		consultSpy.mockResolvedValue(
			consultResult([
				{
					role: "council1",
					label: "Reviewer 1",
					model: "review/one",
					agentId: "Agent1",
					answer: "Use \u001b[31mthe manifest\u001b[0m field\u0007.",
					usage: { requests: 1, tokens: 100, cost: 0.75 },
				},
			]),
		);
		const tool = new ConveneTool(toolSession());

		const result = await tool.execute("call-1", { action: "consult", task: "Which?" });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Use the manifest field.");
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
	});

	it("refuses both actions when the session exposes no council host", async () => {
		const tool = new ConveneTool(toolSession({ host: undefined }));

		await expect(tool.execute("call-1", { action: "consult", task: "Which?" })).rejects.toThrow(
			"The council is unavailable in this session",
		);
		await expect(tool.execute("call-2", { action: "plan", task: "Which?" })).rejects.toThrow(
			"The council is unavailable in this session",
		);
	});
});
