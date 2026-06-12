export const AI_WORKSPACE_PROVIDER_KEYS = [
  "openwork",
  "chatgpt",
  "claude",
  "copilot",
  "gemini",
  "cursor",
  "claude_code",
  "generic_mcp",
] as const;

export type AiWorkspaceProviderKey = typeof AI_WORKSPACE_PROVIDER_KEYS[number];

export const AI_WORKSPACE_OWNERSHIP_MODES = [
  "USER_MANAGED",
  "WORKSPACE_MANAGED",
  "CORGTEX_MANAGED",
] as const;

export type AiWorkspaceOwnershipMode = typeof AI_WORKSPACE_OWNERSHIP_MODES[number];

export const AI_WORKSPACE_HEALTH_STATES = [
  "CONNECTED",
  "NEEDS_SETUP",
  "UNHEALTHY",
  "DISCONNECTED",
  "REVOKED",
  "MANAGED_EXTERNALLY",
] as const;

export type AiWorkspaceHealthState = typeof AI_WORKSPACE_HEALTH_STATES[number];

export const AI_WORKSPACE_CAPABILITIES = [
  "remote_mcp",
  "skill_install",
  "local_client",
  "hosted_worker",
  "oauth",
  "api_key",
  "health_check",
  "write_back",
  "browser_execution",
  "code_execution",
] as const;

export type AiWorkspaceCapability = typeof AI_WORKSPACE_CAPABILITIES[number];

export type AiWorkspaceSetupVariantDefinition = {
  variantKey: string;
  label: string;
  audience: string;
  primaryAction: "open" | "copy" | "copyAndOpen" | "cursorInstall";
  manualSteps: string[];
  limitations: string[];
  verificationPrompt: string;
};

export type AiWorkspaceProviderDefinition = {
  key: AiWorkspaceProviderKey;
  label: string;
  shortLabel: string;
  outcome: string;
  description: string;
  category: "DEFAULT" | "BYO" | "ADVANCED";
  recommendedDefault: boolean;
  freeDefault: boolean;
  visibleInToolPicker: boolean;
  supportedOwnershipModes: AiWorkspaceOwnershipMode[];
  capabilities: AiWorkspaceCapability[];
  setupPath: "guided" | "recipe" | "request";
  setupVariants: AiWorkspaceSetupVariantDefinition[];
};

function provider(
  definition: AiWorkspaceProviderDefinition,
) {
  return definition;
}

export const AI_WORKSPACE_PROVIDER_REGISTRY = {
  openwork: provider({
    key: "openwork",
    label: "OpenWork Free",
    shortLabel: "OpenWork",
    outcome: "Use the recommended free AI workspace with Corgtex context, policies, and write-back.",
    description: "OpenWork is the default self-managed path for teams that want a free, flexible AI workspace before a managed enterprise rollout.",
    category: "DEFAULT",
    recommendedDefault: true,
    freeDefault: true,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED", "CORGTEX_MANAGED"],
    capabilities: [
      "remote_mcp",
      "skill_install",
      "local_client",
      "hosted_worker",
      "oauth",
      "api_key",
      "health_check",
      "write_back",
      "browser_execution",
      "code_execution",
    ],
    setupPath: "guided",
    setupVariants: [
      {
        variantKey: "openwork_app",
        label: "OpenWork desktop or cloud",
        audience: "Teams that want the free default execution workspace.",
        primaryAction: "copyAndOpen",
        manualSteps: [
          "Open or download OpenWork.",
          "Go to Extensions, then Advanced Settings, then Add MCP server.",
          "Paste the Corgtex MCP URL and enable OAuth.",
          "Complete browser sign-in and run the test prompt.",
        ],
        limitations: ["Dynamic client registration must be available for the OAuth connection."],
        verificationPrompt: "Test the Corgtex connection in OpenWork without making external changes.",
      },
    ],
  }),
  chatgpt: provider({
    key: "chatgpt",
    label: "ChatGPT",
    shortLabel: "ChatGPT",
    outcome: "Bring Corgtex company context into a ChatGPT workspace that supports custom connectors.",
    description: "Use this path when the customer already standardizes on ChatGPT and wants Corgtex available through approved connectors.",
    category: "BYO",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "chatgpt_workspace_admin",
        label: "Workspace admin app creation",
        audience: "Workspace admins preparing a connector for normal users.",
        primaryAction: "copyAndOpen",
        manualSteps: [
          "Confirm the ChatGPT workspace plan and admin policy allow custom MCP apps or connectors.",
          "Open ChatGPT connector settings and enable Developer Mode from Advanced settings if required.",
          "Create a Corgtex app and paste the HTTPS Corgtex MCP URL.",
          "Scan tools, complete browser sign-in, and authenticate Corgtex.",
          "Test with an admin account, then publish or approve the connector for users.",
        ],
        limitations: ["Workspace-wide availability depends on plan level and admin connector policy."],
        verificationPrompt: "Test the Corgtex app as an admin without creating records or external changes.",
      },
      {
        variantKey: "chatgpt_developer_mode",
        label: "User or developer-mode setup",
        audience: "Users in workspaces where custom app creation is already allowed.",
        primaryAction: "copyAndOpen",
        manualSteps: [
          "Open ChatGPT Settings, then Connectors, then Advanced settings.",
          "Turn on Developer Mode.",
          "Create a personal Corgtex app using the HTTPS Corgtex MCP URL.",
          "Scan tools, authenticate in the browser, then select Corgtex from Developer Mode in chat.",
        ],
        limitations: ["User-created apps may be blocked or require review in managed ChatGPT workspaces."],
        verificationPrompt: "Test the Corgtex app in ChatGPT without creating records or external changes.",
      },
    ],
  }),
  claude: provider({
    key: "claude",
    label: "Claude",
    shortLabel: "Claude",
    outcome: "Connect Corgtex to Claude, Claude Desktop, or Claude Cowork where remote MCP is available.",
    description: "Use this path when the customer already works in Claude and wants governed Corgtex context inside that workflow.",
    category: "BYO",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "claude_remote_connector",
        label: "Claude web, Desktop, or Cowork",
        audience: "Non-technical teammates using Claude as the work surface.",
        primaryAction: "copyAndOpen",
        manualSteps: [
          "Open Claude connector settings or the guided installer.",
          "Add Corgtex as a custom remote connector using the Corgtex MCP URL.",
          "Complete browser sign-in and select this workspace.",
          "Run the test prompt before governed work.",
        ],
        limitations: ["Team and Enterprise owners may need to approve or publish the connector first."],
        verificationPrompt: "Test the Corgtex connection in Claude without making external changes.",
      },
      {
        variantKey: "claude_code_cli",
        label: "Claude Code",
        audience: "Technical teammates working from a terminal.",
        primaryAction: "copy",
        manualSteps: [
          "Run the generated Claude Code MCP command in Terminal.",
          "Open Claude Code and use /mcp to inspect the Corgtex server.",
          "Complete browser sign-in when prompted.",
          "Run the test prompt before changing files.",
        ],
        limitations: ["Use user scope for broad availability; use project scope only when a project needs a different boundary."],
        verificationPrompt: "Use Claude Code /mcp to confirm Corgtex is connected before changing files.",
      },
    ],
  }),
  copilot: provider({
    key: "copilot",
    label: "GitHub Copilot",
    shortLabel: "Copilot",
    outcome: "Use Corgtex context in GitHub Copilot through VS Code or Copilot CLI.",
    description: "Use this path when the customer already standardizes on GitHub Copilot and wants Corgtex as a governed MCP source.",
    category: "BYO",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "copilot_vscode",
        label: "VS Code and Copilot Chat",
        audience: "Developers using Copilot agent mode in VS Code.",
        primaryAction: "copy",
        manualSteps: [
          "Run MCP: Add Server in VS Code or open the user/workspace mcp.json file.",
          "Add Corgtex as a Streamable HTTP MCP server using the Corgtex MCP URL.",
          "Start the server, trust it, and complete browser sign-in if prompted.",
          "Confirm Corgtex tools appear in Copilot Chat agent mode.",
        ],
        limitations: ["Organization Copilot policies can restrict MCP server access."],
        verificationPrompt: "Ask Copilot Chat to use Corgtex tools for a no-change readiness report.",
      },
      {
        variantKey: "copilot_cli",
        label: "Copilot CLI",
        audience: "Developers using GitHub Copilot from Terminal.",
        primaryAction: "copy",
        manualSteps: [
          "Run the generated copilot mcp add command or use /mcp add in Copilot CLI.",
          "Save the server in the user-level Copilot MCP configuration.",
          "Complete browser sign-in if the remote server requires OAuth.",
          "Use copilot mcp list or /mcp to confirm Corgtex is available.",
        ],
        limitations: ["Remote MCP servers are low-trust and require explicit tool approval."],
        verificationPrompt: "Ask Copilot CLI for a no-change Corgtex readiness report.",
      },
    ],
  }),
  gemini: provider({
    key: "gemini",
    label: "Gemini CLI",
    shortLabel: "Gemini",
    outcome: "Use Corgtex with Gemini CLI through MCP configuration.",
    description: "Use this path for technical teams that want Gemini CLI connected to Corgtex. Consumer Gemini web support is not assumed.",
    category: "ADVANCED",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "api_key", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "gemini_cli_http",
        label: "Gemini CLI HTTP MCP",
        audience: "Technical teams using Gemini CLI.",
        primaryAction: "copy",
        manualSteps: [
          "Run the generated gemini mcp add command for a user-scoped Streamable HTTP server.",
          "Use the generated settings JSON fallback if you prefer manual configuration.",
          "Complete OAuth browser sign-in when Gemini detects the protected server.",
          "Use /mcp to verify the server and available tools.",
        ],
        limitations: ["OAuth requires a local browser and localhost redirect support."],
        verificationPrompt: "Use Gemini CLI /mcp and request a no-change Corgtex readiness report.",
      },
    ],
  }),
  cursor: provider({
    key: "cursor",
    label: "Cursor",
    shortLabel: "Cursor",
    outcome: "Connect Corgtex context to Cursor for technical and product work.",
    description: "Use this path for teams that already use Cursor and want Corgtex as a governed MCP source.",
    category: "ADVANCED",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "cursor_deeplink",
        label: "Cursor MCP install",
        audience: "Technical and product teams using Cursor.",
        primaryAction: "cursorInstall",
        manualSteps: [
          "Open the Add to Cursor prompt or use Cursor MCP settings.",
          "Install the Corgtex Streamable HTTP MCP server.",
          "Complete browser sign-in when Cursor asks to authenticate.",
          "Confirm Corgtex tools are visible before changing files.",
        ],
        limitations: ["Teams may need to approve the MCP server in workspace or organization policy."],
        verificationPrompt: "Ask Cursor for a no-change Corgtex readiness report before editing files.",
      },
      {
        variantKey: "cursor_manual_config",
        label: "Cursor manual MCP config",
        audience: "Teams that prefer to review MCP JSON before installing.",
        primaryAction: "copy",
        manualSteps: [
          "Open Cursor MCP settings or the MCP configuration file.",
          "Paste the generated Corgtex HTTP MCP configuration.",
          "Save the file, trust the server, and complete browser sign-in.",
          "Confirm Corgtex tools are visible before changing files.",
        ],
        limitations: ["Manual configuration still requires Cursor to support the remote OAuth flow."],
        verificationPrompt: "Ask Cursor for a no-change Corgtex readiness report before editing files.",
      },
    ],
  }),
  claude_code: provider({
    key: "claude_code",
    label: "Claude Code",
    shortLabel: "Claude Code",
    outcome: "Connect Corgtex to Claude Code for technical teams that prefer Anthropic's coding client.",
    description: "Use this path when Corgtex context should be available in Claude Code sessions through MCP.",
    category: "ADVANCED",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: false,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
    setupVariants: [],
  }),
  generic_mcp: provider({
    key: "generic_mcp",
    label: "Generic MCP client",
    shortLabel: "MCP client",
    outcome: "Connect any compatible MCP client to Corgtex.",
    description: "Use this path for teams with their own AI clients or internal agent tools.",
    category: "ADVANCED",
    recommendedDefault: false,
    freeDefault: false,
    visibleInToolPicker: true,
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED", "CORGTEX_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "api_key", "health_check", "write_back"],
    setupPath: "recipe",
    setupVariants: [
      {
        variantKey: "generic_remote_mcp",
        label: "Remote MCP client",
        audience: "Teams with another MCP-compatible AI workspace.",
        primaryAction: "copy",
        manualSteps: [
          "Choose remote MCP, Streamable HTTP, or HTTP MCP server in the client.",
          "Paste the Corgtex MCP URL.",
          "Complete browser OAuth if the client supports it.",
          "Run the test prompt before production work.",
        ],
        limitations: ["If the client cannot list Corgtex tools or scopes, treat it as not ready."],
        verificationPrompt: "Test the Corgtex connection without making external changes.",
      },
    ],
  }),
} as const satisfies Record<AiWorkspaceProviderKey, AiWorkspaceProviderDefinition>;

export const AI_WORKSPACE_PROVIDER_DB_VALUES = {
  openwork: "OPENWORK",
  chatgpt: "CHATGPT",
  claude: "CLAUDE",
  copilot: "COPILOT",
  gemini: "GEMINI",
  cursor: "CURSOR",
  claude_code: "CLAUDE_CODE",
  generic_mcp: "GENERIC_MCP",
} as const satisfies Record<AiWorkspaceProviderKey, string>;

export const ENTERPRISE_SERVICE_KEYS = [
  "meeting_recorder",
  "ai_workspace",
  "integrations",
  "workers",
  "support",
] as const;

export type EnterpriseServiceKey = typeof ENTERPRISE_SERVICE_KEYS[number];

export const ENTERPRISE_SERVICE_OWNERSHIP_MODES = [
  "CUSTOMER_MANAGED",
  "CORGTEX_MANAGED",
] as const;

export type EnterpriseServiceOwnershipMode = typeof ENTERPRISE_SERVICE_OWNERSHIP_MODES[number];

export const ENTERPRISE_SERVICE_HEALTH_STATES = [
  "ACTIVE",
  "NEEDS_SETUP",
  "UNHEALTHY",
  "DISCONNECTED",
  "SUSPENDED",
  "MANAGED_EXTERNALLY",
] as const;

export type EnterpriseServiceHealthState = typeof ENTERPRISE_SERVICE_HEALTH_STATES[number];

export type EnterpriseServiceDefinition = {
  key: EnterpriseServiceKey;
  label: string;
  outcome: string;
  description: string;
  defaultOwnershipMode: EnterpriseServiceOwnershipMode;
};

function service(definition: EnterpriseServiceDefinition) {
  return definition;
}

export const ENTERPRISE_SERVICE_REGISTRY = {
  meeting_recorder: service({
    key: "meeting_recorder",
    label: "Meeting recorder",
    outcome: "Capture meeting evidence without every customer operating recorder infrastructure themselves.",
    description: "Recorder access can stay customer-managed for pilots or move to CORGTEX-managed for enterprise rollout.",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  }),
  ai_workspace: service({
    key: "ai_workspace",
    label: "Managed AI workspace",
    outcome: "Operate the default AI workspace plumbing for company-wide rollout.",
    description: "CORGTEX can manage shared AI workspace setup, health, and support when BYO setup is no longer enough.",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  }),
  integrations: service({
    key: "integrations",
    label: "Managed integrations",
    outcome: "Keep enterprise connectors healthy without normal users debugging setup.",
    description: "Tracks whether integrations are customer-managed or operated by CORGTEX.",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  }),
  workers: service({
    key: "workers",
    label: "Managed workers",
    outcome: "Operate shared worker capacity for governed AI workflows.",
    description: "Tracks managed worker status and support state for enterprise customers.",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  }),
  support: service({
    key: "support",
    label: "Managed support",
    outcome: "Escalate service health and rollout issues through a CORGTEX-managed support path.",
    description: "Tracks support ownership for company-wide AI-native rollout.",
    defaultOwnershipMode: "CUSTOMER_MANAGED",
  }),
} as const satisfies Record<EnterpriseServiceKey, EnterpriseServiceDefinition>;

export const ENTERPRISE_SERVICE_DB_VALUES = {
  meeting_recorder: "MEETING_RECORDER",
  ai_workspace: "AI_WORKSPACE",
  integrations: "INTEGRATIONS",
  workers: "WORKERS",
  support: "SUPPORT",
} as const satisfies Record<EnterpriseServiceKey, string>;

export function isAiWorkspaceProviderKey(value: string): value is AiWorkspaceProviderKey {
  return AI_WORKSPACE_PROVIDER_KEYS.includes(value as AiWorkspaceProviderKey);
}

export function requireAiWorkspaceProvider(value: string) {
  if (!isAiWorkspaceProviderKey(value)) {
    throw new Error(`Unsupported AI workspace provider: ${value}`);
  }
  return AI_WORKSPACE_PROVIDER_REGISTRY[value];
}

export function aiWorkspaceProviderToDb(value: AiWorkspaceProviderKey) {
  return AI_WORKSPACE_PROVIDER_DB_VALUES[value];
}

export function aiWorkspaceProviderFromDb(value: string): AiWorkspaceProviderKey | null {
  const entry = Object.entries(AI_WORKSPACE_PROVIDER_DB_VALUES)
    .find(([, dbValue]) => dbValue === value);
  return (entry?.[0] as AiWorkspaceProviderKey | undefined) ?? null;
}

export function aiWorkspaceToolProviderKey(value: AiWorkspaceProviderKey) {
  if (value === "claude_code") return "claude";
  return value;
}

export function isVisibleAiWorkspaceToolProvider(value: string): value is AiWorkspaceProviderKey {
  return isAiWorkspaceProviderKey(value) && AI_WORKSPACE_PROVIDER_REGISTRY[value].visibleInToolPicker;
}

export function isEnterpriseServiceKey(value: string): value is EnterpriseServiceKey {
  return ENTERPRISE_SERVICE_KEYS.includes(value as EnterpriseServiceKey);
}

export function requireEnterpriseService(value: string) {
  if (!isEnterpriseServiceKey(value)) {
    throw new Error(`Unsupported enterprise service: ${value}`);
  }
  return ENTERPRISE_SERVICE_REGISTRY[value];
}

export function enterpriseServiceToDb(value: EnterpriseServiceKey) {
  return ENTERPRISE_SERVICE_DB_VALUES[value];
}

export function listAiWorkspaceProviders() {
  return AI_WORKSPACE_PROVIDER_KEYS.map((key) => AI_WORKSPACE_PROVIDER_REGISTRY[key]);
}

export function listAiWorkspaceToolProviders() {
  return listAiWorkspaceProviders().filter((provider) => provider.visibleInToolPicker);
}

export function listEnterpriseServices() {
  return ENTERPRISE_SERVICE_KEYS.map((key) => ENTERPRISE_SERVICE_REGISTRY[key]);
}
