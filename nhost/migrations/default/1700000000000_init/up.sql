-- AI Agent Workflow Builder — core schema
-- Assumes nhost's built-in `auth.users` table exists for user identity.

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────
-- organizations
-- ────────────────────────────────────────────────────────────────
create table public.organizations (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  quota_limit       integer not null default 1000,
  quota_used        integer not null default 0,
  quota_period_start date not null default date_trunc('month', now()),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- org_members — links a user to an org with a role
-- ────────────────────────────────────────────────────────────────
create table public.org_members (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index idx_org_members_user on public.org_members(user_id);
create index idx_org_members_org on public.org_members(org_id);

-- ────────────────────────────────────────────────────────────────
-- workflows
-- ────────────────────────────────────────────────────────────────
create table public.workflows (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null,
  description  text,
  created_by   uuid not null references auth.users(id),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_workflows_org on public.workflows(org_id);

-- ────────────────────────────────────────────────────────────────
-- workflow_steps — ordered steps belonging to a workflow
-- ────────────────────────────────────────────────────────────────
create table public.workflow_steps (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  step_order    integer not null,
  type          text not null check (type in
                  ('llm_call','http_request','db_write','notify','conditional_branch','approval_gate')),
  name          text,
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (workflow_id, step_order)
);

create index idx_steps_workflow on public.workflow_steps(workflow_id);

-- ────────────────────────────────────────────────────────────────
-- workflow_triggers
-- ────────────────────────────────────────────────────────────────
create table public.workflow_triggers (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  type          text not null check (type in ('manual','webhook','scheduled','database_event')),
  config        jsonb not null default '{}'::jsonb,   -- cron expr, watched table, etc.
  webhook_secret text,                                 -- set only for type = webhook
  is_enabled    boolean not null default true,
  created_at    timestamptz not null default now()
);

create index idx_triggers_workflow on public.workflow_triggers(workflow_id);

-- ────────────────────────────────────────────────────────────────
-- workflow_runs — one per execution
-- ────────────────────────────────────────────────────────────────
create table public.workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  workflow_id   uuid not null references public.workflows(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade, -- denormalized for fast perms
  status        text not null default 'pending' check (status in
                  ('pending','running','paused','completed','failed','cancelled')),
  trigger_type  text not null check (trigger_type in ('manual','webhook','scheduled','database_event')),
  triggered_by  uuid references auth.users(id),
  started_at    timestamptz,
  completed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);

create index idx_runs_workflow on public.workflow_runs(workflow_id);
create index idx_runs_org on public.workflow_runs(org_id);

-- ────────────────────────────────────────────────────────────────
-- step_runs — one per step per run
-- ────────────────────────────────────────────────────────────────
create table public.step_runs (
  id               uuid primary key default gen_random_uuid(),
  workflow_run_id  uuid not null references public.workflow_runs(id) on delete cascade,
  workflow_step_id uuid not null references public.workflow_steps(id) on delete cascade,
  step_order       integer not null,
  type             text not null,
  status           text not null default 'pending' check (status in
                     ('pending','running','succeeded','failed','paused','skipped')),
  input            jsonb,
  output           jsonb,
  error            text,
  attempt_count    integer not null default 0,
  approved_by      uuid references auth.users(id),
  approved_at      timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index idx_step_runs_run on public.step_runs(workflow_run_id);

-- ────────────────────────────────────────────────────────────────
-- workflow_outputs — persisted results for db_write steps
-- ────────────────────────────────────────────────────────────────
create table public.workflow_outputs (
  id               uuid primary key default gen_random_uuid(),
  workflow_run_id  uuid not null references public.workflow_runs(id) on delete cascade,
  step_run_id      uuid not null references public.step_runs(id) on delete cascade,
  data             jsonb not null,
  created_at       timestamptz not null default now()
);

create index idx_outputs_run on public.workflow_outputs(workflow_run_id);

-- ────────────────────────────────────────────────────────────────
-- Aggregation: org usage view (calls used this month, avg run duration)
-- ────────────────────────────────────────────────────────────────
create view public.org_usage_view as
select
  o.id as org_id,
  o.quota_limit,
  o.quota_used,
  o.quota_limit - o.quota_used as quota_remaining,
  count(distinct wr.id) filter (
    where wr.created_at >= date_trunc('month', now())
  ) as runs_this_month,
  avg(extract(epoch from (wr.completed_at - wr.started_at)))
    filter (where wr.completed_at is not null and wr.started_at is not null) as avg_run_duration_seconds
from public.organizations o
left join public.workflow_runs wr on wr.org_id = o.id
group by o.id, o.quota_limit, o.quota_used;

-- ────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_org_updated before update on public.organizations
  for each row execute function public.set_updated_at();

create trigger trg_workflow_updated before update on public.workflows
  for each row execute function public.set_updated_at();
