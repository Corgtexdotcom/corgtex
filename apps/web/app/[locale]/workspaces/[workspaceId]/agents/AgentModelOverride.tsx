"use client";

import { useTransition } from "react";
import { updateAgentModelAction } from "./actions";
import type { AgentConfigSummary } from "@corgtex/domain";
import type { AgentModelOverrideOption } from "./model-override-options";
import { useTranslations } from "next-intl";

export function AgentModelOverride({
  workspaceId,
  agent,
  modelOverrideOptions,
}: {
  workspaceId: string,
  agent: AgentConfigSummary,
  modelOverrideOptions: AgentModelOverrideOption[],
}) {
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("agents");
  const hasUnsupportedOverride = Boolean(agent.modelOverride)
    && !modelOverrideOptions.some((option) => option.value === agent.modelOverride);

  const handleModelChange = (modelOverride: string) => {
    startTransition(() => {
      updateAgentModelAction(workspaceId, agent.agentKey, modelOverride === "default" ? null : modelOverride);
    });
  };

  return (
    <select
      disabled={agent.defaultModelTier === "none" || isPending}
      value={agent.modelOverride || "default"}
      onChange={(e) => handleModelChange(e.target.value)}
      className="nr-input"
      style={{ minWidth: 200, padding: "8px 12px" }}
    >
      <option value="default">{t("modelDefault", { tier: agent.defaultModelTier })}</option>
      {hasUnsupportedOverride && agent.modelOverride ? (
        <option value={agent.modelOverride} disabled>{t("modelUnsupported", { model: agent.modelOverride })}</option>
      ) : null}
      {modelOverrideOptions.map((option) => (
        <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
      ))}
    </select>
  );
}
