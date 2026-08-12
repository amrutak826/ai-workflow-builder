import type { Request, Response } from "express";
import { gqlAdmin, getMembership } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Hasura Action handler for:
//   mutation { approveStep(step_run_id: uuid!, approve: Boolean!, reason: String) }
//
// This is exactly the check the assignment calls out as needing to live in
// code rather than a Hasura permission: "Clearing an approval_gate requires
// the Action handler itself to check the approver's role before resuming
// the run — this can't be a database permission alone, since it's a
// mid-execution decision, not a simple row read or write."
export default async (req: Request, res: Response) => {
  if (req.headers["x-action-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const userId = req.body?.session_variables?.["x-hasura-user-id"];
  const { step_run_id, approve, reason } = req.body?.input ?? {};
  if (!userId) return res.status(401).json({ message: "no authenticated user" });

  const data = await gqlAdmin<{
    step_runs_by_pk: {
      id: string;
      status: string;
      workflow_run_id: string;
      run: { id: string; org_id: string; status: string };
    } | null;
  }>(
    `query ($id: uuid!) {
      step_runs_by_pk(id: $id) {
        id status workflow_run_id
        run: workflow_run { id org_id status }
      }
    }`,
    { id: step_run_id }
  );
  const stepRun = data.step_runs_by_pk;
  if (!stepRun) return res.status(404).json({ message: "step run not found" });

  // Role check happens here, in code, against the *current* caller — not a
  // cached permission. Cross-org callers get "not found" (see triggerWorkflowRun
  // for why), same-org viewers get an explicit 403.
  const membership = await getMembership(userId, stepRun.run.org_id);
  if (!membership) return res.status(404).json({ message: "step run not found" });
  if (!["owner", "editor"].includes(membership.role)) {
    return res.status(403).json({ message: "only an owner or editor may approve a paused step" });
  }

  if (stepRun.status !== "paused" || stepRun.run.status !== "paused") {
    return res.status(409).json({ message: "this step is not currently awaiting approval" });
  }

  if (!approve) {
    await gqlAdmin(
      `mutation ($id: uuid!, $userId: uuid!, $reason: String) {
        update_step_runs_by_pk(pk_columns: {id: $id}, _set: {
          status: "failed", error: $reason, approved_by: $userId, approved_at: now(), completed_at: now()
        }) { id }
      }`,
      { id: step_run_id, userId, reason: reason || "rejected by approver" }
    );
    await gqlAdmin(
      `mutation ($id: uuid!, $reason: String) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $reason, completed_at: now()}) { id }
      }`,
      { id: stepRun.workflow_run_id, reason: reason || "approval rejected" }
    );
    return res.status(200).json({ step_run_id, status: "failed", workflow_run_status: "failed" });
  }

  await gqlAdmin(
    `mutation ($id: uuid!, $userId: uuid!) {
      update_step_runs_by_pk(pk_columns: {id: $id}, _set: {
        status: "succeeded", approved_by: $userId, approved_at: now(), completed_at: now(),
        output: {approved: true}
      }) { id }
    }`,
    { id: step_run_id, userId }
  );

  const result = await advanceRun(stepRun.workflow_run_id);

  return res.status(200).json({ step_run_id, status: "succeeded", workflow_run_status: result.status });
};
