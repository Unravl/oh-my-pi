import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { councilRoleLabel } from "../config/model-roles";
import { type CouncilConsultResult, runCouncilConsult } from "../council/consult";
import { formatCouncilKickoff, getCouncilCoordinator } from "../council/coordinator";
import { isCouncilTerminalState } from "../council/state";
import conveneDescription from "../prompts/tools/convene.md" with { type: "text" };
import type { ToolSession } from ".";

const conveneSchema = type({
	action: type('"plan" | "consult"').describe(
		"consult: reviewers answer in parallel. plan: full adjudicated council run",
	),
	task: type("string").describe(
		"The question to put to the reviewers (`consult`) or the planning task (`plan`). State the decision, the constraint, and the files already in play.",
	),
});

export type ConveneToolParams = typeof conveneSchema.infer;

export interface ConveneToolDetails {
	action: ConveneToolParams["action"];
	/** Present for `plan`, which is the only action that mints a durable run. */
	runId?: string;
	state?: string;
	/** Reviewers that answered, of those launched. */
	answered?: number;
	launched?: number;
	warnings?: string[];
	cost?: number;
}

/**
 * Cap on what one action contributes to the caller's context.
 *
 * A consult reply is already bounded by `COUNCIL_CONSULT_ANSWER_CHAR_LIMIT` per reviewer, but an
 * adjudicated plan may be up to `COUNCIL_PLAN_CHAR_LIMIT` (200k) — enough to displace the
 * conversation that asked for it. The plan is durable at its `local://` path either way, so the
 * truncation notice points there rather than silently dropping the tail.
 */
const COUNCIL_TOOL_PLAN_CHAR_LIMIT = 60_000;

function formatUsage(usage: { requests: number; tokens: number; cost: number }): string {
	return `${usage.requests} requests, ${usage.tokens} tokens, $${usage.cost.toFixed(4)}`;
}

function formatConsult(result: CouncilConsultResult): string {
	const answered = result.replies.filter(reply => reply.answer !== undefined);
	const lines = [
		`${answered.length} of ${result.replies.length} council reviewers answered in ${Math.round(result.durationMs / 1000)}s (${formatUsage(result.usage)}).`,
		"Reviewers answered independently and did not see each other's replies; reconcile the disagreement yourself. They are read-only, so nothing below is verified.",
	];
	for (const reply of result.replies) {
		lines.push("", `## ${reply.label} — ${reply.model}`, `Transcript: history://${reply.agentId}`, "");
		lines.push(reply.answer === undefined ? `Did not answer: ${reply.failure}` : sanitizeText(reply.answer));
	}
	if (result.warnings.length > 0) {
		lines.push("", "## Warnings", ...result.warnings.map(warning => `- ${sanitizeText(warning)}`));
	}
	return lines.join("\n");
}

export class ConveneTool implements AgentTool<typeof conveneSchema, ConveneToolDetails> {
	readonly name = "convene";
	readonly approval = "read" as const;
	readonly label = "Council";
	/**
	 * Whether the operator pre-authorized convening. Off, the model owes the user a cost estimate
	 * before spending; on, it decides for itself and reports the spend afterward. Rendered per
	 * session rather than baked in, because this description is the only thing that carries the
	 * authorization to the model.
	 */
	get description(): string {
		return prompt.render(conveneDescription, {
			autonomous: this.session.settings.get("council.autonomous"),
		});
	}
	readonly parameters = conveneSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Ask the configured model council a question, or have it produce an adjudicated plan";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): ConveneTool | null {
		return session.settings.get("council.tool") ? new ConveneTool(session) : null;
	}

	async execute(
		_id: string,
		params: ConveneToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<ConveneToolDetails>,
	): Promise<AgentToolResult<ConveneToolDetails>> {
		const host = this.session.getCouncilHost?.();
		if (!host) {
			throw new Error(
				"The council is unavailable in this session: it needs a live agent session and model registry.",
			);
		}
		if (params.action === "consult") {
			const result = await runCouncilConsult(host, params.task, {
				signal,
				onKickoff: plan => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Consulting ${plan.members.length} council reviewers: ${plan.members
									.map(
										member => `${councilRoleLabel(member.role)}=${member.model.provider}/${member.model.id}`,
									)
									.join(", ")}.`,
							},
						],
						details: { action: "consult", launched: plan.members.length },
					});
				},
			});
			return {
				content: [{ type: "text", text: formatConsult(result) }],
				details: {
					action: "consult",
					answered: result.replies.filter(reply => reply.answer !== undefined).length,
					launched: result.replies.length,
					warnings: result.warnings,
					cost: result.usage.cost,
				},
			};
		}

		// A full run is durable, session-scoped, and singleton: it binds a coordinator to the session,
		// occupies the one-run-per-session slot, and drives the operator's Council pane. A child
		// session owns none of that — its coordinator would be invisible to the pane, its artifacts
		// would be keyed to a session id `/council resume` cannot reach, and a fan-out of subagents
		// could each convene a full roster. Consulting is the affordance children get.
		if ((this.session.taskDepth ?? 0) > 0) {
			throw new Error(
				'`convene` with `action: "plan"` runs only in the main session. Use `action: "consult"` here, or ask the main agent to convene the full council.',
			);
		}
		const coordinator = getCouncilCoordinator(host);
		const manifest = await coordinator.start(params.task, {
			origin: "agent",
			onKickoff: preview => {
				onUpdate?.({
					content: [{ type: "text", text: formatCouncilKickoff(preview) }],
					details: { action: "plan", runId: preview.runId, state: "dispatching" },
				});
			},
		});
		await coordinator.completion;
		const settled = coordinator.snapshot ?? manifest;
		const details: ConveneToolDetails = {
			action: "plan",
			runId: settled.runId,
			state: settled.state,
			answered: settled.rounds.at(-1)?.members.filter(member => member.status === "succeeded").length,
			launched: settled.rounds.at(-1)?.members.length,
			warnings: settled.warnings,
			cost: settled.usage.cost,
		};
		if (!isCouncilTerminalState(settled.state) || settled.state === "interrupted" || settled.state === "failed") {
			const reason = settled.failure?.reason ?? "the run did not complete";
			throw new Error(
				`Council ${settled.runId} ${settled.state}: ${sanitizeText(reason)}. Reviewer transcripts stay reachable through history://<agent-id>.`,
			);
		}
		const plan = await coordinator.finalPlan(settled);
		if (plan === undefined) {
			throw new Error(`Council ${settled.runId} completed without producing a final plan.`);
		}
		const planUrl = `local://${settled.outputPath}`;
		const truncated = plan.length > COUNCIL_TOOL_PLAN_CHAR_LIMIT;
		const body = truncated
			? `${plan.slice(0, COUNCIL_TOOL_PLAN_CHAR_LIMIT)}\n\n[truncated at ${COUNCIL_TOOL_PLAN_CHAR_LIMIT} of ${plan.length} characters — read ${planUrl} for the rest]`
			: plan;
		// Per-reviewer transcripts, not just the adjudicated result. The brief is one model's verdict on
		// the reviewers' findings, and a caller that wants to know what was dispositioned away has to
		// reach the reports themselves — most of all when the adjudicator is the planner that drafted
		// the plan, which is what an unassigned `adjudicator` role produces.
		const transcripts = settled.rounds
			.flatMap(round => round.members)
			.flatMap(member => member.agentIds ?? [])
			.map(agentId => `history://${agentId}`);
		const header = [
			`Council ${settled.runId} ${settled.state} over ${settled.config.rounds} round(s); ${details.answered ?? 0} of ${details.launched ?? 0} reviewers succeeded (${formatUsage(settled.usage)}).`,
			`This brief is yours to judge, not the user's plan: it is at ${planUrl} and was deliberately not submitted for plan review.`,
			...(transcripts.length > 0
				? [
						`Reviewer transcripts: ${transcripts.join(", ")}. Read them before trusting a disposition that rejected a finding you care about.`,
					]
				: []),
			...(settled.warnings.length > 0
				? ["", "Warnings:", ...settled.warnings.map(warning => `- ${sanitizeText(warning)}`)]
				: []),
		].join("\n");
		return {
			content: [{ type: "text", text: `${header}\n\n${sanitizeText(body)}` }],
			details,
		};
	}
}
