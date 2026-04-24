"use client";

import { useTransition } from "react";
import { updateAgentModelAction } from "./actions";
import type { AgentConfigSummary } from "@corgtex/domain";

export function AgentModelOverride({ workspaceId, agent }: { workspaceId: string, agent: AgentConfigSummary }) {
  const [isPending, startTransition] = useTransition();

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
      <option value="default">Default ({agent.defaultModelTier})</option>
      <option value="google/gemma-4-12b-it">Fast (Gemma 12B)</option>
      <option value="google/gemma-4-31b-it">Standard (Gemma 31B)</option>
      <option value="google/gemini-2.5-flash">Quality (Gemini 2.5 Flash)</option>
    </select>
  );
}
