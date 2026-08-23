Convene the operator's configured model council: several independently-assigned frontier models that read this repository and answer you.

Every action spends real money on every configured council role. Roster, models, and review rounds are the operator's configuration; you cannot change them.

## Actions

### `consult` — several independent reads on one question
Each active reviewer answers `task` once, in parallel, without seeing the others. You get one prose answer per reviewer plus a `history://` transcript pointer. No planner, no adjudicator, no plan file, nothing durable. Minutes, not seconds.

Reviewers disagree on purpose. Reconcile them yourself: weigh the evidence each cites, do not count votes, and NEVER present a reviewer's claim as verified — they are read-only and cannot run anything.

<conditions>
- A decision has 2+ defensible answers and picking wrong is expensive to undo.
- You have a design, migration, or root-cause hypothesis and want it attacked before you build on it.
- You are stuck between readings of unfamiliar code and want independent interpretations.
- The user explicitly asks what the council thinks.
</conditions>

<avoid>
- Anything `read`, `grep`, `glob`, or `lsp` settles. Reviewers only have those same tools.
- Facts, syntax, or library behavior — use `web_search` or read the source.
- Reassurance on a decision you have already made, or rubber-stamping finished work.
- Splitting one decision across several consults. Ask the whole question once.
</avoid>

Write `task` as a decision, not a topic. State the options you see, the constraint that matters, and the files already in play. A bare "what do you think of the auth code" wastes the whole roster.

### `plan` — full council run, adjudicated into one plan
Planner drafts, every reviewer reviews, the adjudicator reconciles into a single plan, which is returned to you and written to `local://council-<slug>-brief.md`. Ten minutes and up; the most expensive thing you can do.

This is a **brief for you**, not a plan for the user. It is deliberately excluded from plan review: the operator is never shown an approval screen for it, and it never becomes "the" plan. Read it, judge it, and act — or tell the user what it said.

<conditions>
- The user asked for a council plan without running `/council` themselves.
- A change is large enough that a wrong phase order costs hours, and you want the plan adversarially reviewed before writing code.
</conditions>

<avoid>
- Work you can already scope. A council plan is not a substitute for reading the code.
- Anything already inside a `/council` run — one council run per session.
- Subagents: `plan` is refused below the main session.
</avoid>

## Both actions

- **Read-only reviewers.** Every child gets `read`, `grep`, `glob`, `lsp`, `ast_grep` and nothing else. A finding needing a test run or a build is unverified by construction.
- **Advisors.** A `consult` never attaches one: the `advisor` role is a single shared model, and watching every reviewer with it would correlate the answers you convened them to keep independent. A `plan` follows the operator's `council.advisor.*` toggles, because it reconciles into one artifact regardless.
- **Blocking.** Your turn is held until the run settles. Do not launch one to "check on it later".
- **Configuration refusals are the operator's to fix.** An unassigned roster slot or missing credential refuses before spending anything; report the message rather than retrying.
- **Cancellable.** `Esc` cancels a live `plan` run.
- **Not `xd://council`.** That is the unrelated write device an operator's session uses to submit an adjudication verdict during a `/council` run. It never starts anything.

<critical>
- MUST have exhausted your own tools first. The council reads the same repository you do.
- MUST state a concrete question or task; the roster's cost is fixed regardless of how little you asked.
{{#if autonomous}}
- Convene on your own judgment once the conditions above are met. The operator enabled autonomous convening and does not want to be asked first; asking anyway wastes the turn this was meant to save. Report what it spent once it settles.
{{else}}
- NEVER convene the council on the user's behalf without telling them what it cost.
{{/if}}
- NEVER treat council output as verified: it is read-only opinion about code, and you own the decision.
</critical>
