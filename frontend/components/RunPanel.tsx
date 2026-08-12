import { useSubscription, useMutation } from "urql";
import { StatusBadge } from "./StatusBadge";

const STEP_PROGRESS = `
  subscription StepRunProgress($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { step_order: asc }) {
      id
      step_order
      type
      status
      output
      error
      attempt_count
      approved_by
      approved_at
    }
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
    }
  }
`;

const APPROVE_STEP = `
  mutation ApproveStep($stepRunId: uuid!, $approve: Boolean!, $reason: String) {
    approveStep(step_run_id: $stepRunId, approve: $approve, reason: $reason) {
      status
      workflow_run_status
    }
  }
`;

export function RunPanel({ runId, canApprove }: { runId: string; canApprove: boolean }) {
  const [result] = useSubscription({ query: STEP_PROGRESS, variables: { runId } });
  const [, approveStep] = useMutation(APPROVE_STEP);

  const steps = result.data?.step_runs ?? [];
  const run = result.data?.workflow_runs_by_pk;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>Run status</strong>
        {run && <StatusBadge status={run.status} />}
      </div>
      {run?.error && <p style={{ color: "#f87171" }}>{run.error}</p>}

      <div style={{ marginTop: 12 }}>
        {steps.map((sr: any) => (
          <div key={sr.id} style={{ padding: "8px 0", borderBottom: "1px solid #262b3a" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>#{sr.step_order} · {sr.type}</span>
              <StatusBadge status={sr.status} />
            </div>
            {sr.attempt_count > 1 && <div style={{ fontSize: 12, opacity: 0.6 }}>attempt {sr.attempt_count}</div>}
            {sr.error && <div style={{ fontSize: 13, color: "#f87171" }}>{sr.error}</div>}
            {sr.output && sr.status === "succeeded" && (
              <pre style={{ fontSize: 12, opacity: 0.7, whiteSpace: "pre-wrap", margin: "4px 0 0" }}>
                {JSON.stringify(sr.output).slice(0, 300)}
              </pre>
            )}

            {sr.status === "paused" && sr.type === "approval_gate" && (
              <div style={{ marginTop: 8 }}>
                {canApprove ? (
                  <>
                    <button
                      style={{ background: "#15803d", color: "white", marginRight: 8 }}
                      onClick={() => approveStep({ stepRunId: sr.id, approve: true })}
                    >
                      Approve
                    </button>
                    <button
                      style={{ background: "#b91c1c", color: "white" }}
                      onClick={() => approveStep({ stepRunId: sr.id, approve: false, reason: "rejected" })}
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <span style={{ fontSize: 13, opacity: 0.7 }}>Awaiting approval from an owner/editor…</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
