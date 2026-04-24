"use client";

import { useTransition } from "react";
import { updateAgentSpendLimitAction } from "./actions";
import { useTranslations } from "next-intl";

export function AgentSpendLimits({ workspaceId, agents }: { workspaceId: string, agents: any[] }) {
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("agents");

  return (
    <div className="stack" style={{ gap: 16 }}>
      {agents.map((agent) => (
        <form 
          key={agent.id} 
          action={updateAgentSpendLimitAction} 
          className="nr-item" 
          style={{ display: "flex", gap: "24px", alignItems: "center", flexWrap: "wrap", padding: "16px" }}
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="agentIdentityId" value={agent.id} />

          <div style={{ flex: "1 1 200px" }}>
            <strong style={{ display: "block", fontSize: "1.05rem" }}>{agent.displayName}</strong>
            <span className="nr-item-meta" style={{ fontSize: "0.85rem" }}>{agent.agentKey}</span>
          </div>

          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="stack" style={{ gap: 4 }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{t("limitMaxSpend")}</span>
              <input
                type="number"
                name="maxSpendPerRunCents"
                step="0.01"
                min="0"
                defaultValue={agent.maxSpendPerRunCents ? (agent.maxSpendPerRunCents / 100).toFixed(2) : ""}
                placeholder={t("limitNoLimit")}
                className="nr-input"
                style={{ width: 140 }}
              />
            </label>

            <label className="stack" style={{ gap: 4 }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{t("limitMaxRuns")}</span>
              <input
                type="number"
                name="maxRunsPerDay"
                min="0"
                step="1"
                defaultValue={agent.maxRunsPerDay ?? ""}
                placeholder={t("limitNoLimit")}
                className="nr-input"
                style={{ width: 140 }}
              />
            </label>

            <button type="submit" className="nr-button nr-button-secondary">
              {t("limitSave")}
            </button>
          </div>
        </form>
      ))}
    </div>
  );
}
