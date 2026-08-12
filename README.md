# AI Agent Workflow Builder

A mini n8n for chaining AI agent steps, built on nhost (Postgres + Hasura +
Auth + Functions) with a Next.js frontend. See `docs/WRITEUP.md` for the
schema/permissions/approval-gate design reasoning.

## What's implemented

- Full schema: `organizations`, `org_members`, `workflows`, `workflow_steps`,
  `workflow_triggers`, `workflow_runs`, `step_runs`, `workflow_outputs`, plus
  an `org_usage_view` aggregation.
- Two Hasura permission layers (org+role scoping, and step-type gating) —
  see `nhost/metadata/databases/default/tables/*.yaml`.
- `triggerWorkflowRun` Action: auth + quota check, creates the run, executes
  `llm_call` / `http_request` / `db_write` / `conditional_branch` /
  `approval_gate` steps in order with retry on the network-calling steps.
- `approveStep` Action: does the mid-execution role check in code, resumes
  a paused run.
- `webhookTrigger` Action: unauthenticated inbound endpoint for the Webhook
  trigger type, gated by a per-trigger secret.
- `notify` implemented as a genuine Hasura Event Trigger (`on_notify_step_running`)
  → `functions/notifyStepHandler.ts`.
- Scheduled trigger (`functions/scheduledRun.ts`, meant to be registered as
  an nhost Scheduled Function) and a dynamic database-event trigger
  (`functions/registerDatabaseEventTrigger.ts` + `databaseEventStart.ts`)
  that can watch any table the user configures.
- Next.js frontend: auth, org switcher, workflow builder, run button,
  live per-step status via subscription (including pause/approve UI), and a
  quota indicator.

## Prerequisites

- Node.js 18+
- [nhost CLI](https://docs.nhost.io/reference/cli/installation) (`npm i -g nhost`)
- Docker (the nhost CLI runs Postgres/Hasura locally in containers)

## 1. Local backend setup

```bash
cd nhost
cp .env.example .env        # fill in ACTION_SECRET / HASURA_GRAPHQL_ADMIN_SECRET
                             # (any random strings for local dev)
                             # LLM_PROVIDER=stub works with no API key at all
nhost up
```

This applies the migration in `migrations/default/1700000000000_init/` and
the metadata in `metadata/`, giving you a running Postgres + Hasura + Auth
stack, and serves the functions in `functions/` locally.

Open the local Hasura console (URL printed by `nhost up`) to confirm the
tables, relationships, and permissions loaded.

### Register the notify event trigger's secret & LLM key

Both live in `nhost/.env` — `ACTION_SECRET` authenticates calls between
Hasura and the functions, `LLM_API_KEY`/`LLM_PROVIDER` picks the real LLM
(Groq, OpenRouter, or Gemini free tier) for `llm_call` steps. Leaving
`LLM_PROVIDER=stub` uses a disclosed 800ms-delay stub instead — see
`functions/lib/llm.ts`.

## 2. Frontend setup

```bash
cd frontend
cp .env.example .env.local  # NEXT_PUBLIC_NHOST_SUBDOMAIN / _REGION
npm install
npm run dev
```

For local dev against `nhost up`, use the subdomain/region nhost CLI prints
(usually `localhost` / not applicable — the CLI's local mode exposes a
direct GraphQL URL; see nhost's docs for wiring `NhostClient` to a local
backend vs a cloud project).

## 3. Seeding two orgs for the Final Task demo

1. Sign up two (or three) users through the frontend's `/login` page.
2. Find their `auth.users.id` values in the Hasura console.
3. Edit `nhost/seeds/default/seed.sql` with those IDs and run it against
   your local Postgres (`nhost up` prints the connection string), or paste
   it into the Hasura console's SQL tab.

This gives you Org A (owner + editor) and Org B (a separate owner) —
exactly the setup the Final Task scenario needs.

## 4. Deploying

- Push this repo, create an nhost Cloud project, link it (`nhost link`),
  and `nhost deploy` to push migrations/metadata/functions.
- Deploy `frontend/` to Vercel, pointing its env vars at the deployed nhost
  project's subdomain/region.
- In the Hasura console for the deployed project, double check the Action
  handler URLs resolved to your deployed Functions URL (nhost usually
  templates `{{NHOST_FUNCTIONS_URL}}` automatically on deploy).

## 5. Demoing the Final Task scenario

1. As Org A's owner, build a workflow with an `llm_call` step, an
   `http_request` step, and a `conditional_branch` step whose `config.field`
   points at the `llm_call` step's output (e.g. `{"field": "text", "equals": "yes"}`).
2. Add an `approval_gate` step.
3. Add a `scheduled` or `webhook` trigger in addition to using the manual
   **Run** button, and show both starting a run.
4. Click **Run** — watch the subscription-driven status stream live,
   including the `paused` state when it hits the approval gate.
5. Approve the step as the Org A owner/editor — watch it resume and
   complete, and watch `quota_used` increment.
6. Log in as the Org B user and confirm: Org A's workflows don't appear in
   the list, `/workflows/<org-a-workflow-id>` (typed directly) returns "not
   found," and calling `approveStep` on an Org A `step_run_id` returns 404 —
   not a 403 that would leak that the ID is valid.

## Notes on what's stubbed vs real

- `llm_call` hits a real API (Groq/OpenRouter/Gemini) when `LLM_API_KEY` is
  set; otherwise a disclosed artificial-delay stub, per the assignment's
  explicit allowance.
- `notify` sends to a real Slack incoming webhook if `SLACK_WEBHOOK_URL` is
  set; otherwise it logs and marks the step succeeded (stub, disclosed in
  code).
- `http_request` always makes a real outbound call to whatever URL the step
  config specifies.
