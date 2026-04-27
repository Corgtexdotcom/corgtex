"use client";

import { useTransition } from "react";
import { updateAgentModelAction } from "./actions";
import type { AgentConfigSummary } from "@corgtex/domain";
import { useTranslations } from "next-intl";

export function AgentModelOverride({ workspaceId, agent }: { workspaceId: string, agent: AgentConfigSummary }) {
  const [isPending, startTransition] = useTransition();
  const t = useTranslations("agents");

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
      <option value="google/gemma-4-12b-it">{t("modelFast")}</option>
      <option value="qwen/qwen3-32b">{t("modelDefaultTier")}</option>
      <option value="meta-llama/llama-4-scout">{t("modelStandard")}</option>
      <option value="google/gemini-2.5-flash">{t("modelQuality")}</option>
    </select>
  );
}
