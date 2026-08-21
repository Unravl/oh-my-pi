/**
 * Streaming-safe filters for leaked chat-template tool-call and thinking markup.
 *
 * Hosted models sometimes leak raw template markup into visible `content` instead
 * of returning structured events. Tool-call healing delegates to the same
 * dialect scanners used by owned in-band tool calling; this file keeps the
 * provider-facing compatibility wrapper and model/provider gating.
 */

import { isDeepseekModelIdOrName } from "@oh-my-pi/pi-catalog/identity";

import { createInbandScanner } from "../dialect/factory";
import { QwenXmlInbandScanner } from "../dialect/qwen-xml";
import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent, InbandScanner, InbandTool } from "../dialect/types";

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

export type StreamMarkupHealingPattern = "kimi" | "dsml" | "qwen" | "thinking";

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
	/**
	 * Tool schemas for the current request. The XML/DSML tagset carries no type
	 * information on `<parameter>` unless the model emits `string="…"`, so
	 * without the schemas every value that happens to parse as JSON is decoded:
	 * a `write` whose `content` is a JSON document arrives as an object, a
	 * `bash` whose `command` is `42` arrives as a number, and the call fails
	 * argument validation. Declared string-only parameters are read verbatim.
	 */
	readonly tools?: readonly InbandTool[];
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * A {@link ThinkingInbandScanner} always heals leaked reasoning idioms
 * (`<think>`, `<thinking>`, ` ```thinking `, Gemma/Harmony channels, …) out of
 * the visible channel. For Kimi / DeepSeek-DSML the provider tool-call grammar
 * runs first, its cleaned text is piped through the stripped-DSML grammar (DSML
 * only), and whatever survives is piped through that thinking healer — so a
 * model can leak tool-call markup and reasoning in the same stream.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt held-back
 * partial tag buffers.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	/** Provider tool-call grammar (Kimi tokens / DSML envelope); absent for plain text streams. */
	readonly #toolScanner: InbandScanner | undefined;
	/**
	 * Second-stage grammar for DSML envelopes whose `｜DSML｜` special tokens were
	 * stripped upstream, leaving the bare `<tool_calls>` / `<invoke name="…">` /
	 * `<parameter name="…">` skeleton the Anthropic tagset already parses. The
	 * exact-token DSML grammar cannot match those, so they would otherwise reach
	 * the user as visible text and the turn would carry no tool calls at all.
	 */
	readonly #strippedToolScanner: InbandScanner | undefined;
	/** Always-on healer for leaked reasoning idioms in the visible text channel. */
	readonly #thinkingScanner = new ThinkingInbandScanner();
	readonly #completed: HealedToolCall[] = [];

	constructor(options: StreamMarkupHealingOptions) {
		const tools = options.tools;
		this.#pattern = options.pattern;
		this.#toolScanner =
			options.pattern === "kimi"
				? createInbandScanner("kimi", { tools })
				: options.pattern === "dsml"
					? createInbandScanner("xml", { tools, xmlTagset: "dsml" })
					: options.pattern === "qwen"
						? new QwenXmlInbandScanner()
						: undefined;
		this.#strippedToolScanner = options.pattern === "dsml" ? createInbandScanner("xml", { tools }) : undefined;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the caller
	 * needs ordered text/thinking/tool-call events.
	 */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking/tool-call events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		if (!this.#toolScanner) return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
		let events = this.#toolScanner.feed(text);
		if (this.#strippedToolScanner) events = this.#pipeText(events, this.#strippedToolScanner);
		return this.#convertScannerEvents(this.#pipeText(events, this.#thinkingScanner));
	}

	/**
	 * Feed a chunk and return cleaned events, excluding synthesized tool calls.
	 * Used when the upstream chunk also carries structured `tool_calls`, keeping
	 * that structured payload as the single source of truth while preserving
	 * adjacent text and thinking events.
	 */
	feedEventsWithoutCalls(text: string): StreamMarkupHealingEvent[] {
		const events = this.feedEvents(text);
		let out: StreamMarkupHealingEvent[] | undefined;
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!;
			if (event.type === "toolCall") {
				out ??= events.slice(0, i);
			} else if (out) {
				out.push(event);
			}
		}
		return out ?? events;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped by the delegated scanners; unterminated
	 * thinking blocks are emitted as thinking, matching the previous MiniMax parser
	 * behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		let tail: InbandScanEvent[] = this.#toolScanner ? this.#toolScanner.flush() : [];
		if (this.#strippedToolScanner) {
			tail = this.#pipeText(tail, this.#strippedToolScanner);
			tail.push(...this.#strippedToolScanner.flush());
		}
		tail = this.#pipeText(tail, this.#thinkingScanner);
		tail.push(...this.#thinkingScanner.flush());
		return this.#convertScannerEvents(tail);
	}

	/** Flush held-back text only. Reconstructed calls are retained for {@link drainCompleted}. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/**
	 * Re-scan one stage's visible text through the next healer: `text` events are
	 * fed to `scanner`, while everything the upstream stage already resolved
	 * (thinking / tool-call events) passes through in stream order.
	 */
	#pipeText(events: readonly InbandScanEvent[], scanner: InbandScanner): InbandScanEvent[] {
		const out: InbandScanEvent[] = [];
		for (const event of events) {
			if (event.type === "text") out.push(...scanner.feed(event.text));
			else out.push(event);
		}
		return out;
	}

	#convertScannerEvents(events: readonly InbandScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "toolEnd":
					out.push({
						type: "toolCall",
						call: {
							id: generateHealedToolCallId(),
							name: event.name,
							arguments: JSON.stringify(event.arguments),
						},
					});
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "toolStart":
				case "toolArgDelta":
					break;
			}
		}
		return out;
	}
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/** Cheap model/provider gate for Kimi-K2 chat-template token leaks. */
export function modelMayLeakKimiToolCalls(provider: string, modelId: string): boolean {
	if (provider === "kimi-code" || provider === "moonshot") return true;
	return /kimi[-/_.]?k2/i.test(modelId);
}

/**
 * Pick the leaked-markup healer for an OpenAI-compatible / Ollama visible-text
 * stream. Kimi chat-template tokens and DeepSeek DSML envelopes need their
 * dedicated tool-call grammars; every other model uses `"thinking"`. All three
 * patterns run the generic {@link ThinkingInbandScanner}, so leaked reasoning
 * idioms (e.g. a Gemini ` ```thinking ` fence on OpenRouter) are always healed.
 *
 * DSML selection keys off the model id alone rather than a provider allowlist:
 * whether the envelope leaks is decided by the serving stack behind the host,
 * not by the provider id a user configures, and a proxy in front of a leaking
 * upstream carries an arbitrary id (`litellm`, `my-gateway`, …).
 */
export function getStreamMarkupHealingPattern(provider: string, modelId: string): StreamMarkupHealingPattern {
	if (modelMayLeakKimiToolCalls(provider, modelId)) return "kimi";
	if (isDeepseekModelIdOrName(modelId)) return "dsml";
	return "thinking";
}
