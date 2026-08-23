import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { councilRoleLabel } from "../../config/model-roles";
import type { CouncilCoordinatorSnapshot, CouncilSoloChild } from "../../council/coordinator";
import type { SessionManager } from "../../session/session-manager";
import { type SubagentEventPayload, TASK_SUBAGENT_EVENT_CHANNEL } from "../../task";
import type { EventBus } from "../../utils/event-bus";
import type { AssistantMessageComponent } from "../components/assistant-message";
import { createCouncilTranscriptHeaderCard } from "../components/council-transcript-message";
import { ToolExecutionComponent } from "../components/tool-execution";
import {
	type AssistantMessageComponentContext,
	createAssistantMessageComponent,
} from "../utils/interactive-context-helpers";
import { assistantHasVisibleContent, splitAssistantMessageToolTimeline } from "../utils/transcript-render-helpers";

type MirroredAssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Coalescing window for the child's cumulative `message_update` snapshots, matching
 * `EventController`'s: the mirrored turn rebuilds at most ~30 times a second instead of
 * once per token, which is all the TUI can paint anyway.
 */
const MIRROR_UPDATE_COALESCE_MS = 33;

/** Segment key of the assistant text that precedes a turn's first tool call. */
const LEAD_SEGMENT = "";

export interface CouncilTranscriptMirrorContext extends AssistantMessageComponentContext {
	eventBus?: EventBus;
	readonly sessionManager: SessionManager;
	/** Container the mirrored blocks mount into. */
	readonly chatContainer: unknown;
	present(content: Component | readonly Component[]): void;
}

interface MirrorPhase {
	child: CouncilSoloChild;
	/** Compact display name: `Planner`, `Adjudicator`, else the reviewer's stable label. */
	label: string;
	model: string;
	headerShown: boolean;
	/**
	 * Assistant cards of the turn currently streaming, keyed by the tool call they follow
	 * ({@link LEAD_SEGMENT} for the text before the first one). Cleared per message.
	 */
	segments: Map<string, AssistantMessageComponent>;
	/** Every tool card of the phase, so a result still finds its block after the turn ended. */
	tools: Map<string, ToolExecutionComponent>;
}

/**
 * Live-mirror one Council child's turns into the main transcript, rendered exactly as Main's
 * own turns are: assistant text and thinking through {@link AssistantMessageComponent}, every
 * tool call through {@link ToolExecutionComponent} with its real renderer, updated in place
 * when the result lands. Only the one header card names the child, so no row pays for a label.
 *
 * Scope is deliberately narrow. Only a child that is alone in its phase is mirrored — the planner
 * always, a review round only when exactly one roster member is enabled — because interleaving
 * several concurrent reviewers into one linear transcript is unreadable; parallel rounds stay in the
 * HUD. Filtering is by the coordinator's pre-allocated agent id, which is the only identity available
 * before the child's first progress tick, and which by construction excludes concurrent reviewers,
 * unrelated task/eval subagents sharing the bus, and Main (whose turn never traverses this channel).
 *
 * Mirroring is **live-only**: `present()` mounts into the current chat container and writes no session
 * entry, so these blocks do not survive a transcript rebuild, a focus switch, or a restart — and do
 * not enter Main's future model context. The durable record is the child's own transcript, which is
 * why the header card names `history://<agentId>`.
 */
export class CouncilTranscriptMirror {
	readonly #ctx: CouncilTranscriptMirrorContext;
	#unsubscribe: (() => void) | undefined;
	#phase: MirrorPhase | undefined;
	#pendingUpdate: MirroredAssistantMessage | undefined;
	#updateTimer: NodeJS.Timeout | undefined;

	constructor(ctx: CouncilTranscriptMirrorContext) {
		this.#ctx = ctx;
	}

	/** Re-read the setting and re-target on every snapshot; the coordinator owns phase transitions. */
	sync(snapshot: CouncilCoordinatorSnapshot): void {
		const child = snapshot.soloChild;
		if (!child || this.#ctx.settings.get("council.mirrorTranscript") !== true) {
			this.#endPhase();
			return;
		}
		if (this.#phase?.child.agentId !== child.agentId) {
			this.#endPhase();
			this.#phase = {
				child,
				...this.#describe(snapshot, child),
				headerShown: false,
				segments: new Map(),
				tools: new Map(),
			};
		}
		this.#subscribe();
	}

	dispose(): void {
		this.#endPhase();
	}

	/**
	 * The transcript these blocks were mounted into was cleared (`/clear`, a compaction rebuild).
	 * Settle and forget them — a detached tool card would otherwise keep its spinner ticking for
	 * the rest of the phase — and re-open the phase, header included, on the child's next event.
	 */
	resetTranscript(): void {
		this.#discardPendingUpdate();
		const phase = this.#phase;
		if (!phase) return;
		this.#settleBlocks(phase);
		phase.segments.clear();
		phase.tools.clear();
		phase.headerShown = false;
	}

	#endPhase(): void {
		this.#discardPendingUpdate();
		const phase = this.#phase;
		this.#phase = undefined;
		if (phase) this.#settleBlocks(phase);
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/**
	 * Freeze every block of a phase as final history. A child abandoned mid-tool (cancelled run,
	 * failed attempt) leaves a spinning card and an unfinalized assistant block, both of which pin
	 * the transcript's repaintable region and keep its rows out of native scrollback.
	 */
	#settleBlocks(phase: MirrorPhase): void {
		for (const tool of phase.tools.values()) tool.seal();
		for (const segment of phase.segments.values()) segment.markTranscriptBlockFinalized();
	}

	#subscribe(): void {
		if (this.#unsubscribe || !this.#ctx.eventBus) return;
		this.#unsubscribe = this.#ctx.eventBus.on(TASK_SUBAGENT_EVENT_CHANNEL, payload => {
			this.#safely(() => this.#dispatch(payload as SubagentEventPayload));
		});
	}

	/** Compact display name and resolved model: the round record's, else the pinned roster entry's. */
	#describe(snapshot: CouncilCoordinatorSnapshot, child: CouncilSoloChild): { label: string; model: string } {
		if (child.kind === "planner") {
			return { label: "Planner", model: snapshot.manifest.planner.resolvedModel };
		}
		// A delegated adjudicator is reserved under out-of-band coordinates that match no round record,
		// so the roster lookup below would resolve it to "unknown model" on a `review round 0` card.
		if (child.kind === "adjudicator") {
			return { label: "Adjudicator", model: snapshot.manifest.adjudicator.resolvedModel };
		}
		const record = snapshot.manifest.rounds[child.round - 1]?.members.find(member => member.order === child.order);
		const roster = snapshot.manifest.roster.find(member => member.order === child.order);
		const role = record?.role ?? roster?.role;
		return {
			label: role === undefined ? child.label : councilRoleLabel(role),
			model: record?.resolvedModel ?? roster?.resolvedModel ?? "unknown model",
		};
	}

	#dispatch(payload: SubagentEventPayload): void {
		const phase = this.#phase;
		// The single load-bearing filter: one id, allocated before launch.
		if (!phase || payload.id !== phase.child.agentId) return;
		const event = payload.event;
		if (event.type === "message_update") {
			if (event.message.role === "assistant") this.#queueUpdate(event.message);
			return;
		}
		// Every other event either reacts to the latest streamed snapshot or must render below it,
		// so the coalesced snapshot lands first.
		this.#flushPendingUpdate();
		switch (event.type) {
			case "message_start":
				// A new turn owns fresh assistant cards; the previous turn's are settled history that
				// must never be overwritten (a turn that errors out never reaches `message_end`).
				if (event.message.role === "assistant") phase.segments.clear();
				return;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.#applyAssistantMessage(phase, event.message, true);
				phase.segments.clear();
				return;
			case "tool_execution_start": {
				// The args here are the authoritative validated ones; a streamed card may still show a
				// mid-reveal prefix, and a provider that never streamed the block has no card at all.
				const card =
					phase.tools.get(event.toolCallId) ??
					this.#createToolCard(phase, event.toolName, event.args, event.toolCallId);
				card.updateArgs(event.args, event.toolCallId);
				card.setArgsComplete(event.toolCallId);
				this.#ctx.ui.requestRender();
				return;
			}
			case "tool_execution_update": {
				const card = phase.tools.get(event.toolCallId);
				if (!card) return;
				card.updateResult(event.partialResult, true, event.toolCallId);
				this.#ctx.ui.requestRender();
				return;
			}
			case "tool_execution_end": {
				const card = phase.tools.get(event.toolCallId);
				if (!card) return;
				card.updateResult({ ...event.result, isError: event.isError }, false, event.toolCallId);
				this.#ctx.ui.requestRender();
				return;
			}
			default:
				return;
		}
	}

	/**
	 * Reconcile one assistant snapshot into the transcript. Content blocks stream in order and the
	 * map keys mirror that order, so appending each card the first time its block appears reproduces
	 * the turn's shape — text, tool call, post-tool text — without inserting between mounted blocks.
	 */
	#applyAssistantMessage(phase: MirrorPhase, message: MirroredAssistantMessage, final: boolean): void {
		const timeline = splitAssistantMessageToolTimeline(message);
		// Only the trailing segment can still grow; everything above it is complete, and finalizing it
		// lets the transcript's commit-safe run extend past it into the live tool blocks below.
		let trailingSegment = LEAD_SEGMENT;
		for (const content of message.content) {
			if (content.type === "toolCall") trailingSegment = content.id;
		}

		this.#upsertSegment(phase, LEAD_SEGMENT, timeline.beforeTools, final || trailingSegment !== LEAD_SEGMENT);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const card = phase.tools.get(content.id);
			if (card) card.updateArgs(content.arguments, content.id);
			else this.#createToolCard(phase, content.name, content.arguments, content.id);
			this.#upsertSegment(
				phase,
				content.id,
				timeline.afterToolCalls.get(content.id),
				final || trailingSegment !== content.id,
			);
		}
		this.#ctx.ui.requestRender();
	}

	#upsertSegment(
		phase: MirrorPhase,
		key: string,
		segment: MirroredAssistantMessage | undefined,
		final: boolean,
	): void {
		// Deferred until there is something to show: a turn that opens with a tool call, or whose
		// first deltas are whitespace, must not mount an empty card above it.
		if (!segment || !assistantHasVisibleContent(segment)) return;
		let component = phase.segments.get(key);
		if (!component) {
			component = createAssistantMessageComponent(this.#ctx);
			phase.segments.set(key, component);
			this.#mount(phase, component);
		}
		component.updateContent(segment, { transient: !final });
		if (final) component.markTranscriptBlockFinalized();
	}

	#createToolCard(phase: MirrorPhase, toolName: string, args: unknown, toolCallId: string): ToolExecutionComponent {
		const settings = this.#ctx.settings;
		const component = new ToolExecutionComponent(
			toolName,
			args,
			{
				// No snapshot store or edit clipboard: those are Main's session registers, and the
				// council roster is read-only, so nothing here renders a hashline edit preview.
				showImages: settings.get("terminal.showImages"),
				editFuzzyThreshold: settings.get("edit.fuzzyThreshold"),
				editAllowFuzzy: settings.get("edit.fuzzyMatch"),
			},
			this.#ctx.viewSession.getToolByName(toolName),
			this.#ctx.ui,
			this.#ctx.sessionManager.getCwd(),
			toolCallId,
		);
		component.setExpanded(this.#ctx.toolOutputExpanded);
		component.setToolActivityVisible(!this.#ctx.hideToolActivity);
		phase.tools.set(toolCallId, component);
		this.#mount(phase, component);
		return component;
	}

	/** Mount a mirrored block, opening the phase with its header card on the first one. */
	#mount(phase: MirrorPhase, component: Component): void {
		if (!phase.headerShown) {
			phase.headerShown = true;
			this.#ctx.present(
				createCouncilTranscriptHeaderCard({
					label: phase.label,
					model: phase.model,
					phase:
						phase.child.kind === "planner"
							? "planning"
							: phase.child.kind === "adjudicator"
								? `adjudicating round ${phase.child.round}`
								: `review round ${phase.child.round}`,
					agentId: phase.child.agentId,
				}),
			);
		}
		this.#ctx.present(component);
	}

	#queueUpdate(message: MirroredAssistantMessage): void {
		this.#pendingUpdate = message;
		if (this.#updateTimer) return;
		this.#updateTimer = setTimeout(() => {
			this.#updateTimer = undefined;
			this.#safely(() => this.#flushPendingUpdate());
		}, MIRROR_UPDATE_COALESCE_MS);
	}

	#flushPendingUpdate(): void {
		const message = this.#pendingUpdate;
		const phase = this.#phase;
		this.#discardPendingUpdate();
		if (message && phase) this.#applyAssistantMessage(phase, message, false);
	}

	/** Drop the coalescing timer and any snapshot still waiting on it. */
	#discardPendingUpdate(): void {
		this.#pendingUpdate = undefined;
		if (!this.#updateTimer) return;
		clearTimeout(this.#updateTimer);
		this.#updateTimer = undefined;
	}

	#safely(run: () => void): void {
		try {
			run();
		} catch (error) {
			logger.warn("Council transcript mirror failed to render a child turn", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
