import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CouncilDispositionTally,
	CouncilRoleStats,
	CouncilRunStats,
} from "@oh-my-pi/pi-coding-agent/council/stats";
import {
	renderCouncilStatsHeader,
	renderCouncilStatsHeadline,
} from "@oh-my-pi/pi-coding-agent/modes/components/council-stats";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(() => initTheme());

const WIDTHS = [60, 80, 120] as const;

function tally(overrides: Partial<CouncilDispositionTally> = {}): CouncilDispositionTally {
	return {
		accepted: 0,
		"accepted with modification": 0,
		rejected: 0,
		duplicate: 0,
		unactionable: 0,
		...overrides,
	};
}

function role(overrides: Partial<CouncilRoleStats> = {}): CouncilRoleStats {
	return {
		key: "planner",
		label: "planner",
		kind: "planner",
		model: "anthropic/claude-sonnet-4-5",
		effort: "high",
		attempts: 1,
		status: "succeeded",
		usage: { requests: 3, tokens: 12_345, cost: 0.0123 },
		findings: 0,
		dispositions: tally(),
		...overrides,
	};
}

function stats(overrides: Partial<CouncilRunStats> = {}): CouncilRunStats {
	return {
		runId: "run-1",
		state: "completed",
		degraded: false,
		rounds: 2,
		reviewersSucceeded: 3,
		reviewersTotal: 4,
		outputPath: "plans/council-run-1.md",
		total: { requests: 21, tokens: 654_321, cost: 1.2345 },
		roles: [
			role(),
			role({
				key: "correctness",
				label: "correctness",
				kind: "reviewer",
				model: "openai/gpt-5",
				findings: 7,
				dispositions: tally({ accepted: 3, "accepted with modification": 2, rejected: 1, duplicate: 1 }),
			}),
			role({
				key: "adjudicator",
				label: "Adjudicator",
				kind: "adjudicator",
				model: "anthropic/claude-opus-4-1",
				effort: null,
			}),
		],
		warnings: [],
		...overrides,
	};
}

/** Visible cell offset at which `needle` starts on a rendered row. */
function offsetOf(line: string, needle: string): number {
	const plain = Bun.stripANSI(line);
	const index = plain.indexOf(needle);
	expect(index).toBeGreaterThanOrEqual(0);
	return Bun.stringWidth(plain.slice(0, index));
}

describe("renderCouncilStatsHeader", () => {
	it("bounds every row to the requested width even for hostile manifest strings", () => {
		const hostile = stats({
			state: "completed-degraded",
			roles: [
				role({ label: "L".repeat(400), model: "m".repeat(400) }),
				role({
					key: "security",
					label: "security",
					kind: "reviewer",
					model: `provider/${"x".repeat(400)}`,
					effort: "\u001b[31mmax\u0007",
					findings: 12,
					dispositions: tally({ accepted: 4, "accepted with modification": 3, unactionable: 5 }),
				}),
				role({ key: "adjudicator", label: "Adjudicator", kind: "adjudicator" }),
			],
			warnings: [
				`round 1:\tmember\u0000 failed\u0007 \u001b[31mprovider error\u001b[0m at ${path.join(os.homedir(), "projects", "omp", "plans", "council.md")}`,
				"W".repeat(600),
			],
		});

		for (const width of WIDTHS) {
			const lines = renderCouncilStatsHeader(hostile, width);
			expect(lines.length).toBeGreaterThan(1);
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders all roles, models, and scores without capping them", () => {
		const many = stats({
			roles: Array.from({ length: 20 }, (_unused, index) =>
				role({
					key: `council${index}`,
					label: `council${index}`,
					model: `provider/model-${index}`,
					kind: "reviewer",
					findings: index,
					dispositions: tally({ accepted: index }),
				}),
			),
			warnings: ["one", "two", "three"],
		});

		const lines = renderCouncilStatsHeader(many, 120);
		// 1 headline + 20 roles + 3 warnings = 24 rows
		expect(lines).toHaveLength(24);
		expect(Bun.stripANSI(lines[0])).toContain("Council");
		for (let index = 0; index < 20; index++) {
			expect(lines.some(line => Bun.stripANSI(line).includes(`council${index}`))).toBe(true);
		}
		expect(lines.some(line => Bun.stripANSI(line).includes("one"))).toBe(true);
		expect(lines.some(line => Bun.stripANSI(line).includes("two"))).toBe(true);
		expect(lines.some(line => Bun.stripANSI(line).includes("three"))).toBe(true);
		expect(lines.every(line => !Bun.stripANSI(line).includes("more"))).toBe(true);
	});

	it("never emits tabs, control characters, or raw escape sequences", () => {
		const dirty = stats({
			roles: [
				role({ label: "plan\tner\u0000", model: "prov\u0007ider/\u001b[31mmodel", effort: "hi\tgh" }),
				role({ key: "adjudicator", label: "Adjudi\u001b[31mcator", kind: "adjudicator", effort: null }),
			],
			warnings: ["round 1:\tfailed\u0000\u0007 \u001b[31mred\u001b[0m"],
		});

		const plain = renderCouncilStatsHeader(dirty, 100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(plain).not.toContain("\t");
		expect(plain).not.toContain("\u0000");
		expect(plain).not.toContain("\u0007");
		expect(plain).not.toContain("[31m");
		expect(plain).not.toContain("\u001b");
	});

	it("leads a reviewer's outcome with the accepted fraction and keeps tallies off the other rows", () => {
		const lines = renderCouncilStatsHeader(
			stats({
				roles: [
					role(),
					role({
						key: "correctness",
						label: "correctness",
						kind: "reviewer",
						findings: 7,
						// `duplicate` never reaches the renderer as its own bucket: summarizeCouncilRun folds a
						// duplicate into the canonical finding's outcome before tallying.
						dispositions: tally({ accepted: 3, "accepted with modification": 2, rejected: 1 }),
					}),
					role({
						key: "adjudicator",
						label: "Adjudicator",
						kind: "adjudicator",
						usage: { requests: 9, tokens: 4_000, cost: 0.5 },
					}),
				],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		const adjudicator = lines.find(line => line.includes("Adjudicator"));
		expect(adjudicator).toBeDefined();
		expect(adjudicator).toContain("9 req");
		expect(adjudicator).toContain("$0.50");
		expect(adjudicator).not.toContain("$0.500");
		expect(adjudicator).not.toContain("Accepted");

		const reviewer = lines.find(line => line.includes("correctness"));
		expect(reviewer).toBeDefined();
		expect(reviewer).toContain("3/7 Accepted");
		expect(reviewer).toContain("2 Modified");
		expect(reviewer).toContain("1 Rejected");
		expect(reviewer).not.toContain("findings");
		expect(reviewer).not.toContain("duplicate");
		expect(reviewer).not.toContain("Unactionable");

		const planner = lines.find(line => line.includes("planner"));
		expect(planner).toBeDefined();
		expect(planner).not.toContain("Accepted");
	});

	it("omits the outcome segment for a reviewer that raised no findings", () => {
		const lines = renderCouncilStatsHeader(
			stats({
				roles: [role({ key: "ux", label: "ux", kind: "reviewer", findings: 0, dispositions: tally() })],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		const reviewer = lines.find(line => line.includes("ux"));
		expect(reviewer).toBeDefined();
		expect(reviewer).not.toContain("findings");
		// No padded trailing column once the outcome cell is gone.
		expect(reviewer).toBe(reviewer?.trimEnd());
	});

	it("aligns model and thinking badges across role rows and states each outcome by icon alone", () => {
		const lines = renderCouncilStatsHeader(
			stats({
				roles: [
					role({ label: "a", status: "running" }),
					role({
						key: "long",
						label: "extremely-long-reviewer-label",
						kind: "reviewer",
						model: "openai/gpt-5",
						status: "failed",
						findings: 2,
						dispositions: tally({ rejected: 2 }),
					}),
					role({
						key: "adjudicator",
						label: "Adjudicator",
						kind: "adjudicator",
						status: "interrupted",
						model: "z/tiny",
					}),
				],
			}),
			200,
		);

		const roleRows = lines.slice(1, 4);
		const modelOffset = offsetOf(roleRows[0], "anthropic/claude-sonnet-4-5");
		expect(offsetOf(roleRows[1], "openai/gpt-5")).toBe(modelOffset);
		expect(offsetOf(roleRows[2], "z/tiny")).toBe(modelOffset);

		// The status word is gone; each row opens with its own distinct glyph instead.
		const icons = roleRows.map(line => Bun.stripANSI(line).trim().split(" ")[0]);
		for (const icon of icons) expect(icon).toBeTruthy();
		expect(new Set(icons).size).toBe(3);
		const text = roleRows.map(line => Bun.stripANSI(line)).join("\n");
		for (const status of ["running", "failed", "interrupted"]) expect(text).not.toContain(status);
	});

	it("colours the headline state badge and reports rounds, reviewers, and run totals", () => {
		const headline = Bun.stripANSI(renderCouncilStatsHeader(stats(), 200)[0]);
		expect(headline).toContain("Council");
		expect(headline).toContain("Completed");
		expect(headline).toContain("rounds 2");
		expect(headline).toContain("3/4 reviewers");
		expect(headline).toContain("21 req");
		expect(headline).toContain("654K tok");
		expect(headline).toContain("$1.23");
	});

	it("reports the run's total duration immediately after the state badge", () => {
		const headline = Bun.stripANSI(renderCouncilStatsHeader(stats({ durationMs: 83_000 }), 200)[0] ?? "");
		expect(headline).toContain("01:23");
		expect(headline.indexOf("Completed")).toBeLessThan(headline.indexOf("01:23"));
		expect(headline.indexOf("01:23")).toBeLessThan(headline.indexOf("rounds 2"));

		// Past an hour it grows a leading hour field rather than overflowing the minutes.
		expect(Bun.stripANSI(renderCouncilStatsHeader(stats({ durationMs: 7_625_000 }), 200)[0] ?? "")).toContain(
			"2:07:05",
		);

		// A run whose timestamps could not be read shows no clock rather than a bogus `00:00`.
		const undated = Bun.stripANSI(renderCouncilStatsHeader(stats(), 200)[0] ?? "");
		expect(undated).toContain("rounds 2");
		expect(undated).not.toMatch(/\d\d:\d\d/);
	});

	it("reports a reviewer's attempts only once one retried, and never duplicates a request count", () => {
		const firstTry = renderCouncilStatsHeader(
			stats({
				roles: [
					role({ attempts: 1, usage: { requests: 3, tokens: 10, cost: 0.1 } }),
					role({ key: "correctness", label: "correctness", kind: "reviewer", attempts: 1 }),
					role({
						key: "adjudicator",
						label: "Adjudicator",
						kind: "adjudicator",
						attempts: 4,
						usage: { requests: 4, tokens: 10, cost: 0.1 },
					}),
				],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		expect(firstTry.join("\n")).not.toContain("attempt");
		// The planner is single-shot and the adjudicator's "turns" *are* its requests: both used to
		// restate the number in the very next cell.
		expect(firstTry.find(line => line.includes("planner"))).not.toContain("3 requests");
		expect(firstTry.find(line => line.includes("Adjudicator"))).not.toContain("4 turns");

		const retried = renderCouncilStatsHeader(
			stats({
				roles: [
					role({ attempts: 1 }),
					role({ key: "correctness", label: "correctness", kind: "reviewer", attempts: 1 }),
					role({ key: "ux", label: "ux", kind: "reviewer", attempts: 3 }),
					role({ key: "adjudicator", label: "Adjudicator", kind: "adjudicator", attempts: 4 }),
				],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		expect(retried.find(line => line.includes("correctness"))).toContain("1 attempt");
		expect(retried.find(line => line.includes("ux"))).toContain("3 attempts");
		expect(retried.find(line => line.includes("planner"))).not.toContain("attempt");
		expect(retried.find(line => line.includes("Adjudicator"))).not.toContain("attempt");
	});

	it("marks an advisor-backed role with a model suffix", () => {
		const lines = renderCouncilStatsHeader(
			stats({
				roles: [
					role({
						key: "adjudicator",
						label: "Adjudicator",
						kind: "adjudicator",
						model: "anthropic/claude-opus-5",
						advisor: true,
					}),
					role({ key: "ux", label: "ux", kind: "reviewer", model: "openai/gpt-5" }),
				],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		expect(lines.find(line => line.includes("Adjudicator"))).toContain("anthropic/claude-opus-5++");
		expect(lines.find(line => line.includes("ux"))).toContain("openai/gpt-5");
		expect(lines.find(line => line.includes("ux"))).not.toContain("++");
	});

	it("puts a reviewer's rank ahead of its status icon and name, and only on reviewer rows", () => {
		const lines = renderCouncilStatsHeader(
			stats({
				roles: [
					role(),
					role({ key: "sharp", label: "sharp", kind: "reviewer", grade: "S" }),
					role({ key: "dud", label: "dud", kind: "reviewer", grade: "D" }),
					role({ key: "gone", label: "gone", kind: "reviewer", status: "failed", grade: "F" }),
					role({ key: "adjudicator", label: "Adjudicator", kind: "adjudicator" }),
				],
			}),
			200,
		).map(line => Bun.stripANSI(line));

		const sharp = lines.find(line => line.includes("sharp")) ?? "";
		expect(sharp.trim().startsWith("S ")).toBeTrue();
		expect(sharp.indexOf("S")).toBeLessThan(sharp.indexOf("sharp"));
		expect(
			lines
				.find(line => line.includes("dud"))
				?.trim()
				.startsWith("D "),
		).toBeTrue();
		expect(
			lines
				.find(line => line.includes("gone"))
				?.trim()
				.startsWith("F "),
		).toBeTrue();

		// The planner and adjudicator are not graded, so their rows open on the blank rank cell and
		// their names still line up with the graded rows above.
		const planner = lines.find(line => line.includes("planner")) ?? "";
		const adjudicator = lines.find(line => line.includes("Adjudicator")) ?? "";
		expect(planner.indexOf("planner")).toBe(sharp.indexOf("sharp"));
		expect(adjudicator.indexOf("Adjudicator")).toBe(sharp.indexOf("sharp"));
	});

	it("reports a failed disposition read on the headline, and stays silent otherwise", () => {
		expect(Bun.stripANSI(renderCouncilStatsHeader(stats(), 200)[0]!)).not.toContain("dispositions unreadable");
		expect(Bun.stripANSI(renderCouncilStatsHeader(stats({ dispositionsUnavailable: true }), 200)[0]!)).toContain(
			"dispositions unreadable",
		);
	});
});

describe("renderCouncilStatsHeadline", () => {
	it("collapses to exactly the full header's headline row", () => {
		for (const width of WIDTHS) {
			const collapsed = renderCouncilStatsHeadline(stats(), width);
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toBe(renderCouncilStatsHeader(stats(), width)[0]);
			expect(Bun.stringWidth(Bun.stripANSI(collapsed[0]!))).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the run's outcome and spend, which are the rows the drop would have lost", () => {
		const headline = Bun.stripANSI(renderCouncilStatsHeadline(stats({ roles: [], warnings: [] }), 200)[0]!);
		expect(headline).toContain("Council");
		expect(headline).toContain("3/4 reviewers");
		expect(headline).toContain("$1.23");
	});

	it("names the run state in Title Case plain language rather than the durable enum", () => {
		expect(Bun.stripANSI(renderCouncilStatsHeadline(stats({ state: "publishing" }), 200)[0]!)).toContain(
			"Writing The Plan",
		);
		expect(Bun.stripANSI(renderCouncilStatsHeadline(stats({ state: "completed-degraded" }), 200)[0]!)).toContain(
			"Completed With Warnings",
		);
		expect(Bun.stripANSI(renderCouncilStatsHeadline(stats({ state: "awaiting-main" }), 200)[0]!)).toContain(
			"Waiting For Your Turn To Finish",
		);
		expect(Bun.stripANSI(renderCouncilStatsHeadline(stats({ state: "awaiting-main" }), 200)[0]!)).not.toContain(
			"awaiting-main",
		);
	});
});

describe("renderCouncilStatsHeader round grouping", () => {
	function reviewer(key: string, rounds: readonly number[]): CouncilRoleStats {
		return role({ key, label: key, kind: "reviewer", model: "openai/gpt-5", rounds });
	}

	function body(roles: CouncilRoleStats[]): string[] {
		return renderCouncilStatsHeader(stats({ roles, warnings: [] }), 200).map(line => Bun.stripANSI(line));
	}

	it("groups reviewers under a divider per round instead of a per-row round column", () => {
		const lines = body([
			reviewer("alpha", [1]),
			reviewer("beta", [2]),
			reviewer("gamma", [1]),
			role({ key: "adjudicator", label: "Adjudicator", kind: "adjudicator" }),
		]);
		const order = lines
			.filter(line => /Round |alpha|beta|gamma|Adjudicator/.test(line))
			.map(line => {
				const trimmed = line.trim();
				if (trimmed.startsWith("─")) return trimmed.replace(/^─+\s*/, "");
				return trimmed.split(/\s+/).find(token => /^(alpha|beta|gamma|Adjudicator)$/.test(token)) ?? trimmed;
			});

		// Roster order is 1, 2, 1: grouping must reorder so each round is contiguous under one heading.
		expect(order).toEqual(["Round 1", "alpha", "gamma", "Round 2", "beta", "Adjudicator"]);
		// The round is stated once per group, never repeated as an `R1`/`R2` cell on every row.
		expect(lines.filter(line => /\bR1\b|\bR2\b/.test(line))).toEqual([]);
	});

	it("gives a reviewer serving several rounds its own group rather than listing it twice", () => {
		const lines = body([reviewer("alpha", [1]), reviewer("both", [1, 2]), reviewer("beta", [2])]);
		expect(lines.filter(line => line.includes("both"))).toHaveLength(1);
		const headings = lines.filter(line => line.includes("Round")).map(line => line.trim());
		expect(headings.map(heading => heading.replace(/^─+\s*/, ""))).toEqual(["Round 1", "Rounds 1, 2", "Round 2"]);
	});

	it("renders no dividers when every reviewer serves the same rounds", () => {
		const lines = body([reviewer("alpha", [1, 2]), reviewer("beta", [1, 2])]);
		expect(lines.filter(line => line.includes("Round "))).toEqual([]);
		expect(lines.filter(line => line.includes("alpha") || line.includes("beta"))).toHaveLength(2);
	});

	// `persistedStats` in council-run-message.ts checks only that `roles` is an array, and
	// `#rebuild()` renders that payload before hydration replaces it, so a divider label is built
	// from unvalidated JSON.
	it("never renders a divider from a persisted round that is not a positive integer", () => {
		const dirty = [
			"2\u0007\u001b[31mRED",
			"../../../etc/passwd",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			-4,
			0,
			2.9,
		] as unknown as readonly number[];
		const lines = body([
			reviewer("alpha", [1]),
			role({ key: "dirty", label: "dirty", kind: "reviewer", model: "openai/gpt-5", rounds: dirty }),
		]);
		const headings = lines.filter(line => line.includes("Round"));

		// 2.9 truncates to 2 and every other entry is dropped, so the group is exactly `Rounds 2`.
		expect(headings.map(heading => heading.trim().replace(/^─+\s*/, ""))).toEqual(["Round 1", "Round 2"]);
		for (const line of lines) {
			expect(line).not.toContain("\u0007");
			expect(line).not.toContain("\u001b[31m");
			expect(line).not.toContain("passwd");
			expect(line).not.toContain("NaN");
			expect(line).not.toContain("Infinity");
		}
	});
});
