import { listAgentRuns, getAgentRunTrace } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
import { getTranslations, getFormatter } from "next-intl/server";

function statusColor(status: string): string {
  if (status === "COMPLETED" || status === "DELIVERED") return "var(--accent)";
  if (status === "FAILED") return "#842029";
  if (status === "RUNNING" || status === "PENDING") return "var(--warning)";
  if (status === "WAITING_APPROVAL") return "#b45309";
  return "inherit";
}

export async function ObservabilityTab({
  workspaceId,
  actor,
  searchParams,
}: {
  workspaceId: string;
  actor: AppActor;
  searchParams: { agentRunId?: string };
}) {
  const agentRuns = await listAgentRuns(actor, workspaceId, { take: 15 });

  const selectedRunTrace = searchParams.agentRunId
    ? await getAgentRunTrace(actor, workspaceId, searchParams.agentRunId)
    : null;

  const t = await getTranslations("agents");
  const format = await getFormatter();

  return (
    <div style={{ display: "flex", gap: "40px", flexWrap: "wrap" }}>
      <section style={{ flex: "1 1 300px" }}>
        <h2 className="nr-section-header">{t("observabilityTitle")}</h2>
        <div>
          {agentRuns.map((run) => (
            <a
              key={run.id}
              href={`/workspaces/${workspaceId}/agents?tab=observability&agentRunId=${run.id}`}
              className="nr-item"
              style={{
                textDecoration: "none",
                color: "inherit",
                display: "block",
                padding: "12px",
                background: searchParams.agentRunId === run.id ? "var(--accent-soft)" : "transparent",
                borderRadius: searchParams.agentRunId === run.id ? "8px" : "0",
                borderBottom: searchParams.agentRunId === run.id ? "none" : "1px dashed var(--line)",
              }}
            >
              <div className="row">
                <span className="nr-tag">{run.agentKey}</span>
                <span style={{ color: statusColor(run.status), fontSize: "0.82rem", fontWeight: 600 }}>
                  {run.status}
                </span>
              </div>
              <div className="nr-excerpt" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                {run.goal.slice(0, 80)}{run.goal.length > 80 ? "..." : ""}
              </div>
              <div className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                {run.startedAt || run.createdAt ? format.dateTime(new Date(run.startedAt ?? run.createdAt), {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit"
                }) : "N/A"}
              </div>
            </a>
          ))}
          {agentRuns.length === 0 && <p className="nr-item-meta">{t("noRuns")}</p>}
        </div>
      </section>

      <section style={{ flex: "2 1 400px" }}>
        <h2 className="nr-section-header">
          {selectedRunTrace
            ? t("traceTitleSelected", { agentKey: selectedRunTrace.agentKey })
            : t("traceTitleUnselected")}
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
                <strong>{t("traceGoal")}</strong>
                <span>{selectedRunTrace.goal}</span>
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="nr-item-meta">{t("traceStatus")}</span>
                <span style={{ color: statusColor(selectedRunTrace.status), fontWeight: 600 }}>
                  {selectedRunTrace.status}
                </span>
              </div>
              <div className="row" style={{ marginBottom: 8 }}>
                <span className="nr-item-meta">{t("traceTrigger")}</span>
                <span>{selectedRunTrace.triggerType} {selectedRunTrace.triggerRef ?? ""}</span>
              </div>
              <div className="row">
                <span className="nr-item-meta">{t("traceDuration")}</span>
                <span>
                  {selectedRunTrace.startedAt && selectedRunTrace.completedAt
                    ? `${Math.round((new Date(selectedRunTrace.completedAt).getTime() - new Date(selectedRunTrace.startedAt).getTime()) / 1000)}s`
                    : t("traceInProgress")}
                </span>
              </div>
            </div>

            {/* Steps timeline */}
            {selectedRunTrace.steps.length > 0 && (
              <div>
                <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>{t("traceSteps")}</h3>
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
                            {t("traceOutput")}
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
                <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>{t("traceToolCalls")}</h3>
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
                              {t("traceInput")}
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
                              {t("traceOutput")}
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
                <h3 className="nr-section-header" style={{ fontSize: "0.9rem", color: "var(--muted)" }}>{t("traceModelUsage")}</h3>
                <div>
                  {selectedRunTrace.modelUsage.map((mu, idx) => (
                    <div key={mu.id} className="nr-item" style={{ padding: "8px 0", borderBottom: idx === selectedRunTrace.modelUsage.length - 1 ? "none" : "1px dashed var(--line)" }}>
                      <div className="row">
                        <span className="nr-tag">{mu.taskType}</span>
                        <span className="nr-item-title" style={{ fontSize: "0.82rem" }}>{mu.model}</span>
                      </div>
                      <div className="nr-item-meta" style={{ fontSize: "0.78rem", marginTop: 4 }}>
                        {mu.inputTokens} in &middot; {mu.outputTokens} out &middot; {mu.latencyMs}ms
                        {mu.estimatedCostUsd && t("traceCost", { cost: `$${Number(mu.estimatedCostUsd).toFixed(Number(mu.estimatedCostUsd) >= 0.01 ? 4 : 6)}` })}
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
                  {t("traceFullResult")}
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
          <p className="nr-item-meta">{t("traceClickLeft")}</p>
        )}
      </section>
    </div>
  );
}
