# convene

> Convene the configured model council from inside a turn: consult the reviewers, or run a full adjudicated plan.

This is the agent-facing counterpart to the [`/council` command](../council.md). The command belongs to the operator and ends in plan review; the tool belongs to the agent and ends in a returned answer.

## Source
- Entry: `packages/coding-agent/src/tools/convene.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/convene.md`
- Consult runner: `packages/coding-agent/src/council/consult.ts`
- Consult preflight: `preflightCouncilConsult` in `packages/coding-agent/src/council/preflight.ts`
- Full run: `CouncilCoordinator.start` / `.finalPlan` in `packages/coding-agent/src/council/coordinator.ts`
- Consultant agent: `packages/coding-agent/src/prompts/agents/council-consultant.md`
- Session bridge: `ToolSession.getCouncilHost` (`packages/coding-agent/src/tools/index.ts`), wired in `packages/coding-agent/src/sdk.ts`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`. Being discoverable, it mounts under `xd://convene` in an ordinary session — invoked by writing its JSON arguments there.
- **The name is not `council` on purpose.** `xd://council` is already the plain-text write device an operator's session uses to submit an adjudication verdict, and `WriteTool` resolves resolution devices *before* mounted tools — a tool mounted at `xd://council` would be listed and permanently unreachable, every write answering `No council run is awaiting adjudication.`
- Registration requires `council.tool = true` (default `true`). A restricted session never receives it, which is what stops a council child from convening the council that spawned it.
- Subagents do receive it, and may `consult`. `plan` refuses below the main session (`taskDepth > 0`).
- Progress: one `onUpdate` at kickoff, naming every model about to be billed.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `action` | `"plan" \| "consult"` | Yes | Full adjudicated run, or parallel reviewer Q&A. |
| `task` | `string` | Yes | The question (`consult`) or the planning task (`plan`). Bounded by the 120,000-character preflight limit. |

## `consult`

Every **enabled** reviewer answers the same question once, in parallel, in prose. There is no planner, no adjudicator, no manifest, no publication, and no round structure.

Consequences of having no manifest: a consult is **not resumable**, does not appear in `/council status`, does not occupy the one-run-per-session slot, and neither blocks nor is blocked by a `/council` run. Each reviewer's transcript is still durable at `history://<agent-id>`, which is why ids are reserved before launch.

The roster comes from the same `resolveCouncilRoster` a dispatch uses, with two deliberate divergences that both follow from "a consult has no rounds and wants independent answers":

- **Round pins do not apply** (`scope: "all"`). A `round` is a review-round *schedule*; a consult runs none, so a pin has nothing to schedule and must not silently drop a model the operator enabled. Every enabled member with a resolvable model answers — including one pinned above `council.rounds`, which a dispatch would park as inert. A member with `round` omitted is unaffected either way: an omitted round means *every* configured round, so it is always in round 1.
- **No advisor ever attaches** (`advisors: false`), regardless of `council.advisor.reviewers`. The `advisor` role is a single shared model, so watching N reviewers with it correlates N answers whose only value is independence — it manufactures the consensus the caller would then report.

Reviewers run the `council-consultant` agent on the same five-tool read-only slate as every other council child, with the same pinned model, and answer against `COUNCIL_CONSULT_SCHEMA` — a single `answer` string capped at 12,000 characters. The schema is passed explicitly, and that is load-bearing twice over: it stops the consult inheriting the *parent* session's output schema, and it extracts deterministically instead of arriving JSON-quoted through the raw-text yield fallback.

A reviewer that fails does not fail the consult: its failure is reported in its own section and as a warning, and the remaining answers are returned. A consult where **no** reviewer answered throws, naming every transcript.

## `plan`
Runs the ordinary coordinator with `origin: "agent"`, waits for `completion`, and returns `finalPlan()` — the adjudicated plan read back from the durable `round<N>.md` artifact with its metadata frame stripped. Because it is the ordinary coordinator, the run is durable, checkpointed, resumable, cancellable with `Esc`, drives the operator's Council pane, and emits the same lifecycle cards and stats table as `/council`.

Three things differ, all derived from the durable `origin` field:

1. **The adjudicator is always delegated.** Main-mode adjudication waits for the session to go idle, and the `convene` tool call is exactly what would have to finish first — it would deadlock. With `modelRoles.adjudicator` unassigned, adjudication falls back to the planner's already-resolved model and preflight warns, the same substitution shape as the planner's own `@slow` fallback.
2. **No child gets an advisor** — planner, reviewers, and adjudicator alike — for the same shared-model reason as `consult`. The operator's `council.advisor.*` toggles keep applying in full to `/council`.
3. **The plan is published as a brief, not a plan.** The output path is `council-<slug>-brief.md` rather than `council-<slug>-plan.md`, so `listPlanFiles` (which matches `/plan\.md$/i`) never lists it, and `CouncilController` skips the plan-approval overlay. The operator is never shown an approval screen for a plan they did not ask for.

`/council resume` reads the origin back off the manifest, so resuming an agent-convened run keeps its delegated adjudicator instead of being refused for an adjudicator change the operator never made.

## Outputs
- `consult`: a header line (answered/launched, duration, spend), a reconciliation warning, then one `## <Label> — <provider>/<id>` section per reviewer with its `history://` pointer and either its answer or its failure, then a warnings block. `details = { action, answered, launched, warnings, cost }`.
- `plan`: a header naming the run, state, rounds, reviewers succeeded, spend, and the `local://` brief path, then the plan body. `details = { action, runId, state, answered, launched, warnings, cost }`.

## Limits & Caps
- Question/task: the 120,000-character council preflight limit.
- Consult answer: 12,000 characters per reviewer (`COUNCIL_CONSULT_ANSWER_CHAR_LIMIT`), schema-enforced.
- Returned plan: truncated into the tool result at 60,000 characters with a notice pointing at the `local://` brief, which always holds the whole plan.
- Concurrency: every reviewer acquires the session spawn permit, so `task.maxConcurrency` bounds the fan-out exactly as it does for `/council`.

## Errors
- No live session (`getCouncilHost` absent): "The council is unavailable in this session".
- `plan` from a subagent: refused, pointing at `consult`.
- Every `CouncilDispatchError` code from [Preflight](../council.md#preflight) surfaces verbatim; all are the operator's configuration to fix and none of them spend.
- A `plan` run that ends `interrupted` or `failed` throws with the failure reason and a pointer to `history://<agent-id>`.
- A `plan` run that completes without a final plan version throws rather than returning an empty brief.

## Notes
- Both actions spend on every configured council role. The tool prompt requires the agent to say so when it convenes the council on the user's behalf.
- Council children are read-only by prompt contract and tool slate, not by sandbox. Nothing the council returns is verified; the calling agent owns the decision.
