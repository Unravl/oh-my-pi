import { logger, prompt } from "@oh-my-pi/pi-utils";
import { councilRoleLabel } from "../config/model-roles";
import consultTaskTemplate from "../prompts/council/consult-task.md" with { type: "text" };
import { withSessionSpawnPermit } from "../task";
import {
	reserveStructuredSubagentId,
	runStructuredSubagent,
	type StructuredSubagentResult,
} from "../task/structured-subagent";
import type { AgentProgress } from "../task/types";
import { type CouncilConsultPlan, type CouncilPreflightHost, preflightCouncilConsult } from "./preflight";
import { COUNCIL_CONSULT_ANSWER_CHAR_LIMIT, validateCouncilConsultAnswer } from "./schema";
import type { CouncilUsage } from "./state";
import { councilChildUsage, zeroCouncilUsage } from "./stats";

/** One reviewer's settled consult, successful or not. Ordered by roster position, never by finish time. */
export interface CouncilConsultReply {
	role: string;
	/** Operator-facing roster label (`Reviewer 1`, `Judge 2`). */
	label: string;
	/** `provider/id` the reviewer actually ran on. */
	model: string;
	/** Session-global child agent id, so `history://<agentId>` reaches the full transcript. */
	agentId: string;
	/** Present exactly when the reviewer returned a schema-valid answer. */
	answer?: string;
	/** Present exactly when it did not. */
	failure?: string;
	usage: CouncilUsage;
}

export interface CouncilConsultResult {
	question: string;
	repoRoot: string;
	replies: CouncilConsultReply[];
	/** Preflight advisories plus per-reviewer degradations, in that order. */
	warnings: string[];
	usage: CouncilUsage;
	durationMs: number;
}

export interface CouncilConsultOptions {
	signal?: AbortSignal;
	/**
	 * Fired whenever a reviewer's live progress changes, so a caller can render a running consult.
	 * Reviewers are identified by their roster index, matching {@link CouncilConsultResult.replies}.
	 */
	onProgress?: (index: number, progress: AgentProgress) => void;
	/** Fired once preflight has resolved the roster, before any reviewer is launched or billed. */
	onKickoff?: (plan: CouncilConsultPlan) => void | Promise<void>;
}

/**
 * Ask every active council reviewer one question, in parallel, and collect their prose answers.
 *
 * A consult is the council's review roster without its planning apparatus: no planner drafts
 * anything, no adjudicator reconciles anything, nothing is checkpointed, and nothing is published.
 * That is the whole point — an agent mid-task wants several independent reads on one decision, not a
 * durable multi-round plan it would then have to resume.
 *
 * Consequences of having no manifest, stated so nobody has to rediscover them: a consult is not
 * resumable, does not appear in `/council status`, does not occupy the one-run-per-session slot, and
 * never blocks or is blocked by a `/council` run. Each reviewer's transcript is still durable and
 * reachable through `history://<agentId>`, which is why the ids are reserved before launch.
 *
 * A reviewer that fails does not fail the consult: the remaining answers are worth more than a
 * uniform refusal, and the failure is reported per reviewer and as a warning. A consult with *no*
 * successful answer throws, because an empty result would read as "the council had nothing to say".
 */
export async function runCouncilConsult(
	host: CouncilPreflightHost,
	question: string,
	options: CouncilConsultOptions = {},
): Promise<CouncilConsultResult> {
	const startedAt = Date.now();
	const plan = await preflightCouncilConsult(host, question, { signal: options.signal });
	if (options.onKickoff) await options.onKickoff(plan);
	options.signal?.throwIfAborted();

	const assignment = prompt.render(consultTaskTemplate, {
		question: plan.question,
		repositoryRoot: plan.repoRoot,
		answerCharLimit: COUNCIL_CONSULT_ANSWER_CHAR_LIMIT,
	});

	// Ids are reserved before launch, not learned from progress: the executor emits raw subagent
	// events before it processes progress, and progress is coalesced, so a short reviewer's whole
	// transcript pointer would be missed by anything waiting for a tick.
	const launches = await Promise.all(
		plan.members.map(async (member, index) => {
			const roleLabel = councilRoleLabel(member.role);
			const label = `Council consult ${roleLabel}`;
			const agentId = await reserveStructuredSubagentId(host.toolSession, { label, inspectOnly: true });
			return { member, index, agentId, label, roleLabel, request: plan.requests[index]! };
		}),
	);
	options.signal?.throwIfAborted();

	const settled = await Promise.all(
		launches.map(async ({ member, index, agentId, label, roleLabel, request }) => {
			const model = `${member.model.provider}/${member.model.id}`;
			const base = { role: member.role, label: roleLabel, model, agentId };
			let result: StructuredSubagentResult;
			try {
				result = await withSessionSpawnPermit(host.toolSession, options.signal, () =>
					runStructuredSubagent({
						...request,
						assignment,
						identity: { id: agentId, label, inspectOnly: true },
						index,
						signal: options.signal,
						...(options.onProgress
							? { onProgress: (progress: AgentProgress) => options.onProgress?.(index, progress) }
							: {}),
					}),
				);
			} catch (error) {
				// An abort is the caller's, not this reviewer's, so it propagates instead of degrading
				// into "reviewer 3 declined to answer".
				if (options.signal?.aborted) throw error;
				return {
					...base,
					failure: error instanceof Error ? error.message : String(error),
					usage: zeroCouncilUsage(),
				};
			}
			const usage = councilChildUsage(result);
			const child = result.result;
			// A pinned council child that drifted models is a failed reviewer, never a substituted one:
			// the caller pays for the roster it configured or hears that it did not run.
			if (child.authFallbackUsed) {
				return { ...base, failure: "used an authentication fallback instead of its pinned model", usage };
			}
			if (child.resolvedModel && child.resolvedModel !== model && !child.resolvedModel.startsWith(`${model}:`)) {
				return { ...base, failure: `resolved to ${child.resolvedModel} instead of its pinned ${model}`, usage };
			}
			if (child.exitCode !== 0 || child.error || child.aborted) {
				return {
					...base,
					failure: child.abortReason ?? child.error ?? (child.stderr || "reviewer failed"),
					usage,
				};
			}
			try {
				return { ...base, answer: validateCouncilConsultAnswer(child.structuredOutput?.data).answer, usage };
			} catch (error) {
				logger.debug("council consult: invalid answer payload", {
					role: member.role,
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
				return { ...base, failure: error instanceof Error ? error.message : String(error), usage };
			}
		}),
	);

	const replies: CouncilConsultReply[] = settled;
	const usage = zeroCouncilUsage();
	for (const reply of replies) {
		usage.requests += reply.usage.requests;
		usage.tokens += reply.usage.tokens;
		usage.cost += reply.usage.cost;
	}
	const warnings = [
		...plan.warnings,
		...replies.filter(reply => reply.failure).map(reply => `${reply.label} (${reply.model}): ${reply.failure}`),
	];
	if (replies.every(reply => reply.answer === undefined)) {
		throw new Error(
			`Every council reviewer failed to answer. ${warnings.join(" ")} Transcripts: ${replies
				.map(reply => `history://${reply.agentId}`)
				.join(", ")}`,
		);
	}
	return {
		question: plan.question,
		repoRoot: plan.repoRoot,
		replies,
		warnings,
		usage,
		durationMs: Date.now() - startedAt,
	};
}
