import { assertSupportedModelOverride } from "@corgtex/models";

const AGENT_MODEL_OVERRIDE_OPTIONS = [
  { value: "google/gemini-2.5-flash-lite", labelKey: "modelFast", settingsLabelKey: "optFast" },
  { value: "qwen/qwen3-32b", labelKey: "modelDefaultTier", settingsLabelKey: "optDefault" },
  { value: "meta-llama/llama-4-scout", labelKey: "modelStandard", settingsLabelKey: "optStandard" },
  { value: "google/gemini-2.5-flash", labelKey: "modelQuality", settingsLabelKey: "optQuality" },
] as const;

export type AgentModelOverrideOption = (typeof AGENT_MODEL_OVERRIDE_OPTIONS)[number];

export function agentModelOverrideOptions(): AgentModelOverrideOption[] {
  return AGENT_MODEL_OVERRIDE_OPTIONS.filter((option) => {
    try {
      assertSupportedModelOverride(option.value);
      return true;
    } catch {
      return false;
    }
  });
}

export function assertAgentModelOverrideAllowed(modelOverride: string | null) {
  if (modelOverride) {
    assertSupportedModelOverride(modelOverride);
  }
}
