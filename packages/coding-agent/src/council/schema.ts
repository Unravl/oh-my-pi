import { parsePlanSections } from "../modes/components/plan-toc";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/output-schema-validator";
import { COUNCIL_MAX_ACTIVE_REVIEWERS } from "./config";

export const COUNCIL_PLAN_HEADINGS = [
	"Context",
	"Approach",
	"Critical files & anchors",
	"Verification",
	"Assumptions & contingencies",
] as const;

/**
 * Council character budgets, sized from catalog model limits rather than guessed.
 *
 * The binding constraint is the *output* budget of the weakest model a council role
 * can resolve to. The catalog's frontier floor is 64k output tokens (`cursor/*`),
 * against 128k for `anthropic/claude-opus-5` and the `gpt-5.6` family, 131k-1M for
 * Kimi K3, and 393k for DeepSeek V4. At roughly 4 characters per token a 64k-token
 * response holds ~256k characters, and an adjudication response must carry the
 * revised plan *plus* every disposition — so the plan ceiling is 200k characters,
 * leaving ~56k for dispositions and JSON escaping even on the weakest provider.
 *
 * These were previously 60k/40k/80k, which read as if characters were tokens: a 60k
 * plan is ~15k tokens, i.e. 12% of the floor model's output budget and 1.5% of
 * Kimi's. Worse, the three numbers did not compose — a 40k task plus a 60k plan
 * already exceeded the 80k injection cap before a single member report — so a plan
 * that passed the schema could still be unadjudicable.
 */
export const COUNCIL_PLAN_CHAR_LIMIT = 200_000;

/** User task accepted by preflight, before any model is spent. */
export const COUNCIL_TASK_CHAR_LIMIT = 120_000;

/**
 * Bounds what Main is *fed* for adjudication (task + JSON-embedded planner output +
 * as many member reports as fit), not what it writes. ~125k tokens against the
 * 1M-token context windows these models carry.
 */
export const COUNCIL_ADJUDICATION_INJECTION_CAP = 500_000;

/** Worst-case injected chars for everything except member reports. */
const COUNCIL_ADJUDICATION_FIXED_OVERHEAD =
	COUNCIL_TASK_CHAR_LIMIT +
	// `plannerOutput` is JSON.stringify'd into the assignment, so newlines and
	// quotes double. Measured overhead on real plans is ~0.5%; 5% is the margin.
	Math.ceil(COUNCIL_PLAN_CHAR_LIMIT * 1.05) +
	// assumptions + blockers: 8 items x 500 chars each, JSON-escaped.
	2 * 8 * 500 * 2 +
	// prompt templates, repair wrapper, repository root, JSON keys.
	8_000;

/** Reports must keep a usable share of the injected budget, not a rounding error. */
const COUNCIL_MIN_REPORT_BUDGET = 100_000;

// Fires on import, so any council module or test catches a divergence immediately.
// This is the guard that the previous 60k/40k/80k triple lacked.
if (COUNCIL_ADJUDICATION_FIXED_OVERHEAD + COUNCIL_MIN_REPORT_BUDGET > COUNCIL_ADJUDICATION_INJECTION_CAP) {
	throw new Error(
		`Council budgets do not compose: fixed overhead ${COUNCIL_ADJUDICATION_FIXED_OVERHEAD} plus the ` +
			`${COUNCIL_MIN_REPORT_BUDGET}-char minimum report budget exceeds the ` +
			`${COUNCIL_ADJUDICATION_INJECTION_CAP}-char adjudication injection cap`,
	);
}

export const COUNCIL_DISPOSITIONS = [
	"accepted",
	"accepted with modification",
	"rejected",
	"duplicate",
	"unactionable",
] as const;

export type CouncilDisposition = (typeof COUNCIL_DISPOSITIONS)[number];

/**
 * Adjudicator grade for one reviewer's whole contribution, weighted by the severity and quality of
 * what it surfaced rather than by how much it wrote. `F` is deliberately absent: it is derived by the
 * harness for a reviewer that never finished, so there is nothing for the adjudicator to judge.
 */
export const COUNCIL_GRADES = ["S", "A", "B", "C", "D"] as const;

export type CouncilGrade = (typeof COUNCIL_GRADES)[number];

/** Grade for the reviewer occupying `slot` (1-based, matching the injected report chunks). */
export interface CouncilReviewerGrade {
	slot: number;
	grade: CouncilGrade;
	reason: string;
}

export type CouncilReadiness = "ready" | "revise";
export type CouncilFindingClassification = "must-fix" | "improvement" | "question";
export type CouncilFindingSeverity = "critical" | "high" | "medium" | "low";
export type CouncilFindingConfidence = "high" | "medium" | "low";

export interface CouncilEvidence {
	path: string;
	symbol?: string;
	observation: string;
}

export interface IncomingCouncilFinding {
	classification: CouncilFindingClassification;
	severity: CouncilFindingSeverity;
	confidence: CouncilFindingConfidence;
	evidence: CouncilEvidence[];
	impact: string;
	required: boolean;
	recommendation: string;
	rejectedAssumptions: string[];
	verification: string[];
}

export interface CouncilFinding extends IncomingCouncilFinding {
	id: string;
}

export interface IncomingCouncilReport {
	readiness: CouncilReadiness;
	findings: IncomingCouncilFinding[];
	strengths: string[];
	missingContext: string[];
}

export interface CouncilReport extends Omit<IncomingCouncilReport, "findings"> {
	findings: CouncilFinding[];
}

export interface CouncilPlannerOutput {
	plan: string;
	assumptions: string[];
	blockers: string[];
	evidenceVersion: "1.0.0";
}

export interface CouncilFindingAdjudication {
	id: string;
	disposition: CouncilDisposition;
	reason: string;
	step: string;
	duplicateOf?: string;
}

export interface CouncilAdjudication {
	plan: string;
	dispositions: CouncilFindingAdjudication[];
	/**
	 * One grade per reviewer that submitted a report. Optional in the durable shape: a run adjudicated
	 * before grading existed still loads, resumes, and renders — just without ranks.
	 */
	grades?: CouncilReviewerGrade[];
}

const EVIDENCE_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string", minLength: 1, maxLength: 500 },
		symbol: { type: "string", maxLength: 300 },
		observation: { type: "string", minLength: 1, maxLength: 2000 },
	},
	required: ["path", "observation"],
	additionalProperties: false,
} as const;

const INCOMING_FINDING_SCHEMA = {
	type: "object",
	properties: {
		classification: { type: "string", enum: ["must-fix", "improvement", "question"] },
		severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
		confidence: { type: "string", enum: ["high", "medium", "low"] },
		evidence: { type: "array", minItems: 1, maxItems: 12, items: EVIDENCE_SCHEMA },
		impact: { type: "string", minLength: 1, maxLength: 3000 },
		required: { type: "boolean" },
		recommendation: { type: "string", minLength: 1, maxLength: 3000 },
		rejectedAssumptions: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1000 },
		},
		verification: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1000 },
		},
	},
	required: [
		"classification",
		"severity",
		"confidence",
		"evidence",
		"impact",
		"required",
		"recommendation",
		"rejectedAssumptions",
		"verification",
	],
	additionalProperties: false,
} as const;

const PERSISTED_FINDING_SCHEMA = {
	...INCOMING_FINDING_SCHEMA,
	properties: {
		...INCOMING_FINDING_SCHEMA.properties,
		id: { type: "string", minLength: 2, maxLength: 64 },
	},
	required: ["id", ...INCOMING_FINDING_SCHEMA.required],
} as const;

export const COUNCIL_REPORT_SCHEMA = {
	type: "object",
	properties: {
		readiness: { type: "string", enum: ["ready", "revise"] },
		findings: { type: "array", maxItems: 40, items: INCOMING_FINDING_SCHEMA },
		strengths: {
			type: "array",
			maxItems: 5,
			items: { type: "string", maxLength: 1500 },
		},
		missingContext: {
			type: "array",
			maxItems: 8,
			items: { type: "string", maxLength: 1500 },
		},
	},
	required: ["readiness", "findings", "strengths", "missingContext"],
	additionalProperties: false,
} as const;
const PERSISTED_COUNCIL_REPORT_SCHEMA = {
	...COUNCIL_REPORT_SCHEMA,
	properties: {
		...COUNCIL_REPORT_SCHEMA.properties,
		findings: { type: "array", maxItems: 40, items: PERSISTED_FINDING_SCHEMA },
	},
} as const;

export const COUNCIL_PLANNER_SCHEMA = {
	type: "object",
	properties: {
		plan: { type: "string", minLength: 1, maxLength: COUNCIL_PLAN_CHAR_LIMIT },
		assumptions: {
			type: "array",
			maxItems: 8,
			items: { type: "string", minLength: 1, maxLength: 500 },
		},
		blockers: {
			type: "array",
			maxItems: 8,
			items: { type: "string", minLength: 1, maxLength: 500 },
		},
		evidenceVersion: { type: "string", enum: ["1.0.0"] },
	},
	required: ["plan", "assumptions", "blockers", "evidenceVersion"],
	additionalProperties: false,
} as const;

const COUNCIL_FINDING_ADJUDICATION_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 8 },
		disposition: { type: "string", enum: COUNCIL_DISPOSITIONS },
		reason: { type: "string", minLength: 1, maxLength: 3000 },
		step: { type: "string", minLength: 1, maxLength: 500 },
		duplicateOf: { type: "string", minLength: 1, maxLength: 8 },
	},
	required: ["id", "disposition", "reason", "step"],
	additionalProperties: false,
} as const;

const COUNCIL_REVIEWER_GRADE_SCHEMA = {
	type: "object",
	properties: {
		// The grade schema is the reason the roster cap exists: every active reviewer must be
		// addressable by a slot the adjudicator can emit, so this ceiling is the configuration cap
		// rather than an independently chosen number.
		slot: { type: "integer", minimum: 1, maximum: COUNCIL_MAX_ACTIVE_REVIEWERS },
		grade: { type: "string", enum: COUNCIL_GRADES },
		reason: { type: "string", minLength: 1, maxLength: 1000 },
	},
	required: ["slot", "grade", "reason"],
	additionalProperties: false,
} as const;

export const COUNCIL_ADJUDICATION_SCHEMA = {
	type: "object",
	properties: {
		plan: { type: "string", minLength: 1, maxLength: COUNCIL_PLAN_CHAR_LIMIT },
		dispositions: { type: "array", items: COUNCIL_FINDING_ADJUDICATION_SCHEMA },
		grades: { type: "array", items: COUNCIL_REVIEWER_GRADE_SCHEMA },
	},
	required: ["plan", "dispositions"],
	additionalProperties: false,
} as const;

/**
 * A consult answer's ceiling. Far below the plan budget on purpose: a consult reply lands in the
 * calling agent's context alongside every other reviewer's, so N reviewers must still compose into
 * one readable tool result rather than displacing the conversation that asked the question.
 */
export const COUNCIL_CONSULT_ANSWER_CHAR_LIMIT = 12_000;

/**
 * A consult answers in prose, so the envelope is one string field rather than a finding contract.
 *
 * It is still a schema, and still `strict`, for two reasons that have nothing to do with rigour:
 * an explicit caller schema is what stops a consult inheriting the *parent* session's output schema,
 * and a named field extracts deterministically instead of arriving JSON-quoted through the raw-text
 * yield fallback.
 */
export const COUNCIL_CONSULT_SCHEMA = {
	type: "object",
	properties: {
		answer: { type: "string", minLength: 1, maxLength: COUNCIL_CONSULT_ANSWER_CHAR_LIMIT },
	},
	required: ["answer"],
	additionalProperties: false,
} as const;

export interface CouncilConsultAnswer {
	answer: string;
}

export class CouncilSchemaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CouncilSchemaValidationError";
	}
}

function validateSchema<T>(schema: unknown, candidate: unknown, label: string): T {
	const { validator, error } = buildOutputValidator(schema);
	if (error || !validator) {
		throw new CouncilSchemaValidationError(`${label} schema is unusable: ${error ?? "no validator"}`);
	}
	const result = validator.validate(candidate);
	if (!result.success) {
		const failure = summarizeValidationFailure(result, candidate, validator.requiredFields);
		throw new CouncilSchemaValidationError(`${label} is invalid: ${failure.message}`);
	}
	return candidate as T;
}

function assertExactPlanHeadings(plan: string, label: string): void {
	const headings = parsePlanSections(plan)
		.filter(section => section.level === 2)
		.map(section => {
			const lineBreak = section.raw.indexOf("\n");
			const headingLine = lineBreak < 0 ? section.raw : section.raw.slice(0, lineBreak);
			return headingLine.slice(2).trim();
		});
	if (
		headings.length !== COUNCIL_PLAN_HEADINGS.length ||
		headings.some((heading, index) => heading !== COUNCIL_PLAN_HEADINGS[index])
	) {
		throw new CouncilSchemaValidationError(
			`${label} H2 headings are ${JSON.stringify(headings)} instead of ${JSON.stringify(COUNCIL_PLAN_HEADINGS)}`,
		);
	}
}

/**
 * Single owner of the finding-id prefix contract: `A`, `B`, ... `Z`, `AA`, ... for slot index 0 up.
 *
 * Shared by prompt-time reviewer instructions (which tell a reviewer to prefix its finding ids) and
 * validation-time finding ids (which reject anything not carrying the coordinator-assigned prefix),
 * so the two can never drift apart.
 */
export function councilSlotPrefix(slotIndex: number): string {
	if (!Number.isSafeInteger(slotIndex) || slotIndex < 0) {
		throw new CouncilSchemaValidationError(
			`Council slot index must be a non-negative safe integer, received ${slotIndex}`,
		);
	}
	let remainder = slotIndex;
	let prefix = "";
	do {
		prefix = String.fromCharCode(65 + (remainder % 26)) + prefix;
		remainder = Math.floor(remainder / 26) - 1;
	} while (remainder >= 0);
	return prefix;
}

export function validateCouncilConsultAnswer(candidate: unknown): CouncilConsultAnswer {
	return validateSchema<CouncilConsultAnswer>(COUNCIL_CONSULT_SCHEMA, candidate, "Council consult answer");
}

export function validateCouncilPlannerOutput(candidate: unknown): CouncilPlannerOutput {
	const output = validateSchema<CouncilPlannerOutput>(COUNCIL_PLANNER_SCHEMA, candidate, "Council planner output");
	assertExactPlanHeadings(output.plan, "Council planner output plan");
	return output;
}

export function validateIncomingCouncilReport(candidate: unknown, slotIndex: number): CouncilReport {
	const report = validateSchema<IncomingCouncilReport>(COUNCIL_REPORT_SCHEMA, candidate, "Council member report");
	const prefix = councilSlotPrefix(slotIndex);
	return {
		...report,
		findings: report.findings.map((finding, index) => ({ ...finding, id: `${prefix}${index + 1}` })),
	};
}

/** Strictly validates a durable coordinator-assigned report and its deterministic slot IDs. */
export function validatePersistedCouncilReport(candidate: unknown, slotIndex: number): CouncilReport {
	const report = validateSchema<CouncilReport>(
		PERSISTED_COUNCIL_REPORT_SCHEMA,
		candidate,
		"Persisted council member report",
	);
	const prefix = councilSlotPrefix(slotIndex);
	for (const [index, finding] of report.findings.entries()) {
		const expected = `${prefix}${index + 1}`;
		if (finding.id !== expected) {
			throw new CouncilSchemaValidationError(
				`Persisted council finding id ${JSON.stringify(finding.id)} does not match deterministic id ${expected}`,
			);
		}
	}
	return report;
}

export function validateCouncilAdjudication(
	candidate: unknown,
	expectedFindingIds: readonly string[],
	allowedDuplicateTargetIds: readonly string[] = [],
	/**
	 * Reviewer slots this adjudication must grade. Supplied only by the live submission path, where a
	 * rejection round-trips back to Main as a correctable tool error; the durable read path leaves it
	 * undefined so a run adjudicated before grading existed still loads.
	 */
	expectedGradeSlots?: readonly number[],
): CouncilAdjudication {
	const adjudication = validateSchema<CouncilAdjudication>(
		COUNCIL_ADJUDICATION_SCHEMA,
		candidate,
		"Council adjudication",
	);
	assertExactPlanHeadings(adjudication.plan, "Council adjudication plan");

	const expectedIds = new Set(expectedFindingIds);
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	const extraIds = new Set<string>();
	for (const disposition of adjudication.dispositions) {
		if (seenIds.has(disposition.id)) duplicateIds.add(disposition.id);
		seenIds.add(disposition.id);
		if (!expectedIds.has(disposition.id)) extraIds.add(disposition.id);
	}
	const missingIds = expectedFindingIds.filter(id => !seenIds.has(id));
	if (missingIds.length > 0 || extraIds.size > 0 || duplicateIds.size > 0) {
		throw new CouncilSchemaValidationError(
			`Council adjudication disposition ids must match expected findings; missing=${JSON.stringify(missingIds)}, extra=${JSON.stringify([...extraIds])}, duplicate=${JSON.stringify([...duplicateIds])}`,
		);
	}

	const allowedTargets = new Set([...expectedFindingIds, ...allowedDuplicateTargetIds]);
	const dispositionsById = new Map(adjudication.dispositions.map(disposition => [disposition.id, disposition]));
	for (const disposition of adjudication.dispositions) {
		if (disposition.disposition !== "duplicate") {
			if (disposition.duplicateOf !== undefined) {
				throw new CouncilSchemaValidationError(
					`Council adjudication disposition ${disposition.id} cannot name duplicateOf unless its disposition is duplicate`,
				);
			}
			continue;
		}
		const duplicateTarget = disposition.duplicateOf;
		if (!duplicateTarget) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} is missing its duplicate target`,
			);
		}
		if (duplicateTarget === disposition.id) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} cannot duplicate itself`,
			);
		}
		if (!allowedTargets.has(duplicateTarget)) {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} has unknown duplicate target ${duplicateTarget}`,
			);
		}
		const targetDisposition = dispositionsById.get(duplicateTarget);
		if (targetDisposition?.disposition === "duplicate") {
			throw new CouncilSchemaValidationError(
				`Council adjudication disposition ${disposition.id} must name a canonical finding; duplicate target ${duplicateTarget} is itself duplicate`,
			);
		}
	}
	const gradedSlots = new Set<number>();
	for (const grade of adjudication.grades ?? []) {
		if (gradedSlots.has(grade.slot)) {
			throw new CouncilSchemaValidationError(
				`Council adjudication grades reviewer slot ${grade.slot} more than once`,
			);
		}
		gradedSlots.add(grade.slot);
	}
	if (expectedGradeSlots) {
		const missingSlots = expectedGradeSlots.filter(slot => !gradedSlots.has(slot));
		const extraSlots = [...gradedSlots].filter(slot => !expectedGradeSlots.includes(slot));
		if (missingSlots.length > 0 || extraSlots.length > 0) {
			throw new CouncilSchemaValidationError(
				`Council adjudication must grade exactly the reviewer slots that reported; missing=${JSON.stringify(missingSlots)}, extra=${JSON.stringify(extraSlots)}`,
			);
		}
	}
	return adjudication;
}
