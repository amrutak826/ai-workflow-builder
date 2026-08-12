import { gqlAdmin } from "./db";
import { callLlm } from "./llm";

type Step = {
  id: string;
  step_order: number;
  type: string;
  name: string | null;
  config: Record<string, any>;
};

type StepRun = {
  id: string;
  workflow_step_id: string;
  step_order: number;
  status: string;
  output: any;
  attempt_count: number;
};

const MAX_ATTEMPTS = 2; // "at least one retry on failure"

/** Advances a workflow_run as far as it can go: runs steps in order until
 *  it hits a failure, an approval_gate (pause), a notify step (delegate to
 *  event trigger), or the end (complete). Safe to call repeatedly — it
 *  always resumes from the first step that hasn't reached a terminal
 *  state, so triggerWorkflowRun, approveStep, and notifyStepHandler all
 *  share this one code path. */
export async function advanceRun(workflowRunId: string): Promise<{ status: string }> {
  const data = await gqlAdmin<{
    workflow_runs_by_pk: { id: string; workflow_id: string; org_id: string; status: string };
  }>(
    `query ($id: uuid!) {
      workflow_runs_by_pk(id: $id) { id workflow_id org_id status }
    }`,
    { id: workflowRunId }
  );
  const run = data.workflow_runs_by_pk;
  if (!run) throw new Error("workflow_run not found");
  if (["completed", "failed", "cancelled"].includes(run.status)) return { status: run.status };

  const stepsData = await gqlAdmin<{ workflow_steps: Step[] }>(
    `query ($wfId: uuid!) {
      workflow_steps(where: { workflow_id: { _eq: $wfId } }, order_by: { step_order: asc }) {
        id step_order type name config
      }
    }`,
    { wfId: run.workflow_id }
  );
  const steps = stepsData.workflow_steps;

  const stepRunsData = await gqlAdmin<{ step_runs: StepRun[] }>(
    `query ($runId: uuid!) {
      step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { step_order: asc }) {
        id workflow_step_id step_order status output attempt_count
      }
    }`,
    { runId: workflowRunId }
  );
  const existingByStepId = new Map(stepRunsData.step_runs.map((sr) => [sr.workflow_step_id, sr]));

  // context carried between steps: last step's output + last branch decision
  let lastOutput: any = null;
  let branchDecision: string | null = null;
  for (const sr of stepRunsData.step_runs) {
    if (sr.status === "succeeded") lastOutput = sr.output;
  }

  await setRunStatus(workflowRunId, "running");

  for (const step of steps) {
    let sr = existingByStepId.get(step.id);

    if (sr && ["succeeded", "skipped"].includes(sr.status)) {
      if (sr.status === "succeeded") lastOutput = sr.output;
      if (step.type === "conditional_branch" && sr.output?.branch) branchDecision = sr.output.branch;
      continue;
    }

    // conditional skip: a step can declare config.run_if = "true" | "false"
    // to only execute on a given upstream branch decision
    if (step.config?.run_if && branchDecision !== null && step.config.run_if !== branchDecision) {
      sr = await upsertStepRun(sr, workflowRunId, step, "skipped", { skipped_reason: "branch_not_taken" });
      continue;
    }

    if (sr && sr.status === "paused") {
      // approval_gate still awaiting approval — stop here.
      return { status: "paused" };
    }

    if (sr && sr.status === "running" && step.type === "notify") {
      // delegated to the event trigger webhook — stop here, it will
      // call advanceRun again once the notification is sent.
      return { status: "running" };
    }

    // ---- execute the step ----
    sr = await upsertStepRun(sr, workflowRunId, step, "running", null, { input: lastOutput });

    if (step.type === "approval_gate") {
      await markStepRun(sr.id, "paused", { note: "awaiting approval" }, null);
      await setRunStatus(workflowRunId, "paused");
      return { status: "paused" };
    }

    if (step.type === "notify") {
      // Leave status = 'running'. The `on_notify_step_running` Hasura
      // Event Trigger fires on this update and calls
      // functions/notifyStepHandler.ts, which sends the alert and then
      // calls advanceRun() again to continue the chain.
      return { status: "running" };
    }

    try {
      const output = await executeStep(step, lastOutput, sr, workflowRunId);
      await markStepRun(sr.id, "succeeded", output, null);
      lastOutput = output;
      if (step.type === "conditional_branch") branchDecision = output.branch;
    } catch (err: any) {
      await markStepRun(sr.id, "failed", null, String(err?.message || err));
      await setRunStatus(workflowRunId, "failed", String(err?.message || err));
      return { status: "failed" };
    }
  }

  await completeRun(run.org_id, workflowRunId);
  return { status: "completed" };
}

async function executeStep(step: Step, input: any, sr: StepRun, workflowRunId: string): Promise<any> {
  switch (step.type) {
    case "llm_call":
      return withRetry(sr.id, async () => {
        const prompt = renderTemplate(step.config.prompt || "{{input}}", input);
        const result = await callLlm(prompt, step.config);
        return { text: result.text, provider: result.provider, stubbed: result.stubbed };
      });

    case "http_request":
      return withRetry(sr.id, async () => {
        const url = renderTemplate(step.config.url, input);
        const res = await fetch(url, {
          method: step.config.method || "GET",
          headers: step.config.headers || {},
          body: step.config.method && step.config.method !== "GET" ? JSON.stringify(step.config.body ?? input) : undefined,
        });
        const bodyText = await res.text();
        let parsed: any;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          parsed = bodyText;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
        return { status: res.status, body: parsed };
      });

    case "db_write": {
      await gqlAdmin(
        `mutation ($runId: uuid!, $stepRunId: uuid!, $data: jsonb!) {
          insert_workflow_outputs_one(object: { workflow_run_id: $runId, step_run_id: $stepRunId, data: $data }) { id }
        }`,
        { runId: workflowRunId, stepRunId: sr.id, data: input ?? {} }
      );
      return { written: true };
    }

    case "conditional_branch": {
      const field = step.config.field || "text";
      const value = getPath(input, field);
      const matches = String(value) === String(step.config.equals);
      return { branch: matches ? "true" : "false", evaluated_field: field, value };
    }

    default:
      throw new Error(`Unsupported step type in executeStep: ${step.type}`);
  }
}

async function withRetry<T>(stepRunId: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await gqlAdmin(
        `mutation ($id: uuid!, $n: Int!) { update_step_runs_by_pk(pk_columns: {id: $id}, _set: {attempt_count: $n}) { id } }`,
        { id: stepRunId, n: attempt }
      );
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

function renderTemplate(tpl: string, input: any): string {
  if (!tpl) return "";
  return tpl.replace(/\{\{\s*input(\.[a-zA-Z0-9_.]+)?\s*\}\}/g, (_m, path) => {
    if (!path) return typeof input === "string" ? input : JSON.stringify(input);
    const val = getPath(input, path.slice(1));
    return val === undefined ? "" : String(val);
  });
}

function getPath(obj: any, path: string) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function upsertStepRun(
  existing: StepRun | undefined,
  workflowRunId: string,
  step: Step,
  status: string,
  output: any = null,
  extra: Record<string, any> = {}
): Promise<StepRun> {
  if (existing) {
    const data = await gqlAdmin<{ update_step_runs_by_pk: StepRun }>(
      `mutation ($id: uuid!, $status: String!, $output: jsonb) {
        update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output: $output, started_at: now()}) {
          id workflow_step_id step_order status output attempt_count
        }
      }`,
      { id: existing.id, status, output }
    );
    return data.update_step_runs_by_pk;
  }
  const data = await gqlAdmin<{ insert_step_runs_one: StepRun }>(
    `mutation ($runId: uuid!, $stepId: uuid!, $order: Int!, $type: String!, $status: String!, $output: jsonb, $input: jsonb) {
      insert_step_runs_one(object: {
        workflow_run_id: $runId, workflow_step_id: $stepId, step_order: $order,
        type: $type, status: $status, output: $output, input: $input, started_at: now()
      }) { id workflow_step_id step_order status output attempt_count }
    }`,
    { runId: workflowRunId, stepId: step.id, order: step.step_order, type: step.type, status, output, input: extra.input ?? null }
  );
  return data.insert_step_runs_one;
}

async function markStepRun(id: string, status: string, output: any, error: string | null) {
  await gqlAdmin(
    `mutation ($id: uuid!, $status: String!, $output: jsonb, $error: String) {
      update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: $status, output: $output, error: $error, completed_at: now()}) { id }
    }`,
    { id, status, output, error }
  );
}

async function setRunStatus(runId: string, status: string, error: string | null = null) {
  await gqlAdmin(
    `mutation ($id: uuid!, $status: String!, $error: String) {
      update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {
        status: $status, error: $error,
        started_at: now()
      }) { id }
    }`,
    { id: runId, status, error }
  );
}

async function completeRun(orgId: string, runId: string) {
  await gqlAdmin(
    `mutation ($id: uuid!) {
      update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "completed", completed_at: now()}) { id }
    }`,
    { id: runId }
  );
  // Increment org quota usage on completion, per spec.
  await gqlAdmin(
    `mutation ($orgId: uuid!) {
      update_organizations_by_pk(pk_columns: {id: $orgId}, _inc: {quota_used: 1}) { id }
    }`,
    { orgId }
  );
}
