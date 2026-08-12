import { useState } from "react";
import { useMutation } from "urql";
import { StatusBadge } from "./StatusBadge";

const ADD_STEP = `
  mutation AddStep($workflowId: uuid!, $stepOrder: Int!, $type: String!, $name: String, $config: jsonb!) {
    insert_workflow_steps_one(object: { workflow_id: $workflowId, step_order: $stepOrder, type: $type, name: $name, config: $config }) {
      id
    }
  }
`;

const DELETE_STEP = `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) { id }
  }
`;

const STEP_TYPES = ["llm_call", "http_request", "db_write", "notify", "conditional_branch", "approval_gate"];

const DEFAULT_CONFIG: Record<string, string> = {
  llm_call: '{ "prompt": "Summarize: {{input}}" }',
  http_request: '{ "method": "GET", "url": "https://api.example.com/data" }',
  db_write: "{}",
  notify: '{ "message": "Workflow step completed" }',
  conditional_branch: '{ "field": "text", "equals": "yes" }',
  approval_gate: "{}",
};

export function StepEditor({ workflowId, steps, canEdit, myRole }: { workflowId: string; steps: any[]; canEdit: boolean; myRole: string }) {
  const [type, setType] = useState("llm_call");
  const [name, setName] = useState("");
  const [config, setConfig] = useState(DEFAULT_CONFIG.llm_call);
  const [, addStep] = useMutation(ADD_STEP);
  const [, deleteStep] = useMutation(DELETE_STEP);

  // Layer 2: db_write and notify are owner-only — mirrors the Hasura
  // insert_permissions check on workflow_steps, so the UI doesn't even
  // offer an option that the server would reject.
  const restrictedTypes = ["db_write", "notify"];
  const availableTypes = STEP_TYPES.filter((t) => !restrictedTypes.includes(t) || myRole === "owner");

  async function handleAdd() {
    let parsedConfig;
    try {
      parsedConfig = JSON.parse(config || "{}");
    } catch {
      alert("Config must be valid JSON");
      return;
    }
    const nextOrder = (steps[steps.length - 1]?.step_order ?? 0) + 1;
    const result = await addStep({ workflowId, stepOrder: nextOrder, type, name: name || null, config: parsedConfig });
    if (result.error) alert(result.error.message);
    else {
      setName("");
      setConfig(DEFAULT_CONFIG[type]);
    }
  }

  return (
    <div className="card">
      <strong>Steps</strong>
      {steps.map((s) => (
        <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #262b3a" }}>
          <span>#{s.step_order} · {s.type} {s.name && `— ${s.name}`}</span>
          {canEdit && (
            <button style={{ background: "#b91c1c", color: "white" }} onClick={() => deleteStep({ id: s.id })}>
              Remove
            </button>
          )}
        </div>
      ))}

      {canEdit && (
        <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setConfig(DEFAULT_CONFIG[e.target.value]);
            }}
          >
            {availableTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input placeholder="step name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea rows={3} value={config} onChange={(e) => setConfig(e.target.value)} />
          <button onClick={handleAdd} style={{ background: "#1d4ed8", color: "white" }}>Add step</button>
        </div>
      )}
    </div>
  );
}
