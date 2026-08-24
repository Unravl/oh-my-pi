import { visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { type CouncilRunState, type CouncilUsage, councilStateBadgeLabel } from "../../council/state";
import type { CouncilDispositionTally, CouncilRoleStats, CouncilRunStats } from "../../council/stats";
import { formatElapsedClock } from "../../slash-commands/helpers/format";
import {
	ADVISOR_MARKER,
	formatBadge,
	formatStatusIcon,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	type ToolUIColor,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { Ellipsis, padToWidth } from "../../tui";
import { theme } from "../theme/theme";
import { formatCost } from "./agent-hub-renderer";

/**
 * Reviewer outcome labels that follow the accepted fraction. `accepted` is absent because that
 * fraction already reports it, and `duplicate` is absent because a duplicate is folded into the
 * canonical finding's outcome upstream. `accepted with modification` is the one disposition whose
 * schema name is too long for a column cell, so it renders as `Modified`. Ordered, not keyed by
 * iteration, so the tally reads the same on every row.
 */
const DISPOSITION_LABELS: readonly (readonly [keyof CouncilDispositionTally, string])[] = [
	["accepted with modification", "Modified"],
	["rejected", "Rejected"],
	["unactionable", "Unactionable"],
];

/**
 * Run-state colouring, matching the live Council HUD header. Every in-progress state — `publishing`
 * included — falls through to accent, which is what an in-progress run should read as.
 */
function runStateColor(state: CouncilRunState): ToolUIColor {
	if (state === "failed" || state === "interrupted") return "error";
	if (state === "cancelling" || state === "completed-degraded") return "warning";
	if (state === "completed") return "success";
	return "accent";
}

/**
 * Status glyph per role outcome, matching the live Council HUD's icons. Deliberately static: this
 * table is history that re-renders on resize and on transcript rebuild, so a `running` row shows the
 * spinner's rest glyph rather than animating a frozen snapshot.
 */
function roleStatusIcon(status: string): string {
	switch (status) {
		case "succeeded":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "running":
			return formatStatusIcon("running", theme);
		case "interrupted":
		case "cancelled":
			return formatStatusIcon("aborted", theme);
		case "pending":
			return formatStatusIcon("pending", theme);
		default:
			return theme.styledSymbol("status.info", "muted");
	}
}

/**
 * Every manifest-sourced string reaches the overlay through here: role names,
 * model ids, statuses and failure reasons are provider output, so they may carry
 * tabs, ANSI, control bytes or absolute home paths.
 */
function sanitizedCell(value: string, width: number): string {
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(value))), Math.max(1, width));
}

function count(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function usageLabel(usage: CouncilUsage): string {
	return [
		`${formatNumber(count(usage.requests))} req`,
		`${formatNumber(count(usage.tokens))} tok`,
		// Two decimals: these columns are read at a glance, and `$0.0000` reads as broken, not precise.
		formatCost(usage.cost, { maxFractionDigits: 2 }),
	].join(theme.sep.dot);
}

/**
 * How the adjudicator disposed of a reviewer's findings, led by the accepted fraction: `1/2 Accepted`
 * says both how much landed and how much was raised, so a separate findings count is redundant.
 *
 * `duplicate` is never a segment. A duplicate means another finding already covered the same ground,
 * so {@link summarizeCouncilRun} resolves it to the canonical finding's disposition before tallying —
 * a duplicate of an accepted finding counts as accepted. Zero-count segments are dropped; the
 * planner and adjudicator rows carry no findings at all and end at the spend column.
 */
function outcomeSegments(role: CouncilRoleStats): string[] {
	if (role.kind !== "reviewer") return [];
	const findings = count(role.findings);
	if (findings === 0) return [];
	const segments = [`${formatNumber(count(role.dispositions.accepted))}/${formatNumber(findings)} Accepted`];
	for (const [disposition, label] of DISPOSITION_LABELS) {
		const tallied = count(role.dispositions[disposition]);
		if (tallied > 0) segments.push(`${formatNumber(tallied)} ${label}`);
	}
	return segments;
}

/**
 * A reviewer's relaunch count, and only when one of them actually retried. The planner's and
 * Adjudicator's launch counts were byte-for-byte the request count in the very next cell — the
 * planner is single-shot and Main's "turns" *are* its requests — so the column now carries the one
 * number the spend cell cannot express.
 */
function attemptLabel(role: CouncilRoleStats): string {
	if (role.kind !== "reviewer") return "";
	const attempts = count(role.attempts);
	return attempts === 0 ? "" : `${formatNumber(attempts)} attempt${attempts === 1 ? "" : "s"}`;
}

/**
 * Colour for a rank. `S`/`A` are the outcomes worth paying for, `F` is a reviewer that never
 * delivered, and the middle grades sit on the neutral-to-warning slope between them.
 */
function gradeColor(grade: string): ToolUIColor {
	switch (grade) {
		case "S":
			return "success";
		case "A":
			return "accent";
		case "B":
			return "muted";
		case "C":
		case "D":
			return "warning";
		default:
			return "error";
	}
}

function roleCells(role: CouncilRoleStats, width: number, showAttempts: boolean): string[] {
	const label =
		sanitizedCell(role.label, Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(width / 5)))) || role.kind;
	// The advisor marker is budgeted before truncating so it cannot be the byte that gets clipped.
	const marker = role.advisor === true ? ADVISOR_MARKER : "";
	const model =
		sanitizedCell(
			role.model,
			Math.max(4, Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(8, Math.floor(width / 3))) - marker.length),
		) || "unknown model";
	const effort =
		sanitizedCell(role.effort ?? "default", Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(width / 10)))) ||
		"default";
	const outcome = outcomeSegments(role);
	const attempts = showAttempts ? attemptLabel(role) : "";
	// Rank first, then status icon and name: the grade is the verdict the operator scans for. Only
	// reviewers carry one, so the planner and adjudicator leave the cell blank and stay aligned.
	// No status word either: `roleStatusIcon` is a distinct glyph per outcome in every symbol theme.
	return [
		role.grade ? theme.bold(theme.fg(gradeColor(role.grade), sanitizedCell(role.grade, 2))) : "",
		`${roleStatusIcon(role.status)} ${theme.bold(theme.fg("accent", label))}`,
		formatBadge(`${model}${marker}`, "muted", theme),
		formatBadge(effort, "muted", theme),
		attempts ? theme.fg("dim", attempts) : "",
		theme.fg("dim", usageLabel(role.usage)),
		outcome.length > 0 ? theme.fg("dim", outcome.join(theme.sep.dot)) : "",
	];
}

/** A laid-out role, plus the round heading that introduces its group when one starts here. */
interface GroupedCouncilRole {
	role: CouncilRoleStats;
	heading?: string;
}

/**
 * Reviewers reordered into round groups, each group introduced by a heading. A reviewer serving
 * several rounds forms its own group instead of being listed under each, so every role still
 * appears exactly once and no spend or grade is counted twice. A roster whose reviewers all serve
 * the same rounds has nothing to separate and renders ungrouped, which is the default shape.
 * Non-reviewer roles keep their positions around the reviewer block: planner above, adjudicator
 * below.
 */
function groupRolesByRound(roles: readonly CouncilRoleStats[]): GroupedCouncilRole[] {
	// A persisted `details.stats` reaches this renderer before hydration replaces it, and only its
	// top-level shape is validated, so `rounds` is arbitrary JSON here. Every round is normalized to
	// a positive integer before it can reach a heading: `count` rejects non-finite values, strings
	// included, so no control byte, ANSI run or home path can be interpolated into a divider.
	const keyOf = (role: CouncilRoleStats): string =>
		(Array.isArray(role.rounds) ? role.rounds : [])
			.map(round => count(round))
			.filter(round => round > 0)
			.join(",");
	const reviewers = roles.filter(role => role.kind === "reviewer");
	const keys = [...new Set(reviewers.map(keyOf))].filter(key => key.length > 0);
	if (keys.length <= 1) return roles.map(role => ({ role }));
	// First round served orders the groups; a multi-round group sorts after the single round it
	// opens with, so `Round 1` precedes `Rounds 1,2`.
	keys.sort((left, right) => {
		const leftRounds = left.split(",").map(Number);
		const rightRounds = right.split(",").map(Number);
		return (leftRounds[0] ?? 0) - (rightRounds[0] ?? 0) || leftRounds.length - rightRounds.length;
	});
	let firstReviewer = roles.length;
	let lastReviewer = -1;
	for (const [index, role] of roles.entries()) {
		if (role.kind !== "reviewer") continue;
		firstReviewer = Math.min(firstReviewer, index);
		lastReviewer = index;
	}
	const grouped: GroupedCouncilRole[] = roles.slice(0, firstReviewer).map(role => ({ role }));
	// A reviewer with no recorded rounds cannot be placed in a group, so it leads the block
	// unheaded rather than inventing a round for it.
	for (const role of reviewers) if (keyOf(role).length === 0) grouped.push({ role });
	for (const key of keys) {
		const rounds = key.split(",");
		const heading = rounds.length === 1 ? `Round ${rounds[0]}` : `Rounds ${rounds.join(", ")}`;
		let opensGroup = true;
		for (const role of reviewers) {
			if (keyOf(role) !== key) continue;
			grouped.push(opensGroup ? { role, heading } : { role });
			opensGroup = false;
		}
	}
	grouped.push(...roles.slice(lastReviewer + 1).map(role => ({ role })));
	return grouped;
}

/** Group divider: a short rule then the label, dim, so a boundary reads without outranking rows. */
function roundDivider(label: string, width: number): string {
	const text = ` ${label}`;
	const rule = "─".repeat(Math.max(0, Math.min(7, width - visibleWidth(text))));
	return truncateToWidth(theme.fg("dim", `${rule}${text}`), width, Ellipsis.Unicode);
}

/**
 * Column widths are per-column maxima clamped by width-derived ceilings, so
 * model and thinking badges start at the same offset on every role row regardless
 * of label width. Label/model/thinking are clamped so a 400-character model id
 * can never push the metrics off the row; the rest are bounded by the final
 * width pass alone. Trailing empty cells are dropped per row instead of padded,
 * so no row ends in a whitespace run the overlay border would have to absorb.
 */
function layoutRoleRows(rows: readonly string[][], width: number): string[] {
	// One ceiling per cell of roleCells: grade, label, model, effort, attempts, spend, outcome.
	const ceilings = [
		2,
		Math.max(8, Math.floor(width / 5)),
		Math.max(12, Math.floor(width / 3)),
		Math.max(6, Math.floor(width / 10)),
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
		Number.POSITIVE_INFINITY,
	];
	const widths = ceilings.map((ceiling, column) =>
		Math.min(
			ceiling,
			rows.reduce((max, cells) => Math.max(max, visibleWidth(cells[column] ?? "")), 0),
		),
	);
	// Drop *every* zero-width column, not just trailing ones: a suppressed interior column (no
	// reviewer retried) would otherwise contribute an empty cell and a stray separator space.
	const columns: { column: number; columnWidth: number }[] = [];
	widths.forEach((columnWidth, column) => {
		if (columnWidth > 0) columns.push({ column, columnWidth });
	});
	return rows.map(cells => {
		let last = columns.length - 1;
		while (last > 0 && visibleWidth(cells[columns[last]!.column] ?? "") === 0) last--;
		const parts: string[] = [];
		for (let index = 0; index <= last; index++) {
			const { column, columnWidth } = columns[index]!;
			const cell = cells[column] ?? "";
			const bounded = visibleWidth(cell) > columnWidth ? truncateToWidth(cell, columnWidth) : cell;
			parts.push(index === last ? bounded : padToWidth(bounded, columnWidth));
		}
		return truncateToWidth(parts.join(" "), width, Ellipsis.Unicode);
	});
}

function headlineRow(stats: CouncilRunStats, width: number): string {
	// Title Case for the badge; the colour still keys on the raw enum.
	const state = sanitizedCell(councilStateBadgeLabel(stats.state), TRUNCATE_LENGTHS.TITLE) || "unknown";
	const meta = [
		// Total wall clock, in the same `mm:ss` shape the live HUD ticks, so the two read alike.
		...(stats.durationMs === undefined ? [] : [formatElapsedClock(stats.durationMs)]),
		`rounds ${formatNumber(count(stats.rounds))}`,
		`${formatNumber(count(stats.reviewersSucceeded))}/${formatNumber(count(stats.reviewersTotal))} reviewers`,
		usageLabel(stats.total),
	];
	const headline = [
		theme.bold(theme.fg("accent", "Council")),
		formatBadge(state, runStateColor(stats.state), theme),
		theme.fg("dim", meta.join(theme.sep.dot)),
		...(stats.dispositionsUnavailable === true ? [theme.fg("warning", "dispositions unreadable")] : []),
	].join(" ");
	return truncateToWidth(headline, Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0, Ellipsis.Unicode);
}

/**
 * The collapse fallback for hosts whose header budget cannot afford the full block: the run's
 * identity, outcome and spend on one row. Byte-identical to `renderCouncilStatsHeader`'s first row,
 * so collapsing never re-renders the headline differently from the full projection.
 */
export function renderCouncilStatsHeadline(stats: CouncilRunStats, width: number): string[] {
	return [headlineRow(stats, width)];
}

/**
 * Pure projection of a council run's stats into the plan-review overlay's
 * full-width header region: a headline, one column-aligned row per role grouped by the rounds its
 * reviewers serve, then the run's warnings. The overlay only wraps each row in its border, so every
 * returned string is already sanitized and bounded to `width`.
 */
export function renderCouncilStatsHeader(stats: CouncilRunStats, width: number): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
	const cellWidth = Math.max(1, safeWidth);
	const rows = [headlineRow(stats, safeWidth)];

	if (stats.roles.length > 0) {
		// One retry anywhere earns the column for the whole table.
		const showAttempts = stats.roles.some(role => role.kind === "reviewer" && count(role.attempts) > 1);
		// Columns are laid out across every role at once, dividers excluded, so a heading never
		// widens a column and the grouped rows stay aligned with the planner and adjudicator.
		const grouped = groupRolesByRound(stats.roles);
		const laid = layoutRoleRows(
			grouped.map(entry => roleCells(entry.role, cellWidth, showAttempts)),
			safeWidth,
		);
		grouped.forEach((entry, index) => {
			if (entry.heading !== undefined) rows.push(roundDivider(entry.heading, safeWidth));
			const row = laid[index];
			if (row !== undefined) rows.push(row);
		});
	}

	for (const warning of stats.warnings) {
		const text = sanitizedCell(warning, Math.min(TRUNCATE_LENGTHS.CONTENT, Math.max(1, cellWidth - 2)));
		if (text) rows.push(truncateToWidth(theme.fg("dim", `! ${text}`), safeWidth, Ellipsis.Unicode));
	}

	return rows;
}
