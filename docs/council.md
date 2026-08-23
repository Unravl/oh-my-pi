# Council

Council sends one task to an ordered roster of independently configured models, has each of them review it, adjudicates the findings into a single plan, and publishes that plan into the session-local `local://` cache. It is durable: every phase is checkpointed to disk, so an interrupted run can be resumed in the same session.

This guide is the reference for how a run behaves. For the YAML keys see [Settings › Council](./settings.md#council); for how roster roles map onto model selectors see [Models › Council roles in Model Hub](./models.md#council-roles-in-model-hub).

## Commands

| Form                        | Effect                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `/council <task>`           | Start a run. Dispatches immediately, with no confirmation step.                               |
| `/council status`           | Report the active run, or the configured idle roster when none is active.                     |
| `/council cancel`           | Cancel the active run (or an in-flight preflight).                                            |
| `/council resume [run-id]`  | Resume an interrupted run of the current session. Without an id, the newest resumable one.    |
| `/council config`           | Open the Model Hub **Roles & Council** section (TUI); print editable YAML guidance elsewhere. |
| `/council -- <task>`        | Escape hatch: run a task whose first word is `status`, `cancel`, `resume`, or `config`.       |

Those four subcommand words are the entire reserved set. A single-typo first token with no trailing text is refused with a suggestion rather than being run as a task, and the refusal names the `--` escape.

`/council` is never forwarded as an ordinary user prompt: every branch consumes the slash command, so your task text does not become a turn on the main model. It does still reach Main in the default adjudication mode, where the adjudication assignment embeds the task alongside the planner draft and the reviewer reports. With a `modelRoles.adjudicator` assigned, the task goes only to the Council children.

## The agent-facing tool

Everything below describes a run the operator started. The agent can also convene the council itself, through the `convene` tool, without anyone typing `/council`. It has two actions and is documented in full in [Tools › convene](./tools/convene.md).

| Action    | What runs                                                    | What comes back                                                            |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `consult` | Every active reviewer answers one question, in parallel      | One prose answer per reviewer, plus each `history://<agent-id>`             |
| `plan`    | The ordinary run: planner, reviewers, adjudicator            | The adjudicated plan, plus `local://council-<slug>-brief.md`               |

`consult` is the council's roster without its planning apparatus: no planner, no adjudicator, no manifest, no publication, no rounds. It is consequently **not resumable**, absent from `/council status`, and outside the one-run-per-session slot — it neither blocks nor is blocked by a `/council` run. Reviewer transcripts are still durable.

Because a consult runs no rounds, a member's `round` pin has nothing to schedule and does not gate it: **every enabled member with an assigned model answers**, including one pinned above `council.rounds` that a real run would park as inert. (A member with `round` omitted serves every configured round anyway, so it is always in round 1 either way.)

`plan` is this document's run, driven by the coordinator, with the same durability, resume, cancellation, pane, cards, and stats. It is available only in the main session; a subagent gets `consult`. Three things differ, all following from the durable `origin` field the manifest now records:

- **The adjudicator is always delegated.** Main-mode adjudication waits for your session to go idle, and the tool call holding your turn is exactly what would have to finish first, so it would deadlock. With `modelRoles.adjudicator` unassigned, adjudication falls back to the planner's already-resolved model and preflight warns — the same substitution shape as the planner's own `@slow` fallback, and never a model the run has not already resolved and credential-checked.
- **No advisor attaches to any child.** Not the planner, not a reviewer, not the adjudicator, whatever `council.advisor.*` says. The `advisor` role is a *single shared model*, so watching several council children with it correlates outputs whose whole value is independence — it would manufacture the agreement the agent then reports to you as consensus. Your toggles keep applying in full to `/council`.
- **The plan publishes as a brief.** The output path is `council-<slug>-brief.md`, not `council-<slug>-plan.md`. The plan listing matches `*plan.md`, so a brief is invisible to it, and the Council controller skips the plan-approval overlay: **you are never shown an approval screen for a plan you did not ask for.** The agent reads the brief and acts, or tells you what it said.

`/council resume` reads the origin back off the manifest, so resuming an agent-convened run keeps its delegated adjudicator rather than being refused for an adjudicator change you never made.

Set `council.tool: false` to remove the tool. The slash command is unaffected.

## The roster

The roster lives in global `council.members` and is an ordered list of `{ role, enabled, round? }` entries. It defaults to `council1` through `council4`, all enabled. Roster ids are ordinary custom model roles, so each one must be assigned exactly one selector in `modelRoles`; on a fresh install nothing is assigned, and the first `/council <task>` refuses until you assign the enabled members in **Roles & Council**.

Two ids are reserved as leads and can never appear in `council.members`:

- **`planner`** drafts the initial plan. Unassigned, it falls back to the `slow` model role.
- **`adjudicator`** judges the findings. Unassigned, your main session adjudicates in-session through [`xd://council`](#xdcouncil).

A member's optional `round` pins it to that review round; omitting it runs the member in every configured round. `council.rounds` selects one or two rounds. A member that is disabled, or pinned above `council.rounds`, is **inert**: it is kept in the roster and shown in the Model Hub, but it never runs, is never credential-checked, never counts toward any limit, and never marks a run degraded. Every configured round must have at least one active member.

Operator-facing surfaces render roster ids as stable labels (`Reviewer 1`, `Planner`, `Adjudicator`; a custom id like `judge2` becomes `Judge 2`). The durable ids stay raw everywhere they are load-bearing: config paths, YAML, `@councilN` selectors, manifest keys, and artifact filenames.

### The 64-active-reviewer limit

At most 64 reviewers may be *active* (enabled and serving a configured round) at once. This is a **representability** limit, not a fan-out limit: the adjudication grade schema addresses each reviewer by a 1-based `slot` whose `maximum` is that same constant, so a 65th active reviewer could be launched and billed but never graded. Configuration parsing refuses before anything runs, naming the observed count, the limit, and your global config path, and it offers both repairs: disable the surplus members, or pin them to a round above `council.rounds`. The check runs after `council.rounds` is parsed, precisely because lowering the rounds is one of those two repairs.

How many reviewers actually run *simultaneously* is a separate question, governed by machinery Council does not own. Every council child is launched through the session spawn permit, so `task.maxConcurrency` (default `32`, `0` meaning unlimited) bounds concurrent children, and provider request limits apply on top. Council adds no semaphore of its own.

A structurally valid manifest recorded by an earlier build with more than 64 roster entries still parses, so its status, history, HUD, and stats keep rendering. It is deliberately not resumable, and the refusal comes from the *artifact*, not from your live configuration: an eligibility check on the persisted roster runs before fresh preflight, so reducing your current roster below 64 does not make that run resumable again. `/council resume` with no id skips it, and its ordinary resume hint is suppressed; `/council resume <run-id>` refuses with `COUNCIL_CONFIG_INVALID` naming the run, the observed reviewer count, and the 64-reviewer limit. It is never reported as corrupt. The recovery is to reduce the active roster and start a new run, not to rewrite durable history.

## Run lifecycle

### The twelve states

| State                | Operator label                    | Meaning                                                                    |
| -------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `dispatching`        | starting                          | The manifest exists on disk; no child has launched.                        |
| `planning`           | drafting the plan                 | The planner child is writing the initial draft.                            |
| `reviewing`          | under review                      | This round's reviewer children are running.                                |
| `awaiting-main`      | waiting for your turn to finish   | Main-mode adjudication is parked, waiting to take your session's turn.     |
| `adjudicating`       | judging findings                  | The adjudicator (Main or delegated child) holds the turn.                  |
| `round-transition`   | starting next round               | Round N is adjudicated and written; round N+1 is about to launch.          |
| `publishing`         | writing the plan                  | Declared and rendered, but see the note below.                             |
| `cancelling`         | cancelling                        | Cancellation accepted; children are draining (up to 5 s).                  |
| `interrupted`        | interrupted                       | **Terminal.** Stopped before finishing. Resumable.                         |
| `failed`             | failed                            | **Terminal.** A phase failed. Usually resumable; two codes are not.        |
| `completed`          | completed                         | **Terminal.** The plan was published with no degradation.                  |
| `completed-degraded` | completed with warnings           | **Terminal.** The plan was published, but something degraded the run.      |

The four terminal states latch: once a run is terminal, nothing can move it back to an in-progress state.

`round-transition` is a checkpointed boundary, not a phase children run in; a one-round run never enters it. `publishing` is part of the persisted state vocabulary and every renderer handles it, but a coordinator-driven run does not currently assign it: the publish step executes while the manifest still reads `round-transition` (multi-round) or the last active phase (single-round). Treat it as accepted-but-not-produced.

`completed-degraded` is a **success** state, not a failure: the plan was published, but at least one reviewer failed or a degrading condition was flagged. Like `completed`, it is terminal and not resumable.

`cancelling` is transient. A successful `/council cancel` lands on `interrupted`, never on `cancelling`. Cancellation announces itself before the drain, aborts every child through one shared signal, waits up to 5 seconds for the checkpoint, your own turn (only if Council owns it), and the run promise, then forces the interrupt. A reviewer that observed the abort records `cancelled`; one the coordinator swept while still running records `interrupted`.

### What actually happens

1. **Preflight** resolves everything and spends nothing (see [Preflight order](#preflight-order)).
2. The **kickoff** line is emitted, naming the planner, the adjudicator and its mode, and each round's reviewers with their models. It precedes every council model request.
3. The **planner** drafts a plan against your task and the captured instruction snapshot, writing `draft.md`.
4. For each configured round: the round's **reviewers** run in parallel, each producing `<role>-r<round>.json`; then the **adjudicator** reads the plan plus the bounded report context and returns a revised plan, one disposition per finding, and one grade per reporting reviewer. The result is written as `round<round>.md`. A non-final round then enters `round-transition`.
5. The final adjudicated plan is **published** to `local://council-<slug>-plan.md`.
6. The run settles as `completed` or `completed-degraded`, emits a terminal lifecycle card, and delivers one summary card with the stats table.

Round 2 uses a different adjudication prompt from round 1 and carries the round-1 revised plan plus its canonical finding ids in the basis, so a delegated adjudicator that never saw round 1 still has the eligible duplicate targets.

## Preflight

`/council <task>` refuses before any council model is invoked. Refusals carry a `CouncilDispatchError` whose `spending` flag is `false`, and they are ordered deliberately so that the cheapest, most-likely faults report first.

### Preflight order

1. **Task bounds.** Non-empty after trimming, and within the 120,000-character preflight limit.
2. **Configuration.** Roster shape, role-id grammar, reserved and duplicate ids, configured multi-selectors, `council.rounds`, then the 64-active-reviewer cap.
3. **Enabled members.** At least one member is enabled.
4. **Round staffing.** Every configured round has at least one active member.
5. **Reviewer assignments.** Every active member has exactly one resolvable, available, credentialed model, checked sequentially in roster order. Missing assignments are collected and reported together, in roster order, using stable labels.
6. **Leads.** The planner selector, then the adjudicator selector. Main-mode adjudication additionally revalidates your session's model, credentials, and `write` tool.
7. **Repository root.** `cwd` and the Git top level are canonicalized.
8. **Instruction capture.** The AGENTS.md / CLAUDE.md snapshot is built.
9. **Subagent policy** for the planner request, then each member request, then the delegated adjudicator request.
10. **Publication target.** The session plan root is canonicalized and a collision-free file name is allocated.

An abort (`/council cancel`, a session transition, Esc) is checked before preflight starts and between every awaited stage, so cancellation stops preflight rather than running it to completion. These are cooperative checkpoints around APIs that do not all accept an `AbortSignal`, so a single non-cooperative operation can still run to its own completion before the next checkpoint fires.

An **unavailable member blocks the whole dispatch**. Council never silently shrinks the roster.

### Dispatch codes

| Code                              | Cause                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `COUNCIL_TASK_INVALID`            | Task is whitespace-only, or longer than 120,000 characters.                                     |
| `COUNCIL_CONFIG_INVALID`          | `council.*` is malformed, uses a reserved or duplicate role id, or exceeds the 64-active cap.    |
| `COUNCIL_NO_ENABLED_MEMBERS`      | No roster member is enabled.                                                                    |
| `COUNCIL_ROUND_UNSTAFFED`         | A configured round has no active member.                                                        |
| `COUNCIL_MEMBER_MODEL_INVALID`    | A roster slot is unassigned, ambiguous, unresolvable, unavailable, or lacks credentials.        |
| `COUNCIL_PLANNER_MODEL_INVALID`   | The `planner` role configures several selectors, or its model is unusable.                      |
| `COUNCIL_ADJUDICATOR_MODEL_INVALID` | The `adjudicator` role configures several selectors, or its model is unusable.                |
| `COUNCIL_MAIN_MODEL_INVALID`      | Main-mode adjudication, but your session's own model or credentials are unusable.               |
| `COUNCIL_WRITE_TOOL_REQUIRED`     | Main-mode adjudication, but `write` is not in your active tool set, so `xd://council` is unreachable. |
| `COUNCIL_REPOSITORY_INVALID`      | The working directory or Git root cannot be canonicalized.                                      |
| `COUNCIL_INSTRUCTIONS_INVALID`    | The instruction snapshot could not be captured (symlinked, oversized, or non-UTF-8 AGENTS.md).  |
| `COUNCIL_SUBAGENT_POLICY_INVALID` | A council child's effective subagent policy cannot be resolved.                                 |
| `COUNCIL_PUBLICATION_INVALID`     | The session plan root is unusable, or the promised output path escapes it.                      |

Warnings are separate from refusals. Some are **degrading** (they set `degraded` and steer the run toward `completed-degraded`); a member pinned above `council.rounds`, or an enabled advisor with no `advisor` model assigned, is merely **advisory** and does not degrade the run.

## Reviewer children

### Confinement, and its limits

Every council child (planner, reviewer, adjudicator) runs with a fixed five-tool read-only slate: `read`, `grep`, `glob`, `lsp`, `ast_grep`, with tool names restricted. No skills, no rules, no skill autoloading. Its model is pinned: an authentication fallback or any model drift aborts the child rather than quietly substituting a model you did not pay for. Its working directory is the canonicalized session `cwd`, and its identity is inspection-only.

A council child therefore **cannot write, edit, run a shell command, spawn a subagent, browse the web, or reach an MCP tool**. A finding that would need a test run or a build to confirm cannot be confirmed by the reviewer that raised it.

This is a prompt contract plus a restricted tool-name set, **not** a sandbox and not data-source or OS-level enforcement. The retained read tools can still address internal URLs, absolute paths, and HTTP sources where those are supported, so "read-only, repository-rooted" describes intent and tool surface rather than an enforced boundary.

### The shared reviewer brief

Every reviewer receives the identical review brief from `packages/coding-agent/src/prompts/council/lens.md`, compiled into the binary and copied verbatim into each roster entry of the manifest. The assigned model supplies the difference between reviewers, not the instructions.

The brief is part of the run's resume identity and is compared byte-for-byte. That is deliberate reproducibility policy: **editing `lens.md` forces a new run.** An in-flight run resumed against a build whose brief changed is refused with "the council roster changed since this run started". There is no migration and no opt-out.

### Advisors

Three independent toggles (`council.advisor.planner`, `council.advisor.reviewers`, `council.advisor.adjudicator`) attach a live advisor, on the shared `advisor` model role, to that role's own turns. `council.advisor.adjudicator` applies only to a *delegated* adjudicator; a main-session adjudicator follows the global `advisor.enabled`.

Advisor tools go through a **two-stage intersection**. First, a restricted session's allowlist is a hard ceiling: the advisor's candidate slate is filtered down to the council child's five read-only tools, so an `advisor.tools` roster naming `write`, `edit`, or `bash` gets none of them inside a council child. Second, the advisor runtime intersects that ceiling with its own configured names (or the advisor default set). The advisor's own `advise` tool is added by the runtime and always survives both stages.

Advisor spend is folded into the same usage bucket as the role it watches, including for failed attempts and schema retries, so the `++` marker beside a role in the stats table always has a real number behind it. If an advisor is enabled but the `advisor` role resolves to no model, preflight warns and the advisor simply does not attach.

## Schema budgets

Council's structured outputs are bounded so that an adjudication always fits in one injectable context.

| Budget                              | Value     | Applies to                                                          |
| ----------------------------------- | --------- | --------------------------------------------------------------------- |
| Task                                | 120,000   | `/council <task>` text, checked first in preflight.                 |
| Plan                                | 200,000   | Planner `plan` and every adjudicated `plan`.                        |
| Adjudication injection cap          | 500,000   | Total characters injected into one adjudication turn.               |
| Instruction snapshot                | 512 KiB   | Total bytes of captured AGENTS.md / CLAUDE.md content.              |
| Findings per report                 | 40        | Plus per-field caps: impact and recommendation 3,000; evidence 1-12 items. |
| Grade `reason`                      | 1,000     | One grade per reporting reviewer.                                   |

Those first three do not stand alone. A **module-level composition guard** runs when any council module is imported and asserts that the fixed adjudication overhead (the task budget, the plan budget plus 5% framing, the disposition and grade allowances, and a fixed slack) plus a 100,000-character minimum report budget still fits inside the injection cap. If the three budgets are ever edited into an arrangement where a schema-valid plan and task could not be adjudicated, the guard throws at import time, so the failure surfaces on the first council import or test rather than mid-run after real spend.

At runtime the cap is enforced twice more: a pre-spend check rejects a fixed context that cannot fit even in the worst case (every roster slot graded, zero reports), and the context builder then shrinks the per-report budget in a loop before giving up. Reports are packed by severity (critical, high, medium, low) then by slot, and any overflow is reported to the adjudicator as a count plus the omitted ids. The manifest records `adjudicationBudget: { injectedChars, cap }` for the last attempt.

Severity inflation is therefore self-defeating: when the cap binds, an inflated severity displaces a real defect from another reviewer.

## Grading

The adjudicator grades each reviewer that actually reported, on `S`, `A`, `B`, `C`, `D`, by the severity and quality of what it surfaced rather than by volume. Grades are addressed by the reviewer's 1-based position in the manifest roster. `F` is deliberately absent from the schema: the harness derives it for a reviewer that never finished, because the adjudicator only ever sees submitted reports and cannot express "did not deliver".

The adjudication context always carries a one-line summary per slot (readiness, finding count) even for a zero-finding report, so every owed grade has a basis. On submission, grades must cover exactly the slots that reported, with no slot graded twice. When two rounds grade the same reviewer, the later round wins.

`grades` is optional on the adjudication payload, so a run adjudicated by an older build still loads, resumes, and renders, just without ranks.

## Adjudication

### Main mode (default)

With `modelRoles.adjudicator` unassigned, your own session judges. The run enters `awaiting-main`, waits for your session to go idle, revalidates your model and effort, then injects a hidden assignment message and moves to `adjudicating`. You answer by writing the JSON adjudication to `xd://council`. If your model or effort changed while the turn was being acquired, or the session was busy, acquisition retries; `awaiting-main` therefore persists for as long as you keep using the session.

At most two turns are spent: one initial, one repair. Two turns without a valid payload fail the run with `COUNCIL_ADJUDICATION_MISSING`.

Because a Main turn never returns through a subagent result, its spend is measured directly from your session's own assistant messages over the turn, and a live sampler reads the same message slice the final charge bills, so the HUD converges on the durable number instead of double-counting.

### Delegated mode

Assign `modelRoles.adjudicator` and a pinned child judges instead. It terminal-yields its adjudication, so the run never enters `awaiting-main` and never installs the `xd://council` handler. One schema retry mirrors the reviewer path; two failures fail the run under the same `COUNCIL_ADJUDICATION_MISSING` code.

### `xd://council`

The write device that carries an adjudication back to a Main-mode run. It is documented in [Resolution devices runtime](./resolve-tool-runtime.md#xdcouncil).

## Artifacts and recovery

### On disk

There is no per-run directory. Council artifacts are flat files directly under the session's `local://` root, named `council-<runId>-<artifact>`, and the artifact names are a closed set:

| Artifact              | Contents                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `manifest.json`       | The full run record: state, roster, leads, rounds, plan versions, usage, warnings, failure.        |
| `instructions.json`   | The dispatch-time AGENTS.md / CLAUDE.md snapshot, with per-file digests. Written once, never replaced. |
| `draft.md`            | The planner's plan, plus a base64 metadata frame.                                                  |
| `<role>-r<round>.json` | One reviewer's report for that round.                                                             |
| `round<round>.md`     | That round's adjudicated plan, plus a base64 adjudication metadata frame.                         |

Round numbers in those names are literally `1` or `2`. Every artifact is verified against the manifest's recorded digest and byte length on load. The `.md` artifacts are **not** plain Markdown: the trailing HTML-comment metadata frame is required exactly, so hand-editing one makes the run unloadable.

Writes are staged to a temporary sibling, fsynced, and installed by exclusive link, with the manifest as the only file ever replaced in place. A crash between writing an artifact and checkpointing the manifest leaves an orphan, and load deterministically adopts exactly one class of orphan at a time rather than inferring a phase from filesystem presence.

### Usage buckets

The manifest records four ledgers, each `{ requests, tokens, cost }`:

- `usage`: the whole-run aggregate, covering the planner, every member attempt, and every adjudication turn.
- `plannerUsage`: the planner's charge, billed as soon as the child returns, so a planner whose output fails validation is still accounted for.
- member `usage`: per round-member record, accumulated across schema retries rather than overwritten. A two-round reviewer has two records.
- `adjudicatorUsage`: the adjudicator's charge, in either mode.

An attached advisor is folded into the same bucket as the role it watches, so the per-role numbers and the aggregate reconcile.

### Same-session recovery

A run belongs to the session that created it. Its artifacts live in that session's `local://` root, its manifest carries that session id, and storage compares the id on every read and every write. A run survives restarting or reloading the same session, and never crosses to a different one.

Recovery is inert: a manifest found in any unfinished state is normalized to `interrupted` with no phase inferred from artifacts, so a hard crash presents identically to an explicit cancel.

`/council resume` with no id picks the newest **resumable** run, falling back to the newest overall so that "already completed" and the precise refusals stay reachable. An unknown run id lists up to five recent runs with their states and resumability.

Everything terminal is unresumable except `interrupted` and most `failed` runs. The two failures that can never resolve themselves are excluded: a structurally invalid planner result (it would be re-requested against the same pinned model) and a publication collision.

Resume re-runs preflight against your current configuration and refuses if the run's identity moved. Six things are compared:

| Mismatch               | Message                                              |
| ---------------------- | ------------------------------------------------------ |
| roster / planner       | the council roster changed since this run started    |
| adjudicator            | the council adjudicator changed                      |
| config                 | council settings changed                             |
| task                   | the task text differs                                |
| repository root        | this is a different repository                       |
| instruction snapshot   | AGENTS.md / CLAUDE.md changed                        |

The roster comparison covers role, order, requested selector, resolved model, effort, advisor flag, served rounds, and the shared brief. The adjudicator is compared only when either side is delegated: a Main-mode adjudicator on both sides is informational and deliberately absorbed, because it does not change who spends or how the verdict is produced.

Resume replays rather than re-spends wherever an artifact exists. The planner draft is read back and revalidated. A round with an existing `round<round>.md` is skipped entirely, adjudication included. A reviewer that already succeeded is replayed from its report; one that already failed stays failed. Only reviewers that neither succeeded nor failed are relaunched, and a relaunch accumulates `attempts` and `agentIds` rather than resetting them, so the earlier attempt's transcript stays reachable through `history://<agent-id>`.

The resumed run re-promises the same output path; it is never re-slugged.

## Publication and plan review

A successful run publishes exactly one file into the session-local plan root: `local://council-<slug>-plan.md` for a `/council` run, or `local://council-<slug>-brief.md` for an agent-convened one. **A council run creates nothing in your working tree.**

The slug is derived deterministically from your task text, with no model involved: the task is Unicode-normalized, stripped of combining marks, lowercased, split on non-alphanumerics, and rejoined with hyphens one whole word at a time, stopping before the first word that would exceed a 48-character budget. Truncation is therefore word-aligned (the sole exception being a single first word longer than the whole budget, which is hard-cut). A trailing `-plan` or `-brief` is stripped, and an empty or bare-stem result becomes `council`. On collision the budget shrinks to make room for a `-2`, `-3`, … suffix, so the shortened name stays word-aligned.

The `council-` prefix is load-bearing, not cosmetic: your own plan-mode plans are `local://<slug>-plan.md` in the same root, and the plan listing has no provenance check, so an un-namespaced council plan could be mistaken for "the" plan or collide with a same-slug user plan. A publication collision is a terminal, non-resumable council failure. The stem is load-bearing for the same reason at one remove: the listing matches `*plan.md`, so `-brief.md` is the mechanism by which an agent-convened plan stays out of plan review. The manifest's `origin` and its stem must agree, and a manifest where they disagree is refused as corrupt.

**Legacy manifests.** A manifest written before the retarget may still carry `plans/<slug>.md` as its `outputPath`. That path is read-compatible and resolves under the session-local plan root's `plans/` subdirectory, which is created on demand there. It never refers to a repository directory. New runs mint only the namespaced bare filename.

Plan review picks the published plan up through the ordinary plan-file listing over the same `local://` root; there is no separate handoff object. When plan mode is unavailable, the controller says so and points at `/plan-review`. A brief never enters that listing and never reaches plan review.

## TUI surfaces

### The Council pane

While a run is live, a Council pane is docked between the transcript and the pending-message bar. It disappears the moment the run reaches a terminal state. Ordinary user turns stay available throughout, and collapsing the pane does not cancel the run.

Each row is one role, in fixed order: Planner, reviewers in roster order, Adjudicator. Row status is one of queued, waiting, running, retry, succeeded, failed, interrupted; `waiting` specifically means Council is blocked on *your* turn, not on itself. While the run is `cancelling`, every unsettled row renders as interrupted.

One footer row is always reserved, so the pane can never drop content without saying so and the control hints never scroll out of view. It shows the hidden-row count, the expand or collapse key, the scroll hint when the expanded viewport can actually scroll, and `Esc cancel`.

### Keys

- **`Ctrl+O`** (`app.tools.expand`) toggles the Council pane instead of transcript tool output, but only while a run is live *and* its pane is on screen. Everywhere else the global behaviour is unchanged.
- **`Shift+Up` / `Shift+Down`** scroll the pane only when it is expanded and its viewport can actually move. At either extreme the keystroke is not consumed and falls through to `app.message.dequeue`, which shares the `Shift+Up` chord. `PgUp` / `PgDn` scroll an expanded, scrollable pane and are consumed there.
- **`Esc`** cancels the run. Once Council has reserved your streaming turn for adjudication it takes Esc first; once Main is idle it takes Esc ahead of draft preservation and the double-Esc navigation gesture.

See [Keybindings](./keybindings.md) for the full chord table.

### Live transcript mirroring

When exactly one council child is running in its phase, its turns can be mirrored into the main transcript. That is the planner always, a delegated adjudicator always, and a review round only when that round launches exactly one reviewer. Two or more concurrent reviewers stay HUD-only, because interleaving them into one linear transcript is unreadable. On a resume where only one reviewer still needs re-running, that reviewer becomes mirrorable even in a multi-reviewer roster. Main-mode adjudication is never mirrored: Main is not a child.

Mirroring is gated by `council.mirrorTranscript` (default `true`), re-read on every snapshot, so toggling it mid-run takes effect immediately.

Mirroring is **live-only**. The mirrored blocks write no session entry: they do not survive a transcript rebuild, a focus switch, or a restart, and they never enter Main's future model context. The durable record is the child's own transcript, which is why each mirrored phase opens with a header card naming `history://<agent-id>`. Durable transcript rebuilding is a separate mechanism and is unaffected by this setting.

### Durable cards and stats

A run's story is told by an append-only sequence of small durable cards, because the session journal has no update operation: kickoff, one round-start and one round-settle per round, a cancel card if cancelled, and one terminal card. Each is keyed for idempotence, capped at 300 characters, and bounded by a per-run ceiling that the terminal card alone is exempt from. The round-settle card matters most when mirroring is suppressed: for a multi-reviewer round it is the only durable statement that the round happened.

The terminal card and the summary card carry a persisted stats projection: per role, its stable label, model, effort, advisor marker, grade, status, attempts, spend, and disposition tally; per run, the state, rounds, reviewers succeeded of total, duration, total spend, and up to eight warnings with the remainder reported as a count. Because the projection is re-derived from the manifest on every rebuild, it contains no live-session-only markers.

## ACP and RPC

`/council` is available on both hosts through the shared command handler. `/council config` has no Model Hub to open there, so it prints the current roster plus an editable YAML block for your global config file instead. Every `/council` line reaches an ACP client as an ordinary assistant message chunk and an RPC client as `command_output`.

### ACP

An ACP prompt containing `/council <task>` stays open until the run settles: the turn is held, and `end_turn` is reported only after the terminal command output. `cancel` unblocks the hold immediately, requests Council cancellation (a session-transition cancel while executing, an ordinary cancel otherwise), aborts the session, and finishes the prompt with `cancelled`. Cancel cleanup is bounded; if it times out, the managed session is closed. Session transitions (new, resumed, forked, and extension-driven in-place new sessions) quiesce and release the run's coordinator before the session identity changes.

### RPC

A `/council` prompt response is **held** until the run produces its terminal command output, so a normal completion emits the kickoff and terminal output bytes before exactly one correlated response for the original request.

The hold does **not** occupy the serial input queue. It is a per-prompt response barrier: `handleCommand` produces the correlated response, a background response operation waits for the held completion and emits it, and the dispatcher moves on. Later frames keep being processed and answered while the original prompt response is still pending, so `abort`, `/council cancel`, `new_session`, `switch_session`, `branch`, and `handoff` all continue to work during a paid run.

**Responses may therefore arrive out of request order. Clients must correlate by id.** No Council-specific control frame exists or is needed.

- **Cancellation.** Send `/council cancel` (or `abort`) as an ordinary frame. Its response can overtake the held one, and cancellation is processed before the original prompt response settles.
- **Session transitions.** A transition quiesces the bound coordinator before the session id changes. If quiescence times out, the transition rethrows and the old session identity is preserved rather than half-mutated.
- **Shutdown.** `pi.shutdown()` requests bounded Council quiescence as a pre-drain step (draining first would wait on the very run being ended), then drains the response operations, disposes, and exits. Clean quiescence lets the held completion settle on its own, so terminal command output still precedes the response. If quiescence fails or times out, the failure is recorded, the held barriers are released so shutdown cannot deadlock, owed protocol output is drained, and fatal disposal continues.
- **Stdin EOF.** Side channels are closed, then the accepted serial queue is drained *before* Council is quiesced. A `/council` frame can still be parked behind a slow accepted command when stdin closes; quiescing first would find no run, latch, and then let the drained frame start one whose held response nothing would ever release. Serial drain is bounded (a `/council` prompt responds as soon as it schedules its barrier), so once it returns nothing new can start. Council is then quiesced (abandoning held barriers if it times out), the response operations are drained, and the session is disposed. There is no remaining client obligation after EOF.
- **Teardown failure.** A dispose that rethrows a captured transition failure completes the rest of session teardown first, then exits nonzero. It is reported through the centralized logger; stdout stays pure protocol.

Any future host that calls the shared `/council` handler must install the same session-transition reconciliation and explicitly own its `holdTurn` response semantics.
