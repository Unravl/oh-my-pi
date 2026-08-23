import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	SPINNER_RENDER_INTERVAL_MS,
	stopSharedSpinnerTicker,
	ToolExecutionComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

// Contract under test: live tool previews that render a pending/running status
// must keep the spinner glyph tied to the shared tool-frame ticker. This covers
// both the shared ToolExecutionComponent interval and renderer-local caches that
// would otherwise keep serving the first pending frame.
describe("ToolExecutionComponent live preview spinners", () => {
	beforeAll(async () => {
		await initTheme();
	});

	// Earlier test files may leak live blocks (components never stopAnimation'd),
	// which keeps the shared ticker armed on a REAL interval and makes these
	// fake-timer assertions observe a pre-existing timer instead of a fresh one.
	beforeEach(() => {
		stopSharedSpinnerTicker();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("animates the eval pending cell while the call is live", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"eval",
			{ language: "py", code: "import time\ntime.sleep(10)" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			const firstFrame = stripVTControlCharacters(component.render(80).join("\n"));
			vi.advanceTimersByTime(120);
			const secondFrame = stripVTControlCharacters(component.render(80).join("\n"));

			expect(requestComponentRender).toHaveBeenCalledWith(component);
			expect(requestRender).not.toHaveBeenCalled();
			expect(firstFrame).toContain("time.sleep(10)");
			expect(secondFrame).toContain("time.sleep(10)");
			expect(secondFrame).not.toBe(firstFrame);
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick headerless bash pending previews", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("ticks live bash results that show a timeout footer", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600", timeout: 1400 },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "waiting" }],
					details: { timeoutSeconds: 1400, startedAtMs: Date.now() },
				},
				true,
			);
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestComponentRender).toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick detached async bash result snapshots", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "sleep 600", async: true },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "started background job" }],
					details: {
						command: "sleep 600",
						async: { state: "running", jobId: "job-1", type: "bash" },
					},
				},
				true,
			);
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick github pending previews whose Text is materialized per rebuild", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		const component = new ToolExecutionComponent(
			"github",
			{ op: "run_watch", run: "12345" },
			{},
			undefined,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	it("does not tick custom tools whose pending label is a static tool-name Text", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const requestComponentRender = vi.fn();
		// A renderResult-only custom tool renders the static tool-name label
		// while pending, so the spinner interval must not start.
		const tool = { name: "ext_tool", renderResult: () => undefined };
		const component = new ToolExecutionComponent(
			"ext_tool",
			{ input: 1 },
			{},
			tool as never,
			{ requestRender, requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		try {
			requestRender.mockClear();
			requestComponentRender.mockClear();
			vi.advanceTimersByTime(500);
			expect(requestRender).not.toHaveBeenCalled();
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			component.stopAnimation();
		}
	});

	// Regression (issue #8731): concurrent live tool blocks — e.g. parallel task
	// subagents — must share ONE spinner timer, not one per block, or active-work
	// CPU scales with block count.
	it("drives every concurrent live block from a single shared spinner timer", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const renders = [vi.fn(), vi.fn(), vi.fn()];
		const components = renders.map(
			requestComponentRender =>
				new ToolExecutionComponent(
					"eval",
					{ language: "py", code: "import time\ntime.sleep(10)" },
					{},
					undefined,
					{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
					process.cwd(),
				),
		);

		try {
			const spinnerTimers = setIntervalSpy.mock.calls.filter(([, ms]) => ms === SPINNER_RENDER_INTERVAL_MS).length;
			// One shared ticker for all three live blocks, not three.
			expect(spinnerTimers).toBe(1);

			// A single tick repaints every registered block in lockstep.
			vi.advanceTimersByTime(SPINNER_RENDER_INTERVAL_MS);
			for (const requestComponentRender of renders) {
				expect(requestComponentRender).toHaveBeenCalledTimes(1);
			}
		} finally {
			for (const component of components) component.stopAnimation();
		}
	});

	it("renders generic three-, two-, one-, and zero-row presentations", () => {
		const component = new ToolExecutionComponent(
			"bash",
			{ command: "bun test packages/tui" },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.setTranscriptAllocation(3, { tick: 0, now: 0 });
			const full = component.render(80);
			component.setTranscriptAllocation(2, { tick: 1, now: 80 });
			const folded = component.render(80);
			component.setTranscriptAllocation(1, { tick: 3, now: 240 });
			const compact = component.render(80);
			component.setTranscriptAllocation(0, { tick: 4, now: 320 });

			expect(full.length).toBeGreaterThanOrEqual(3);
			expect(folded).toHaveLength(2);
			expect(stripVTControlCharacters(folded.join("\n"))).toContain("bun test packages/tui");
			expect(compact).toHaveLength(1);
			expect(stripVTControlCharacters(compact[0]!)).toContain("bash · bun test packages/tui");
			expect(component.render(80)).toEqual([]);
		} finally {
			component.stopAnimation();
		}
	});

	it("shows elapsed time only while a compact fallback is running", () => {
		vi.spyOn(performance, "now").mockReturnValue(1_000);
		const component = new ToolExecutionComponent(
			"ext_tool",
			{},
			{},
			{ name: "ext_tool", label: "Catalog" } as never,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.setExecutionStarted();
			component.setTranscriptAllocation(1, { tick: 27, now: 3_200 });
			const running = stripVTControlCharacters(component.render(24)[0] ?? "");
			expect(running).toContain("Catalog · running 2s");
			expect(Bun.stringWidth(running)).toBeLessThanOrEqual(24);

			component.updateResult({ content: [{ type: "text", text: "done" }] }, false);
			const settled = stripVTControlCharacters(component.render(24)[0] ?? "");
			expect(settled).toContain("Catalog");
			expect(settled).not.toContain("running");
			expect(settled).not.toMatch(/\d+s$/);
			expect(Bun.stringWidth(settled)).toBeLessThanOrEqual(24);
		} finally {
			component.stopAnimation();
		}
	});

	it("gives extension tools a readable compact fallback", () => {
		const component = new ToolExecutionComponent(
			"ext_tool",
			{ input: "processing catalog" },
			{},
			{ name: "ext_tool", label: "Catalog" } as never,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.setTranscriptAllocation(1, { tick: 0, now: 0 });
			const row = stripVTControlCharacters(component.render(30)[0] ?? "");
			expect(row).toContain("Catalog · processing");
			expect(Bun.stringWidth(row)).toBeLessThanOrEqual(30);
		} finally {
			component.stopAnimation();
		}
	});
	// Regression: a live hub call whose streamed args have not parsed yet
	// (op still unknown) folded to a contentless `╭─ Hub` / `╰` frame under
	// viewport pressure. A squeezed block keeps its real render whenever it
	// fits the allocation; only genuinely overflowing blocks fold.
	it("keeps the real render on squeezed hub blocks when it fits", () => {
		const component = new ToolExecutionComponent(
			"hub",
			{},
			{},
			{ name: "hub", label: "Hub" } as never,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.setTranscriptAllocation(2, { tick: 0, now: 0 });
			const pending = component.render(80).map(row => stripVTControlCharacters(row));
			expect(pending).toHaveLength(1);
			expect(pending[0]).toContain("Hub");
			expect(pending[0]).not.toContain("╭");

			component.updateResult({ content: [{ type: "text", text: "done" }] }, false);
			const settled = component.render(80).map(row => stripVTControlCharacters(row));
			expect(settled.length).toBeLessThanOrEqual(2);
			expect(settled.join("\n")).toContain("done");
		} finally {
			component.stopAnimation();
		}
	});

	it("folds an overflowing squeezed hub block to a frame naming its op target", () => {
		const component = new ToolExecutionComponent(
			"hub",
			{ op: "send", to: "Main", message: "hi" },
			{},
			{ name: "hub", label: "Hub" } as never,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.updateResult({ content: [{ type: "text", text: "line1\nline2\nline3\nline4" }] }, false);
			component.setTranscriptAllocation(1, { tick: 0, now: 0 });
			const folded = component.render(80).map(row => stripVTControlCharacters(row));
			expect(folded).toHaveLength(1);
			expect(folded[0]).toContain("Hub · send → Main");
		} finally {
			component.stopAnimation();
		}
	});
});
