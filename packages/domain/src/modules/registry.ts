/**
 * Module Manifest registry - the single source of truth for Corgtex's
 * 3-tier module strategy. Everything (control-plane feature flags, the web
 * flag superset, the nav union + groups, posture bundles, catalog app
 * metadata, and module-by-role access) derives from this list behind parity
 * tests that pin the previous hand-written behavior.
 *
 * MUST stay pure and dependency-free (types only) so it is safe to import
 * from the web client bundle.
 */

import type {
  FeatureFlagDefinition,
  ModuleManifest,
} from "./types";

function flag(
  flagKey: string,
  label: string,
  description: string,
  defaultEnabled: boolean,
): FeatureFlagDefinition {
  return { flag: flagKey, label, description, defaultEnabled };
}

/**
 * Canonical display order of workspace feature flags. This is the only
 * ordering anchor; it mirrors `CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS` so the
 * derived control-plane list keeps its current UI order. The registry test
 * asserts this set equals the set of flags declared across all modules.
 */
export const WORKSPACE_FEATURE_FLAG_ORDER = [
  "GOALS",
  "TOOL_LINKS",
  "FINANCE",
  "SLICING_PIE",
  "BUILD_ARTIFACTS",
  "RELATIONSHIPS",
  "CONTEXT_MAPS",
  "AGENT_GOVERNANCE",
  "OS_METRICS",
  "SETTINGS_GENERAL",
  "MULTILINGUAL",
  "MEETING_TRANSCRIPT_SOURCES",
  "MEETING_RECORDERS",
  "MEETING_CONTEXTUAL_INTELLIGENCE",
  "CONTEXT_MAP_AI",
  "SLACK_MEETING_ACTION_REVIEW",
  "AI_WORKSPACES",
  "OPENWORK_DEFAULT",
  "EXECUTION_PACKETS",
  "MANAGED_ENTERPRISE_SERVICES",
  "PRACTICE_PROJECTS",
] as const;

/**
 * The canonical literal union of workspace feature flag keys. Downstream types
 * (control-plane, web flag superset, nav union) alias this so there is one
 * source of truth for the flag vocabulary at the type level too.
 */
export type WorkspaceFeatureFlagKey = (typeof WORKSPACE_FEATURE_FLAG_ORDER)[number];

/** Canonical nav group order, mirroring `WORKSPACE_NAV_GROUPS`. */
export const NAV_GROUP_ORDER: readonly string[] = [
  "workspace",
  "operations",
  "governance",
  "finance",
  "aiGovernance",
  "system",
];

export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
  // --- Core: workspace group ---
  {
    key: "home",
    tier: "core",
    title: "Home",
    description: "Workspace home dashboard.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "", labelKey: "home", icon: "home", group: "workspace", mobilePrimaryOrder: 10 },
  },
  {
    key: "goals",
    tier: "first_party",
    title: "Goals",
    description: "Goal trees, recognition, and progress tracking.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("GOALS", "Goals", "Goal trees, recognition, and progress tracking.", true),
    nav: { href: "/goals", labelKey: "goals", icon: "goals", group: "workspace" },
    scopes: ["goals:read", "goals:write"],
  },
  {
    key: "brain",
    tier: "core",
    title: "Brain",
    description: "Organizational knowledge base.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/brain", labelKey: "brain", icon: "brain", group: "workspace" },
    scopes: ["brain:read", "brain:write"],
  },
  {
    key: "tools",
    tier: "first_party",
    title: "Tools catalog",
    description: "Shared tool links, catalog approvals, and credentials.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("TOOL_LINKS", "Tools catalog", "Shared tool links, catalog approvals, and credentials.", false),
    nav: { href: "/tools", labelKey: "tools", icon: "tools", group: "workspace" },
    scopes: ["tools:read", "tools:write", "tools:credentials:read"],
  },
  {
    key: "built",
    tier: "first_party",
    title: "Build artifacts",
    description: "Workspace build artifact publishing and review.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("BUILD_ARTIFACTS", "Build artifacts", "Workspace build artifact publishing and review.", false),
    nav: { href: "/built", labelKey: "built", icon: "built", group: "workspace" },
  },
  {
    key: "members",
    tier: "core",
    title: "Members",
    description: "Workspace members directory.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/members", labelKey: "members", icon: "members", group: "workspace" },
    scopes: ["members:read", "members:write"],
  },

  // --- Core + first-party: operations group ---
  {
    key: "tensions",
    tier: "core",
    title: "Tensions",
    description: "Tension capture and triage.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/tensions", labelKey: "tensions", icon: "tensions", group: "operations", mobilePrimaryOrder: 20 },
    scopes: ["tensions:read", "tensions:write"],
  },
  {
    key: "actions",
    tier: "core",
    title: "Actions",
    description: "Action items and assignments.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/actions", labelKey: "actions", icon: "actions", group: "operations", mobilePrimaryOrder: 30 },
    scopes: ["actions:read", "actions:write"],
  },
  {
    key: "meetings",
    tier: "core",
    title: "Meetings",
    description: "Meeting intake, summaries, and follow-up.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/meetings", labelKey: "meetings", icon: "meetings", group: "operations" },
    scopes: ["meetings:read", "meetings:write"],
    subFlags: [
      flag("MEETING_TRANSCRIPT_SOURCES", "Meeting transcript sources", "Import transcripts from existing meeting recorders and upload exports.", false),
      flag("MEETING_RECORDERS", "Meeting recorders", "Managed meeting recorder entitlement and recorder config.", false),
      flag(
        "MEETING_CONTEXTUAL_INTELLIGENCE",
        "Context-aware meeting intelligence",
        "Use workspace context to summarize meetings and automatically update related governance records.",
        false,
      ),
      flag(
        "SLACK_MEETING_ACTION_REVIEW",
        "Slack meeting action review",
        "Post meeting summaries and proposed action-item follow-ups to an approved Slack review surface before action creation.",
        false,
      ),
    ],
  },
  {
    key: "relationships",
    tier: "first_party",
    title: "Relationships",
    description: "CRM, leads, and relationship workspace views.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("RELATIONSHIPS", "Relationships", "CRM, leads, and relationship workspace views.", true),
    nav: { href: "/leads", labelKey: "relationships", icon: "relationships", group: "operations" },
    scopes: ["relationships:read", "relationships:write"],
  },
  {
    key: "context-maps",
    tier: "first_party",
    title: "Context maps",
    description: "Living company context graph maps, graph evidence, and region-scoped agent context.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag(
      "CONTEXT_MAPS",
      "Context maps",
      "Living company context graph maps, graph evidence, and region-scoped agent context.",
      false,
    ),
    nav: { href: "/maps", labelKey: "contextMaps", icon: "contextMaps", group: "operations" },
    scopes: ["context-graph:read", "context-graph:propose", "context-graph:approve"],
    subFlags: [
      flag(
        "CONTEXT_MAP_AI",
        "Context map AI",
        "Premium chat tools for reading, reasoning about, and applying living context map graph changes.",
        false,
      ),
    ],
  },

  // --- Core + first-party: governance group ---
  {
    key: "agreements",
    tier: "core",
    title: "Agreements",
    description: "Constitution, accepted policies, and working agreements.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/agreements", labelKey: "agreements", icon: "agreements", group: "governance" },
  },
  {
    key: "proposals",
    tier: "core",
    title: "Proposals",
    description: "Governance proposals and decisions.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/proposals", labelKey: "proposals", icon: "proposals", group: "governance", mobilePrimaryOrder: 50 },
    scopes: ["proposals:read", "proposals:write"],
  },
  {
    key: "circles",
    tier: "core",
    title: "Circles",
    description: "Circles and roles structure.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/circles", labelKey: "circles", icon: "circles", group: "governance" },
    scopes: ["circles:read"],
  },
  // --- First-party: finance group ---
  {
    key: "finance",
    tier: "first_party",
    title: "Finance",
    description: "Spend requests, ledgers, and finance workflows.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("FINANCE", "Finance", "Spend requests, ledgers, and finance workflows.", true),
    nav: { href: "/finance", labelKey: "finance", icon: "finance", group: "finance" },
    scopes: ["finance:read", "finance:write"],
    // Mirrors today's behavior: the tab is visible (read) to everyone while
    // write/manage is restricted to finance stewards and admins
    // (requireFinanceAccess in finance.ts).
    defaultAccessByRole: {
      CONTRIBUTOR: "read",
      FACILITATOR: "read",
      FINANCE_STEWARD: "write",
      ADMIN: "write",
    },
  },

  // --- First-party: AI governance group ---
  {
    key: "agent-governance",
    tier: "first_party",
    title: "Agent governance",
    description: "Agent registry, access, spend, and observability controls.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("AGENT_GOVERNANCE", "Agent governance", "Agent registry, access, spend, and observability controls.", true),
    nav: {
      href: "/agents",
      labelKey: "agentGovernance",
      icon: "agents",
      group: "aiGovernance",
      requiredCapability: "canManageAgentGovernance",
    },
    scopes: ["agents:read", "runtime:read", "runtime:write"],
  },

  // --- First-party: system group ---
  {
    key: "os-metrics",
    tier: "first_party",
    title: "OS metrics",
    description: "Governance health and operating-system metrics.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("OS_METRICS", "OS metrics", "Governance health and operating-system metrics.", true),
    nav: { href: "/governance", labelKey: "osMetrics", icon: "governance", group: "system" },
  },
  {
    key: "audit",
    tier: "core",
    title: "Audit trail",
    description: "Workspace audit log.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/audit", labelKey: "auditTrail", icon: "audit", group: "system" },
  },
  {
    key: "notifications",
    tier: "core",
    title: "Notifications",
    description: "Workspace notifications.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/notifications", labelKey: "notifications", icon: "notifications", group: "system", mobilePrimaryOrder: 40 },
  },
  {
    key: "settings",
    tier: "core",
    title: "Settings",
    description: "Workspace settings.",
    dataOwnership: "corgtex_postgres",
    nav: { href: "/settings", labelKey: "settings", icon: "settings", group: "system" },
    subFlags: [
      flag("SETTINGS_GENERAL", "General settings", "General workspace configuration screens.", true),
    ],
  },

  // --- Headless / infrastructure modules (flags without nav) ---
  {
    key: "multilingual",
    tier: "core",
    title: "Multilingual",
    description: "Locale switcher and translated workspace UI.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag("MULTILINGUAL", "Multilingual", "Locale switcher and translated workspace UI.", false),
  },
  {
    key: "ai-workspaces",
    tier: "core",
    title: "AI workspaces",
    description: "Catalog and setup foundation for OpenWork, ChatGPT, Claude, GitHub Copilot, Gemini, Cursor, and generic MCP clients.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag(
      "AI_WORKSPACES",
      "AI workspaces",
      "Catalog and setup foundation for OpenWork, ChatGPT, Claude, GitHub Copilot, Gemini, Cursor, and generic MCP clients.",
      true,
    ),
    subFlags: [
      flag("OPENWORK_DEFAULT", "OpenWork default", "Recommend OpenWork as the default free self-managed AI workspace.", false),
      flag(
        "MANAGED_ENTERPRISE_SERVICES",
        "Managed enterprise services",
        "CORGTEX-managed service ownership, health, usage, and support escalation foundation.",
        false,
      ),
    ],
  },
  {
    key: "execution-packets",
    tier: "core",
    title: "Execution packets",
    description: "Durable execution request, context packet, and result write-back plumbing.",
    dataOwnership: "corgtex_postgres",
    featureFlag: flag(
      "EXECUTION_PACKETS",
      "Execution packets",
      "Durable execution request, context packet, and result write-back plumbing.",
      false,
    ),
    scopes: ["execution:read", "execution:write"],
  },

  // --- Native first-party module. ---
  {
    key: "practice-ledger",
    tier: "first_party",
    title: "Practice Ledger",
    description:
      "Native consulting finance workspace for project budgets, burn, remaining budget, and margin tracking.",
    dataOwnership: "corgtex_postgres",
    // Finance is now the native Practice Ledger surface for every workspace;
    // this sub-flag controls optional consulting project portfolio affordances.
    subFlags: [
      flag(
        "PRACTICE_PROJECTS",
        "Practice projects",
        "Consulting project portfolio: budgets, burn, remaining, and margin tracking with an attention queue.",
        false,
      ),
      flag(
        "SLICING_PIE",
        "Slicing Pie",
        "Internal Slicing Pie ownership calculations from Practice Ledger time and expense entries.",
        false,
      ),
    ],
  },
];

/** All module manifests, in canonical registry order. */
export function getModuleManifests(): readonly ModuleManifest[] {
  return MODULE_MANIFESTS;
}

/** All feature flag definitions declared across modules, keyed by flag. */
export function collectFeatureFlagDefinitions(): Map<string, FeatureFlagDefinition> {
  const byFlag = new Map<string, FeatureFlagDefinition>();
  for (const mod of MODULE_MANIFESTS) {
    if (mod.featureFlag) byFlag.set(mod.featureFlag.flag, mod.featureFlag);
    for (const sub of mod.subFlags ?? []) byFlag.set(sub.flag, sub);
  }
  return byFlag;
}

/** Feature flag definitions in canonical display order. */
export function listWorkspaceFeatureFlagDefinitions(): FeatureFlagDefinition[] {
  const byFlag = collectFeatureFlagDefinitions();
  return WORKSPACE_FEATURE_FLAG_ORDER.map((flagKey) => {
    const definition = byFlag.get(flagKey);
    if (!definition) {
      throw new Error(`Module registry is missing a definition for feature flag "${flagKey}".`);
    }
    return definition;
  });
}

/** Feature flag keys in canonical display order. */
export function listWorkspaceFeatureFlagKeys(): WorkspaceFeatureFlagKey[] {
  return [...WORKSPACE_FEATURE_FLAG_ORDER];
}

/** Default-enabled map for every workspace feature flag. */
export function defaultWorkspaceFeatureFlags(): Record<WorkspaceFeatureFlagKey, boolean> {
  const defaults = {} as Record<WorkspaceFeatureFlagKey, boolean>;
  for (const definition of listWorkspaceFeatureFlagDefinitions()) {
    defaults[definition.flag as WorkspaceFeatureFlagKey] = definition.defaultEnabled;
  }
  return defaults;
}

/** Modules that contribute a nav entry, in registry order. */
export function listNavModules(): ModuleManifest[] {
  return MODULE_MANIFESTS.filter((mod) => Boolean(mod.nav));
}

/** Satellite-tier modules (excludes graduated modules now classified first-party). */
export function listSatelliteModules(): ModuleManifest[] {
  return MODULE_MANIFESTS.filter((mod) => mod.tier === "satellite");
}

/**
 * Find a module by its satellite app key. Keys off the `satellite` integration
 * spec rather than the tier, so a graduated module (now first-party) is still
 * resolvable by the catalog/MCP/enterprise-app surfaces that reference it.
 */
export function getSatelliteModuleByAppKey(appKey: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find((mod) => mod.satellite?.appKey === appKey);
}

/** Find any module by its key. */
export function getModuleByKey(key: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find((mod) => mod.key === key);
}

/**
 * Every workspace feature flag a module owns: its primary flag (if any) first,
 * then its sub-flags, in declaration order. Used to expand module-keyed client
 * posture bundles into the concrete flag overrides the control plane applies.
 */
export function listModuleFlagKeys(moduleKey: string): string[] {
  const mod = getModuleByKey(moduleKey);
  if (!mod) return [];
  const keys: string[] = [];
  if (mod.featureFlag) keys.push(mod.featureFlag.flag);
  for (const sub of mod.subFlags ?? []) keys.push(sub.flag);
  return keys;
}

/**
 * The satellite module (if any) that should render embedded inside the given
 * first-party module's tab at its current graduation stage. Used by the host
 * tab (e.g. finance) to render the satellite while data stays satellite-owned.
 */
export function getSatelliteEmbedForModule(moduleKey: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find((mod) =>
    (mod.graduation?.stage === "embed" || mod.graduation?.stage === "dual_write") &&
    mod.graduation?.embedInModuleKey === moduleKey,
  );
}

/**
 * MCP scopes that are not owned by a single first-party/nav module because they
 * are cross-cutting platform/support concerns (workspace info, archives, chat,
 * support audit, connected external tools, integration/data-feed inspection,
 * and the governance reference reads that span proposals/circles/metrics).
 *
 * Together with every module's `scopes`, this set must partition `ALL_SCOPES`
 * (the canonical MCP scope registry in agent-auth) exactly - asserted by the
 * scope-ownership parity test so a new scope cannot ship without an owner.
 *
 * Kept as a literal here (not derived from SCOPE_REGISTRY) so this registry
 * stays pure/dependency-free; the test imports both sides and proves parity.
 */
export const PLATFORM_SCOPES: readonly string[] = [
  "workspace:read",
  "workspace:write",
  "support:write",
  "archive:read",
  "archive:write",
  "conversations:write",
  "governance:read",
  "documents:write",
  "external-tools:read",
  "external-tools:write",
  "integrations:read",
  "data-sources:read",
  "data-sources:write",
  "webhooks:write",
];

/**
 * Map of MCP scope -> owning module key, derived from each manifest's `scopes`.
 * Throws if a scope is claimed by more than one module so ownership stays unique.
 */
export function listModuleScopeOwnership(): Map<string, string> {
  const owner = new Map<string, string>();
  for (const mod of MODULE_MANIFESTS) {
    for (const scope of mod.scopes ?? []) {
      const existing = owner.get(scope);
      if (existing && existing !== mod.key) {
        throw new Error(
          `MCP scope "${scope}" is claimed by both "${existing}" and "${mod.key}". Scope ownership must be unique.`,
        );
      }
      owner.set(scope, mod.key);
    }
  }
  return owner;
}

/** The module key that owns the given MCP scope, or undefined for platform scopes. */
export function getModuleForScope(scope: string): string | undefined {
  return listModuleScopeOwnership().get(scope);
}

/** Every MCP scope declared as module-owned across the registry, sorted. */
export function listModuleOwnedScopes(): string[] {
  return [...listModuleScopeOwnership().keys()].sort();
}
