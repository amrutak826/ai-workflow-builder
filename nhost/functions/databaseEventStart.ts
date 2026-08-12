import type { Request, Response } from "express";
import { gqlAdmin } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Webhook target for a *dynamically created* Hasura Event Trigger on
// whatever table the user picked for a 'database_event' workflow_trigger
// (see registerDatabaseEventTrigger.ts, called when that trigger type is
// saved from the frontend). The event trigger's payload always identifies
// the workflow_trigger row via a comment/config on creation — we pass the
// trigger id in the webhook URL query string so this one handler can serve
// every watched table without per-table code.
export default async (req: Request, res: Response) => {
  if (req.headers["x-hasura-event-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const workflowTriggerId = req.query.trigger_id as string;
  if (!workflowTriggerId) return res.status(400).json({ message: "missing trigger_id" });

  const data = await gqlAdmin<{
    workflow_triggers_by_pk: { id: string; workflow_id: string; is_enabled: boolean; workflow: { org_id: string } } | null;
  }>(
    `query ($id: uuid!) {
      workflow_triggers_by_pk(id: $id) {
        id workflow_id is_enabled
        workflow { org_id }
      }
    }`,
    { id: workflowTriggerId }
  );
  const trigger = data.workflow_triggers_by_pk;
  if (!trigger || !trigger.is_enabled) return res.status(200).json({ ignored: true });

  const orgData = await gqlAdmin<{ organizations_by_pk: { quota_limit: number; quota_used: number } }>(
    `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_limit quota_used } }`,
    { id: trigger.workflow.org_id }
  );
  if (orgData.organizations_by_pk.quota_used >= orgData.organizations_by_pk.quota_limit) {
    return res.status(200).json({ skipped: "quota_exhausted" });
  }

  const createData = await gqlAdmin<{ insert_workflow_runs_one: { id: string } }>(
    `mutation ($workflowId: uuid!, $orgId: uuid!) {
      insert_workflow_runs_one(object: {
        workflow_id: $workflowId, org_id: $orgId, status: "pending", trigger_type: "database_event"
      }) { id }
    }`,
    { workflowId: trigger.workflow_id, orgId: trigger.workflow.org_id }
  );

  await advanceRun(createData.insert_workflow_runs_one.id);
  return res.status(200).json({ workflow_run_id: createData.insert_workflow_runs_one.id });
};
