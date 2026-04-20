import { listAuditLogs, getModelUsageSummary, listAgentRuns, getAgentRunTrace, getStorageUsageSummary } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";


function formatDateTime(value: Date | string | null | undefined) {
  if (!value) return "N/A";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

function actionLabel(action: string): string {
  return action.replace(/\./g, " ").replace(/([A-Z])/g, " $1").trim();
}

function statusColor(status: string): string {
  if (status === "COMPLETED" || status === "DELIVERED") return "var(--accent)";
  if (status === "FAILED") return "#842029";
  if (status === "RUNNING" || status === "PENDING") return "var(--warning)";
  if (status === "WAITING_APPROVAL") return "#b45309";
  return "inherit";
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ entityType?: string; entityId?: string; agentRunId?: string; tab?: string }>;
}) {
  const { workspaceId } = await params;
  const search = await searchParams;
  const actor = await requirePageActor();
  const tab = search.tab ?? "audit";

  const auditLogs = await listAuditLogs(actor, workspaceId, {
    take: 50,
    entityType: search.entityType,
    entityId: search.entityId,
  });

  const usageSummary = await getModelUsageSummary(actor, workspaceId, { periodDays: 30 });
  const storageSummary = await getStorageUsageSummary(actor, workspaceId);

  const agentRuns = await listAgentRuns(actor, workspaceId, { take: 10 });

  // If a specific agent run is selected, get its trace
  const selectedRunTrace = search.agentRunId
    ? await getAgentRunTrace(actor, workspaceId, search.agentRunId)
    : null;

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>Audit &amp; Observability</h1>
        <div className="nr-masthead-meta">
          <span>Decision trail, agent traces, and model usage analytics.</span>
        </div>
      </header>

      {/* Tab navigation */}
      <div className="nr-tab-bar" style={{ marginBottom: 32 }}>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=audit`}
          className={`nr-tab ${tab === "audit" ? "nr-tab-active" : ""}`}
        >
          Audit Trail
        </a>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=agents`}
          className={`nr-tab ${tab === "agents" ? "nr-tab-active" : ""}`}
        >
          Agent Traces
        </a>
        <a
          href={`/workspaces/${workspaceId}/audit?tab=costs`}
          className={`nr-tab ${tab === "costs" ? "nr-tab-active" : ""}`}
        >
          Cost Dashboard
        </a>
      </div>

      {/* Audit Trail Tab */}
      {tab === "audit" && (
        <section>
          <h2 className="nr-section-header">Decision Trail</h2>
          <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
            Every action taken in this workspace, by humans and agents.
            {search.entityType && search.entityId && (
              <span>
                {" "}Filtered to <strong>{search.entityType}</strong>: {search.entityId}.{" "}
                <a href={`/workspaces/${workspaceId}/audit?tab=audit`}>Clear filter</a>
              </span>
            )}
          </p>
          <div>
            {auditLogs.length === 0 && <p className="nr-item-meta">No audit entries found.</p>}
            {auditLogs.map((log) => (
              <div className="nr-item" key={log.id} style={{ padding: "12px 0" }}>
                <div className="row">
                  <strong className="nr-item-title" style={{ textTransform: "capitalize" }}>{actionLabel(log.action)}</strong>
                  <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                    {formatDateTime(log.createdAt)}
                  </span>
                </div>
                <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                  {log.entityType} &middot; {log.entityId.slice(0, 12)}...
                  {log.actorUserId && (
                    <span> &middot; Actor: {log.actorUserId.slice(0, 8)}...</span>
                  )}
                </div>
                {log.meta && typeof log.meta === "object" && (
                  <details style={{ marginTop: 8 }}>
                    <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.78rem" }}>
                      Metadata
                    </summary>
                    <pre style={{
                      fontSize: "0.75rem",
                      background: "transparent",
                      border: "1px dashed var(--line)",
                      padding: 12,
                      borderRadius: 8,
                      overflow: "auto",
                      maxHeight: 200,
                      marginTop: 8,
                    }}>
                      {JSON.stringify(log.meta, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Agent Traces Tab */}
      {tab === "agents" && (
        <div style={{ display: "flex", gap: "40px", flexWrap: "wrap" }}>
          <section style={{ flex: "1 1 300px" }}>
            <h2 className="nr-section-header">Agent Runs</h2>
            <div>
              {agentRuns.map((run) => (
                <a
                  key={run.id}
                  href={`/workspaces/${workspaceId}/audit?tab=agents&agentRunId=${run.id}`}
                  className="nr-item"
                  style={{
                    textDecoration: "none",
                    color: "inherit",
                    display: "block",
                    padding: "12px",
                    background: search.agentRunId === run.id ? "var(--accent-soft)" : "transparent",
                    borderRadius: search.agentRunId === run.id ? "8px" : "0",
                    borderBottom: search.agentRunId === run.id ? "none" : "1px dashed var(--line)",
                  }}
                >
                  <div className="row">
                    <span className="tag">{run.agentKey}</span>
                    <span style={{ color: statusColor(run.status), fontSize: "0.82rem", fontWeight: 600 }}>
                      {run.status}
                    </span>
                  </div>
                  <div className="nr-excerpt" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                    {run.goal.slice(0, 80)}{run.goal.length > 80 ? "..." : ""}
                  </div>
                  <div className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                    {formatDateTime(run.startedAt ?? run.createdAt)}
                  </div>
                </a>
              ))}
            </div>
          </section>

          <section style={{ flex: "2 1 400px" }}>
            <h2 className="nr-section-header">
              {selectedRunTrace
                ? `Trace: ${selectedRunTrace.agentKey}`
                : "Select an agent run"}
            </h2>
            {selectedRunTrace ? (
              <div className="stack" style={{ gap: 24 }}>
                {/* Run metadata */}
                <div style={{
                  padding: 16,
                  background: "transparent",
                  border: "1px dashed var(--line)",
                  borderRadius: 8,
                  fontSize: "0.85rem",
                }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <strong>Goal:</strong>
                    <span>{selectedRunTrace.goal}</span>
                  </div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="nr-item-meta">Status</span>
                    <span style={{ color: statusColor(selectedRunTrace.status), fontWeight: 600 }}>
                      {selectedRunTrace.status}
                    </span>
                  </div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="nr-item-meta">Trigger</span>
                    <span>{selectedRunTrace.triggerType} {selectedRunTrace.triggerRef ?? ""}</span>
                  </div>
                  <div className="row">
                    <span className="nr-item-meta">Duration</span>
                    <span>
                      {selectedRunTrace.startedAt && selectedRunTrace.completedAt
                        ? `${Math.round((new Date(selectedRunTrace.completedAt).getTime() - new Date(selectedRunTrace.startedAt).getTime()) / 1000)}s`
                        : "In progress"}
                    </span>
                  </div>
                </div>

                {/* Steps timeline */}
                {selectedRunTrace.steps.length > 0 && (
                  <div>
                    <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>Steps</h3>
                    <div>
                      {selectedRunTrace.steps.map((step, idx) => (
                        <div key={step.id} className="nr-item" style={{ padding: "12px 0", position: "relative", borderBottom: idx === selectedRunTrace.steps.length - 1 ? "none" : "1px dashed var(--line)" }}>
                          <div className="row">
                            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                              <span style={{
                                width: 10,
                                height: 10,
                                borderRadius: "50%",
                                background: step.status === "COMPLETED" ? "var(--accent)" : step.error ? "#842029" : "var(--warning)",
                                flexShrink: 0,
                              }} />
                              <strong className="nr-item-title" style={{ fontSize: "0.85rem" }}>{step.name}</strong>
                            </div>
                            <span style={{ color: statusColor(step.status), fontSize: "0.78rem" }}>
                              {step.status}
                            </span>
                          </div>
                          {step.error && (
                            <div style={{ color: "#842029", fontSize: "0.8rem", marginTop: 6, marginLeft: 22 }}>
                              {step.error}
                            </div>
                          )}
                          {step.outputJson && (
                            <details style={{ marginTop: 6, marginLeft: 22 }}>
                              <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.75rem" }}>
                                Output
                              </summary>
                              <pre style={{
                                fontSize: "0.72rem",
                                background: "transparent",
                                padding: 8,
                                border: "1px dashed var(--line)",
                                borderRadius: 6,
                                overflow: "auto",
                                maxHeight: 150,
                                marginTop: 6,
                              }}>
                                {JSON.stringify(step.outputJson, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tool calls */}
                {selectedRunTrace.toolCalls.length > 0 && (
                  <div>
                    <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>Tool Calls</h3>
                    <div>
                      {selectedRunTrace.toolCalls.map((tc, idx) => (
                        <div key={tc.id} className="nr-item" style={{ padding: "12px 0", borderBottom: idx === selectedRunTrace.toolCalls.length - 1 ? "none" : "1px dashed var(--line)" }}>
                          <div className="row">
                            <strong className="nr-item-title" style={{ fontSize: "0.85rem" }}>{tc.name}</strong>
                            <span style={{ color: statusColor(tc.status), fontSize: "0.78rem" }}>
                              {tc.status}
                            </span>
                          </div>
                          {tc.error && (
                            <div style={{ color: "#842029", fontSize: "0.8rem", marginTop: 6 }}>
                              {tc.error}
                            </div>
                          )}
                          <div className="actions-inline" style={{ marginTop: 6 }}>
                            {tc.inputJson && (
                              <details>
                                <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.75rem" }}>
                                  Input
                                </summary>
                                <pre style={{
                                  fontSize: "0.72rem",
                                  background: "transparent",
                                  padding: 8,
                                  border: "1px dashed var(--line)",
                                  borderRadius: 6,
                                  overflow: "auto",
                                  maxHeight: 120,
                                  marginTop: 6,
                                }}>
                                  {JSON.stringify(tc.inputJson, null, 2)}
                                </pre>
                              </details>
                            )}
                            {tc.outputJson && (
                              <details>
                                <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.75rem" }}>
                                  Output
                                </summary>
                                <pre style={{
                                  fontSize: "0.72rem",
                                  background: "transparent",
                                  padding: 8,
                                  border: "1px dashed var(--line)",
                                  borderRadius: 6,
                                  overflow: "auto",
                                  maxHeight: 120,
                                  marginTop: 6,
                                }}>
                                  {JSON.stringify(tc.outputJson, null, 2)}
                                </pre>
                              </details>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Model usage */}
                {selectedRunTrace.modelUsage.length > 0 && (
                  <div>
                    <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>Model Usage</h3>
                    <div>
                      {selectedRunTrace.modelUsage.map((mu, idx) => (
                        <div key={mu.id} className="nr-item" style={{ padding: "8px 0", borderBottom: idx === selectedRunTrace.modelUsage.length - 1 ? "none" : "1px dashed var(--line)" }}>
                          <div className="row">
                            <span className="tag">{mu.taskType}</span>
                            <span className="nr-item-title" style={{ fontSize: "0.82rem" }}>{mu.model}</span>
                          </div>
                          <div className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                            {mu.inputTokens} in &middot; {mu.outputTokens} out &middot; {mu.latencyMs}ms
                            {mu.estimatedCostUsd && ` · ${formatUsd(Number(mu.estimatedCostUsd))}`}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Result */}
                {selectedRunTrace.resultJson && (
                  <details style={{ borderTop: "1px dashed var(--line)", paddingTop: 16 }}>
                    <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.85rem" }}>
                      Full result JSON
                    </summary>
                    <pre style={{
                      fontSize: "0.75rem",
                      background: "transparent",
                      border: "1px dashed var(--line)",
                      padding: 12,
                      borderRadius: 8,
                      overflow: "auto",
                      maxHeight: 300,
                      marginTop: 8,
                    }}>
                      {JSON.stringify(selectedRunTrace.resultJson, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ) : (
              <p className="nr-item-meta">Click an agent run on the left to view its full execution trace.</p>
            )}
          </section>
        </div>
      )}

      {/* Cost Dashboard Tab */}
      {tab === "costs" && (
        <div className="stack" style={{ gap: 40 }}>
          {/* Summary cards */}
          <div className="nr-stat-bar">
            <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
              <strong style={{ fontSize: "1.3rem" }}>{formatUsd(usageSummary.totalCostUsd)}</strong>
              <span className="nr-meta">Total Cost (30d)</span>
            </div>
            <span className="nr-stat-sep" />
            <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
              <strong style={{ fontSize: "1.3rem" }}>{usageSummary.totalTokens.toLocaleString()}</strong>
              <span className="nr-meta">Total Tokens</span>
            </div>
            <span className="nr-stat-sep" />
            <div className="nr-stat" style={{ display: "flex", flexDirection: "column" }}>
              <strong style={{ fontSize: "1.3rem" }}>{usageSummary.totalCalls}</strong>
              <span className="nr-meta">API Calls</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px" }}>
            {/* Storage Usage */}
            <section style={{ gridColumn: "1 / -1" }}>
              <h2 className="nr-section-header">Raw File Storage (R2)</h2>
              <div className="nr-item" style={{ padding: "16px", background: "var(--bg)", border: "1px dashed var(--line)", borderRadius: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                  <strong style={{ fontSize: "1.1rem" }}>{storageSummary.totalGb.toFixed(3)} GiB <span className="nr-item-meta">/ {storageSummary.limitGb} GiB</span></strong>
                  <span style={{ fontWeight: 600, color: storageSummary.isOverLimit ? "#842029" : "inherit" }}>
                    {formatUsd(storageSummary.estimatedOverageUsd)} / mo
                  </span>
                </div>
                
                <div className="nr-item-meta" style={{ marginBottom: 12, fontSize: "0.85rem" }}>
                  {storageSummary.isOverLimit 
                    ? "WARNING: You have reached your 10 GB limit. File ingestion is frozen."
                    : "The first 10 GB is included at $0/mo. File ingestion freezes at limits to prevent unmonitored overages."}
                </div>

                <div style={{
                  height: 12,
                  borderRadius: 6,
                  background: "var(--line)",
                  overflow: "hidden",
                  width: "100%",
                }}>
                  <div style={{
                    width: `${Math.min(100, Math.round((storageSummary.totalGb / storageSummary.limitGb) * 100))}%`,
                    height: "100%",
                    background: storageSummary.isOverLimit ? "#842029" : (storageSummary.totalGb > 8 ? "var(--warning)" : "var(--accent)"),
                    borderRadius: 6,
                  }} />
                </div>
              </div>
            </section>

            {/* By Model */}
            <section>
              <h2 className="nr-section-header">Cost by Model</h2>
              <div>
                {usageSummary.byModel.length === 0 && <p className="nr-item-meta">No model usage data.</p>}
                {usageSummary.byModel.map((m) => (
                  <div key={`${m.provider}:${m.model}`} className="nr-item" style={{ padding: "12px 0" }}>
                    <div className="row">
                      <strong className="nr-item-title">{m.model}</strong>
                      <span style={{ fontWeight: 700 }}>{formatUsd(m.totalCostUsd)}</span>
                    </div>
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {m.provider} &middot; {m.callCount} calls &middot;
                      {m.totalInputTokens.toLocaleString()} in &middot;
                      {m.totalOutputTokens.toLocaleString()} out &middot;
                      avg {Math.round(m.totalLatencyMs / Math.max(1, m.callCount))}ms
                    </div>
                    {/* Cost bar */}
                    {usageSummary.totalCostUsd > 0 && (
                      <div style={{
                        marginTop: 8,
                        height: 4,
                        borderRadius: 2,
                        background: "var(--line)",
                        overflow: "hidden",
                      }}>
                        <div style={{
                          width: `${Math.round((m.totalCostUsd / usageSummary.totalCostUsd) * 100)}%`,
                          height: "100%",
                          background: "var(--accent)",
                          borderRadius: 2,
                        }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {/* By Agent */}
            <section>
              <h2 className="nr-section-header">Cost by Agent</h2>
              <div>
                {usageSummary.byAgent.length === 0 && <p className="nr-item-meta">No agent usage data.</p>}
                {usageSummary.byAgent.map((a) => (
                  <div key={a.agentKey} className="nr-item" style={{ padding: "12px 0" }}>
                    <div className="row">
                      <strong className="nr-item-title">{a.agentKey}</strong>
                      <span style={{ fontWeight: 700 }}>{formatUsd(a.totalCostUsd)}</span>
                    </div>
                    <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                      {a.callCount} calls &middot;
                      {a.totalInputTokens.toLocaleString()} in &middot;
                      {a.totalOutputTokens.toLocaleString()} out
                    </div>
                    {usageSummary.totalCostUsd > 0 && (
                      <div style={{
                        marginTop: 8,
                        height: 4,
                        borderRadius: 2,
                        background: "var(--line)",
                        overflow: "hidden",
                      }}>
                        <div style={{
                          width: `${Math.round((a.totalCostUsd / usageSummary.totalCostUsd) * 100)}%`,
                          height: "100%",
                          background: "var(--accent)",
                          borderRadius: 2,
                        }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Daily usage */}
          <section>
            <h2 className="nr-section-header">Daily Usage (30d)</h2>
            <div>
              {usageSummary.byDay.length === 0 && <p className="nr-item-meta">No daily usage data.</p>}
              {usageSummary.byDay.map((d) => (
                <div key={d.date} className="nr-item" style={{ padding: "12px 0" }}>
                  <div className="row">
                    <span className="nr-item-title" style={{ fontWeight: 600, fontSize: "0.85rem" }}>{d.date}</span>
                    <span style={{ fontWeight: 700 }}>{formatUsd(d.totalCostUsd)}</span>
                  </div>
                  <div className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                    {d.callCount} calls &middot;
                    {(d.totalInputTokens + d.totalOutputTokens).toLocaleString()} tokens
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
