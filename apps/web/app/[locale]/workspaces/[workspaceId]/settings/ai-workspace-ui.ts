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
  resources: AiWorkspaceSetupResource[];
  steps: string[];
  notes: string[];
  verificationChecks: string[];
};

export type AiWorkspaceSetupResource = {
  title: string;
  label: string;
  value: string;
  copiedMessage: string;
  fallbackMessage: string;
};

const CHATGPT_APPS_URL = "https://chatgpt.com/apps";
const OPENWORK_SITE_URL = "https://openworklabs.com/";
const OPENWORK_REPO_URL = "https://github.com/different-ai/openwork";

type ProviderRecipeDefinition = {
  title: string;
  surface: string;
  setupTarget: string;
  executionBoundary: string;
  extraRules: string[];
  verificationChecks: string[];
};

const PROVIDER_RECIPE_DEFINITIONS: Record<string, ProviderRecipeDefinition> = {
  chatgpt: {
    title: "ChatGPT connector instructions",
    surface: "ChatGPT",
    setupTarget: "Create or update the Corgtex app or connector and use the MCP URL as the remote server.",
    executionBoundary: "Use ChatGPT for conversation, analysis, and drafting; use Corgtex tools for company context, policy constraints, scopes, execution packets, and write-back.",
    extraRules: [
      "Do not paste secrets or private setup credentials into ChatGPT chat; complete connector auth through the browser flow.",
      "For Business, Enterprise, or Edu workspaces, confirm an admin has published or approved the connector before asking normal users to rely on it.",
    ],
    verificationChecks: [
      "ChatGPT can start the Corgtex connector auth flow.",
      "Company context and allowed scopes are available through Corgtex tools.",
      "Write-back targets can be listed before any result is submitted.",
      "The test prompt returns a readiness report without creating external changes.",
    ],
  },
  claude: {
    title: "Claude connector instructions",
    surface: "Claude",
    setupTarget: "Use the guided installer or Claude connector settings to add Corgtex as a custom remote connector.",
    executionBoundary: "Use Claude for planning and writing; use Corgtex as the durable source for context, policies, scope boundaries, approval rules, and output write-back.",
    extraRules: [
      "Claude Team or Enterprise owners may need to approve the connector at organization level.",
      "Keep final outputs tied to Corgtex execution requests when the work needs audit or write-back.",
    ],
    verificationChecks: [
      "Claude can open the Corgtex connector and complete browser sign-in.",
      "Claude can read company context through Corgtex without asking the user to paste private context.",
      "Claude can list write-back targets before proposing where output should go.",
      "Claude keeps governed output in Corgtex rather than only in the chat transcript.",
    ],
  },
  gemini: {
    title: "Gemini CLI MCP instructions",
    surface: "Gemini CLI",
    setupTarget: "Use Gemini CLI MCP settings to add Corgtex as a remote MCP or HTTP server.",
    executionBoundary: "Use Gemini CLI for technical execution; use Corgtex for context, scopes, policies, approval rules, and write-back state.",
    extraRules: [
      "Consumer Gemini web support is not assumed; this recipe is for technical CLI users.",
      "Treat local terminal access as a powerful execution surface and follow the approval rule in every execution packet.",
    ],
    verificationChecks: [
      "Gemini CLI can reach the Corgtex MCP URL.",
      "Browser sign-in or OAuth completes without exposing tokens in terminal history.",
      "Gemini CLI can list available Corgtex tools and write-back targets.",
      "The test prompt confirms no external change was made during setup verification.",
    ],
  },
  cursor: {
    title: "Cursor MCP instructions",
    surface: "Cursor",
    setupTarget: "Approve the Corgtex MCP install prompt and complete browser sign-in when Cursor asks to authenticate.",
    executionBoundary: "Use Cursor for code and product execution; use Corgtex execution packets for authority, context, policy, write-back targets, and audit.",
    extraRules: [
      "Do not create branches, commits, deployments, or external writes unless the execution packet allows that action.",
      "Keep implementation notes and artifacts mapped back to Corgtex when the work is governed.",
    ],
    verificationChecks: [
      "Cursor shows a Corgtex MCP server after install.",
      "Cursor can read scoped company context without copying private context into editor rules.",
      "Cursor can see execution packet and result submission tools for governed code work.",
      "Cursor can report a safe next action before modifying files.",
    ],
  },
  claude_code: {
    title: "Claude Code MCP instructions",
    surface: "Claude Code",
    setupTarget: "Run the generated Claude Code MCP command, then authenticate Corgtex through browser sign-in.",
    executionBoundary: "Use Claude Code for code execution; use Corgtex to determine authority, scope, approval rules, write-back targets, and durable result records.",
    extraRules: [
      "User scope keeps Corgtex available across projects; add local project scope only when a project needs a different boundary.",
      "Do not commit, push, deploy, or submit results unless the execution packet permits the action.",
    ],
    verificationChecks: [
      "Claude Code lists the Corgtex MCP server after the install command.",
      "Claude Code can authenticate without exposing tokens in shell history.",
      "Claude Code can retrieve context and allowed write-back targets through Corgtex.",
      "Claude Code can explain the approval rule before changing files.",
    ],
  },
  generic_mcp: {
    title: "Generic MCP client instructions",
    surface: "Generic MCP client",
    setupTarget: "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client and paste the Corgtex MCP URL.",
    executionBoundary: "Use the external client for execution; use Corgtex as the enterprise plumbing layer for context, scopes, policies, audit, and write-back.",
    extraRules: [
      "Do not use unscoped local credentials or shared tokens when the client supports browser OAuth.",
      "If the client cannot show available Corgtex tools or scopes, treat it as not ready for governed work.",
    ],
    verificationChecks: [
      "The client can reach the Corgtex MCP URL.",
      "The client completes browser OAuth or an approved auth flow.",
      "The client can list Corgtex tools and write-back targets.",
      "The client returns a no-change readiness report before production work starts.",
    ],
  },
};

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
      const instructionsPackage = buildOpenWorkInstructionsPackage(connectorUrl);
      const testPrompt = buildOpenWorkTestPrompt();
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
          {
            kind: "copy",
            label: "Copy instructions",
            value: instructionsPackage.value,
            copiedMessage: instructionsPackage.copiedMessage,
            fallbackMessage: instructionsPackage.fallbackMessage,
          },
          {
            kind: "copy",
            label: "Copy test prompt",
            value: testPrompt.value,
            copiedMessage: testPrompt.copiedMessage,
            fallbackMessage: testPrompt.fallbackMessage,
          },
          { kind: "open", label: "Open OpenWork", href: OPENWORK_SITE_URL, variant: "primary" },
          { kind: "open", label: "View source", href: OPENWORK_REPO_URL, variant: "secondary" },
        ],
        resources: [instructionsPackage, testPrompt],
        steps: [
          "Open OpenWork desktop, cloud, or self-hosted workspace.",
          "Add Corgtex as a remote MCP or HTTP connector using the MCP URL.",
          "Install the Corgtex instructions as the OpenWork workspace or skill guidance.",
          "Complete browser sign-in and keep the recommended workspace scopes.",
          "Run the test prompt before sending production work from Corgtex.",
        ],
        notes: [
          "Free self-managed pilots should start here.",
          "Corgtex remains the context, policy, scope, audit, and write-back system; OpenWork remains the execution workspace.",
          "Managed OpenWork rollout still needs license, security, and commercial review.",
        ],
        verificationChecks: [
          "OpenWork can reach the Corgtex MCP URL and complete browser sign-in.",
          "The test prompt can read company context through Corgtex.",
          "The test prompt can list allowed write-back targets without exposing private targets outside its scopes.",
          "Execution packet tools are visible for governed work requests.",
          "OpenWork is instructed to submit results back to Corgtex instead of writing directly to unsupported destinations.",
        ],
      };
    }

    if (provider.key === "chatgpt") {
      const recipe = buildProviderRecipe(provider, connectorUrl);
      return {
        ...base,
        actions: [
          ...buildResourceCopyActions(recipe.resources),
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
          "Copy the Corgtex instructions into the connector or workspace guidance.",
          "Run the safe test prompt before using ChatGPT for governed work.",
        ],
        resources: recipe.resources,
        notes: ["Workspace admins may need to publish the connector for Business, Enterprise, or Edu users."],
        verificationChecks: recipe.verificationChecks,
      };
    }

    if (provider.key === "claude") {
      const recipe = buildProviderRecipe(provider, connectorUrl);
      return {
        ...base,
        actions: [
          { kind: "open", label: "Open guided installer", href: CLAUDE_INSTALLER_PATH, variant: "primary" },
          ...buildResourceCopyActions(recipe.resources),
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
          "Copy the Corgtex instructions into Claude project or connector guidance.",
          "Run the safe test prompt before sending governed work.",
        ],
        resources: recipe.resources,
        notes: ["Claude Team or Enterprise owners may need to add the connector at organization level first."],
        verificationChecks: recipe.verificationChecks,
      };
    }

    if (provider.key === "cursor") {
      const recipe = buildProviderRecipe(provider, connectorUrl);
      return {
        ...base,
        actions: [
          {
            kind: "cursorInstall",
            label: "Add to Cursor",
            appHref: cursorLinks.app,
            browserHref: cursorLinks.browser,
          },
          ...buildResourceCopyActions(recipe.resources),
        ],
        steps: [
          "Open the Cursor install prompt.",
          "Approve the MCP server named Corgtex.",
          "Complete browser sign-in when Cursor asks to authenticate.",
          "Add the Corgtex instructions to workspace rules when the team wants governed code work.",
          "Run the safe test prompt before modifying files.",
        ],
        resources: recipe.resources,
        notes: ["Use this for technical teams that want Corgtex context inside code and product work."],
        verificationChecks: recipe.verificationChecks,
      };
    }

    if (provider.key === "claude_code") {
      const recipe = buildProviderRecipe(provider, connectorUrl, claudeCodeCommand);
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
          ...buildResourceCopyActions(recipe.resources),
        ],
        steps: [
          "Paste the command into Terminal.",
          "Open Claude Code and inspect MCP connections.",
          "Authenticate Corgtex through browser sign-in when prompted.",
          "Copy the Corgtex instructions into project guidance for governed work.",
          "Run the safe test prompt before changing files.",
        ],
        resources: recipe.resources,
        notes: ["User scope keeps Corgtex available across projects; local scope can be added later per project."],
        verificationChecks: recipe.verificationChecks,
      };
    }

    if (provider.key === "gemini") {
      const recipe = buildProviderRecipe(provider, connectorUrl);
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
          ...buildResourceCopyActions(recipe.resources),
        ],
        steps: [
          "Open Gemini CLI MCP settings.",
          "Add Corgtex as a remote MCP or HTTP server using the MCP URL.",
          "Complete browser sign-in if the client prompts for OAuth.",
          "Copy the Corgtex instructions into the CLI session or project guidance.",
          "Run the safe test prompt before using Gemini CLI for governed work.",
        ],
        resources: recipe.resources,
        notes: ["Consumer Gemini web support is not assumed; this path is for technical CLI users."],
        verificationChecks: recipe.verificationChecks,
      };
    }

    const recipe = buildProviderRecipe(provider, connectorUrl);
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
        ...buildResourceCopyActions(recipe.resources),
      ],
      steps: [
        "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
        "Paste the Corgtex MCP URL.",
        "Complete browser OAuth and use the workspace-scoped Corgtex tools.",
        "Copy the Corgtex instructions into the client guidance if supported.",
        "Run the safe test prompt before production work.",
      ],
      resources: recipe.resources,
      notes: ["Use this for internal tools or AI workspaces that already support remote MCP."],
      verificationChecks: recipe.verificationChecks,
    };
  });
}

function buildProviderRecipe(
  provider: AiWorkspaceProviderView,
  connectorUrl: string,
  command?: string,
) {
  const definition = PROVIDER_RECIPE_DEFINITIONS[provider.key] ?? PROVIDER_RECIPE_DEFINITIONS.generic_mcp;
  const instructions = buildProviderInstructionsResource(definition, connectorUrl, command);
  const testPrompt = buildProviderTestPromptResource(definition);

  return {
    resources: [instructions, testPrompt],
    verificationChecks: definition.verificationChecks,
  };
}

function buildResourceCopyActions(resources: AiWorkspaceSetupResource[]): AiWorkspaceSetupAction[] {
  return resources.map((resource) => ({
    kind: "copy",
    label: resource.label === "Test prompt" ? "Copy test prompt" : "Copy instructions",
    value: resource.value,
    copiedMessage: resource.copiedMessage,
    fallbackMessage: resource.fallbackMessage,
  }));
}

function buildProviderInstructionsResource(
  definition: ProviderRecipeDefinition,
  connectorUrl: string,
  command?: string,
): AiWorkspaceSetupResource {
  return {
    title: definition.title,
    label: "Instructions package",
    copiedMessage: `Copied the ${definition.surface} Corgtex instructions.`,
    fallbackMessage: "Clipboard access was blocked. Select and copy the instructions package.",
    value: [
      `# Corgtex Instructions for ${definition.surface}`,
      "",
      definition.setupTarget,
      "",
      `Corgtex MCP server: ${connectorUrl}`,
      command ? `Install command: ${command}` : null,
      "",
      "Operating boundary:",
      definition.executionBoundary,
      "",
      "Required behavior:",
      "- Pull company context, policies, allowed scopes, and write-back targets from Corgtex before executing governed work.",
      "- Use Corgtex execution packets as the source of goal, actor, approval rule, and output destination.",
      "- Do not invent authority, bypass scopes, or write to unsupported destinations.",
      "- Submit governed results back to Corgtex with status, artifacts, idempotency, and target mapping.",
      ...definition.extraRules.map((rule) => `- ${rule}`),
      "",
      "Useful Corgtex tools:",
      "- get_company_context",
      "- list_writeback_targets",
      "- create_execution_request",
      "- get_execution_packet",
      "- submit_execution_result",
    ].filter((line): line is string => line !== null).join("\n"),
  };
}

function buildProviderTestPromptResource(definition: ProviderRecipeDefinition): AiWorkspaceSetupResource {
  return {
    title: `${definition.surface} connection test prompt`,
    label: "Test prompt",
    copiedMessage: `Copied the ${definition.surface} Corgtex test prompt.`,
    fallbackMessage: "Clipboard access was blocked. Select and copy the test prompt.",
    value: [
      `Test the Corgtex connection in ${definition.surface} without making external changes.`,
      "",
      "1. Use Corgtex tools to read the current company context and summarize only what the granted scopes allow.",
      "2. List available write-back target types and explain which ones are safe to use.",
      "3. Confirm whether execution request creation, packet retrieval, and result submission tools are visible.",
      "4. Do not create records, submit results, change files, deploy, or write to external systems.",
      "5. Return a short readiness report with connected, missing setup, scope limitations, and next safe action.",
    ].join("\n"),
  };
}

function buildOpenWorkInstructionsPackage(connectorUrl: string): AiWorkspaceSetupResource {
  return {
    title: "Corgtex OpenWork instructions package",
    label: "Instructions package",
    copiedMessage: "Copied the Corgtex OpenWork instructions package.",
    fallbackMessage: "Clipboard access was blocked. Select and copy the instructions package.",
    value: [
      "# Corgtex OpenWork Instructions",
      "",
      "Use OpenWork as the execution workspace and Corgtex as the enterprise plumbing layer.",
      "",
      `Corgtex MCP server: ${connectorUrl}`,
      "",
      "Operating rules:",
      "- Pull company context, policies, and allowed scopes from Corgtex before planning work.",
      "- Use Corgtex execution packets as the source of task goal, actor, policy constraints, expected output, approval rule, and write-back target.",
      "- Do not invent authority, bypass scopes, or write to destinations that are not listed by Corgtex.",
      "- Ask for approval when the packet approval rule requires review before write-back.",
      "- Submit execution results back to Corgtex with artifacts, status, and idempotency instead of leaving work only in chat.",
      "- Treat Corgtex audit, model usage, and write-back state as the durable record.",
      "",
      "Useful Corgtex tools:",
      "- get_company_context: read company context within granted scopes.",
      "- list_writeback_targets: inspect allowed output destinations.",
      "- create_execution_request: create governed work from Corgtex when the user asks from OpenWork.",
      "- get_execution_packet: claim a governed request before executing.",
      "- submit_execution_result: return output, artifacts, status, and write-back mapping to Corgtex.",
      "",
      "Default behavior:",
      "- Prefer concise status updates and concrete outputs.",
      "- Show assumptions and blockers before executing risky work.",
      "- Keep private or scoped context inside the Corgtex-authorized workflow.",
    ].join("\n"),
  };
}

function buildOpenWorkTestPrompt(): AiWorkspaceSetupResource {
  return {
    title: "OpenWork connection test prompt",
    label: "Test prompt",
    copiedMessage: "Copied the OpenWork test prompt.",
    fallbackMessage: "Clipboard access was blocked. Select and copy the test prompt.",
    value: [
      "Test the Corgtex connection without making any external changes.",
      "",
      "1. Use Corgtex to read the current company context.",
      "2. List available write-back targets and summarize which target types are available.",
      "3. Confirm whether execution request, packet retrieval, and result submission tools are visible.",
      "4. Do not submit a result or create a write-back unless I explicitly approve it.",
      "5. Return a short readiness report with connected, missing setup, scope limitations, and the next safe action.",
    ].join("\n"),
  };
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
