/**
 * Module Manifest types.
 *
 * This file is the type vocabulary for the Module Manifest registry - the
 * single source of truth for Corgtex's 3-tier module strategy
 * (core / first-party / satellite). It MUST stay pure and dependency-free
 * (no Prisma, no @corgtex/shared runtime) so it can be imported from the web
 * client bundle as well as from server code.
 */

export type ModuleTier = "core" | "first_party" | "satellite";

export type ModuleDataOwnership = "corgtex_postgres" | "satellite";

/** Coarse workspace membership roles (mirrors the Prisma `MemberRole` enum). */
export type MemberRoleKey = "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN";

/** Effective access level a principal has to a module. */
export type ModuleAccessLevel = "none" | "read" | "write";

/**
 * The kinds of principal an access grant can target. The resolver unifies all
 * of these into one effective access level - this is the "one access system"
 * without collapsing the underlying role tables.
 */
export type ModuleGrantPrincipalType = "MEMBER" | "MEMBER_ROLE" | "GOVERNANCE_ROLE" | "CIRCLE";

/** A single per-workspace access grant (a row in `WorkspaceModuleGrant`). */
export type ModuleGrant = {
  moduleKey: string;
  principalType: ModuleGrantPrincipalType;
  /**
   * For MEMBER: a member id. For MEMBER_ROLE: a `MemberRole`. For
   * GOVERNANCE_ROLE: a governance role id. For CIRCLE: a circle id.
   */
  principalId: string;
  accessLevel: ModuleAccessLevel;
};

/**
 * Everything needed to resolve a member's access, gathered once per request.
 * Keeping this as plain data separates the I/O (gather) from the pure resolve
 * step, so caching can be added later without touching resolution logic.
 */
export type ModuleAccessContext = {
  /** Coarse member role, or null for non-member actors. */
  role: MemberRoleKey | null;
  /** The acting member id, or null. */
  memberId: string | null;
  /** Governance role ids the member currently holds. */
  governanceRoleIds: string[];
  /**
   * Circle ids the member belongs to, already expanded to include ancestor
   * circles (cascade is pre-applied during gather).
   */
  circleIds: string[];
  /** Module org opt-in flags (feature flag map). */
  flags: Record<string, boolean>;
  /** Per-workspace grants. */
  grants: ModuleGrant[];
};

/**
 * A workspace feature flag definition. Mirrors the shape of an entry in
 * `CONTROL_PLANE_WORKSPACE_FEATURE_FLAGS` so the control-plane registry,
 * the web flag superset, and the nav union can all be derived from modules.
 */
export type FeatureFlagDefinition = {
  flag: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
};

/** A capability key a module exposes - the graduation-stable interface. */
export type ModuleCapability = {
  key: string;
  description: string;
  requiredScopes?: string[];
};

/** Presentation-light nav descriptor. Icon/label mapping stays web-side. */
export type ModuleNav = {
  href: string;
  labelKey: string;
  icon: string;
  group: string;
  /** Optional priority for fixed mobile primary slots; overflow still uses nav order. */
  mobilePrimaryOrder?: number | null;
  /** Mirrors the existing nav `requiredCapability` gate. */
  requiredCapability?: string | null;
};

/**
 * Satellite-app integration spec. Present for modules with a satellite
 * integration; retained after a cutover graduation as integration metadata /
 * provenance even once the module is reclassified first-party.
 */
export type SatelliteSpec = {
  appKey: string;
  repository: string;
  appUrlEnv: string;
  mcpUrlEnv: string;
  appCategory: string;
  routingCategory: string;
  dataClassification: string;
};

/** The three-stage graduation path a satellite follows to become first-party. */
export type GraduationStage = "embed" | "dual_write" | "cutover";

/**
 * Graduation state for a satellite module. Promotion is a config change: at the
 * `embed`/`dual_write` stages the satellite renders inside a first-party
 * module's tab (`embedInModuleKey`) while its data still lives in the satellite.
 */
export type ModuleGraduation = {
  stage: GraduationStage;
  /** First-party module whose tab hosts this satellite during embed/dual_write. */
  embedInModuleKey?: string;
};

/** A Corgtex-shaped export of a satellite module's records, for migration. */
export type PortableRecordBatch = {
  moduleKey: string;
  schemaVersion: string;
  records: Array<Record<string, unknown>>;
};

export type PortableImportResult = {
  imported: number;
  skipped: number;
};

/**
 * The contract a satellite must satisfy to remain cheaply promotable to a
 * first-party module. Implemented by the satellite app and consumed during the
 * dual-write/cutover graduation stages. The four properties encode the
 * "portable from day one" rules: stable UUIDs, exportable records, mandatory
 * Brain provenance, and a capability-keyed interface (the module's `contract`).
 */
export type PortableModule = {
  moduleKey: string;
  /** Records use stable, migration-safe UUIDs. */
  stableIds: true;
  /** Brain provenance is always synced (a standing shadow trail). */
  brainProvenance: true;
  /** Emit records in a Corgtex-shaped export. */
  exportRecords: () => Promise<PortableRecordBatch>;
  /** Import a Corgtex-shaped export into native storage. */
  importRecords: (batch: PortableRecordBatch) => Promise<PortableImportResult>;
};

export type ModuleManifest = {
  /** Stable machine key, e.g. "finance". */
  key: string;
  tier: ModuleTier;
  title: string;
  description: string;
  /** Primary feature flag, or null for an always-on core module. */
  featureFlag?: FeatureFlagDefinition | null;
  /** Sub-feature toggles owned by this module. */
  subFlags?: FeatureFlagDefinition[];
  /** Nav entry, or null for headless/infra modules. */
  nav?: ModuleNav | null;
  /** MCP scopes this module owns. */
  scopes?: string[];
  dataOwnership: ModuleDataOwnership;
  /** Graduation-stable capability interface. */
  contract?: ModuleCapability[];
  /** Satellite integration spec, only for satellite-tier modules. */
  satellite?: SatelliteSpec | null;
  /** Graduation state for a satellite module (promotion is a config change). */
  graduation?: ModuleGraduation | null;
  /**
   * Default access level per coarse member role. Wired in Phase 2; optional
   * here so the type is forward-compatible without changing behavior yet.
   */
  defaultAccessByRole?: Partial<Record<MemberRoleKey, ModuleAccessLevel>>;
};
