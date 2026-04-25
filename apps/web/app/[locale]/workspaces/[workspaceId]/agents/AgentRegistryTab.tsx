import { getModelUsageSummary, listAgentIdentities, listAgentConfigs } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AgentRegistryToggle } from "./AgentRegistryToggle";
import { updateAgentGovernancePolicyAction } from "./actions";
import { getTranslations } from "next-intl/server";

export async function AgentRegistryTab({
  workspaceId,
  actor,
}: {
  workspaceId: string;
  actor: AppActor;
}) {
  const [identities, usageSummary, lastRuns, configs] = await Promise.all([
    listAgentIdentities(actor, workspaceId),
    getModelUsageSummary(actor, workspaceId, { periodDays: 30 }),
    prisma.agentRun.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      distinct: ["agentKey"],
      select: { agentKey: true, createdAt: true },
    }),
    listAgentConfigs(actor, workspaceId),
  ]);

  const lastRunMap = new Map(lastRuns.map((r) => [r.agentKey, r.createdAt]));
  const usageMap = new Map(usageSummary.byAgent.map((u) => [u.agentKey, u]));
  const configMap = new Map(configs.map((c) => [c.agentKey, c]));
  const t = await getTranslations("agents");

  return (
    <section className="stack" style={{ gap: 24 }}>
      <div>
        <h2 className="nr-section-header">{t("registryTitle")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          {t("registryDesc")}
        </p>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        {identities.map((identity) => {
          const configInfo = configMap.get(identity.agentKey as any);
          const usage = usageMap.get(identity.agentKey);
          const lastRun = lastRunMap.get(identity.agentKey);
          
          const costTier = configInfo?.costTier ?? "unknown";
          let costBadgeColor = "var(--zinc-600)";
          if (costTier === "free" || costTier === "low") costBadgeColor = "var(--green-600)";
          else if (costTier === "medium") costBadgeColor = "var(--yellow-600)";
          else if (costTier === "high" || costTier === "very-high") costBadgeColor = "var(--red-600)";

          return (
            <div key={identity.id} className="nr-item" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 16 }}>
              <div className="stack" style={{ gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>{identity.displayName}</h3>
                  <span className="nr-tag" style={{ backgroundColor: "var(--zinc-800)", color: "white" }}>
                    {identity.memberType}
                  </span>
                  {configInfo && (
                    <span className="nr-tag" style={{ textTransform: "capitalize" }}>
                      {configInfo.category}
                    </span>
                  )}
                  {configInfo && identity.isActive && (
                    <span className="nr-tag" style={{ borderColor: costBadgeColor, color: costBadgeColor }}>
                      {t("costBadge", { tier: costTier })}
                    </span>
                  )}
                  {!identity.isActive && (
                    <span className="nr-tag" style={{ borderColor: "var(--red-600)", color: "var(--red-600)" }}>
                      {t("disabled")}
                    </span>
                  )}
                </div>
                
                <div className="nr-item-meta" style={{ display: "flex", gap: 24, fontSize: "0.85rem" }}>
                  <span><strong style={{ color: "var(--fg)" }}>{t("agentKey")}</strong> {identity.agentKey}</span>
                  <span><strong style={{ color: "var(--fg)" }}>{t("runs30d")}</strong> {usage?.callCount || 0}</span>
                  <span><strong style={{ color: "var(--fg)" }}>{t("cost30d")}</strong> ${usage?.totalCostUsd.toFixed(4) || "0.0000"}</span>
                  {lastRun && (
                    <span><strong style={{ color: "var(--fg)" }}>{t("lastRun")}</strong> {lastRun.toLocaleDateString()} {lastRun.toLocaleTimeString()}</span>
                  )}
                </div>
              </div>
              
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <AgentRegistryToggle 
                  workspaceId={workspaceId} 
                  agentKey={identity.agentKey} 
                  enabled={identity.isActive} 
                />
              </div>
            </div>
            
            <details style={{ padding: "0 16px 16px 16px", marginTop: -8 }}>
              <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--accent)" }}>
                Edit Governance Policy
              </summary>
              <form action={updateAgentGovernancePolicyAction} style={{ marginTop: 12 }}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="agentKey" value={identity.agentKey} />
                
                <p className="nr-item-meta" style={{ fontSize: "0.8rem", marginBottom: 8 }}>
                  Define plain-text boundaries, instructions, and thresholds for this agent. These rules are prepended to the agent&apos;s system prompt at runtime.
                </p>
                <textarea 
                  name="governancePolicy" 
                  defaultValue={configInfo?.governancePolicy ?? ""} 
                  placeholder="e.g., Always ask a human before committing any financial transaction over $50."
                  style={{ width: "100%", minHeight: 80, padding: 12, borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", fontFamily: "monospace", fontSize: "0.85rem", marginBottom: 12 }}
                />
                <div>
                  <button type="submit" className="secondary small">Save Policy</button>
                </div>
              </form>
            </details>
          </div>
          );
        })}
        {identities.length === 0 && (
          <div className="nr-item-meta" style={{ padding: "40px 0", textAlign: "center" }}>
            {t("noAgents")}
          </div>
        )}
      </div>
    </section>
  );
}
