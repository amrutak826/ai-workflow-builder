import type { Request, Response } from "express";
import { gqlAdmin } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Registered in nhost as a Scheduled Function (see README) running on a
// cron schedule, e.g. every minute: "* * * * *". nhost calls this on that
// schedule; it looks for workflow_triggers of type 'scheduled' whose cron
// config says they're due, and starts a run for each.
//
// Cron matching is intentionally simple (exact minute match against
// config.cron as "* * * * *"-style fields) — good enough to demonstrate a
// real scheduled trigger without pulling in a cron-parsing dependency.
export default async (req: Request, res: Response) => {
  if (req.headers["x-action-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const now = new Date();
  const data = await gqlAdmin<{
    workflow_triggers: { id: string; workflow_id: string; config: Record<string, any>; workflow: { org_id: string } }[];
  }>(
    `query {
      workflow_triggers(where: { type: { _eq: "scheduled" }, is_enabled: { _eq: true } }) {
        id workflow_id config
        workflow { org_id }
      }
    }`
  );

  const started: string[] = [];
  for (const trigger of data.workflow_triggers) {
    if (!isDue(trigger.config.cron, now)) continue;

    const orgData = await gqlAdmin<{ organizations_by_pk: { quota_limit: number; quota_used: number } }>(
      `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_limit quota_used } }`,
      { id: trigger.workflow.org_id }
    );
    if (orgData.organizations_by_pk.quota_used >= orgData.organizations_by_pk.quota_limit) continue;

    const createData = await gqlAdmin<{ insert_workflow_runs_one: { id: string } }>(
      `mutation ($workflowId: uuid!, $orgId: uuid!) {
        insert_workflow_runs_one(object: {
          workflow_id: $workflowId, org_id: $orgId, status: "pending", trigger_type: "scheduled"
        }) { id }
      }`,
      { workflowId: trigger.workflow_id, orgId: trigger.workflow.org_id }
    );
    started.push(createData.insert_workflow_runs_one.id);
    await advanceRun(createData.insert_workflow_runs_one.id);
  }

  return res.status(200).json({ started });
};

/** Minimal 5-field cron matcher: "min hour day month weekday", '*' = any. */
function isDue(cron: string | undefined, now: Date): boolean {
  if (!cron) return false;
  const [min, hour, day, month, weekday] = cron.trim().split(/\s+/);
  const fields = [
    [min, now.getMinutes()],
    [hour, now.getHours()],
    [day, now.getDate()],
    [month, now.getMonth() + 1],
    [weekday, now.getDay()],
  ] as const;
  return fields.every(([f, v]) => f === "*" || Number(f) === v);
};
