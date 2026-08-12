import type { Request, Response } from "express";
import { gqlAdmin, getMembership } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Hasura Action handler for: mutation { triggerWorkflowRun(workflow_id: uuid!) }
//
// Responsibilities (per spec):
//   1. Verify the caller is owner/editor in the workflow's org
//   2. Check the org's quota isn't exhausted
//   3. Create the workflow_run, then execute steps in order
//   4. Increment quota usage on completion (done inside advanceRun)
export default async (req: Request, res: Response) => {
  if (req.headers["x-action-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const userId = req.body?.session_variables?.["x-hasura-user-id"];
  const { workflow_id } = req.body?.input ?? {};

  if (!userId) return res.status(401).json({ message: "no authenticated user" });
  if (!workflow_id) return res.status(400).json({ message: "workflow_id is required" });

  const wfData = await gqlAdmin<{ workflows_by_pk: { id: string; org_id: string; is_active: boolean } | null }>(
    `query ($id: uuid!) { workflows_by_pk(id: $id) { id org_id is_active } }`,
    { id: workflow_id }
  );
  const workflow = wfData.workflows_by_pk;
  // Same 404-for-unauthorized shape as a real permission filter would give —
  // an Org B caller guessing an Org A workflow_id gets "not found", not a
  // 403 that would confirm the ID is valid.
  if (!workflow) return res.status(404).json({ message: "workflow not found" });

  // 1. Layer 1 check, re-verified in code because this handler runs with
  //    the admin secret (Hasura's declarative permissions don't apply here).
  const membership = await getMembership(userId, workflow.org_id);
  if (!membership || !["owner", "editor"].includes(membership.role)) {
    return res.status(404).json({ message: "workflow not found" });
  }

  // 2. Quota check
  const orgData = await gqlAdmin<{ organizations_by_pk: { quota_limit: number; quota_used: number } }>(
    `query ($id: uuid!) { organizations_by_pk(id: $id) { quota_limit quota_used } }`,
    { id: workflow.org_id }
  );
  const org = orgData.organizations_by_pk;
  if (org.quota_used >= org.quota_limit) {
    return res.status(403).json({ message: "organization quota exhausted for this period" });
  }

  // 3. Create the run
  const createData = await gqlAdmin<{ insert_workflow_runs_one: { id: string } }>(
    `mutation ($workflowId: uuid!, $orgId: uuid!, $userId: uuid!) {
      insert_workflow_runs_one(object: {
        workflow_id: $workflowId, org_id: $orgId, status: "pending",
        trigger_type: "manual", triggered_by: $userId
      }) { id }
    }`,
    { workflowId: workflow_id, orgId: workflow.org_id, userId }
  );
  const runId = createData.insert_workflow_runs_one.id;

  // 4. Execute. For a demo-scale workflow this finishes within the request;
  //    a production version would enqueue this and return immediately,
  //    with the subscription being the only thing the client waits on.
  const result = await advanceRun(runId);

  return res.status(200).json({ workflow_run_id: runId, status: result.status });
};
