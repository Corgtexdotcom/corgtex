export type DelegatedActionPolicyClass = "read" | "normal_write" | "draft_or_clarify" | "sensitive";

export type DelegatedActionPolicyDecision = {
  policyClass: DelegatedActionPolicyClass;
  autoRunAllowed: boolean;
  requiresSensitiveHandling: boolean;
  reason: string;
};

type DelegatedActionPolicyInput = {
  toolName?: string | null;
  operation?: "read" | "write" | null;
  confidence?: number | null;
  explicitUserIntent?: boolean;
  highConfidenceThreshold?: number;
  mediumConfidenceThreshold?: number;
};

const CREDENTIAL_REVEAL_TOOL_NAMES = new Set([
  "reveal_tool_link_credential",
]);

const SUPPORT_CONTROL_PLANE_MUTATION_TOOL_NAMES = new Set([
  "record_support_audit",
  "set_feature_flag",
  "support_reopen_resolved_proposals",
  "set_meeting_series_recorder_url",
  "set_meeting_recorder_auto_recording",
  "ensure_meeting_recorder_coverage",
  "update_agent_credential_scopes",
  "revoke_agent_credential",
  "update_agent_policy",
  "update_model_budget",
]);

export function isSensitiveDelegatedAction(toolName: string | null | undefined) {
  if (!toolName) return false;
  return CREDENTIAL_REVEAL_TOOL_NAMES.has(toolName) || SUPPORT_CONTROL_PLANE_MUTATION_TOOL_NAMES.has(toolName);
}

function normalizedConfidence(confidence: number | null | undefined) {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.max(0, Math.min(1, confidence));
}

export function evaluateDelegatedActionPolicy(input: DelegatedActionPolicyInput): DelegatedActionPolicyDecision {
  if (isSensitiveDelegatedAction(input.toolName)) {
    return {
      policyClass: "sensitive",
      autoRunAllowed: false,
      requiresSensitiveHandling: true,
      reason: "Credential reveal and support/control-plane mutations require the sensitive handling path.",
    };
  }

  if (input.operation === "read") {
    return {
      policyClass: "read",
      autoRunAllowed: true,
      requiresSensitiveHandling: false,
      reason: "Read/search actions run automatically when scoped.",
    };
  }

  const confidence = normalizedConfidence(input.confidence);
  const highThreshold = input.highConfidenceThreshold ?? 0.8;
  const mediumThreshold = input.mediumConfidenceThreshold ?? 0.55;

  if (input.explicitUserIntent || confidence === null || confidence >= highThreshold) {
    return {
      policyClass: "normal_write",
      autoRunAllowed: true,
      requiresSensitiveHandling: false,
      reason: "Normal delegated writes run automatically when the user intent is explicit or confidence is high.",
    };
  }

  return {
    policyClass: "draft_or_clarify",
    autoRunAllowed: false,
    requiresSensitiveHandling: false,
    reason: confidence >= mediumThreshold
      ? "Medium-confidence work should become a draft before publishing."
      : "Low-confidence work should ask for clarification before writing.",
  };
}
