import { useState } from "react";
import { useMutation } from "urql";

const ADD_TRIGGER = `
  mutation AddTrigger($workflowId: uuid!, $type: String!, $config: jsonb!, $webhookSecret: String) {
    insert_workflow_triggers_one(object: { workflow_id: $workflowId, type: $type, config: $config, webhook_secret: $webhookSecret }) {
      id
      type
    }
  }
`;

function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function TriggerEditor({ workflowId, triggers, myRole }: { workflowId: string; triggers: any[]; myRole: string }) {
  const [type, setType] = useState("scheduled");
  const [cron, setCron] = useState("*/5 * * * *");
  const [table, setTable] = useState("");
  const [, addTrigger] = useMutation(ADD_TRIGGER);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  // webhook triggers are owner-only, mirroring the Layer 2 Hasura check.
  const canAddType = (t: string) => t !== "webhook" || myRole === "owner";

  async function handleAdd() {
    if (type === "webhook") {
      const secret = randomSecret();
      const result = await addTrigger({ workflowId, type, config: {}, webhookSecret: secret });
      if (result.error) alert(result.error.message);
      else setCreatedSecret(secret);
      return;
    }
    const config = type === "scheduled" ? { cron } : type === "database_event" ? { schema: "public", table } : {};
    const result = await addTrigger({ workflowId, type, config, webhookSecret: null });
    if (result.error) alert(result.error.message);
  }

  return (
    <div className="card">
      <strong>Triggers</strong>
      {triggers.map((t) => (
        <div key={t.id} style={{ padding: "6px 0", borderBottom: "1px solid #262b3a" }}>
          {t.type} {t.type === "scheduled" && `· ${t.config?.cron}`} {t.type === "database_event" && `· watching ${t.config?.table}`}
          {!t.is_enabled && " (disabled)"}
        </div>
      ))}

      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="scheduled">scheduled</option>
          {myRole === "owner" && <option value="webhook">webhook</option>}
          <option value="database_event">database_event</option>
        </select>
        {type === "scheduled" && (
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="cron: min hour day month weekday" />
        )}
        {type === "database_event" && (
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="table name to watch, e.g. leads" />
        )}
        <button disabled={!canAddType(type)} onClick={handleAdd} style={{ background: "#1d4ed8", color: "white" }}>
          Add trigger
        </button>
      </div>

      {createdSecret && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <p>Webhook created. Save this secret now — it isn't shown again:</p>
          <code style={{ display: "block", padding: 8, background: "#0f121a", borderRadius: 6, wordBreak: "break-all" }}>
            {createdSecret}
          </code>
          <p style={{ opacity: 0.7, marginTop: 6 }}>
            Call: <code>POST /v1/action/webhookTrigger {"{"} workflow_id, secret {"}"}</code>
          </p>
        </div>
      )}
    </div>
  );
}
