export const AI_WORKSPACE_PROVIDER_KEYS = [
  "openwork",
  "chatgpt",
  "claude",
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

export type AiWorkspaceProviderDefinition = {
  key: AiWorkspaceProviderKey;
  label: string;
  shortLabel: string;
  outcome: string;
  description: string;
  category: "DEFAULT" | "BYO" | "ADVANCED";
  recommendedDefault: boolean;
  freeDefault: boolean;
  supportedOwnershipModes: AiWorkspaceOwnershipMode[];
  capabilities: AiWorkspaceCapability[];
  setupPath: "guided" | "recipe" | "request";
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back"],
    setupPath: "recipe",
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back"],
    setupPath: "recipe",
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "api_key", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "health_check", "write_back", "code_execution"],
    setupPath: "recipe",
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
    supportedOwnershipModes: ["USER_MANAGED", "WORKSPACE_MANAGED", "CORGTEX_MANAGED"],
    capabilities: ["remote_mcp", "oauth", "api_key", "health_check", "write_back"],
    setupPath: "recipe",
  }),
} as const satisfies Record<AiWorkspaceProviderKey, AiWorkspaceProviderDefinition>;

export const AI_WORKSPACE_PROVIDER_DB_VALUES = {
  openwork: "OPENWORK",
  chatgpt: "CHATGPT",
  claude: "CLAUDE",
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

export function listEnterpriseServices() {
  return ENTERPRISE_SERVICE_KEYS.map((key) => ENTERPRISE_SERVICE_REGISTRY[key]);
}
