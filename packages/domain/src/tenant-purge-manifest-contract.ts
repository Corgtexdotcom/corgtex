import { AppError } from "./errors";

export const TENANT_PURGE_TARGET_MODES = Object.freeze(["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"] as const);
export const TENANT_PURGE_BLOCKER_CODES = Object.freeze([
  "TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "LINKED_DEPLOYMENT", "LINKED_TRIAL", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING",
  "TRIAL_NOT_EXPIRED", "SHARED_RESOURCE_AMBIGUITY", "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION",
  "ACTIVE_CREDENTIAL", "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING",
  "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED", "LEGAL_HOLD", "RETENTION_HOLD", "MANAGED_RELEASE_LEASE",
  "PROVIDER_CUTOVER", "CLIENT_MIGRATION",
] as const);

export type TenantPurgeBlockerCode = typeof TENANT_PURGE_BLOCKER_CODES[number];
export type TenantPurgeTarget =
  | { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }
  | { mode: "SELF_SERVE_TRIAL_WORKSPACE"; trialId: string; deploymentId: string; workspaceId: string };

export interface TenantPurgeManifestPolicies {
  pageSize: number;
  maxPagesPerModel: number;
  maxEvidenceItems: number;
  cacheMaxTtlSeconds: number;
}

export interface TenantPurgeTopologyInput {
  capturedAt: Date;
  workspace: { id: string; managedDeploymentIds: readonly string[]; trialIds: readonly string[] } | null;
  deployment: {
    id: string; managedWorkspaceId: string | null; accountId: string | null; primaryAccountIds: readonly string[];
    sharedResourceAmbiguous: boolean; hasManagedReleaseLease: boolean; hasProviderCutover: boolean; hasClientMigration: boolean;
  } | null;
  account: { id: string; deploymentIds: readonly string[]; primaryDeploymentId: string | null } | null;
  trial: { id: string; workspaceId: string | null; expired: boolean } | null;
  blockers: readonly TenantPurgeBlockerCode[];
}

export interface TenantPurgeContractReader {
  isTargetAuthorized(target: Readonly<TenantPurgeTarget>): Promise<unknown>;
  readTopology(target: Readonly<TenantPurgeTarget>): Promise<TenantPurgeTopologyInput>;
}

export interface TenantPurgeManifestContract {
  readonly schemaVersion: 1;
  readonly target: Readonly<TenantPurgeTarget>;
  readonly capabilitySha: string;
  readonly redactionKeyBytes: readonly number[];
  readonly policies: Readonly<TenantPurgeManifestPolicies>;
  readonly topology: {
    readonly capturedAt: string;
    readonly workspace: Readonly<{ id: string; managedDeploymentIds: readonly string[]; trialIds: readonly string[] }> | null;
    readonly deployment: Readonly<{ id: string; managedWorkspaceId: string | null; accountId: string | null; primaryAccountIds: readonly string[]; sharedResourceAmbiguous: boolean; hasManagedReleaseLease: boolean; hasProviderCutover: boolean; hasClientMigration: boolean }> | null;
    readonly account: Readonly<{ id: string; deploymentIds: readonly string[]; primaryDeploymentId: string | null }> | null;
    readonly trial: Readonly<{ id: string; workspaceId: string | null; expired: boolean }> | null;
  };
  readonly blockers: readonly TenantPurgeBlockerCode[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;

function invalid(message: string): never {
  throw new AppError(400, "TENANT_PURGE_CONTRACT_INVALID", message);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`Invalid tenant purge ${label}.`);
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if ((prototype !== Object.prototype && prototype !== null) || ownKeys.some((key) => typeof key !== "string")
    || JSON.stringify([...ownKeys].sort()) !== JSON.stringify([...keys].sort())
    || ownKeys.some((key) => !("value" in Object.getOwnPropertyDescriptor(value, key)!))) invalid(`Invalid tenant purge ${label}.`);
  return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`Invalid tenant purge ${label}.`);
  return value;
}

function uuidOrNull(value: unknown, label: string): string | null {
  return value === null ? null : uuid(value, label);
}

function uuidList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(`Invalid tenant purge ${label}.`);
  const result = value.map((item) => uuid(item, label));
  if (new Set(result).size !== result.length) invalid(`Invalid tenant purge ${label}.`);
  return result;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`Invalid tenant purge ${label}.`);
  return value;
}

function boundedInteger(value: unknown, label: string, max: number, min = 1): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid(`Invalid tenant purge ${label}.`);
  return value as number;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function targetSnapshot(value: unknown): TenantPurgeTarget {
  const raw = exactRecord(value, value && typeof value === "object" && (value as { mode?: unknown }).mode === "ACCOUNT_WORKSPACE"
    ? ["mode", "accountId", "deploymentId", "workspaceId"] : ["mode", "trialId", "deploymentId", "workspaceId"], "target");
  if (!TENANT_PURGE_TARGET_MODES.includes(raw.mode as never)) invalid("Invalid tenant purge target mode.");
  const common = { deploymentId: uuid(raw.deploymentId, "deployment ID"), workspaceId: uuid(raw.workspaceId, "workspace ID") };
  return raw.mode === "ACCOUNT_WORKSPACE"
    ? freezeDeep({ mode: raw.mode, accountId: uuid(raw.accountId, "account ID"), ...common })
    : freezeDeep({ mode: raw.mode as "SELF_SERVE_TRIAL_WORKSPACE", trialId: uuid(raw.trialId, "trial ID"), ...common });
}

function policySnapshot(value: unknown): TenantPurgeManifestPolicies {
  const raw = exactRecord(value, ["pageSize", "maxPagesPerModel", "maxEvidenceItems", "cacheMaxTtlSeconds"], "policies");
  return freezeDeep({
    pageSize: boundedInteger(raw.pageSize, "page size", 1_000),
    maxPagesPerModel: boundedInteger(raw.maxPagesPerModel, "page limit", 1_000),
    maxEvidenceItems: boundedInteger(raw.maxEvidenceItems, "evidence limit", 100_000),
    cacheMaxTtlSeconds: boundedInteger(raw.cacheMaxTtlSeconds, "cache TTL", 31_536_000, 0),
  });
}

function topologySnapshot(value: unknown) {
  let raw: Record<string, unknown>;
  try {
    raw = exactRecord(structuredClone(value), ["capturedAt", "workspace", "deployment", "account", "trial", "blockers"], "topology");
  } catch (error) {
    if (error instanceof AppError) throw error;
    return invalid("Invalid tenant purge topology.");
  }
  if (!(raw.capturedAt instanceof Date) || Number.isNaN(raw.capturedAt.getTime())) invalid("Invalid tenant purge capture time.");
  const workspace = raw.workspace === null ? null : exactRecord(raw.workspace, ["id", "managedDeploymentIds", "trialIds"], "workspace topology");
  const deployment = raw.deployment === null ? null : exactRecord(raw.deployment, ["id", "managedWorkspaceId", "accountId", "primaryAccountIds", "sharedResourceAmbiguous", "hasManagedReleaseLease", "hasProviderCutover", "hasClientMigration"], "deployment topology");
  const account = raw.account === null ? null : exactRecord(raw.account, ["id", "deploymentIds", "primaryDeploymentId"], "account topology");
  const trial = raw.trial === null ? null : exactRecord(raw.trial, ["id", "workspaceId", "expired"], "trial topology");
  if (!Array.isArray(raw.blockers) || new Set(raw.blockers).size !== raw.blockers.length
    || raw.blockers.some((code) => !TENANT_PURGE_BLOCKER_CODES.includes(code as never))) invalid("Invalid tenant purge blockers.");
  return freezeDeep({
    capturedAt: raw.capturedAt.toISOString(),
    workspace: workspace && { id: uuid(workspace.id, "workspace topology ID"), managedDeploymentIds: uuidList(workspace.managedDeploymentIds, "workspace deployment IDs"), trialIds: uuidList(workspace.trialIds, "workspace trial IDs") },
    deployment: deployment && { id: uuid(deployment.id, "deployment topology ID"), managedWorkspaceId: uuidOrNull(deployment.managedWorkspaceId, "managed workspace ID"), accountId: uuidOrNull(deployment.accountId, "deployment account ID"), primaryAccountIds: uuidList(deployment.primaryAccountIds, "primary account IDs"), sharedResourceAmbiguous: exactBoolean(deployment.sharedResourceAmbiguous, "shared resource flag"), hasManagedReleaseLease: exactBoolean(deployment.hasManagedReleaseLease, "release lease flag"), hasProviderCutover: exactBoolean(deployment.hasProviderCutover, "provider cutover flag"), hasClientMigration: exactBoolean(deployment.hasClientMigration, "client migration flag") },
    account: account && { id: uuid(account.id, "account topology ID"), deploymentIds: uuidList(account.deploymentIds, "account deployment IDs"), primaryDeploymentId: uuidOrNull(account.primaryDeploymentId, "primary deployment ID") },
    trial: trial && { id: uuid(trial.id, "trial topology ID"), workspaceId: uuidOrNull(trial.workspaceId, "trial workspace ID"), expired: exactBoolean(trial.expired, "expired trial flag") },
    suppliedBlockers: [...raw.blockers] as TenantPurgeBlockerCode[],
  });
}

function topologyBlockers(target: TenantPurgeTarget, topology: ReturnType<typeof topologySnapshot>): TenantPurgeBlockerCode[] {
  const blockers = new Set(topology.suppliedBlockers);
  const { workspace, deployment, account, trial } = topology;
  if (!workspace || !deployment || workspace.id !== target.workspaceId || deployment.id !== target.deploymentId
    || deployment.managedWorkspaceId !== target.workspaceId || !workspace.managedDeploymentIds.includes(target.deploymentId)) blockers.add("TARGET_TUPLE_MISMATCH");
  if (workspace?.managedDeploymentIds.some((id) => id !== target.deploymentId)) { blockers.add("LINKED_DEPLOYMENT"); blockers.add("SIBLING_DEPLOYMENT"); }
  if (deployment?.primaryAccountIds.length || account?.primaryDeploymentId) blockers.add("PRIMARY_ROUTING");
  if (deployment?.sharedResourceAmbiguous) blockers.add("SHARED_RESOURCE_AMBIGUITY");
  if (deployment?.hasManagedReleaseLease) blockers.add("MANAGED_RELEASE_LEASE");
  if (deployment?.hasProviderCutover) blockers.add("PROVIDER_CUTOVER");
  if (deployment?.hasClientMigration) blockers.add("CLIENT_MIGRATION");
  if (target.mode === "ACCOUNT_WORKSPACE") {
    if (!account || account.id !== target.accountId || deployment?.accountId !== target.accountId || !account.deploymentIds.includes(target.deploymentId)) blockers.add("TARGET_TUPLE_MISMATCH");
    if (account?.deploymentIds.some((id) => id !== target.deploymentId) || (account?.primaryDeploymentId && account.primaryDeploymentId !== target.deploymentId)) { blockers.add("LINKED_DEPLOYMENT"); blockers.add("SIBLING_DEPLOYMENT"); }
    if (workspace?.trialIds.length || trial) blockers.add("LINKED_TRIAL");
  } else {
    if (!trial || trial.id !== target.trialId || trial.workspaceId !== target.workspaceId || !workspace?.trialIds.includes(target.trialId)) blockers.add("TARGET_TUPLE_MISMATCH");
    if (trial && !trial.expired) blockers.add("TRIAL_NOT_EXPIRED");
    if (workspace?.trialIds.some((id) => id !== target.trialId)) blockers.add("LINKED_TRIAL");
    if (deployment?.accountId || deployment?.primaryAccountIds.length || account) blockers.add("LINKED_ACCOUNT");
  }
  return [...blockers].sort();
}

export async function captureTenantPurgeManifestContract(input: {
  target: TenantPurgeTarget; capabilitySha: string; redactionKey: Uint8Array; privateAuthority: boolean;
  reader: TenantPurgeContractReader; policies: TenantPurgeManifestPolicies;
}): Promise<TenantPurgeManifestContract> {
  if (input.privateAuthority !== true) throw new AppError(403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED", "Private tenant purge authority is required.");
  const target = targetSnapshot(input.target);
  if (typeof input.capabilitySha !== "string" || !SHA.test(input.capabilitySha)) invalid("Invalid tenant purge capability SHA.");
  if (!(input.redactionKey instanceof Uint8Array) || input.redactionKey.byteLength < 32) invalid("Invalid tenant purge redaction key.");
  const capabilitySha = input.capabilitySha;
  const redactionKeyBytes = Object.freeze(Array.from(Uint8Array.from(input.redactionKey)));
  const policies = policySnapshot(input.policies);
  if (typeof input.reader?.isTargetAuthorized !== "function" || typeof input.reader?.readTopology !== "function") invalid("Invalid tenant purge reader.");
  const isTargetAuthorized = input.reader.isTargetAuthorized.bind(input.reader);
  const readTopology = input.reader.readTopology.bind(input.reader);
  if (await isTargetAuthorized(target) !== true) throw new AppError(403, "TENANT_PURGE_TARGET_FORBIDDEN", "Tenant purge target is not authorized.");
  const topology = topologySnapshot(await readTopology(target));
  const blockers = Object.freeze(topologyBlockers(target, topology));
  const { suppliedBlockers: _suppliedBlockers, ...publicTopology } = topology;
  return freezeDeep({ schemaVersion: 1, target, capabilitySha, redactionKeyBytes, policies, topology: publicTopology, blockers });
}
