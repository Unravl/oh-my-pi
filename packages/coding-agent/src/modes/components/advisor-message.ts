import { type Component, visibleWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AdvisorMessageDetails, AdvisorNote, AdvisorSeverity } from "../../advisor";
import {
	createCachedComponent,
	formatBadge,
	replaceTabs,
	type ToolUIColor,
	truncateMiddleToWidth,
	wrapTextWithAnsi,
} from "../../tools/render-utils";
import { Ellipsis, truncateToWidth } from "../../tui";
import type { Theme } from "../theme/theme";

const COLLAPSED_NOTES = 3;
const NOTE_LINE_WIDTH = 110;

/**
 * Roster names come from project-level `WATCHDOG.yml` (untrusted repo input) and
 * are now promoted into the card title, where `truncateMiddleToWidth` requires
 * plain single-line text.
 */
function sanitizeSourceLabel(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/\s+/g, " ").trim();
}

/** Roster name of a note, or undefined for the implicit "default" advisor. */
function noteName(note: AdvisorNote): string | undefined {
	const name = note.advisor ? sanitizeSourceLabel(note.advisor) : "";
	return name.length > 0 && name !== "default" ? name : undefined;
}

function noteModel(note: AdvisorNote): string | undefined {
	const model = note.model ? sanitizeSourceLabel(note.model) : "";
	return model.length > 0 ? model : undefined;
}

function wrapVarying(text: string, w1: number, w2: number): string[] {
	if (text.length === 0) return [];
	const firstWrap = wrapTextWithAnsi(text, w1);
	if (firstWrap.length <= 1) {
		return firstWrap;
	}
	const firstLine = firstWrap[0];
	const idx = text.indexOf(firstLine);
	if (idx === -1) {
		return wrapTextWithAnsi(text, w2);
	}
	const remainder = text.slice(idx + firstLine.length).trimStart();
	const restWrap = wrapTextWithAnsi(remainder, w2);
	return [firstLine, ...restWrap];
}

function severityColor(severity: AdvisorSeverity | undefined): ToolUIColor {
	switch (severity) {
		case "blocker":
			return "error";
		case "concern":
			return "warning";
		default:
			return "muted";
	}
}

/**
 * Display-only transcript card for advisor notes injected into the primary
 * session. Styled as a distinct voice so notes never blend into thinking
 * output (whose `thinkingText` color equals `toolOutput` in most themes):
 * a bold `customMessageLabel` header tag (skill-card convention), a heavy
 * rail tinted per-note severity, and the note body on the default text color.
 */
export function createAdvisorMessageCard(
	details: AdvisorMessageDetails | undefined,
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const notes = details?.notes ?? [];
	const blockers = notes.filter(note => note.severity === "blocker").length;
	const meta: string[] = [`${notes.length} ${notes.length === 1 ? "note" : "notes"}`];
	if (blockers > 0) meta.push(uiTheme.fg("error", `${blockers} blocker${blockers === 1 ? "" : "s"}`));

	// A source is the (name, model) pair, and an absent half counts: a named note
	// batched with an unlabeled or legacy one is two sources, not one.
	const names = notes.map(noteName);
	const models = notes.map(noteModel);
	const distinctSources = new Set(notes.map((_, i) => `${names[i] ?? ""}\u0000${models[i] ?? ""}`));
	const mixed = distinctSources.size > 1;
	// Mixed cards keep a per-note label because one header cannot always fit every
	// selector. Computed over the whole batch so a hidden note from a second
	// advisor still marks the visible ones; `shown` is a prefix of `notes`.
	const noteLabels = notes.map((_, i) => (mixed ? (names[i] ?? models[i]) : undefined));
	const distinctModels = [...new Set(models.filter((m): m is string => m !== undefined))];
	// Best first; the last entry is the one that gets clipped if nothing fits.
	const sourceCandidates: string[] = mixed
		? [distinctModels.join(uiTheme.sep.dot), `${distinctSources.size} advisors`].filter(c => c.length > 0)
		: [names[0] && models[0] ? `${names[0]}${uiTheme.sep.dot}${models[0]}` : "", models[0] ?? names[0] ?? ""].filter(
				c => c.length > 0,
			);

	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const tag = uiTheme.fg("customMessageLabel", uiTheme.bold(`${uiTheme.status.info} Advisor`));
			const metaText = meta.join(uiTheme.sep.dot);
			// `tag SPACE source [dot meta]`. Reserve the model before the roster name
			// and before `meta`, so the final per-line truncate can never undo it.
			const budgetWithMeta = width - visibleWidth(tag) - 1 - visibleWidth(metaText) - visibleWidth(uiTheme.sep.dot);
			const budgetWithoutMeta = width - visibleWidth(tag) - 1;
			let source = sourceCandidates.find(c => visibleWidth(c) <= budgetWithMeta) ?? "";
			let showMeta = true;
			if (source.length === 0 && sourceCandidates.length > 0) {
				showMeta = false;
				source =
					sourceCandidates.find(c => visibleWidth(c) <= budgetWithoutMeta) ??
					truncateMiddleToWidth(sourceCandidates[sourceCandidates.length - 1], Math.max(0, budgetWithoutMeta));
			}
			const head = source.length > 0 ? `${tag} ${uiTheme.fg("muted", source)}` : tag;
			const tail =
				showMeta && metaText.length > 0
					? `${source.length > 0 ? uiTheme.fg("dim", uiTheme.sep.dot) : " "}${uiTheme.fg("dim", metaText)}`
					: "";
			const lines = [`${head}${tail}`];
			const railGlyph = uiTheme.symbol("advisor.rail");
			const shown = expanded ? notes : notes.slice(0, COLLAPSED_NOTES);
			shown.forEach((entry, noteIndex) => {
				const badge = entry.severity
					? `${formatBadge(entry.severity, severityColor(entry.severity), uiTheme)} `
					: "";
				// Homogeneous cards attribute in the title instead; only a mixed batch
				// needs per-note labels to tell its sources apart.
				const label = noteLabels[noteIndex];
				const who = label ? `${uiTheme.fg("dim", `[${label}]`)} ` : "";
				const rail = uiTheme.fg(severityColor(entry.severity), railGlyph);
				const quoteWidth = visibleWidth(`  ${railGlyph} `);
				const badgeWidth = visibleWidth(badge);
				const whoWidth = visibleWidth(who);
				const w1 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth - badgeWidth - whoWidth);
				const w2 = Math.max(10, Math.min(NOTE_LINE_WIDTH, width) - quoteWidth);

				const paragraphs = entry.note.split("\n").filter(p => p.trim());
				const bodyLines: string[] = [];
				for (let i = 0; i < paragraphs.length; i++) {
					const p = paragraphs[i];
					if (i === 0) {
						bodyLines.push(...wrapVarying(p, w1, w2));
					} else {
						bodyLines.push(...wrapTextWithAnsi(p, w2));
					}
				}

				bodyLines.forEach((line, index) => {
					const prefix = index === 0 ? `${badge}${who}` : "";
					lines.push(`  ${rail} ${prefix}${uiTheme.fg("customMessageText", replaceTabs(line))}`);
				});
			});
			const hidden = notes.length - shown.length;
			if (hidden > 0) {
				const rail = uiTheme.fg("dim", railGlyph);
				lines.push(`  ${rail} ${uiTheme.fg("dim", `… +${hidden} more ${hidden === 1 ? "note" : "notes"}`)}`);
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}
