import type { Request, Response } from "express";
import { gqlAdmin } from "./lib/db";
import { advanceRun } from "./lib/steps";

// Webhook target for the `on_notify_step_running` Hasura Event Trigger on
// step_runs (see nhost/metadata/databases/default/tables/public_step_runs.yaml).
// This is what makes `notify` "implemented as an Event Trigger" rather than
// inline code inside the Action: the runner just flips the row to
// status='running', and this handler — invoked by the database event, not
// by the runner directly — does the actual send and then resumes the chain.
export default async (req: Request, res: Response) => {
  if (req.headers["x-hasura-event-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const event = req.body?.event;
  const stepRun = event?.data?.new;
  if (!stepRun || stepRun.type !== "notify" || stepRun.status !== "running") {
    // Not the row/state combination we care about — ack and ignore.
    return res.status(200).json({ ignored: true });
  }

  const stepData = await gqlAdmin<{ workflow_steps_by_pk: { config: Record<string, any> } }>(
    `query ($id: uuid!) { workflow_steps_by_pk(id: $id) { config } }`,
    { id: stepRun.workflow_step_id }
  );
  const config = stepData.workflow_steps_by_pk?.config ?? {};

  try {
    await sendNotification(config, stepRun.input);
    await gqlAdmin(
      `mutation ($id: uuid!) {
        update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "succeeded", output: {sent: true}, completed_at: now()}) { id }
      }`,
      { id: stepRun.id }
    );
  } catch (err: any) {
    await gqlAdmin(
      `mutation ($id: uuid!, $error: String) {
        update_step_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error, completed_at: now()}) { id }
      }`,
      { id: stepRun.id, error: String(err?.message || err) }
    );
    await gqlAdmin(
      `mutation ($id: uuid!, $error: String) {
        update_workflow_runs_by_pk(pk_columns: {id: $id}, _set: {status: "failed", error: $error, completed_at: now()}) { id }
      }`,
      { id: stepRun.workflow_run_id, error: String(err?.message || err) }
    );
    return res.status(200).json({ ok: false });
  }

  // Continue executing the rest of the workflow now that the alert is sent.
  await advanceRun(stepRun.workflow_run_id);
  return res.status(200).json({ ok: true });
};

async function sendNotification(config: Record<string, any>, input: any) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const message = config.message || `Workflow notification: ${JSON.stringify(input).slice(0, 500)}`;

  if (!webhookUrl) {
    // Disclosed stub — same pattern as the LLM stub fallback.
    console.log("[STUBBED NOTIFY]", message);
    return;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status}`);
}
