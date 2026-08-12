import { useState } from "react";
import { useAuthenticationStatus, useSignOut } from "@nhost/nextjs";
import { useQuery, useMutation } from "urql";
import { useRouter } from "next/router";
import { useMyOrgs } from "../lib/useMyOrgs";
import Login from "./login";

const ORG_WORKFLOWS = `
  query OrgWorkflows($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      name
      description
      is_active
      runs(order_by: { created_at: desc }, limit: 1) {
        status
      }
    }
  }
`;

const ORG_USAGE = `
  query OrgUsage($orgId: uuid!) {
    org_usage_view(where: { org_id: { _eq: $orgId } }) {
      quota_limit
      quota_used
      quota_remaining
      runs_this_month
      avg_run_duration_seconds
    }
  }
`;

const CREATE_WORKFLOW = `
  mutation CreateWorkflow($orgId: uuid!, $name: String!) {
    insert_workflows_one(object: { org_id: $orgId, name: $name }) { id }
  }
`;

export default function Dashboard() {
  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  if (isLoading) return null;
  if (!isAuthenticated) return <Login />;
  return <DashboardInner />;
}

function DashboardInner() {
  const { orgs, fetching: orgsFetching } = useMyOrgs();
  const [orgId, setOrgId] = useState<string | null>(null);
  const router = useRouter();
  const { signOut } = useSignOut();

  const activeOrgId = orgId ?? orgs[0]?.id ?? null;
  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  const [wfResult] = useQuery({ query: ORG_WORKFLOWS, variables: { orgId: activeOrgId }, pause: !activeOrgId });
  const [usageResult] = useQuery({ query: ORG_USAGE, variables: { orgId: activeOrgId }, pause: !activeOrgId });
  const [, createWorkflow] = useMutation(CREATE_WORKFLOW);

  const usage = usageResult.data?.org_usage_view?.[0];

  async function handleCreate() {
    const name = prompt("Workflow name?");
    if (!name || !activeOrgId) return;
    const result = await createWorkflow({ orgId: activeOrgId, name });
    if (result.data?.insert_workflows_one) {
      router.push(`/workflows/${result.data.insert_workflows_one.id}`);
    }
  }

  if (orgsFetching) return <p>Loading your organizations...</p>;
  if (orgs.length === 0) {
    return <p style={{ padding: 40 }}>You aren't a member of any organization yet. Ask an owner to add you via org_members.</p>;
  }

  return (
    <div style={{ maxWidth: 800, margin: "40px auto", padding: "0 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>AI Workflow Builder</h1>
        <button onClick={() => signOut()} style={{ background: "#262b3a", color: "#e6e8ec" }}>Sign out</button>
      </div>

      <div className="card">
        <label>Organization: </label>
        <select value={activeOrgId ?? ""} onChange={(e) => setOrgId(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name} ({o.role})</option>
          ))}
        </select>

        {usage && (
          <div style={{ marginTop: 12, fontSize: 14, opacity: 0.85 }}>
            Quota: <strong>{usage.quota_used} / {usage.quota_limit}</strong> used this period
            &nbsp;·&nbsp; {usage.runs_this_month} runs this month
            &nbsp;·&nbsp; avg duration: {usage.avg_run_duration_seconds ? `${Math.round(usage.avg_run_duration_seconds)}s` : "—"}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Workflows</h2>
        {activeOrg?.role !== "viewer" && (
          <button onClick={handleCreate} style={{ background: "#1d4ed8", color: "white" }}>+ New workflow</button>
        )}
      </div>

      {wfResult.fetching && <p>Loading workflows...</p>}
      {(wfResult.data?.workflows ?? []).map((wf: any) => (
        <div key={wf.id} className="card" style={{ cursor: "pointer" }} onClick={() => router.push(`/workflows/${wf.id}`)}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>{wf.name}</strong>
            {wf.runs[0] && <span className={`badge badge-${wf.runs[0].status}`}>{wf.runs[0].status}</span>}
          </div>
          {wf.description && <p style={{ opacity: 0.7, margin: "6px 0 0" }}>{wf.description}</p>}
        </div>
      ))}
      {wfResult.data?.workflows?.length === 0 && <p style={{ opacity: 0.6 }}>No workflows yet.</p>}
    </div>
  );
}
