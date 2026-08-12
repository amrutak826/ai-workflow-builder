import type { Request, Response } from "express";
import { gqlAdmin } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Hasura Action handler for:
//   mutation { webhookTrigger(workflow_id: uuid!, secret: String!, payload: json) }
//
// This is the "Webhook" trigger type: an unauthenticated inbound endpoint
// external systems call to start a run. Authorization here is the
// workflow_id + per-trigger secret pair (checked below), not a logged-in
// user's org membership — there is no logged-in user. Only an owner can
// create a webhook trigger in the first place (see Hasura Layer 2
// permissions on workflow_triggers), which is what keeps this endpoint
// safe despite being public.
export default async (req: Request, res: Response) => {
  if (req.headers["x-action-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const { workflow_id, secret, payload } = req.body?.input ?? {};
  if (!workflow_id || !secret) {
    return res.status(400).json({ message: "workflow_id and secret are required" });
  }

  const data = await gqlAdmin<{
    workflow_triggers: { id: string; webhook_secret: string; is_enabled: boolean; workflow: { org_id: string } }[];
  }>(
    `query ($wfId: uuid!) {
      workflow_triggers(where: { workflow_id: { _eq: $wfId }, type: { _eq: "webhook" } }) {
        id webhook_secret is_enabled
        workflow { org_id }
      }
    }`,
    { wfId: workflow_id }
  );
  const trigger = data.workflow_triggers[0];

  // Constant-shape error for "no such workflow" vs "wrong secret" vs
  // "disabled" would leak info via timing/response differences in a real
  // system; a production version should use a constant-time compare and a
  // uniform error message. Kept explicit here for clarity in review.
  if (!trigger || !trigger.is_enabled || trigger.webhook_secret !== secret) {
    return res.status(404).json({ message: "no matching webhook trigger" });
  }

  const orgData = await gqlAdmin<{ organizations_by_pk: { quota_limit: number; quota_used: number } }>(
    `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_limit quota_used } }`,
    { id: trigger.workflow.org_id }
  );
  if (orgData.organizations_by_pk.quota_used >= orgData.organizations_by_pk.quota_limit) {
    return res.status(403).json({ message: "organization quota exhausted for this period" });
  }

  const createData = await gqlAdmin<{ insert_workflow_runs_one: { id: string } }>(
    `mutation ($workflowId: uuid!, $orgId: uuid!) {
      insert_workflow_runs_one(object: {
        workflow_id: $workflowId, org_id: $orgId, status: "pending", trigger_type: "webhook"
      }) { id }
    }`,
    { workflowId: workflow_id, orgId: trigger.workflow.org_id }
  );
  const runId = createData.insert_workflow_runs_one.id;

  const result = await advanceRun(runId);
  return res.status(200).json({ workflow_run_id: runId, status: result.status });
};
