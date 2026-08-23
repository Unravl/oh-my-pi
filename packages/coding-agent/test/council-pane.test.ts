import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import {
	COUNCIL_EXPANDED_VISIBLE_LIMIT,
	CouncilPaneComponent,
	type CouncilPaneRowSnapshot,
	type CouncilPaneSnapshot,
	SUBAGENT_HUD_VISIBLE_LIMIT,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-pane";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

function row(overrides: Partial<CouncilPaneRowSnapshot> = {}): CouncilPaneRowSnapshot {
	return {
		key: "planner",
		label: "Planner",
		model: "anthropic/claude-sonnet-4-5",
		effort: "high",
		status: "running",
		attempts: 1,
		...overrides,
	};
}

function snapshot(overrides: Partial<CouncilPaneSnapshot> = {}): CouncilPaneSnapshot {
	return {
		runId: "run-1",
		state: "reviewing",
		round: 1,
		totalRounds: 2,
		startedAt: "2026-08-05T12:00:00.000Z",
		outputPath: "/home/test/project/plans/council-run-1.md",
		usage: { requests: 4, tokens: 12_345, cost: 0.0123 },
		// Production order: the plan is drafted, reviewed, then judged.
		rows: [
			row(),
			row({ key: "member:0", label: "Reviewer 1", status: "succeeded" }),
			row({ key: "member:1", label: "Reviewer 2", status: "failed", error: "provider failed" }),
			row({ key: "member:2", label: "Reviewer 3", status: "retry", attempts: 2 }),
			row({ key: "adjudicator", label: "Adjudicator", status: "queued", attempts: 0 }),
		],
		terminal: false,
		...overrides,
	};
}

function harness(terminalRows = 24, editorMaxHeight = 12) {
	let rows = terminalRows;
	const requestRender = vi.fn();
	const requestComponentRender = vi.fn();
	const pane = new CouncilPaneComponent({
		tui: { requestRender, requestComponentRender },
		getTerminalRows: () => rows,
		getEditorMaxHeight: () => editorMaxHeight,
		now: () => Date.parse("2026-08-05T12:00:12.000Z"),
	});
	return {
		pane,
		requestRender,
		requestComponentRender,
		setTerminalRows(next: number) {
			rows = next;
		},
	};
}

function plain(lines: readonly string[]): string {
	return Bun.stripANSI(lines.join("\n"));
}

/** The status glyph of a rendered body row, with the frame border and tree connector stripped. */
function rowIcon(line: string): string {
	return Bun.stripANSI(line).replace(/[│├└]/g, " ").trim().split(" ")[0] ?? "";
}

/** Spend is dot-joined like a member row and capped at two decimals, never `$0.0000`. */
function expectSpend(text: string): void {
	expect(text).toContain("4 req");
	expect(text).toContain("12K tok");
	expect(text).toContain("$0.01");
	expect(text).not.toContain("$0.012");
	expect(text).not.toContain("4 req/12K");
}

describe("CouncilPaneComponent", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("has no inactive rows", () => {
		const { pane } = harness();
		expect(pane.render(100)).toEqual([]);
	});

	it("bounds compact and expanded bodies at 24 and 12 terminal rows", () => {
		// Each render adds the two frame rows (top/bottom border) around the body.
		const frameRows = 2;
		const roomy = harness(24, 12);
		roomy.pane.update(snapshot());
		const compact = roomy.pane.render(100);
		expect(compact.length).toBeLessThanOrEqual(Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 24 - 12 - 4) + frameRows);
		expect(plain(compact)).toContain("Council");
		expect(plain(compact)).toContain("R1/2");
		expect(plain(compact)).toContain("council-r");
		expectSpend(plain(compact));

		roomy.pane.setExpanded(true);
		// Five rows, one error detail and the reserved footer exactly fill the seven body
		// rows this terminal leaves, plus the header line and the two borders.
		expect(roomy.pane.render(100)).toHaveLength(7 + 1 + frameRows);

		// Page keys are Council's only once the viewport genuinely overflows.
		const scrolling = harness(24, 12);
		scrolling.pane.update(
			snapshot({
				rows: [
					row({ recentOutput: ["a", "b", "c", "d", "e", "f"] }),
					row({ key: "adjudicator", label: "Adjudicator" }),
				],
			}),
		);
		scrolling.pane.setExpanded(true);
		scrolling.pane.render(100);
		expect(scrolling.pane.handleInput("\x1b[6~")).toBeTrue();
		expect(scrolling.requestComponentRender).toHaveBeenCalledWith(scrolling.pane);

		const short = harness(12, 6);
		short.pane.update(snapshot());
		expect(short.pane.render(100).length).toBeLessThanOrEqual(
			Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 12 - 6 - 4) + frameRows,
		);
		short.pane.setExpanded(true);
		expect(short.pane.render(100).length).toBeLessThanOrEqual(
			Math.min(SUBAGENT_HUD_VISIBLE_LIMIT + 1, 12 - 6 - 4) + frameRows,
		);
	});

	it("distinguishes every status by icon alone, without spending a column on the word", () => {
		const statuses = ["queued", "waiting", "running", "retry", "succeeded", "failed", "interrupted"] as const;

		const { pane } = harness(40, 12);
		pane.update(
			snapshot({
				rows: statuses.map((status, index) =>
					row({ key: String(index), label: `slot-${index}`, status, attempts: index }),
				),
			}),
		);
		const body = pane.render(140).slice(2, -2);
		expect(body).toHaveLength(statuses.length);

		// Rendered shape is `│ <connector> <icon> <label> …`; drop the frame and tree glyphs.
		const icons = body.map(rowIcon);
		for (const icon of icons) expect(icon).toBeTruthy();
		expect(new Set(icons).size).toBe(statuses.length);

		const text = plain(body);
		for (const status of statuses) expect(text).not.toContain(status);
	});

	it("moves warnings out of the header into the expanded body", () => {
		const { pane } = harness(24, 12);
		pane.update(
			snapshot({
				warnings: ["fallback engaged", "partial result"],
				rows: [row(), row({ key: "adjudicator", label: "Adjudicator", status: "queued", attempts: 0 })],
			}),
		);
		const collapsed = plain(pane.render(140));
		expect(collapsed).not.toContain("degraded+2w");
		expect(collapsed).not.toContain("degraded+");
		expectSpend(collapsed);
		expect(collapsed).toContain("+2 warnings");
		expect(collapsed).not.toContain("fallback engaged");

		pane.setExpanded(true);
		const expanded = plain(pane.render(140));
		expect(expanded).toContain("2 warnings");
		expect(expanded).toContain("fallback engaged");
		expect(expanded).toContain("partial result");
	});

	it("sanitizes and width-bounds the header without a reviewer confinement contract", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot({ outputPath: "/home/test/project/plans/council\t\u001b[31munsafe\u001b[0m.md" }));
		const wideOutput = plain(pane.render(140));
		expect(wideOutput).not.toContain("read-only/root:");
		expect(wideOutput).not.toContain("\t");
		expect(wideOutput).not.toContain("[31m");
		expect(wideOutput).toContain("unsafe");
		const narrowLines = pane.render(72);
		expect(plain(narrowLines)).not.toContain("read-only/root:");
		for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72);
	});

	it("titles the state badge and keeps confinement and degraded jargon out of the header", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot({ state: "completed-degraded", warnings: ["fallback engaged"] }));
		const header = Bun.stripANSI(pane.render(140)[1] ?? "");
		expect(header).toContain("Completed With Warnings");
		expect(header).not.toContain("completed with warnings");
		expect(header).not.toContain("completed-degraded");
		expect(header).toContain("R1/2");
		expect(header).not.toContain("round 1/2");
		expect(header).not.toContain("read-only/root:");
		expect(header).not.toContain("degraded+");
		expect(header).not.toContain("1w");
	});

	it("leads with the elapsed clock, then the round, and never reports settled counts", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot());
		const header = Bun.stripANSI(pane.render(140)[1] ?? "");
		expect(header).toContain("00:12");
		expect(header).toContain("R1/2");
		expect(header.indexOf("00:12")).toBeLessThan(header.indexOf("R1/2"));
		expect(header).not.toContain("settled");
	});

	it("aligns the model and thinking columns across rows of differing width", () => {
		const rows = [
			row({ key: "a", label: "a", model: "m/a", effort: "low", status: "queued", attempts: 0 }),
			row({ key: "b", label: "planner-main", model: "provider/mid", effort: "high", status: "running" }),
			row({ key: "c", label: "ux", model: "vendor/long-model-x", effort: "max", status: "retry", attempts: 2 }),
		];
		for (const width of [72, 80, 100, 140]) {
			const { pane } = harness(40, 12);
			pane.update(snapshot({ rows }));
			const frame = pane.render(width);
			// Frame: top border, header line, body rows, reserved footer, bottom border.
			const body = frame.slice(2, -2);
			expect(body).toHaveLength(3);
			const columns: readonly (readonly [string, string, string])[] = [
				["m/a", "provider/mid", "vendor/long-model-x"],
				["low", "high", "max"],
			];
			for (const needles of columns) {
				const offsets = body.map((line, index) => {
					const text = Bun.stripANSI(line);
					const at = text.indexOf(needles[index]);
					return at < 0 ? -1 : Bun.stringWidth(text.slice(0, at));
				});
				for (const offset of offsets) expect(offset).toBeGreaterThan(0);
				expect(new Set(offsets).size).toBe(1);
			}
		}
	});

	it("bounds every rendered line to the frame width in both modes", () => {
		for (const width of [72, 80, 100, 140]) {
			const { pane } = harness(40, 12);
			pane.update(
				snapshot({
					warnings: [`fallback ${"engaged ".repeat(40)}`, "partial result"],
					rows: [
						row({ label: "a", model: "m/a", effort: null }),
						row({
							key: "wide",
							label: `planner ${"long ".repeat(40)}`,
							model: `provider/${"m".repeat(120)}`,
							effort: "maximum-effort-and-then-some",
							advisor: true,
							status: "failed",
							error: `provider failed ${"badly ".repeat(60)}`,
							recentOutput: ["終".repeat(200), "second"],
						}),
					],
				}),
			);
			for (const line of pane.render(width)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			pane.setExpanded(true);
			for (const line of pane.render(width)) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("sanitizes and width-bounds long, CJK, ANSI, tab, control, tool-arg, output, and error text", () => {
		const malicious = `\u001b[31m模型\t${"界".repeat(200)}\u001b[0m\u0000`;
		const hugeArgs = `${"arg\t".repeat(2_500)}ARGUMENT_TAIL_MUST_NOT_LEAK`;
		const homePath = `${os.homedir()}/private/council-secret.log`;
		const { pane } = harness(40, 12);
		pane.update(
			snapshot({
				state: "reviewing",
				outputPath: `/tmp/${"p".repeat(400)}/plan.md`,
				rows: [
					row({
						label: malicious,
						model: "provider/MODEL_BADGE",
						effort: "max",
						currentTool: `bash\t\u001b[34mtool\u001b[0m`,
						currentToolArgs: `{"path":"${homePath}"} ${hugeArgs}`,
						lastIntent: `${malicious}\nsecond physical line`,
						recentOutput: [`\u001b[35moutput\t${"終".repeat(400)}\u001b[0m\u0007`],
						error: `at ${homePath}\t\u001b[31merror\u001b[0m\n${"x".repeat(400)}`,
					}),
				],
			}),
		);
		pane.setExpanded(true);
		const lines = pane.render(72);
		const output = plain(lines);
		expect(output).not.toContain("\t");
		expect(output).not.toContain("\u0000");
		expect(output).toContain("MODEL_BADGE");
		expect(output).toContain("max");
		expect(output).not.toContain("\u0007");
		expect(output).not.toContain("[31m");
		expect(output).not.toContain("ARGUMENT_TAIL_MUST_NOT_LEAK");
		expect(output).toContain("模型");
		expect(output).toContain("error:");
		expect(output).toContain("~/private/council-secret.log");
		expect(output).not.toContain(os.homedir());
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(72);
	});

	it("uses component repaints for ticks and same-topology snapshots", () => {
		const h = harness();
		const initial = snapshot();
		h.pane.update(initial);
		expect(h.requestRender).toHaveBeenCalledTimes(1);
		h.requestRender.mockClear();
		h.requestComponentRender.mockClear();

		h.pane.tick(Date.parse("2026-08-05T12:00:13.000Z"));
		expect(h.requestComponentRender).toHaveBeenCalledTimes(1);
		expect(h.requestRender).not.toHaveBeenCalled();
		h.requestComponentRender.mockClear();

		h.pane.update({
			...initial,
			usage: { requests: 5, tokens: 13_000, cost: 0.013 },
			rows: initial.rows.map(item => ({ ...item, attempts: item.attempts + 1 })),
		});
		expect(h.requestComponentRender).toHaveBeenCalledTimes(1);
		expect(h.requestRender).not.toHaveBeenCalled();

		h.pane.update({ ...initial, rows: [...initial.rows, row({ key: "new", label: "new" })] });
		expect(h.requestRender).toHaveBeenCalledTimes(1);
	});

	it("renders only a nonterminal snapshot and clears on terminal transition", () => {
		const h = harness();
		const active = snapshot();
		h.pane.update(active);
		expect(h.pane.render(100).length).toBeGreaterThan(0);

		h.pane.update({ ...active, state: "completed", terminal: true });
		expect(h.pane.render(100)).toEqual([]);
	});

	it("recomputes a single bounded frame on resize without retaining old rows", () => {
		const h = harness(24, 12);
		h.pane.update(
			snapshot({
				rows: [row({ recentOutput: Array.from({ length: 8 }, (_, index) => `old-detail-${index}`) })],
			}),
		);
		h.pane.setExpanded(true);
		const before = plain(h.pane.render(100));
		expect(before).toContain("old-detail");

		h.setTerminalRows(12);
		const afterLines = h.pane.render(100);
		const after = plain(afterLines);
		// Body rows collapse to zero, leaving just the bordered header strip
		// (top border, header, bottom border).
		expect(afterLines.length).toBeLessThanOrEqual(3);
		expect(after.match(/Council/g)).toHaveLength(1);
		expect(after).not.toContain("old-detail");
	});

	it("protects the usage totals when the header cannot fit every segment", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot());
		const wide = Bun.stripANSI(pane.render(140)[1] ?? "");
		expectSpend(wide);
		expect(wide).toContain("council-run-1.md");
		expect(wide).toContain("R1/2");

		// The plan path is the first segment to go; the usage totals are never clipped.
		const narrowLines = pane.render(60);
		const narrow = Bun.stripANSI(narrowLines[1] ?? "");
		expectSpend(narrow);
		expect(narrow).not.toContain("council-run-1.md");
		for (const line of narrowLines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);

		// A path long enough to consume the whole remainder: composing at the frame width
		// instead of the frame's *inner* width used to clip these last two cells, eating
		// the trailing usage segment.
		pane.update(snapshot({ outputPath: `/tmp/${"p".repeat(200)}.md` }));
		const filled = pane.render(120);
		expect(Bun.stringWidth(filled[1] ?? "")).toBe(120);
		expectSpend(Bun.stripANSI(filled[1] ?? ""));
	});

	it("fills the expanded ceiling on a tall terminal despite the editor height cap", () => {
		const { pane } = harness(60, 18);
		const outputs = ["1", "2", "3", "4", "5", "6"];
		pane.update(
			snapshot({
				rows: [
					row({ key: "a", label: "a", recentOutput: outputs, error: "boom" }),
					row({ key: "b", label: "b", recentOutput: outputs }),
					row({ key: "c", label: "c", recentOutput: outputs }),
					row({ key: "d", label: "d", recentOutput: outputs }),
				],
			}),
		);
		pane.setExpanded(true);
		// 4 primaries + 24 output lines + 1 error + the footer = 30 logical rows, clamped to
		// the expanded ceiling rather than the editor's 18-row cap.
		expect(pane.render(100).slice(2, -1)).toHaveLength(COUNCIL_EXPANDED_VISIBLE_LIMIT);
	});

	it("always reserves one footer row and buys a failed row's reason first", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot());
		const body = pane.render(120).slice(2, -1);
		expect(body).toHaveLength(7);
		expect(plain(body)).toContain("error: provider failed");
		expect(Bun.stripANSI(body.at(-1) ?? "")).toContain("Esc cancel");

		// Rows fit but their details do not: the footer says how many are hidden.
		pane.update(
			snapshot({
				rows: Array.from({ length: 6 }, (_, index) =>
					row({ key: `r${index}`, label: `r${index}`, lastIntent: `intent-${index}` }),
				),
			}),
		);
		const hiddenFooter = Bun.stripANSI(pane.render(120).slice(2, -1).at(-1) ?? "");
		expect(hiddenFooter).toContain("hidden details");
		expect(hiddenFooter).toContain("Esc cancel");

		// Rows overflow: the same single footer carries the hidden-row count instead.
		pane.update(
			snapshot({ rows: Array.from({ length: 12 }, (_, index) => row({ key: `r${index}`, label: `r${index}` })) }),
		);
		const overflowFooter = Bun.stripANSI(pane.render(120).slice(2, -1).at(-1) ?? "");
		expect(overflowFooter).toContain("… 6 more");
		expect(overflowFooter).toContain("Esc cancel");
	});

	it("keeps unfinished rows in the compact window without reordering the roster", () => {
		const { pane } = harness(24, 12);
		const done = Array.from({ length: 6 }, (_, index) =>
			row({ key: `done-${index}`, label: `done-${index}`, status: "succeeded" }),
		);
		const live = Array.from({ length: 5 }, (_, index) =>
			row({ key: `live-${index}`, label: `live-${index}`, status: "running" }),
		);
		pane.update(snapshot({ rows: [...done, ...live] }));
		const output = plain(pane.render(120));
		for (const item of live) expect(output).toContain(item.label);
		// The window drops the overflowing settled rows, but the survivors stay in roster order:
		// a row must never jump position just because it finished.
		expect(output).not.toContain("done-5");
		expect(output.indexOf("done-0")).toBeGreaterThan(0);
		expect(output.indexOf("done-0")).toBeLessThan(output.indexOf("live-0"));
		expect(output.indexOf("live-0")).toBeLessThan(output.indexOf("live-4"));
	});

	it("holds a row's position when it settles mid-run", () => {
		const { pane } = harness(40, 12);
		const rows = [
			row({ key: "planner", label: "Planner", status: "succeeded" }),
			row({ key: "member:0", label: "Reviewer 1", status: "running" }),
			row({ key: "adjudicator", label: "Adjudicator", status: "queued", attempts: 0 }),
		];
		pane.update(snapshot({ rows }));
		const before = plain(pane.render(120));
		expect(before.indexOf("Planner")).toBeLessThan(before.indexOf("Reviewer 1"));
		expect(before.indexOf("Reviewer 1")).toBeLessThan(before.indexOf("Adjudicator"));

		pane.update(snapshot({ rows: rows.map(item => ({ ...item, status: "succeeded" as const })) }));
		const after = plain(pane.render(120));
		expect(after.indexOf("Planner")).toBeLessThan(after.indexOf("Reviewer 1"));
		expect(after.indexOf("Reviewer 1")).toBeLessThan(after.indexOf("Adjudicator"));
	});

	it("shows the attempts column only when a row actually retried", () => {
		const { pane } = harness(24, 12);
		pane.update(
			snapshot({
				rows: [
					row({ key: "a", label: "aa", attempts: 1 }),
					row({ key: "b", label: "bb", attempts: 1, requests: 4 }),
				],
			}),
		);
		const settledFirstTry = plain(pane.render(120));
		expect(settledFirstTry).toContain("4 req");
		expect(settledFirstTry).not.toContain("attempt");
		// The suppressed interior column leaves no stray separator behind.
		expect(settledFirstTry).not.toMatch(/ {2}4 req/);

		pane.update(
			snapshot({
				rows: [
					row({ key: "a", label: "aa", attempts: 1 }),
					row({ key: "b", label: "bb", attempts: 2, status: "retry", requests: 4 }),
				],
			}),
		);
		const retried = plain(pane.render(120));
		expect(retried).toContain("2 attempts");
		expect(retried).toContain("1 attempt");
	});

	it("marks an advisor-backed agent with a model suffix", () => {
		const { pane } = harness(24, 12);
		pane.update(
			snapshot({
				rows: [
					row({ key: "adjudicator", label: "Adjudicator", model: "anthropic/claude-opus-5", advisor: true }),
					row({ key: "member:0", label: "Reviewer 1", model: "openai/gpt-5" }),
				],
			}),
		);
		const output = plain(pane.render(140));
		expect(output).toContain("anthropic/claude-opus-5++");
		expect(output).toContain("openai/gpt-5");
		expect(output).not.toContain("openai/gpt-5++");
	});

	it("middle-truncates a long model name so provider and version both survive", () => {
		const { pane } = harness(24, 12);
		pane.update(snapshot({ rows: [row({ model: "anthropic/claude-sonnet-4-5-20260101-preview" })] }));
		const output = plain(pane.render(100));
		expect(output).toContain("anthropic/");
		expect(output).toContain("preview");
	});

	it("marks unsettled rows as interrupted while a run is cancelling", () => {
		const { pane } = harness(24, 12);
		pane.update(
			snapshot({
				state: "cancelling",
				rows: [
					row({ key: "a", label: "alpha", status: "running" }),
					row({ key: "b", label: "beta", status: "succeeded" }),
				],
			}),
		);
		const body = pane.render(120).slice(2, -2);
		// The status word is gone, so cancellation shows in the icons: both rows are settled now,
		// and the interrupted one no longer animates a spinner.
		const icons = body.map(rowIcon);
		expect(icons).toHaveLength(2);
		expect(new Set(icons).size).toBe(2);
		expect(plain(body)).toContain("alpha");
		expect(plain(body)).toContain("beta");
	});
});
