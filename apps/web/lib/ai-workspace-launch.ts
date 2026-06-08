import {
  CHATGPT_APPS_URL,
  CLAUDE_CHAT_URL,
  COPILOT_VSCODE_MCP_DOCS_URL,
  CURSOR_MCP_DOCS_URL,
  GEMINI_MCP_DOCS_URL,
  OPENWORK_DOWNLOAD_URL,
} from "@/lib/install-helpers";

export type AiWorkspaceSetupVariant = {
  variantKey: string;
  label: string;
  audience: string;
  primaryAction: "open" | "copy" | "copyAndOpen" | "cursorInstall";
  manualSteps: string[];
  limitations: string[];
  verificationPrompt: string;
};

export type AiWorkspaceLaunchProvider = {
  key: string;
  label: string;
  shortLabel: string;
  outcome: string;
  description: string;
  recommendedDefault: boolean;
  freeDefault: boolean;
  setupVariants: AiWorkspaceSetupVariant[];
};

export type AiWorkspaceLaunchState = {
  activeProviderKey: string | null;
  providers: AiWorkspaceLaunchProvider[];
};

export type ExecutionWritebackOption = {
  value: string;
  label: string;
  description: string;
};

export type BuildExecutionRequestPayloadParams = {
  goal: string;
  providerKey: string;
  surface: "mobile_work" | "desktop_rail";
  currentPath: string;
  writebackTargetType: string;
  idempotencyKey: string;
};

export type BuildHandoffPromptParams = {
  requestId: string;
  providerLabel: string;
  goal: string;
  writebackTargetLabel: string;
};

const AI_WORKSPACE_LAUNCH_URLS: Record<string, string> = {
  openwork: OPENWORK_DOWNLOAD_URL,
  chatgpt: CHATGPT_APPS_URL,
  claude: CLAUDE_CHAT_URL,
  copilot: COPILOT_VSCODE_MCP_DOCS_URL,
  cursor: CURSOR_MCP_DOCS_URL,
  gemini: GEMINI_MCP_DOCS_URL,
};

export const EXECUTION_WRITEBACK_OPTIONS: ExecutionWritebackOption[] = [
  { value: "ACTION", label: "New action", description: "Turn the result into a trackable action draft." },
  { value: "TENSION", label: "New tension", description: "Capture the result as a tension for review." },
  { value: "PROPOSAL", label: "New proposal", description: "Draft a governance proposal from the result." },
  { value: "BRAIN_ARTICLE", label: "Brain article", description: "Write back a knowledge article or runbook draft." },
  { value: "BUILD_ARTIFACT", label: "Build artifact", description: "Attach a file, output, or implementation artifact." },
  { value: "COMMENT", label: "Comment only", description: "Submit a governed result without creating a new record." },
];

export function aiWorkspaceLaunchUrl(providerKey: string | null | undefined) {
  if (!providerKey) return null;
  return AI_WORKSPACE_LAUNCH_URLS[providerKey] ?? null;
}

export function aiWorkspaceSettingsHref(workspaceId: string, providerKey: string | null | undefined) {
  const params = new URLSearchParams({ tab: "ai-workspaces" });
  if (providerKey) params.set("provider", providerKey);
  return `/workspaces/${workspaceId}/settings?${params.toString()}`;
}

export function activeAiWorkspaceProvider(state: AiWorkspaceLaunchState | null | undefined) {
  if (!state?.activeProviderKey) return null;
  return state.providers.find((provider) => provider.key === state.activeProviderKey) ?? null;
}

export function writebackOptionLabel(value: string | null | undefined) {
  return EXECUTION_WRITEBACK_OPTIONS.find((option) => option.value === value)?.label ?? "Execution result";
}

export function buildExecutionRequestPayload({
  goal,
  providerKey,
  surface,
  currentPath,
  writebackTargetType,
  idempotencyKey,
}: BuildExecutionRequestPayloadParams) {
  return {
    goal: goal.trim(),
    provider: providerKey,
    context: {
      source: "corgtex-ui",
      surface,
      currentPath,
    },
    expectedOutput: {
      mode: "draft",
      instructions: [
        "Use Corgtex tools for company context, allowed scopes, and write-back targets.",
        "Submit the result back to Corgtex with status, artifacts, idempotency, and target mapping.",
      ],
    },
    approvalRule: "Submit a draft result back to Corgtex for review before final write-back unless the execution packet explicitly allows direct write-back.",
    writebackTargetType,
    writebackTargetLabel: writebackOptionLabel(writebackTargetType),
    idempotencyKey,
  };
}

export function buildExecutionRequestHandoffPrompt({
  requestId,
  providerLabel,
  goal,
  writebackTargetLabel,
}: BuildHandoffPromptParams) {
  return [
    `Pick up Corgtex execution request ${requestId} in ${providerLabel}.`,
    "",
    `Goal: ${goal.trim()}`,
    `Expected write-back: ${writebackTargetLabel}`,
    "",
    "Use the Corgtex MCP tools in this order:",
    "1. get_execution_packet for the request id above.",
    "2. get_company_context only within the scopes granted by the packet.",
    "3. list_writeback_targets before choosing an output destination.",
    "4. submit_execution_result with artifacts, status, idempotency, and target mapping.",
    "",
    "Do not write directly to unsupported destinations. If the packet requires approval, return a draft result for review.",
  ].join("\n");
}

export function createUiIdempotencyKey(prefix: string) {
  const randomValue = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${randomValue}`;
}
