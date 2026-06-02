import {
  buildClaudeCodeCommand,
  buildClaudeInstallerShareUrl,
  buildCursorInstallLinks,
  CLAUDE_CODE_INSTALLER_PATH,
  CLAUDE_CONNECTORS_URL,
  CLAUDE_INSTALLER_PATH,
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
};

export type EnterpriseServiceView = {
  key: string;
  label: string;
  outcome: string;
  description: string;
  defaultOwnershipMode: string;
};

export type AiWorkspaceProviderGroup = "default" | "byo" | "advanced";

export type AiWorkspaceSetupAction =
  | {
      kind: "copy";
      label: string;
      value: string;
      copiedMessage: string;
      fallbackMessage: string;
    }
  | {
      kind: "copyAndOpen";
      label: string;
      value: string;
      href: string;
      productName: string;
    }
  | {
      kind: "open";
      label: string;
      href: string;
      variant: "primary" | "secondary";
    }
  | {
      kind: "cursorInstall";
      label: string;
      appHref: string;
      browserHref: string;
    };

export type AiWorkspaceSetupCard = {
  provider: AiWorkspaceProviderView;
  group: AiWorkspaceProviderGroup;
  statusLabel: string;
  ownershipLabel: string;
  setupLabel: string;
  connectorUrl: string;
  command?: string;
  actions: AiWorkspaceSetupAction[];
  steps: string[];
  notes: string[];
};

const CHATGPT_APPS_URL = "https://chatgpt.com/apps";
const OPENWORK_SITE_URL = "https://openworklabs.com/";
const OPENWORK_REPO_URL = "https://github.com/different-ai/openwork";

const GROUP_RANK: Record<AiWorkspaceProviderGroup, number> = {
  default: 0,
  byo: 1,
  advanced: 2,
};

const PROVIDER_RANK: Record<string, number> = {
  openwork: 0,
  chatgpt: 1,
  claude: 2,
  gemini: 3,
  cursor: 4,
  claude_code: 5,
  generic_mcp: 6,
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

export function buildAiWorkspaceSetupCards(
  providers: AiWorkspaceProviderView[],
  connectorUrl: string,
  origin?: string | null,
): AiWorkspaceSetupCard[] {
  const cursorLinks = buildCursorInstallLinks(connectorUrl);
  const claudeCodeCommand = buildClaudeCodeCommand(connectorUrl);
  const claudeInstallerShareUrl = buildClaudeInstallerShareUrl(origin);

  return [...providers].sort(providerComparator).map((provider) => {
    const group = providerGroup(provider);
    const base = {
      provider,
      group,
      statusLabel: provider.recommendedDefault ? "Recommended default" : "Needs setup",
      ownershipLabel: ownershipLabel(provider.supportedOwnershipModes),
      setupLabel: setupLabel(provider.setupPath),
      connectorUrl,
    };

    if (provider.key === "openwork") {
      return {
        ...base,
        actions: [
          {
            kind: "copy",
            label: "Copy MCP URL",
            value: connectorUrl,
            copiedMessage: "Copied the Corgtex MCP URL for OpenWork.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the MCP URL.",
          },
          { kind: "open", label: "Open OpenWork", href: OPENWORK_SITE_URL, variant: "primary" },
          { kind: "open", label: "View source", href: OPENWORK_REPO_URL, variant: "secondary" },
        ],
        steps: [
          "Open OpenWork desktop, cloud, or self-hosted workspace.",
          "Add Corgtex as a remote MCP or HTTP connector using the MCP URL.",
          "Complete browser sign-in and keep the default workspace scopes.",
          "Send the first task from Corgtex once execution packets are enabled.",
        ],
        notes: [
          "Free self-managed pilots should start here.",
          "Managed OpenWork rollout still needs license, security, and commercial review.",
        ],
      };
    }

    if (provider.key === "chatgpt") {
      return {
        ...base,
        actions: [
          {
            kind: "copyAndOpen",
            label: "Copy URL and open ChatGPT Apps",
            value: connectorUrl,
            href: CHATGPT_APPS_URL,
            productName: "ChatGPT Apps",
          },
        ],
        steps: [
          "Create a Corgtex app or connector in ChatGPT.",
          "Paste the Corgtex MCP URL as the remote server.",
          "Complete browser sign-in when ChatGPT starts the connector flow.",
        ],
        notes: ["Workspace admins may need to publish the connector for Business, Enterprise, or Edu users."],
      };
    }

    if (provider.key === "claude") {
      return {
        ...base,
        actions: [
          { kind: "open", label: "Open guided installer", href: CLAUDE_INSTALLER_PATH, variant: "primary" },
          {
            kind: "copyAndOpen",
            label: "Copy URL and open Claude Connectors",
            value: connectorUrl,
            href: CLAUDE_CONNECTORS_URL,
            productName: "Claude Connectors",
          },
          {
            kind: "copy",
            label: "Copy share link",
            value: claudeInstallerShareUrl,
            copiedMessage: "Copied the Claude installer share link.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the share link.",
          },
        ],
        steps: [
          "Open Claude connector settings or the guided installer.",
          "Add Corgtex as a custom connector using the MCP URL.",
          "Complete browser sign-in and select this Corgtex workspace.",
        ],
        notes: ["Claude Team or Enterprise owners may need to add the connector at organization level first."],
      };
    }

    if (provider.key === "cursor") {
      return {
        ...base,
        actions: [
          {
            kind: "cursorInstall",
            label: "Add to Cursor",
            appHref: cursorLinks.app,
            browserHref: cursorLinks.browser,
          },
        ],
        steps: [
          "Open the Cursor install prompt.",
          "Approve the MCP server named Corgtex.",
          "Complete browser sign-in when Cursor asks to authenticate.",
        ],
        notes: ["Use this for technical teams that want Corgtex context inside code and product work."],
      };
    }

    if (provider.key === "claude_code") {
      return {
        ...base,
        command: claudeCodeCommand,
        actions: [
          { kind: "open", label: "Open guided installer", href: CLAUDE_CODE_INSTALLER_PATH, variant: "primary" },
          {
            kind: "copy",
            label: "Copy Claude Code command",
            value: claudeCodeCommand,
            copiedMessage: "Copied the Claude Code command.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the command.",
          },
        ],
        steps: [
          "Paste the command into Terminal.",
          "Open Claude Code and inspect MCP connections.",
          "Authenticate Corgtex through browser sign-in when prompted.",
        ],
        notes: ["User scope keeps Corgtex available across projects; local scope can be added later per project."],
      };
    }

    if (provider.key === "gemini") {
      return {
        ...base,
        actions: [
          {
            kind: "copy",
            label: "Copy MCP URL",
            value: connectorUrl,
            copiedMessage: "Copied the Corgtex MCP URL for Gemini CLI.",
            fallbackMessage: "Clipboard access was blocked. Select and copy the MCP URL.",
          },
        ],
        steps: [
          "Open Gemini CLI MCP settings.",
          "Add Corgtex as a remote MCP or HTTP server using the MCP URL.",
          "Complete browser sign-in if the client prompts for OAuth.",
        ],
        notes: ["Consumer Gemini web support is not assumed; this path is for technical CLI users."],
      };
    }

    return {
      ...base,
      actions: [
        {
          kind: "copy",
          label: "Copy MCP URL",
          value: connectorUrl,
          copiedMessage: "Copied the Corgtex MCP URL.",
          fallbackMessage: "Clipboard access was blocked. Select and copy the MCP URL.",
        },
      ],
      steps: [
        "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
        "Paste the Corgtex MCP URL.",
        "Complete browser OAuth and use the workspace-scoped Corgtex tools.",
      ],
      notes: ["Use this for internal tools or AI workspaces that already support remote MCP."],
    };
  });
}

function setupLabel(setupPath: AiWorkspaceProviderView["setupPath"]) {
  if (setupPath === "guided") return "Guided setup";
  if (setupPath === "request") return "Request setup";
  return "Setup recipe";
}

function ownershipLabel(modes: string[]) {
  if (modes.includes("CORGTEX_MANAGED")) return "Self-managed or CORGTEX-managed";
  if (modes.includes("WORKSPACE_MANAGED")) return "User-managed or workspace-managed";
  return modes.map((mode) => mode.replace(/_/g, " ").toLowerCase()).join(", ");
}
