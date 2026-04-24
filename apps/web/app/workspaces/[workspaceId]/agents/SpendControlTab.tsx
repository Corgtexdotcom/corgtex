import { getModelUsageSummary, getModelUsageBudget, listAgentIdentities } from "@corgtex/domain";
import { AgentBudgetManager } from "../settings/agents/AgentBudgetManager";
import { AgentSpendLimits } from "./AgentSpendLimits";
import type { AppActor } from "@corgtex/shared";

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

export async function SpendControlTab({
  workspaceId,
  actor,
}: {
  workspaceId: string;
  actor: AppActor;
}) {
  const [usageSummary, budget, agentIdentities] = await Promise.all([
    getModelUsageSummary(actor, workspaceId, { periodDays: 30 }),
    getModelUsageBudget(actor, workspaceId),
    listAgentIdentities(actor, workspaceId),
  ]);

  return (
    <div className="stack" style={{ gap: 40 }}>
      {/* Workspace Budget Manager */}
      <section>
        <h2 className="nr-section-header">Workspace Budget</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Set an overall monthly spending limit for AI model usage across all agents in this workspace.
        </p>
        <AgentBudgetManager workspaceId={workspaceId} budget={budget ? { monthlyCostCapUsd: Number(budget.monthlyCostCapUsd), alertThresholdPct: budget.alertThresholdPct, periodStartDay: budget.periodStartDay } : null} />
      </section>

      <section>
        <h2 className="nr-section-header">Per-Agent Limits</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          Set restrictive spend limits per run and max runs per day for individual agents to prevent runaway costs.
        </p>
        <AgentSpendLimits workspaceId={workspaceId} agents={agentIdentities} />
      </section>

      {/* Cost Dashboard */}
      <section>
        <h2 className="nr-section-header" style={{ marginBottom: 24 }}>Cost Analytics</h2>

        <div className="nr-stat-bar" style={{ marginBottom: 40 }}>
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
          {/* By Model */}
          <section>
            <h3 className="nr-section-header" style={{ fontSize: "1rem" }}>Cost by Model</h3>
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
            <h3 className="nr-section-header" style={{ fontSize: "1rem" }}>Cost by Agent</h3>
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
        <section style={{ marginTop: 40 }}>
          <h3 className="nr-section-header" style={{ fontSize: "1rem" }}>Daily Usage (30d)</h3>
          <div>
            {usageSummary.byDay.length === 0 && <p className="nr-item-meta">No daily usage data.</p>}
            {usageSummary.byDay.map((d) => (
              <div key={d.date} className="nr-item" style={{ padding: "12px 0", borderBottom: "1px dashed var(--line)" }}>
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
      </section>
    </div>
  );
}
