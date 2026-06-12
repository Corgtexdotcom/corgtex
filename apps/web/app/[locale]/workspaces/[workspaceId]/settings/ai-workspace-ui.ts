import {
  CHATGPT_CONNECTORS_ADVANCED_URL,
  CHATGPT_CONNECTORS_URL,
  COPILOT_DOCS_URL,
  COPILOT_VSCODE_MCP_DOCS_URL,
  buildClaudeCodeCommand,
  buildClaudeInstallerShareUrl,
  buildCopilotCliCommand,
  buildCursorInstallLinks,
  buildCursorMcpJsonConfig,
  buildGeminiMcpCommand,
  buildGeminiMcpConfig,
  buildVsCodeMcpConfig,
  CLAUDE_CODE_INSTALLER_PATH,
  CLAUDE_CONNECTORS_URL,
  GEMINI_MCP_DOCS_URL,
  OPENWORK_DOWNLOAD_URL,
} from "@/lib/install-helpers";

export type AiWorkspaceProviderView = {
  key: string;
  label: string;
  shortLabel: string;
  outcome: string;
  description: string;
  category: "DEFAULT" | "BYO" | "ADVANCED";
  recommendedDefault: boolean;
  freeDefault: boolean;
  setupPath: "guided" | "recipe" | "request";
  capabilities: string[];
  supportedOwnershipModes: string[];
  setupVariants: AiWorkspaceSetupVariantView[];
};

export type AiWorkspaceSetupVariantView = {
  variantKey: string;
  label: string;
  audience: string;
  primaryAction: "open" | "copy" | "copyAndOpen" | "cursorInstall";
  manualSteps: string[];
  limitations: string[];
  verificationPrompt: string;
};

export type EnterpriseServiceView = {
  key: string;
  label: string;
  outcome: string;
  description: string;
  defaultOwnershipMode: string;
  persistedId?: string | null;
  ownershipMode?: string | null;
  healthStatus?: string | null;
  providerKey?: string | null;
  lastHealthCheckAt?: string | null;
  lastSuccessfulHealthCheckAt?: string | null;
  lastSuccessfulSyncAt?: string | null;
  lastError?: string | null;
  usageLabel?: string | null;
  usageDetail?: string | null;
  supportEscalationStatus?: string | null;
  supportEscalatedAt?: string | null;
  supportNotesMd?: string | null;
  readinessChecks?: EnterpriseServiceReadinessCheckView[];
};

export type EnterpriseServiceReadinessCheckView = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type AiWorkspaceProviderGroup = "default" | "byo" | "advanced";

export type AiWorkspaceActionVariant = "primary" | "secondary";

export type AiWorkspaceSetupAction =
  | {
      kind: "copy";
      label: string;
      value: string;
      copiedMessage: string;
      fallbackMessage: string;
      variant?: AiWorkspaceActionVariant;
    }
  | {
      kind: "copyAndOpen";
      label: string;
      value: string;
      href: string;
      productName: string;
      variant?: AiWorkspaceActionVariant;
    }
  | {
      kind: "open";
      label: string;
      href: string;
      variant?: AiWorkspaceActionVariant;
    }
  | {
      kind: "cursorInstall";
      label: string;
      appHref: string;
      browserHref: string;
      variant?: AiWorkspaceActionVariant;
    };

export type AiWorkspaceAdvancedSection = {
  title: string;
  description: string;
  actions: AiWorkspaceSetupAction[];
  steps: string[];
  notes: string[];
};

export type AiWorkspaceSetupCard = {
  provider: AiWorkspaceProviderView;
  group: AiWorkspaceProviderGroup;
  statusLabel: string;
  ownershipLabel: string;
  connectorUrl: string;
  summary: string;
  actions: AiWorkspaceSetupAction[];
  steps: string[];
  notes: string[];
  advancedSection?: AiWorkspaceAdvancedSection;
};

const PRIMARY_PROVIDER_KEYS = ["openwork", "claude", "chatgpt", "cursor"];

const GROUP_RANK: Record<AiWorkspaceProviderGroup, number> = {
  default: 0,
  byo: 1,
  advanced: 2,
};

const PROVIDER_RANK: Record<string, number> = {
  openwork: 0,
  claude: 1,
  chatgpt: 2,
  cursor: 3,
  copilot: 4,
  gemini: 5,
  claude_code: 6,
  generic_mcp: 7,
};

const CAPABILITY_LABELS: Record<string, string> = {
  remote_mcp: "Remote MCP",
  skill_install: "Skill package",
  local_client: "Local client",
  hosted_worker: "Hosted worker",
  oauth: "OAuth",
  api_key: "API key",
  health_check: "Health check",
  write_back: "Write-back",
  browser_execution: "Browser execution",
  code_execution: "Code execution",
};

const ENTERPRISE_SERVICE_OWNERSHIP_LABELS: Record<string, string> = {
  CUSTOMER_MANAGED: "Customer-managed",
  CORGTEX_MANAGED: "CORGTEX-managed",
};

const ENTERPRISE_SERVICE_HEALTH_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  NEEDS_SETUP: "Needs setup",
  UNHEALTHY: "Unhealthy",
  DISCONNECTED: "Disconnected",
  SUSPENDED: "Suspended",
  MANAGED_EXTERNALLY: "Managed externally",
};

export type EnterpriseServiceHealthTone = "success" | "warning" | "danger" | "neutral" | "info";

export function providerGroup(provider: AiWorkspaceProviderView): AiWorkspaceProviderGroup {
  if (provider.category === "DEFAULT" || provider.recommendedDefault) return "default";
  if (provider.category === "BYO") return "byo";
  return "advanced";
}

export function groupAiWorkspaceProviders(providers: AiWorkspaceProviderView[]) {
  const groups: Record<AiWorkspaceProviderGroup, AiWorkspaceProviderView[]> = {
    default: [],
    byo: [],
    advanced: [],
  };

  for (const provider of providers) {
    groups[providerGroup(provider)].push(provider);
  }

  for (const key of Object.keys(groups) as AiWorkspaceProviderGroup[]) {
    groups[key].sort(providerComparator);
  }

  return groups;
}

export function providerComparator(a: AiWorkspaceProviderView, b: AiWorkspaceProviderView) {
  return GROUP_RANK[providerGroup(a)] - GROUP_RANK[providerGroup(b)]
    || Number(b.recommendedDefault) - Number(a.recommendedDefault)
    || (PROVIDER_RANK[a.key] ?? 100) - (PROVIDER_RANK[b.key] ?? 100)
    || a.label.localeCompare(b.label);
}

export function capabilityLabel(capability: string) {
  return CAPABILITY_LABELS[capability] ?? capability.replace(/_/g, " ");
}

export function enterpriseServiceOwnershipLabel(value: string | null | undefined) {
  if (!value) return "Customer-managed";
  return ENTERPRISE_SERVICE_OWNERSHIP_LABELS[value] ?? value.replace(/_/g, " ").toLowerCase();
}

export function enterpriseServiceHealthLabel(value: string | null | undefined) {
  if (!value) return "Needs setup";
  return ENTERPRISE_SERVICE_HEALTH_LABELS[value] ?? value.replace(/_/g, " ").toLowerCase();
}

export function enterpriseServiceHealthTone(value: string | null | undefined): EnterpriseServiceHealthTone {
  if (value === "ACTIVE") return "success";
  if (value === "NEEDS_SETUP" || value === "MANAGED_EXTERNALLY") return "warning";
  if (value === "UNHEALTHY" || value === "DISCONNECTED" || value === "SUSPENDED") return "danger";
  return "neutral";
}

export function enterpriseServiceProviderLabel(value: string | null | undefined) {
  if (!value) return "No provider recorded";
  return value.replace(/_/g, " ").toLowerCase();
}

export function formatServiceTimestamp(value: string | null | undefined) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function normalizeSelectedProvider(
  value: string | string[] | undefined,
  providers: AiWorkspaceProviderView[],
) {
  const selected = Array.isArray(value) ? value[0] : value;
  if (selected && providers.some((provider) => provider.key === selected)) return selected;
  return providers.find((provider) => provider.recommendedDefault)?.key ?? providers[0]?.key ?? null;
}

export function normalizeSelectedService(
  value: string | string[] | undefined,
  services: EnterpriseServiceView[],
) {
  const selected = Array.isArray(value) ? value[0] : value;
  if (selected && services.some((service) => service.key === selected)) return selected;
  return null;
}

export function isPrimaryAiWorkspaceProvider(provider: AiWorkspaceProviderView) {
  return PRIMARY_PROVIDER_KEYS.includes(provider.key);
}

export function splitAiWorkspaceProviders(providers: AiWorkspaceProviderView[]) {
  const sorted = [...providers].sort(providerDisplayComparator);
  return {
    primary: sorted.filter(isPrimaryAiWorkspaceProvider),
    advanced: sorted.filter((provider) => !isPrimaryAiWorkspaceProvider(provider)),
  };
}

export function buildAiWorkspaceSetupCards(
  providers: AiWorkspaceProviderView[],
  connectorUrl: string,
  origin?: string | null,
  workspaceId?: string | null,
): AiWorkspaceSetupCard[] {
  const cursorLinks = buildCursorInstallLinks(connectorUrl);
  const claudeCodeCommand = buildClaudeCodeCommand(connectorUrl);
  const claudeReturnTo = workspaceId ? `/workspaces/${workspaceId}/settings?tab=ai-workspaces&provider=claude` : null;
  const claudeInstallerPath = buildClaudeInstallerShareUrl(null, {
    workspaceId,
    returnTo: claudeReturnTo,
  });
  const claudeInstallerShareUrl = buildClaudeInstallerShareUrl(origin, {
    workspaceId,
    returnTo: claudeReturnTo,
  });

  return [...providers].sort(providerDisplayComparator).map((provider) => {
    const group = providerGroup(provider);
    const base = {
      provider,
      group,
      statusLabel: provider.recommendedDefault ? "Recommended" : "Needs setup",
      ownershipLabel: ownershipLabel(provider.supportedOwnershipModes),
      connectorUrl,
      summary: connectionSummary(provider),
    };

    if (provider.key === "openwork") {
      return {
        ...base,
        actions: [
          {
            kind: "copyAndOpen",
            label: "Connect OpenWork",
            value: connectorUrl,
            href: OPENWORK_DOWNLOAD_URL,
            productName: "OpenWork",
            variant: "primary",
          },
          copyMcpUrlAction(connectorUrl, "OpenWork"),
        ],
        steps: [
          "Open your OpenWork workspace.",
          "Go to Extensions, then Advanced Settings, then Add MCP server.",
          "Paste the Corgtex MCP URL, enable OAuth, and finish browser sign-in.",
        ],
        notes: [
          "OpenWork must support dynamic client registration for the OAuth connection.",
          "After it is connected, users work in OpenWork and Corgtex supplies the governed company context.",
        ],
      };
    }

    if (provider.key === "chatgpt") {
      return {
        ...base,
        actions: [
          {
            kind: "copyAndOpen",
            label: "Connect ChatGPT",
            value: connectorUrl,
            href: CHATGPT_CONNECTORS_URL,
            productName: "ChatGPT connector settings",
            variant: "primary",
          },
          { kind: "open", label: "Open advanced settings", href: CHATGPT_CONNECTORS_ADVANCED_URL, variant: "secondary" },
          copyMcpUrlAction(connectorUrl, "ChatGPT"),
        ],
        steps: [
          "In ChatGPT settings, open Connectors, then Advanced settings.",
          "Turn on Developer Mode if it is not already enabled.",
          "Create an app, paste the HTTPS Corgtex MCP URL, scan tools, and authenticate.",
          "In a chat, use Developer Mode and choose Corgtex when you want ChatGPT to work with Corgtex.",
        ],
        notes: ["Business, Enterprise, or Edu workspaces may require an admin to approve or publish the app before normal users can use it."],
      };
    }

    if (provider.key === "claude") {
      return {
        ...base,
        actions: [
          { kind: "open", label: "Connect Claude", href: claudeInstallerPath, variant: "primary" },
          {
            kind: "copyAndOpen",
            label: "Open Claude settings",
            value: connectorUrl,
            href: CLAUDE_CONNECTORS_URL,
            productName: "Claude Connectors",
            variant: "secondary",
          },
          {
            kind: "copy",
            label: "Copy share link",
            value: claudeInstallerShareUrl,
            copiedMessage: "Copied the Claude installer share link.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the share link.",
            variant: "secondary",
          },
        ],
        steps: [
          "Open the guided installer.",
          "Approve Corgtex as a custom remote connector.",
          "Finish browser sign-in and choose this workspace.",
        ],
        notes: [
          "Pro and Max users can add a custom connector directly.",
          "Team and Enterprise owners may need to add Corgtex at organization level before members can connect it.",
        ],
        advancedSection: {
          title: "Claude Code",
          description: "For technical teammates who use Claude Code from Terminal.",
          actions: [
            { kind: "open", label: "Open Claude Code installer", href: CLAUDE_CODE_INSTALLER_PATH, variant: "secondary" },
            {
              kind: "copy",
              label: "Copy Claude Code command",
              value: claudeCodeCommand,
              copiedMessage: "Copied the Claude Code command.",
              fallbackMessage: "Clipboard access was blocked. Select and copy the command.",
              variant: "secondary",
            },
          ],
          steps: [
            "Paste the command in Terminal.",
            "Open Claude Code and run /mcp.",
            "Authenticate Corgtex in the browser when prompted.",
          ],
          notes: ["User scope keeps Corgtex available across projects."],
        },
      };
    }

    if (provider.key === "copilot") {
      return {
        ...base,
        actions: [
          {
            kind: "copy",
            label: "Copy VS Code config",
            value: JSON.stringify(buildVsCodeMcpConfig(connectorUrl), null, 2),
            copiedMessage: "Copied the VS Code MCP configuration.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the configuration.",
            variant: "primary",
          },
          {
            kind: "copy",
            label: "Copy Copilot CLI command",
            value: buildCopilotCliCommand(connectorUrl),
            copiedMessage: "Copied the Copilot CLI command.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the command.",
            variant: "secondary",
          },
          { kind: "open", label: "VS Code MCP docs", href: COPILOT_VSCODE_MCP_DOCS_URL, variant: "secondary" },
          { kind: "open", label: "Copilot CLI docs", href: COPILOT_DOCS_URL, variant: "secondary" },
        ],
        steps: [
          "In VS Code, run MCP: Add Server or paste the copied user/workspace mcp.json entry.",
          "For Copilot CLI, use /mcp add or paste the copied command.",
          "Authenticate in the browser if the selected Copilot surface supports OAuth remote MCP.",
        ],
        notes: [
          "Repository and cloud-agent Copilot MCP setup is not offered here because OAuth-backed remote MCP is not supported for that path.",
        ],
      };
    }

    if (provider.key === "cursor") {
      return {
        ...base,
        actions: [
          {
            kind: "cursorInstall",
            label: "Connect Cursor",
            appHref: cursorLinks.app,
            browserHref: cursorLinks.browser,
            variant: "primary",
          },
          {
            kind: "copy",
            label: "Copy manual mcp.json",
            value: JSON.stringify(buildCursorMcpJsonConfig(connectorUrl), null, 2),
            copiedMessage: "Copied the Cursor MCP configuration.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the configuration.",
            variant: "secondary",
          },
        ],
        steps: [
          "Click Add to Cursor.",
          "Approve the Corgtex MCP install prompt.",
          "Finish browser sign-in when Cursor asks to authenticate.",
        ],
        notes: ["If the install prompt does not open, use the copied mcp.json fallback in Cursor MCP settings."],
      };
    }

    if (provider.key === "gemini") {
      return {
        ...base,
        actions: [
          {
            kind: "copy",
            label: "Copy Gemini command",
            value: buildGeminiMcpCommand(connectorUrl),
            copiedMessage: "Copied the Gemini CLI MCP command.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the command.",
            variant: "primary",
          },
          {
            kind: "copy",
            label: "Copy settings JSON",
            value: JSON.stringify(buildGeminiMcpConfig(connectorUrl), null, 2),
            copiedMessage: "Copied the Gemini CLI MCP settings.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the configuration.",
            variant: "secondary",
          },
          { kind: "open", label: "Gemini MCP docs", href: GEMINI_MCP_DOCS_URL, variant: "secondary" },
        ],
        steps: [
          "Paste the command in Terminal, or use the settings JSON fallback with httpUrl.",
          "Open Gemini CLI and run /mcp.",
          "Run /mcp auth corgtex if Gemini asks for authentication.",
        ],
        notes: ["Consumer Gemini web support is not assumed; this path is for technical CLI users."],
      };
    }

    return {
      ...base,
      actions: [copyMcpUrlAction(connectorUrl, provider.shortLabel, "primary")],
      steps: [
        "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
        "Paste the Corgtex MCP URL.",
        "Complete browser OAuth and confirm Corgtex tools are visible.",
      ],
      notes: ["Use this for internal tools or AI workspaces that already support remote MCP."],
    };
  });
}

function providerDisplayComparator(a: AiWorkspaceProviderView, b: AiWorkspaceProviderView) {
  return (PROVIDER_RANK[a.key] ?? 100) - (PROVIDER_RANK[b.key] ?? 100)
    || GROUP_RANK[providerGroup(a)] - GROUP_RANK[providerGroup(b)]
    || a.label.localeCompare(b.label);
}

function connectionSummary(provider: AiWorkspaceProviderView) {
  if (provider.key === "chatgpt") {
    return "Connect Corgtex as a ChatGPT developer-mode app. After that, users work in ChatGPT and call Corgtex from the chat.";
  }
  if (provider.key === "claude") {
    return "Connect Corgtex as a Claude remote connector. After that, users work in Claude and Corgtex supplies company context.";
  }
  if (provider.key === "openwork") {
    return "Use OpenWork as the default free AI workspace connected to Corgtex through MCP.";
  }
  if (provider.key === "cursor") {
    return "Install Corgtex in Cursor with Cursor's one-click MCP install link.";
  }
  if (provider.key === "copilot") {
    return "Advanced setup for VS Code or Copilot CLI. Repository and cloud-agent OAuth paths are intentionally not offered.";
  }
  if (provider.key === "gemini") {
    return "Advanced setup for Gemini CLI using an HTTP MCP server and browser authentication.";
  }
  return provider.outcome;
}

function copyMcpUrlAction(
  connectorUrl: string,
  productName: string,
  variant: AiWorkspaceActionVariant = "secondary",
): Extract<AiWorkspaceSetupAction, { kind: "copy" }> {
  return {
    kind: "copy",
    label: "Copy MCP URL",
    value: connectorUrl,
    copiedMessage: `Copied the Corgtex MCP URL for ${productName}.`,
    fallbackMessage: "Clipboard access was blocked. Select and copy the MCP URL.",
    variant,
  };
}

function ownershipLabel(modes: string[]) {
  if (modes.includes("CORGTEX_MANAGED")) return "Self-managed or CORGTEX-managed";
  if (modes.includes("WORKSPACE_MANAGED")) return "User-managed or workspace-managed";
  return modes.map((mode) => mode.replace(/_/g, " ").toLowerCase()).join(", ");
}
