# Write-up

## Schema reasoning

The schema follows the required chain `org → members → workflows → steps/triggers`
and `workflow → runs → step_runs` directly. A few deliberate choices:

- **`workflow_runs.org_id` is denormalized** (copied from `workflows.org_id` at
  creation) rather than requiring a join through `workflows` for every
  permission check. Every run and step-run permission filter — and the
  subscription that drives the live UI — needs to answer "is this org
  member allowed to see this row" as cheaply as possible; denormalizing
  saves a hop through `workflows` → `organizations` on the hottest query
  path in the app.
- **`step_runs` is separate from `workflow_steps`** because a step is a
  *definition* (reused every run) and a step_run is one *execution* of it —
  they need independent lifecycles (attempt_count, approval, output) without
  mutating the workflow's design.
- **`workflow_outputs` is a separate table from `step_runs.output`** so that
  `db_write` steps have a place to persist structured results that outlives
  a single run's step_run rows conceptually (e.g. for later reporting),
  while `step_runs.output` stays a generic "whatever this step produced"
  bucket for every step type.
- **`org_usage_view`** is a Postgres view (not a computed field) so the
  aggregation (quota + avg run duration) can be tracked once, permissioned
  once, and queried like any other table via `org_usage_view(where: ...)`,
  rather than living behind a bespoke Action.

## Two permission layers, enforced differently

**Layer 1 (org + role scoping)** is pure Hasura declarative permissions.
Every select/insert/update/delete permission on `workflows`, `workflow_steps`,
`workflow_triggers`, `workflow_runs`, and `step_runs` filters through a
relationship chain back to `org_members` and checks
`user_id = X-Hasura-User-Id`. Because the filter always goes through the
row's *own* org relationship — never a client-supplied org_id — an editor
in Org A gets zero rows back for Org B data even if they know Org B's
workflow UUID and query it directly. This is why it's airtight against ID
guessing: the check isn't "does the org_id match a value I was told," it's
"does a membership row exist for *this specific row's* org and *this*
caller," evaluated inside Postgres by Hasura on every request.

**Layer 2 (step-level gating)** is split across two mechanisms depending on
whether the decision is a simple row check or a mid-execution one:
- For `db_write`/`notify` steps and `webhook` triggers, it's still a Hasura
  declarative permission — `insert_permissions.check` on `workflow_steps`
  and `workflow_triggers` branches on the `type` column, requiring `owner`
  for those specific types and `owner`/`editor` for the rest. This is
  enforceable as a row check because "can this row be inserted" only needs
  the row's own data plus the caller's membership.
- For resuming an `approval_gate`, a row permission can't work: whether to
  resume depends on *which specific row* is currently paused, requires
  writing to `workflow_runs`/`step_runs` (tables `user` has no
  insert/update permission on, on purpose — see below), and needs to make
  a decision, not just permit a write. So `approveStep` is a Hasura Action
  backed by a Node function that runs with the admin secret, re-derives the
  caller's org membership via `getMembership()`, and only proceeds if their
  role is `owner`/`editor`, before touching any row.

## Approval-gate pause/resume

`workflow_runs` and `step_runs` intentionally have **no insert/update
permission for the `user` role** — the only way to mutate them is through
the two Actions, which run as admin and do their own authorization first.
The shared execution engine (`advanceRun`, in `functions/lib/steps.ts`)
walks a workflow's steps in order, resuming from the first step that
hasn't reached a terminal status. When it hits an `approval_gate` step it
sets that step_run to `paused`, sets the `workflow_run` to `paused`, and
returns — it does not loop further. `approveStep` checks the caller's role,
and on approval marks that step_run `succeeded` and calls `advanceRun`
again, which picks up exactly where it left off (every already-succeeded
step is skipped by its stored status). The live subscription on `step_runs`
picks up both the `paused` state and every subsequent status change with no
polling, because it's a genuine GraphQL subscription rather than
client-side refetching.
