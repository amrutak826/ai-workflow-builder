// Called from a Hasura Event Trigger on workflow_triggers itself (insert,
// where type = 'database_event') OR directly from the frontend's "create
// trigger" flow. It uses Hasura's Metadata API (not the migrations CLI, so
// it works at runtime) to register a new event trigger on the table the
// user picked to watch, wired to databaseEventStart.ts.
//
// This keeps "watch table X" fully dynamic/user-configurable rather than
// hardcoding one watched table at build time — matches the assignment's
// "a row change in a watched table auto-starts a run" requirement for an
// arbitrary table.

import type { Request, Response } from "express";

const HASURA_URL = (process.env.GRAPHQL_ENDPOINT as string).replace(/\/v1\/graphql$/, "");
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET as string;
const FUNCTIONS_URL = process.env.NHOST_FUNCTIONS_URL as string;

export default async (req: Request, res: Response) => {
  if (req.headers["x-action-secret"] !== process.env.ACTION_SECRET) {
    return res.status(401).json({ message: "unauthorized" });
  }

  const { workflow_trigger_id, schema, table } = req.body ?? {};
  if (!workflow_trigger_id || !schema || !table) {
    return res.status(400).json({ message: "workflow_trigger_id, schema, and table are required" });
  }

  const metadataReq = {
    type: "pg_create_event_trigger",
    args: {
      source: "default",
      name: `db_event_${workflow_trigger_id.replace(/-/g, "")}`,
      table: { schema, name: table },
      insert: { columns: "*" },
      update: { columns: "*" },
      delete: { columns: "*" },
      webhook: `${FUNCTIONS_URL}/databaseEventStart?trigger_id=${workflow_trigger_id}`,
      headers: [{ name: "x-hasura-event-secret", value: process.env.ACTION_SECRET }],
      retry_conf: { num_retries: 3, interval_sec: 5, timeout_sec: 30 },
    },
  };

  const metaRes = await fetch(`${HASURA_URL}/v1/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-hasura-admin-secret": ADMIN_SECRET },
    body: JSON.stringify(metadataReq),
  });

  if (!metaRes.ok) {
    return res.status(500).json({ message: "failed to register event trigger", detail: await metaRes.text() });
  }

  return res.status(200).json({ registered: true });
};
