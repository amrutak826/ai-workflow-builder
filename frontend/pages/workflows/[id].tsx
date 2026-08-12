import { useState } from "react";
import { useRouter } from "next/router";
import { useQuery, useMutation } from "urql";
import { useAuthenticationStatus } from "@nhost/nextjs";
import { useMyOrgs } from "../../lib/useMyOrgs";
import { StepEditor } from "../../components/StepEditor";
import { TriggerEditor } from "../../components/TriggerEditor";
import { RunPanel } from "../../components/RunPanel";
import Login from "../login";

const WORKFLOW_DETAIL = `
  query WorkflowDetail($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      description
      org_id
      steps(order_by: { step_order: asc }) {
        id
        step_order
        type
        name
        config
      }
      triggers {
        id
        type
        is_enabled
        config
      }
    }
  }
`;

const TRIGGER_RUN = `
  mutation TriggerRun($workflowId: uuid!) {
    triggerWorkflowRun(workflow_id: $workflowId) {
      workflow_run_id
      status
    }
  }
`;

export default function WorkflowPage() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  if (isLoading) return null;
  if (!isAuthenticated) return <Login />;
  return <WorkflowInner />;
}

function WorkflowInner() {
  const router = useRouter();
  const id = router.query.id as string;
  const { orgs } = useMyOrgs();

  const [result] = useQuery({ query: WORKFLOW_DETAIL, variables: { id }, pause: !id });
  const [, triggerRun] = useMutation(TRIGGER_RUN);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);

  const wf = result.data?.workflows_by_pk;
  const myRole = orgs.find((o) => o.id === wf?.org_id)?.role ?? "viewer";
  const canEdit = myRole === "owner" || myRole === "editor";

  async function handleRun() {
    setTriggering(true);
    const res = await triggerRun({ workflowId: id });
    setTriggering(false);
    if (res.error) {
      alert(res.error.message);
      return;
    }
    setActiveRunId(res.data.triggerWorkflowRun.workflow_run_id);
  }

  if (result.fetching) return <p style={{ padding: 40 }}>Loading...</p>;
  if (!wf) return <p style={{ padding: 40 }}>Workflow not found (or you don't have access to it).</p>;

  return (
    <div style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <button onClick={() => router.push("/")} style={{ background: "transparent", padding: 0, marginBottom: 12 }}>← back</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>{wf.name}</h1>
        {myRole !== "viewer" && (
          <button onClick={handleRun} disabled={triggering} style={{ background: "#15803d", color: "white" }}>
            {triggering ? "Starting…" : "▶ Run"}
          </button>
        )}
      </div>
      {wf.description && <p style={{ opacity: 0.7 }}>{wf.description}</p>}

      <StepEditor workflowId={id} steps={wf.steps} canEdit={canEdit} myRole={myRole} />
      <TriggerEditor workflowId={id} triggers={wf.triggers} myRole={myRole} />

      {activeRunId && <RunPanel runId={activeRunId} canApprove={myRole === "owner" || myRole === "editor"} />}
    </div>
  );
}
