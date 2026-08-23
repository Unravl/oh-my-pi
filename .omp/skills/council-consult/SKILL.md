---
name: council-consult
description: Put a hard engineering decision to the model council and reconcile the disagreement. Use when a design, migration, root-cause, or tradeoff call has 2+ defensible answers and getting it wrong is expensive; when you want a plan or hypothesis attacked before building on it; when the user asks what the council thinks; or when you need several independent reads on unfamiliar code. Covers the `convene` tool's `consult` and `plan` actions.
---

# Consulting the council

The `convene` tool hands you the operator's roster of independently-assigned frontier models. `consult` asks them one question in parallel and returns their prose answers. `plan` runs the whole machine — planner, reviewers, adjudicator — and returns one adjudicated plan.

Neither is a search. Reviewers get `read`, `grep`, `glob`, `lsp`, `ast_grep` and nothing else: exactly your read tools, minus the ability to run anything. **If your own tools can settle it, they add nothing and cost real money.**

No advisor is ever attached to a council child you convene. The `advisor` role is one shared model, so watching several reviewers with it would correlate the answers whose independence is the entire product — what comes back is the assigned models' own judgment. A consult also ignores `round` pins, because it runs no rounds: every enabled member answers.

## Gate — before you call it

Answer all four. Any "no" means don't.

1. **Is it a decision, not a lookup?** Two or more defensible answers, and you cannot pick between them from evidence you already have. A question with one correct answer is a `grep`, not a consult.
2. **Is being wrong expensive?** Wrong phase order, a migration that strands data, a contract other packages consume, a fix that treats a symptom. If the wrong answer costs minutes to undo, decide it yourself.
3. **Have you already read the code?** Consulting before reading outsources your job and produces answers you cannot evaluate. You must be able to tell a wrong answer from a right one when it comes back.
4. **Can a read-only reader actually answer it?** "Does this race under load" and "is this slow" need a run. Reviewers cannot run anything, so they will speculate, and speculation is what you were trying to avoid.

## Writing the question

The roster's cost is fixed whatever you ask, so ask the whole question. One consult, framed properly, beats three vague ones.

Include, in this order:

- **The decision.** One sentence, imperative or interrogative. "Should the origin live on the manifest or be derived from the output-path stem?"
- **The options you already see**, and why each is tempting. This is what stops four reviewers spending their turns rediscovering your option A.
- **The constraint that actually binds.** Backward compatibility, a resume path, a wire format, a deadline, an invariant. Without it you get textbook answers.
- **The files already in play**, repo-relative. Reviewers start cold; naming three paths saves every one of them a discovery pass.
- **What you have ruled out and why.** Otherwise it comes back as a recommendation.

<example>
Bad: "What do you think about the council origin design?"

Good: "Council runs need to record whether an agent or the operator convened them, because an agent-convened run must not enter plan review. Option A: a durable `origin` field on `CouncilManifestV2` (new optional key, parser must allow it). Option B: derive it from the published filename stem (`-brief.md` vs `-plan.md`), no schema change. Constraint: manifests written by older builds must still parse and resume, and `parseCouncilManifest` uses `assertExactKeys`. Files: `src/council/state.ts` (manifest + `isValidCouncilOutputPath`), `src/council/publication.ts` (stem allocation), `src/modes/controllers/council-controller.ts:584` (the plan-approval trigger). I have ruled out a manifest version bump — an in-flight run must survive the upgrade. Which, and what breaks?"
</example>

## Reconciling what comes back

You get N independent answers. They were written without seeing each other, so they will disagree — that is the product, not a defect.

- **Weigh evidence, do not count votes.** One reviewer citing `state.ts:889` beats three asserting a general principle. A majority of ungrounded answers is still ungrounded.
- **Treat unanimity as a weak signal on hard questions.** If a genuinely contested call comes back 4-0, suspect the question was leading, or that the answer really was obvious and you should have found it yourself.
- **Mine the disagreement for the real constraint.** Reviewers usually split because they weighted different constraints. Name the constraint they split on; that is normally the actual decision.
- **Nothing is verified.** Every claim about behavior is a read of source, not an observation of a run. Check anything load-bearing yourself.
- **A failed reviewer is not a veto.** The tool reports per-reviewer failures as warnings and still returns the rest.
- **Cite where it lands.** Transcripts are at `history://<agent-id>`. When you tell the user what the council said, say which reviewer and on what evidence.

## After

- **Own the outcome.** "The council said X" is not a justification. If you follow it, follow it because the evidence held.
- **Say what it cost** when you convened it on the user's behalf. The tool result carries requests, tokens, and dollars.
- **Do not re-consult the same question** after an answer you dislike. Either the framing was wrong — then fix the framing and say so — or the answer stands.

## When to escalate to `plan`

`plan` costs the full roster plus a planner and an adjudicator, and takes ten minutes and up. It earns that only when the *plan itself* is the deliverable: a change large enough that a wrong phase order costs hours, and you want it adversarially reviewed before writing code. It returns a brief for you at `local://council-<slug>-brief.md`; it is deliberately never offered to the user for approval, and it never becomes "the" plan.

`plan` runs only in the main session. Subagents get `consult`.

If you are choosing between one decision and a whole plan: consult. A consult that changes your mind is cheap; a plan you then discard is not.
