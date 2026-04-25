import type { AppActor } from "@corgtex/shared";
import { submitAgentFeedbackAction } from "./actions";

export function AgentInboxTab({
  workspaceId,
  actor,
  pendingRuns,
}: {
  workspaceId: string;
  actor: AppActor;
  pendingRuns: any[]; // Any is fine here, it comes from listAgentRuns which has complex type
}) {
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section>
        <h2 className="nr-section-header">Questions from Agents</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Agents will pause and ask for your input here when they encounter ambiguity or reach a policy threshold.
        </p>

        {pendingRuns.length === 0 ? (
          <div className="nr-item" style={{ textAlign: "center", padding: "40px 20px" }}>
            <strong style={{ display: "block" }}>Inbox zero!</strong>
            <span className="nr-item-meta">No agents are currently waiting for your input.</span>
          </div>
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {pendingRuns.map((run) => {
              // Find the last step that might contain the context/question
              const lastStep = run.steps?.[run.steps.length - 1];
              
              return (
                <div key={run.id} className="nr-item" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div className="row">
                    <span className="nr-tag">{run.agentKey}</span>
                    <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                      {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  
                  <div>
                    <strong style={{ display: "block", marginBottom: 4 }}>Goal:</strong>
                    <div className="nr-excerpt">{run.goal}</div>
                  </div>

                  {lastStep && (
                    <div style={{ background: "var(--bg-subtle)", padding: 12, borderRadius: 8, border: "1px dashed var(--line)" }}>
                      <strong style={{ display: "block", marginBottom: 4 }}>Agent is asking:</strong>
                      <div className="nr-excerpt" style={{ color: "var(--text)" }}>
                        {lastStep.outputJson?.question || "Waiting for input..."}
                      </div>
                      
                      <form action={submitAgentFeedbackAction} style={{ marginTop: 16 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="agentRunId" value={run.id} />
                        <input type="hidden" name="stepId" value={lastStep.id} />
                        
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <textarea 
                            name="feedback"
                            placeholder="Type your response or instruction to the agent..."
                            style={{ flex: 1, minHeight: 60, padding: 8, borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" }}
                            required
                          />
                          <button type="submit" className="primary small">Reply</button>
                        </div>
                      </form>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
