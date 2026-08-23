import * as path from "node:path";
import { type Component, Container, matchesKey, ScrollView, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import { type CouncilRunState, councilStateBadgeLabel } from "../../council/state";
import { formatElapsedClock } from "../../slash-commands/helpers/format";
import {
	ADVISOR_MARKER,
	expandKeyHint,
	formatBadge,
	formatStatusIcon,
	PREVIEW_LIMITS,
	previewLine,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateMiddleToWidth,
	truncateToWidth,
} from "../../tools/render-utils";
import { padToWidth } from "../../tui";
import { theme } from "../theme/theme";
import { formatCost } from "./agent-hub-renderer";
import { sharedSpinnerFrame } from "./tool-execution";

/** Shared compact-HUD row ceiling used by subagents and Council. */
export const SUBAGENT_HUD_VISIBLE_LIMIT = 8;

/**
 * Expanded-mode row ceiling. Deliberately independent of
 * {@link SUBAGENT_HUD_VISIBLE_LIMIT} (shared with the subagent HUD) and of the
 * editor's own height cap: an expanded pane is the user's active view, so only
 * terminal room and this constant bound it.
 */
export const COUNCIL_EXPANDED_VISIBLE_LIMIT = 24;

/** Rows retained for transcript/status chrome after the editor and Council pane. */
const COUNCIL_TRANSCRIPT_RESERVED_ROWS = 4;
/** Below this the plan path degenerates to a bare ellipsis, so the header drops it instead. */
const COUNCIL_HEADER_MIN_PATH_WIDTH = 8;

/** The pane always reserves one body row for the key-hint/overflow footer. */
const COUNCIL_FOOTER_ROWS = 1;

export type CouncilPaneRowStatus = "queued" | "waiting" | "running" | "retry" | "succeeded" | "failed" | "interrupted";

export interface CouncilPaneRowSnapshot {
	key: string;
	label: string;
	model: string;
	effort: string | null;
	/** Whether a live advisor watches this agent's turns; rendered as a `++` model suffix. */
	advisor?: boolean;
	/** Configured review rounds a reviewer serves; absent for the planner and the adjudicator. */
	rounds?: readonly number[];
	status: CouncilPaneRowStatus;
	attempts: number;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentOutput?: readonly string[];
	requests?: number;
	tokens?: number;
	cost?: number;
	error?: string;
}

export interface CouncilPaneUsageSnapshot {
	requests?: number;
	tokens?: number;
	cost?: number;
}

/** Immutable, renderer-focused projection of a coordinator snapshot. */
export interface CouncilPaneSnapshot {
	runId: string;
	state: CouncilRunState;
	round: number;
	totalRounds: number;
	startedAt?: string;
	outputPath: string;
	warnings?: readonly string[];
	failure?: string;
	usage?: CouncilPaneUsageSnapshot;
	rows: readonly CouncilPaneRowSnapshot[];
	terminal: boolean;
}

interface CouncilPaneRenderHost {
	requestRender(): void;
	requestComponentRender(component: Component): void;
}

export interface CouncilPaneOptions {
	tui: CouncilPaneRenderHost;
	getTerminalRows?: () => number;
	getEditorMaxHeight?: () => number;
	now?: () => number;
}

/** Holds mutable HUD and editor-adjacent chrome outside transcript history. */
export class AnchoredLiveContainer extends Container {}

interface RenderedCouncilRow {
	cells: readonly string[];
	/** Styled detail bodies without their tree prefix; the first `errorCount` are failure reasons. */
	details: readonly string[];
	errorCount: number;
	finished: boolean;
}

/** A row after column layout: `content` is column-aligned and width-bounded, sans connector. */
interface CouncilBodyRow {
	content: string;
	details: readonly string[];
	errorCount: number;
	finished: boolean;
}

function statusIcon(status: CouncilPaneRowStatus, spinnerFrame?: number): string {
	switch (status) {
		case "queued":
			return formatStatusIcon("pending", theme);
		case "waiting":
			// Distinct from `queued`: Council is blocked on the user's turn, not on itself.
			return theme.styledSymbol("status.info", "muted");
		case "running":
			// `formatStatusIcon`'s spinner branch returns a bare glyph, so the accent is ours
			// to apply — otherwise the animated icon would silently lose its color.
			return spinnerFrame === undefined
				? formatStatusIcon("running", theme)
				: theme.fg("accent", formatStatusIcon("running", theme, spinnerFrame));
		case "retry":
			return formatStatusIcon("warning", theme);
		case "succeeded":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "interrupted":
			return formatStatusIcon("aborted", theme);
	}
}

function sanitizedLine(value: unknown, width: number): string {
	const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return previewLine(shortenEmbeddedPaths(replaceTabs(sanitizeText(text))), Math.max(1, width));
}

/**
 * Attempt counts are noise until one of them means something: the column exists only to explain a
 * retry, so it is rendered when *any* row has retried and collapsed for every row otherwise.
 */
function attemptLabel(attempts: number): string {
	const count = Number.isFinite(attempts) ? Math.max(0, Math.trunc(attempts)) : 0;
	if (count === 0) return "";
	return `${count} ${count === 1 ? "attempt" : "attempts"}`;
}

/** Shared `<n> req · <n> tok · $<cost>` spend segments for both a member row and the run header. */
function metricSegments(usage: CouncilPaneUsageSnapshot): string[] {
	const parts: string[] = [];
	if (usage.requests !== undefined) parts.push(`${formatNumber(Math.max(0, usage.requests))} req`);
	if (usage.tokens !== undefined) parts.push(`${formatNumber(Math.max(0, usage.tokens))} tok`);
	// Two decimals: these cells are read at a glance, and `$0.0000` reads as broken, not precise.
	if (usage.cost !== undefined) parts.push(formatCost(usage.cost, { maxFractionDigits: 2 }));
	return parts;
}

/**
 * Mirror of the model column's layout ceiling minus its badge brackets, so the model
 * cell can middle-truncate to its final width instead of being re-clipped (and losing
 * the version tail the middle ellipsis exists to preserve) during column layout.
 */
function modelCellWidth(width: number): number {
	const brackets = visibleWidth(theme.format.bracketLeft) + visibleWidth(theme.format.bracketRight);
	return Math.max(4, Math.min(TRUNCATE_LENGTHS.SHORT, Math.max(12, Math.floor(width / 3)) - brackets));
}

/** Keyed on the raw state: the badge text is plain language, its color is not. */
function headerStatusColor(state: CouncilRunState): "accent" | "warning" | "success" | "error" {
	switch (state) {
		case "failed":
		case "interrupted":
			return "error";
		case "cancelling":
		case "completed-degraded":
			return "warning";
		case "completed":
			return "success";
		case "dispatching":
		case "planning":
		case "reviewing":
		case "awaiting-main":
		case "adjudicating":
		case "round-transition":
		case "publishing":
			return "accent";
	}
}

/**
 * Fixed-position, bounded Council run HUD. It never owns transcript children;
 * terminal snapshots therefore collapse to a truly blank footprint.
 */
export class CouncilPaneComponent extends AnchoredLiveContainer {
	readonly #tui: CouncilPaneRenderHost;
	readonly #getTerminalRows: () => number;
	readonly #getEditorMaxHeight: () => number;
	readonly #now: () => number;
	#snapshot: CouncilPaneSnapshot | undefined;
	#expanded = false;
	#nowMs: number;
	#topologyKey = "inactive";
	#scrollView: ScrollView | undefined;

	constructor(options: CouncilPaneOptions) {
		super();
		this.#tui = options.tui;
		this.#getTerminalRows = options.getTerminalRows ?? (() => process.stdout.rows ?? 24);
		this.#getEditorMaxHeight = options.getEditorMaxHeight ?? (() => 6);
		this.#now = options.now ?? Date.now;
		this.#nowMs = this.#now();
	}

	get snapshot(): CouncilPaneSnapshot | undefined {
		return this.#snapshot;
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	isActive(): boolean {
		return this.#snapshot !== undefined && !this.#snapshot.terminal;
	}

	update(snapshot: CouncilPaneSnapshot | undefined): void {
		const previousActive = this.isActive();
		const next = snapshot && !snapshot.terminal ? snapshot : undefined;
		const nextTopology = next ? this.#snapshotTopology(next) : "inactive";
		if (this.#snapshot === next && this.#topologyKey === nextTopology) return;
		this.#snapshot = next;
		this.#nowMs = this.#now();
		const nextActive = this.isActive();
		const topologyChanged = this.#topologyKey !== nextTopology;
		this.#topologyKey = nextTopology;
		if (previousActive !== nextActive || topologyChanged) {
			this.#tui.requestRender();
		} else if (nextActive) {
			this.#tui.requestComponentRender(this);
		}
	}

	/** Elapsed-time repaint that deliberately preserves root geometry. */
	tick(now = this.#now()): void {
		if (!this.isActive()) return;
		this.#nowMs = now;
		this.#tui.requestComponentRender(this);
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded === expanded) return;
		this.#expanded = expanded;
		if (this.#snapshot) this.#topologyKey = this.#snapshotTopology(this.#snapshot);
		this.#scrollView = undefined;
		if (this.isActive()) this.#tui.requestRender();
	}

	toggleExpanded(): boolean {
		this.setExpanded(!this.#expanded);
		return this.#expanded;
	}

	/**
	 * Page keys are Council-owned only while its expanded viewport can actually
	 * scroll, so a non-scrolling pane never swallows them. Shift+Arrow is the
	 * default second binding for `app.message.dequeue`, so it is consumed only when
	 * the offset really moves: at either extreme the key falls through to dequeue.
	 */
	handleInput(data: string): boolean {
		if (!this.isActive() || !this.#expanded) return false;
		const scrollView = this.#scrollView;
		if (!scrollView || scrollView.getMaxScrollOffset() === 0) return false;
		const paging = matchesKey(data, "pageUp") || matchesKey(data, "pageDown");
		if (!paging && !matchesKey(data, "shift+up") && !matchesKey(data, "shift+down")) return false;
		const before = scrollView.getScrollOffset();
		if (!scrollView.handleScrollKey(data)) return false;
		if (!paging && scrollView.getScrollOffset() === before) return false;
		this.#tui.requestComponentRender(this);
		return true;
	}

	override render(width: number): readonly string[] {
		const snapshot = this.#snapshot;
		if (!snapshot || snapshot.terminal) return [];
		const frameWidth = Math.max(1, Math.trunc(width));
		// Compose at the frame's *inner* width: #wrapFrame spends two columns on its
		// borders, so composing at the full width had every line clipped by two cells
		// after layout had already committed to them.
		const contentWidth = frameWidth >= 3 ? frameWidth - 2 : frameWidth;
		// Monotonic clock on purpose: #nowMs is wall-clock for elapsed math, and mixing
		// the two epochs would leave this spinner permanently out of phase with every
		// other one on screen.
		const spinnerFrame = sharedSpinnerFrame(theme.spinnerFrames.length, performance.now());
		const view = this.#cancellationView(snapshot);
		// One retry anywhere earns the column for the whole table; a roster that never retried
		// spends no width saying "1 attempt" five times over.
		const showAttempts = view.some(row => row.attempts > 1);
		const rendered = view.map(row => this.#renderRow(row, contentWidth, spinnerFrame, showAttempts));
		const rows = this.#layoutRows(rendered, contentWidth);
		const warnings = this.#expanded ? this.#warningLines(snapshot, contentWidth) : [];
		const bodyLimit = this.#bodyHeight(rows, warnings.length);
		const body = this.#expanded
			? this.#renderExpandedBody(rows, warnings, bodyLimit, contentWidth)
			: this.#renderCompactBody(rows, bodyLimit, contentWidth);
		const content = [this.#renderHeader(snapshot, contentWidth), ...body];
		return this.#wrapFrame(content, frameWidth);
	}

	/**
	 * While a run is cancelling, every child that has not settled is already being torn
	 * down; leaving it queued or running hides the cancellation propagating.
	 */
	#cancellationView(snapshot: CouncilPaneSnapshot): readonly CouncilPaneRowSnapshot[] {
		if (snapshot.state !== "cancelling") return snapshot.rows;
		return snapshot.rows.map((row): CouncilPaneRowSnapshot => {
			if (row.status === "succeeded" || row.status === "failed" || row.status === "interrupted") return row;
			return { ...row, status: "interrupted" };
		});
	}

	/**
	 * Draw a rounded outline around the run's HUD so it reads as a bounded
	 * status strip separated from the transcript and editor. Side borders hug
	 * every content line; top and bottom close the frame. The frame is dropped
	 * when the terminal is too narrow to draw the three horizontal glyphs and
	 * two side borders without overflowing (mirroring {@link Box}'s own
	 * border-clipping), so a bordered pane never overflows its given width.
	 */
	#wrapFrame(content: readonly string[], width: number): string[] {
		if (width < 3) return [...content];
		const box = theme.boxRound;
		const paint = (text: string) => theme.fg("borderMuted", text);
		const innerWidth = Math.max(0, width - 2);
		const horizontal = box.horizontal.repeat(innerWidth);
		const frame = [
			paint(`${box.topLeft}${horizontal}${box.topRight}`),
			...content.map(
				line =>
					`${paint(box.vertical)}${padToWidth(truncateToWidth(line, innerWidth), innerWidth)}${paint(box.vertical)}`,
			),
			paint(`${box.bottomLeft}${horizontal}${box.bottomRight}`),
		];
		return frame;
	}

	/**
	 * Column widths are per-column maxima clamped by width-derived ceilings, so
	 * badges line up across rows of differing label/model width. Recomputed every
	 * frame and never cached, so a resize lays out cleanly from scratch.
	 */
	#layoutRows(rendered: readonly RenderedCouncilRow[], width: number): CouncilBodyRow[] {
		// One ceiling per cell of #renderRow: label, model, effort, rounds, attempts, spend.
		const ceilings = [
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
				rendered.reduce((max, row) => Math.max(max, visibleWidth(row.cells[column] ?? "")), 0),
			),
		);
		// Drop *every* zero-width column, not just trailing ones: a suppressed interior
		// column (an attempt count of zero) would otherwise contribute an empty cell and
		// a stray separator space to the joined row.
		const columns: { column: number; columnWidth: number }[] = [];
		widths.forEach((columnWidth, column) => {
			if (columnWidth > 0) columns.push({ column, columnWidth });
		});
		return rendered.map(row => {
			const cells = columns.map(({ column, columnWidth }, index) => {
				const cell = row.cells[column] ?? "";
				const bounded = visibleWidth(cell) > columnWidth ? truncateToWidth(cell, columnWidth) : cell;
				return index === columns.length - 1 ? bounded : padToWidth(bounded, columnWidth);
			});
			return {
				content: truncateToWidth(cells.join(" "), Math.max(1, width - 3)),
				details: row.details,
				errorCount: row.errorCount,
				finished: row.finished,
			};
		});
	}

	/** Warnings live in the expanded body; the collapsed header stays jargon-free. */
	#warningLines(snapshot: CouncilPaneSnapshot, width: number): string[] {
		const warnings = snapshot.warnings ?? [];
		if (warnings.length === 0) return [];
		const heading = `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`;
		const lines = [truncateToWidth(` ${theme.fg("dim", heading)}`, width)];
		for (const warning of warnings) {
			const text = sanitizedLine(warning, Math.min(TRUNCATE_LENGTHS.CONTENT, Math.max(1, width - 3)));
			if (text) lines.push(truncateToWidth(`   ${theme.fg("dim", text)}`, width));
		}
		return lines;
	}

	/**
	 * Segments are budgeted by priority, not by join order: the run label, its state
	 * badge and the usage totals are unconditional, the plan path takes whatever width
	 * is left over, and the middle segments drop cheapest-first. A narrow terminal
	 * therefore loses the path, then the elapsed clock, then the warning count, then
	 * the round — never the usage totals off the right edge.
	 */
	#renderHeader(snapshot: CouncilPaneSnapshot, width: number): string {
		const separatorWidth = visibleWidth(theme.sep.dot);
		const required = [
			theme.bold(theme.fg("accent", "Council")),
			formatBadge(councilStateBadgeLabel(snapshot.state), headerStatusColor(snapshot.state), theme),
		];
		// Display order, not drop order: the clock leads the round so the run's age is the
		// first number read, while the round still outranks it when width runs short.
		const optional: { text: string; priority: number; keep: boolean }[] = [];
		if (snapshot.startedAt) {
			const startedAt = Date.parse(snapshot.startedAt);
			if (Number.isFinite(startedAt))
				optional.push({
					text: theme.fg("dim", formatElapsedClock(this.#nowMs - startedAt)),
					priority: 1,
					keep: false,
				});
		}
		optional.push({
			text: theme.fg("dim", `R${Math.max(0, snapshot.round)}/${Math.max(1, snapshot.totalRounds)}`),
			priority: 4,
			keep: false,
		});
		const warnings = snapshot.warnings ?? [];
		// Collapsed mode has no warning body, so the count has to ride in the header.
		if (!this.#expanded && warnings.length > 0) {
			const label = `+${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`;
			optional.push({ text: theme.fg("warning", label), priority: 2, keep: false });
		}
		const trailing: string[] = [];
		if (snapshot.usage) {
			const usage = metricSegments(snapshot.usage);
			if (usage.length > 0) trailing.push(theme.fg("dim", usage.join(theme.sep.dot)));
		}
		// Fix the unconditional cost first, then fill the middle greedily by priority and
		// restore display order; whatever survives leaves its remainder to the path.
		let used =
			[...required, ...trailing].reduce((total, segment) => total + visibleWidth(segment), 0) +
			Math.max(0, required.length + trailing.length - 1) * separatorWidth;
		for (const item of [...optional].sort((left, right) => right.priority - left.priority)) {
			const next = used + visibleWidth(item.text) + separatorWidth;
			if (next > width) continue;
			used = next;
			item.keep = true;
		}
		const middle = optional.filter(item => item.keep).map(item => item.text);
		const fixed = [...required, ...middle, ...trailing];
		const pathWidth = Math.max(0, width - used - separatorWidth);
		const shortenedOutput = shortenPath(sanitizeText(snapshot.outputPath));
		const displayOutput =
			visibleWidth(shortenedOutput) > pathWidth ? path.basename(shortenedOutput) : shortenedOutput;
		// A path clipped below this reads as a bare ellipsis, which is noise rather than a
		// shorter path, so the segment is dropped outright instead.
		const output = pathWidth >= COUNCIL_HEADER_MIN_PATH_WIDTH ? sanitizedLine(displayOutput, pathWidth) : "";
		const segments = output ? [...required, ...middle, theme.fg("statusLinePath", output), ...trailing] : fixed;
		return truncateToWidth(segments.join(theme.sep.dot), width);
	}

	#renderRow(
		row: CouncilPaneRowSnapshot,
		width: number,
		spinnerFrame: number,
		showAttempts: boolean,
	): RenderedCouncilRow {
		const cellWidth = Math.max(1, width - 3);
		const detailWidth = Math.max(1, width - 4);
		const label =
			sanitizedLine(row.label, Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(cellWidth / 5)))) || "member";
		// Middle ellipsis: a model's provider prefix *and* its version tail identify it, so a
		// trailing clip ("anthropic/claude-sonnet…") loses the half that disambiguates.
		// The advisor marker is budgeted before truncating so it cannot be the byte that gets clipped.
		const marker = row.advisor === true ? ADVISOR_MARKER : "";
		const model = truncateMiddleToWidth(
			sanitizedLine(row.model, TRUNCATE_LENGTHS.LINE) || "unknown model",
			Math.max(4, modelCellWidth(width) - marker.length),
		);
		const effort =
			sanitizedLine(
				row.effort ?? "default",
				Math.min(TRUNCATE_LENGTHS.TITLE, Math.max(4, Math.floor(cellWidth / 10))),
			) || "default";
		const attempts = showAttempts ? attemptLabel(row.attempts) : "";
		const metrics = metricSegments(row);
		// No status word: `statusIcon` is a distinct glyph per status in every symbol theme, so the
		// badge only repeated it at the cost of a column.
		// A round badge only earns its column when the roster is actually split, so a single-round run
		// (or a reviewer serving every round) renders exactly as before.
		const roundBadge = row.rounds && row.rounds.length > 0 ? `R${row.rounds.join(",")}` : "";
		const cells = [
			`${statusIcon(row.status, spinnerFrame)} ${theme.bold(theme.fg("accent", label))}`,
			formatBadge(`${model}${marker}`, "muted", theme),
			formatBadge(effort, "muted", theme),
			roundBadge ? theme.fg("dim", roundBadge) : "",
			attempts ? theme.fg("dim", attempts) : "",
			metrics.length > 0 ? theme.fg("dim", metrics.join(theme.sep.dot)) : "",
		];

		// Failure reasons lead the detail list, so the first line spare budget buys is why
		// a row went red.
		const details: string[] = [];
		let errorCount = 0;
		if (row.error) {
			const error = sanitizedLine(row.error, Math.min(TRUNCATE_LENGTHS.CONTENT, detailWidth));
			details.push(theme.fg("error", `error: ${error}`));
			errorCount++;
		}
		if (row.currentTool) {
			const args = row.currentToolArgs;
			let detail = `tool ${sanitizedLine(row.currentTool, TRUNCATE_LENGTHS.SHORT)}`;
			if (args !== undefined) detail += ` ${sanitizedLine(args, Math.min(TRUNCATE_LENGTHS.CONTENT, detailWidth))}`;
			details.push(theme.fg("toolOutput", detail));
		}
		if (row.lastIntent) {
			const intent = sanitizedLine(row.lastIntent, Math.min(TRUNCATE_LENGTHS.CONTENT, detailWidth));
			if (intent) details.push(theme.fg("muted", intent));
		}
		const outputLimit = this.#expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED;
		for (const output of (row.recentOutput ?? []).slice(-outputLimit)) {
			const line = sanitizedLine(output, Math.min(TRUNCATE_LENGTHS.LINE, detailWidth));
			if (line) details.push(theme.fg("toolOutput", line));
		}
		return {
			cells,
			details,
			errorCount,
			finished: row.status === "succeeded" || row.status === "failed" || row.status === "interrupted",
		};
	}

	/**
	 * Connectors are composed here rather than baked into layout, so the compact window
	 * can reorder rows and still close its tree with exactly one `└`.
	 */
	#composeRow(row: CouncilBodyRow, last: boolean, details: readonly string[], width: number): string[] {
		const lines = [truncateToWidth(` ${theme.fg("dim", last ? "└" : "├")} ${row.content}`, width)];
		const prefix = ` ${theme.fg("dim", last ? " " : "│")}  `;
		for (const detail of details) lines.push(truncateToWidth(`${prefix}${detail}`, width));
		return lines;
	}

	/**
	 * The one reserved hint row. It is always rendered, so the pane can never drop rows
	 * or details without saying so and the expand/cancel keys never scroll out of view.
	 */
	#footerLine(width: number, hiddenRows: number, hiddenDetails: number, scrollable: boolean): string {
		const segments: string[] = [];
		if (hiddenRows > 0) segments.push(`… ${hiddenRows} more`);
		if (this.#expanded) {
			segments.push(`${expandKeyHint()} collapse`);
			if (scrollable) segments.push("PgUp/PgDn, Shift+Up/Down scroll");
		} else if (hiddenDetails > 0) {
			segments.push(
				`${expandKeyHint()} expand (${hiddenDetails} hidden ${hiddenDetails === 1 ? "detail" : "details"})`,
			);
		} else {
			segments.push(`${expandKeyHint()} expand`);
		}
		segments.push("Esc cancel");
		return theme.fg("dim", truncateToWidth(` ${segments.join(theme.sep.dot)}`, width));
	}

	#renderCompactBody(rows: readonly CouncilBodyRow[], height: number, width: number): string[] {
		if (height <= 0) return [];
		const rowBudget = Math.max(0, height - COUNCIL_FOOTER_ROWS);
		// Unfinished rows win the *window*, but never the *order*: an agent's position in the
		// roster is fixed (Planner, reviewers, Adjudicator) so the eye never has to re-find a row
		// because it finished. Selection is by priority, display strictly by snapshot order.
		const chosen = new Set(
			[...rows.filter(row => !row.finished), ...rows.filter(row => row.finished)].slice(0, rowBudget),
		);
		const visible = rows.filter(row => chosen.has(row));
		const detailTotal = rows.reduce((count, row) => count + row.details.length, 0);
		const selected = new Map<CouncilBodyRow, string[]>();
		let remaining = rowBudget - visible.length;
		let shown = 0;
		const take = (row: CouncilBodyRow, detail: string) => {
			const existing = selected.get(row);
			if (existing) existing.push(detail);
			else selected.set(row, [detail]);
			remaining--;
			shown++;
		};
		for (const row of visible) {
			if (remaining <= 0) break;
			for (const detail of row.details.slice(0, row.errorCount)) {
				if (remaining <= 0) break;
				take(row, detail);
			}
		}
		for (const row of visible) {
			if (remaining <= 0) break;
			for (const detail of row.details.slice(row.errorCount)) {
				if (remaining <= 0) break;
				take(row, detail);
			}
		}
		const last = visible.at(-1);
		const lines = visible.flatMap(row => this.#composeRow(row, row === last, selected.get(row) ?? [], width));
		lines.push(this.#footerLine(width, rows.length - visible.length, detailTotal - shown, false));
		return lines;
	}

	#renderExpandedBody(
		rows: readonly CouncilBodyRow[],
		warnings: readonly string[],
		height: number,
		width: number,
	): readonly string[] {
		if (height <= 0) return [];
		const viewportHeight = Math.max(0, height - COUNCIL_FOOTER_ROWS);
		const last = rows.at(-1);
		const lines = [...rows.flatMap(row => this.#composeRow(row, row === last, row.details, width)), ...warnings];
		if (!this.#scrollView) {
			this.#scrollView = new ScrollView(lines, {
				height: viewportHeight,
				scrollbar: "auto",
				theme: {
					track: text => theme.fg("borderMuted", text),
					thumb: text => theme.fg("accent", text),
				},
			});
		} else {
			this.#scrollView.setLines(lines);
			this.#scrollView.setHeight(viewportHeight);
		}
		const scrollable = this.#scrollView.getMaxScrollOffset() > 0;
		return [...this.#scrollView.render(width), this.#footerLine(width, 0, 0, scrollable)];
	}

	/**
	 * Total body budget **including** the one reserved footer row, which the renderers
	 * subtract. Expanded mode deliberately escapes the editor-height clamp: that clamp
	 * caps out at 18 rows, which would make {@link COUNCIL_EXPANDED_VISIBLE_LIMIT}
	 * unreachable on every terminal. Compact mode keeps the shared subagent ceiling.
	 */
	#bodyHeight(rows: readonly CouncilBodyRow[], extraLines: number): number {
		const rawTerminalRows = this.#getTerminalRows();
		const terminalRows = Number.isFinite(rawTerminalRows) ? Math.max(1, Math.trunc(rawTerminalRows)) : 24;
		const rawEditorMaxHeight = this.#getEditorMaxHeight();
		const editorMaxHeight = Number.isFinite(rawEditorMaxHeight) ? Math.max(1, Math.trunc(rawEditorMaxHeight)) : 6;
		const logicalRows =
			rows.reduce((count, row) => count + 1 + row.details.length, 0) +
			(this.#expanded ? extraLines : 0) +
			COUNCIL_FOOTER_ROWS;
		const terminalRoom = Math.max(0, terminalRows - editorMaxHeight - COUNCIL_TRANSCRIPT_RESERVED_ROWS - 1);
		const modeLimit = this.#expanded
			? COUNCIL_EXPANDED_VISIBLE_LIMIT
			: Math.min(SUBAGENT_HUD_VISIBLE_LIMIT, editorMaxHeight);
		return Math.min(logicalRows, terminalRoom, modeLimit);
	}

	#snapshotTopology(snapshot: CouncilPaneSnapshot): string {
		return [
			this.#expanded ? "expanded" : "compact",
			...snapshot.rows.map(row =>
				[
					row.key,
					row.currentTool === undefined ? 0 : 1,
					row.lastIntent === undefined ? 0 : 1,
					row.error === undefined ? 0 : 1,
					row.recentOutput?.length ?? 0,
				].join(":"),
			),
		].join("|");
	}
}
