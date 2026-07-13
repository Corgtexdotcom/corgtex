import {
  buildInstallerPath,
  buildInstallerShareUrl,
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

type AiWorkspaceSetupVariantView = {
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

type EnterpriseServiceReadinessCheckView = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type AiWorkspaceProviderGroup = "default" | "byo" | "advanced";

type AiWorkspaceActionVariant = "primary" | "secondary";

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

type AiWorkspaceAdvancedSection = {
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

export type BuildAiWorkspaceSetupCardsOptions = {
  returnTo?: string | null;
  includeClaudeAdvanced?: boolean;
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

function providerComparator(a: AiWorkspaceProviderView, b: AiWorkspaceProviderView) {
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

function isPrimaryAiWorkspaceProvider(provider: AiWorkspaceProviderView) {
  return PRIMARY_PROVIDER_KEYS.includes(provider.key);
}

export function splitAiWorkspaceProviders(providers: AiWorkspaceProviderView[]) {
  const sorted = [...providers].sort(providerDisplayComparator);
  return {
    primary: sorted.filter(isPrimaryAiWorkspaceProvider),
    advanced: sorted.filter((provider) => !isPrimaryAiWorkspaceProvider(provider)),
  };
}

export function primaryAiWorkspaceProviders(providers: AiWorkspaceProviderView[]) {
  return [...providers].filter(isPrimaryAiWorkspaceProvider).sort(providerDisplayComparator);
}

export function buildAiWorkspaceSetupCards(
  providers: AiWorkspaceProviderView[],
  connectorUrl: string,
  origin?: string | null,
  workspaceId?: string | null,
  options: BuildAiWorkspaceSetupCardsOptions = {},
): AiWorkspaceSetupCard[] {
  const includeClaudeAdvanced = options.includeClaudeAdvanced ?? true;

  const providerReturnTo = (providerKey: string) =>
    options.returnTo ?? (workspaceId ? `/workspaces/${workspaceId}/settings?tab=ai-workspaces&provider=${providerKey}` : null);
  const providerInstallerPath = (providerKey: string) => buildInstallerPath(providerKey, {
    workspaceId,
    returnTo: providerReturnTo(providerKey),
  });
  const providerInstallerShareUrl = (providerKey: string) => buildInstallerShareUrl(origin, providerKey, {
    workspaceId,
    returnTo: providerReturnTo(providerKey),
  });
  const installerAction = (providerKey: string, label: string): Extract<AiWorkspaceSetupAction, { kind: "open" }> => ({
    kind: "open",
    label,
    href: providerInstallerPath(providerKey),
    variant: "primary",
  });
  const installerShareAction = (providerKey: string, productName: string): Extract<AiWorkspaceSetupAction, { kind: "copy" }> => ({
    kind: "copy",
    label: "Copy installer link",
    value: providerInstallerShareUrl(providerKey),
    copiedMessage: `Copied the ${productName} installer link.`,
    fallbackMessage: "Clipboard access was blocked. Select and copy the installer link.",
    variant: "secondary",
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
          installerAction(provider.key, "Connect OpenWork"),
          installerShareAction(provider.key, "OpenWork"),
        ],
        steps: [
          "Open the guided installer.",
          "Copy the Corgtex MCP URL and open OpenWork from the installer.",
          "When OpenWork opens Corgtex, authorize as your current Corgtex user for this workspace.",
          "Return here and verify the connection.",
        ],
        notes: [
          "OpenWork must support dynamic client registration for the OAuth connection.",
          "Provider email is not used for authorization; Corgtex uses the signed-in Corgtex user and workspace.",
        ],
      };
    }

    if (provider.key === "chatgpt") {
      return {
        ...base,
        actions: [
          installerAction(provider.key, "Connect ChatGPT"),
          installerShareAction(provider.key, "ChatGPT"),
        ],
        steps: [
          "Open the guided installer.",
          "Copy the Corgtex MCP URL and open ChatGPT connector settings from the installer.",
          "Create the Corgtex app in ChatGPT, scan tools, and let ChatGPT open Corgtex.",
          "Authorize as your current Corgtex user for this workspace, then use Developer Mode and choose Corgtex in chat.",
        ],
        notes: ["Business, Enterprise, or Edu workspaces may require an admin to approve or publish the app before normal users can use it. Corgtex never matches ChatGPT email to Corgtex email."],
      };
    }

    if (provider.key === "claude") {
      return {
        ...base,
        actions: [
          installerAction(provider.key, "Connect Claude"),
          installerShareAction(provider.key, "Claude"),
        ],
        steps: [
          "Open the guided installer.",
          "Approve Corgtex as a custom remote connector.",
          "When Claude opens Corgtex, authorize as your current Corgtex user for this workspace.",
          "Return here and verify the connection.",
        ],
        notes: [
          "Pro and Max users can add a custom connector directly.",
          "Team and Enterprise owners may need to add Corgtex at organization level before members can connect it. Corgtex never matches Claude email to Corgtex email.",
        ],
        advancedSection: includeClaudeAdvanced ? {
          title: "Claude Code",
          description: "For technical teammates who use Claude Code from Terminal.",
          actions: [
            { kind: "open", label: "Open Claude Code installer", href: providerInstallerPath("claude_code"), variant: "secondary" },
            installerShareAction("claude_code", "Claude Code"),
          ],
          steps: [
            "Open the guided Claude Code installer.",
            "Copy the generated command and paste it in Terminal.",
            "Open Claude Code and run /mcp.",
            "When Claude Code opens Corgtex, authorize as your current Corgtex user for this workspace.",
          ],
          notes: ["User scope keeps Corgtex available across projects."],
        } : undefined,
      };
    }

    if (provider.key === "copilot") {
      return {
        ...base,
        actions: [
          installerAction(provider.key, "Connect Copilot"),
          installerShareAction(provider.key, "Copilot"),
        ],
        steps: [
          "Open the guided installer.",
          "Copy the VS Code configuration or Copilot CLI command from the installer.",
          "When Copilot opens Corgtex, authorize as your current Corgtex user for this workspace.",
          "Return here and verify the connection.",
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
          installerAction(provider.key, "Connect Cursor"),
          installerShareAction(provider.key, "Cursor"),
        ],
        steps: [
          "Open the guided installer.",
          "Use Add to Cursor or the manual mcp.json fallback from the installer.",
          "When Cursor opens Corgtex, authorize as your current Corgtex user for this workspace.",
          "Return here and verify the connection.",
        ],
        notes: ["If the install prompt does not open, use the copied mcp.json fallback in Cursor MCP settings."],
      };
    }

    if (provider.key === "gemini") {
      return {
        ...base,
        actions: [
          installerAction(provider.key, "Connect Gemini"),
          installerShareAction(provider.key, "Gemini"),
        ],
        steps: [
          "Open the guided installer.",
          "Copy the Gemini CLI command or settings JSON from the installer.",
          "Open Gemini CLI and run /mcp.",
          "Run /mcp auth corgtex if Gemini asks for authentication, then authorize in Corgtex as your current Corgtex user for this workspace.",
        ],
        notes: ["Consumer Gemini web support is not assumed; this path is for technical CLI users."],
      };
    }

    return {
      ...base,
      actions: [
        installerAction(provider.key, "Open guided installer"),
        installerShareAction(provider.key, provider.shortLabel),
      ],
      steps: [
        "Open the guided installer.",
        "Copy the Corgtex MCP URL from the installer.",
        "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
        "When the client opens Corgtex, authorize as your current Corgtex user for this workspace.",
      ],
      notes: ["Use this for internal tools or AI workspaces that already support remote MCP. Unknown clients appear as Generic MCP after Corgtex OAuth completes."],
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
    return "Paste the Corgtex MCP URL in ChatGPT, authorize in Corgtex, then work from ChatGPT with Corgtex context.";
  }
  if (provider.key === "claude") {
    return "Paste the Corgtex MCP URL in Claude, authorize in Corgtex, then work from Claude with Corgtex context.";
  }
  if (provider.key === "openwork") {
    return "Paste the Corgtex MCP URL in OpenWork, authorize in Corgtex, then work from OpenWork with Corgtex context.";
  }
  if (provider.key === "cursor") {
    return "Install the Corgtex MCP URL in Cursor, authorize in Corgtex, then work from Cursor with Corgtex context.";
  }
  if (provider.key === "copilot") {
    return "Paste the Corgtex MCP URL into VS Code or Copilot CLI, authorize in Corgtex, then verify before use.";
  }
  if (provider.key === "gemini") {
    return "Add the Corgtex MCP URL to Gemini CLI, authorize in Corgtex, then verify before use.";
  }
  return provider.outcome;
}

function ownershipLabel(modes: string[]) {
  if (modes.includes("CORGTEX_MANAGED")) return "Self-managed or CORGTEX-managed";
  if (modes.includes("WORKSPACE_MANAGED")) return "User-managed or workspace-managed";
  return modes.map((mode) => mode.replace(/_/g, " ").toLowerCase()).join(", ");
}
