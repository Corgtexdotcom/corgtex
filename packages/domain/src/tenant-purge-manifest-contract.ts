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

export interface TenantPurgePreparedManifestValues {
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

export interface TenantPurgeManifestValueInput {
  target: TenantPurgeTarget;
  capabilitySha: string;
  redactionKey: Uint8Array;
  privateAuthority: boolean;
  policies: TenantPurgeManifestPolicies;
  topology: TenantPurgeTopologyInput;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_ARRAY_LENGTH = 100_000;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;
const UINT8_SET = Uint8Array.prototype.set;

function invalid(message: string): never {
  throw new AppError(400, "TENANT_PURGE_CONTRACT_INVALID", message);
}

function observe<T>(label: string, operation: () => T): T {
  try { return operation(); } catch (error) { if (error instanceof AppError) throw error; return invalid(`Invalid tenant purge ${label}.`); }
}

function exactRecord(value: unknown, expected: readonly string[] | ((snapshot: Record<string, unknown>) => readonly string[]), label: string) {
  const { prototype, descriptors } = observe(label, () => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`Invalid tenant purge ${label}.`);
    return { prototype: Object.getPrototypeOf(value), descriptors: Object.getOwnPropertyDescriptors(value) };
  });
  const keys = Reflect.ownKeys(descriptors);
  if ((prototype !== Object.prototype && prototype !== null) || keys.some((key) => typeof key !== "string")) invalid(`Invalid tenant purge ${label}.`);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid(`Invalid tenant purge ${label}.`);
    snapshot[key] = descriptor.value;
  }
  const required = typeof expected === "function" ? expected(snapshot) : expected;
  if (keys.length !== required.length || required.some((key) => !Object.prototype.hasOwnProperty.call(snapshot, key))) invalid(`Invalid tenant purge ${label}.`);
  return snapshot;
}

function exactArray(value: unknown, label: string): unknown[] {
  const lengthDescriptor = observe(label, () => typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, "length") : undefined);
  const lengthValue = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : -1;
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > MAX_ARRAY_LENGTH
    || lengthDescriptor?.enumerable !== false) invalid(`Invalid tenant purge ${label}.`);
  const { prototype, keys } = observe(label, () => {
    if (!Array.isArray(value)) invalid(`Invalid tenant purge ${label}.`);
    return { prototype: Object.getPrototypeOf(value), keys: Reflect.ownKeys(value) };
  });
  if (prototype !== Array.prototype || keys.length !== lengthValue + 1 || !keys.includes("length")
    || keys.some((key) => typeof key !== "string")) invalid(`Invalid tenant purge ${label}.`);
  const length = lengthValue;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = observe(label, () => Object.getOwnPropertyDescriptor(value, String(index)));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(`Invalid tenant purge ${label}.`);
    result.push(descriptor.value);
  }
  return result;
}

function valueInputSnapshot(value: unknown) {
  const authority = observe("value input authority", () => typeof value === "object" && value !== null
    ? Object.getOwnPropertyDescriptor(value, "privateAuthority") : undefined);
  if (!authority || !("value" in authority) || authority.value !== true)
    throw new AppError(403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED", "Private tenant purge authority is required.");
  const required = ["target", "capabilitySha", "redactionKey", "privateAuthority", "policies", "topology"];
  const { prototype, keys } = observe("value input", () => ({ prototype: Object.getPrototypeOf(value!), keys: Reflect.ownKeys(value!) }));
  if ((prototype !== Object.prototype && prototype !== null) || !authority.enumerable || keys.length !== required.length
    || keys.some((key) => typeof key !== "string") || required.some((key) => !keys.includes(key))) invalid("Invalid tenant purge value input.");
  const snapshot = Object.create(null) as Record<string, unknown>; snapshot.privateAuthority = true;
  for (const key of required) if (key !== "privateAuthority") {
    const descriptor = observe("value input", () => Object.getOwnPropertyDescriptor(value!, key));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("Invalid tenant purge value input.");
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid(`Invalid tenant purge ${label}.`);
  return value;
}

function uuidList(value: unknown, label: string) {
  const result = exactArray(value, label).map((item) => uuid(item, label));
  if (new Set(result).size !== result.length) invalid(`Invalid tenant purge ${label}.`);
  return result;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") invalid(`Invalid tenant purge ${label}.`);
  return value;
}

function integer(value: unknown, label: string, maximum: number, minimum = 1) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid(`Invalid tenant purge ${label}.`);
  return value as number;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

function targetSnapshot(value: unknown): TenantPurgeTarget {
  const raw = exactRecord(value, (snapshot) => snapshot.mode === "ACCOUNT_WORKSPACE"
    ? ["mode", "accountId", "deploymentId", "workspaceId"] : ["mode", "trialId", "deploymentId", "workspaceId"], "target");
  if (!TENANT_PURGE_TARGET_MODES.includes(raw.mode as never)) invalid("Invalid tenant purge target mode.");
  const common = { deploymentId: uuid(raw.deploymentId, "deployment ID"), workspaceId: uuid(raw.workspaceId, "workspace ID") };
  return raw.mode === "ACCOUNT_WORKSPACE"
    ? freezeDeep({ mode: raw.mode, accountId: uuid(raw.accountId, "account ID"), ...common })
    : freezeDeep({ mode: raw.mode as "SELF_SERVE_TRIAL_WORKSPACE", trialId: uuid(raw.trialId, "trial ID"), ...common });
}

function keySnapshot(value: unknown) {
  const length = observe("redaction key", () => {
    if (!(value instanceof Uint8Array)) invalid("Invalid tenant purge redaction key.");
    return Reflect.apply(TYPED_ARRAY_BYTE_LENGTH, value, []) as number;
  });
  if (length < 32 || length > 64) invalid("Invalid tenant purge redaction key.");
  const copy = new Uint8Array(length);
  observe("redaction key", () => Reflect.apply(UINT8_SET, copy, [value]));
  const bytes: number[] = [];
  for (let index = 0; index < length; index += 1) bytes.push(copy[index]!);
  return Object.freeze(bytes);
}

function policySnapshot(value: unknown): TenantPurgeManifestPolicies {
  const raw = exactRecord(value, ["pageSize", "maxPagesPerModel", "maxEvidenceItems", "cacheMaxTtlSeconds"], "policies");
  return freezeDeep({ pageSize: integer(raw.pageSize, "page size", 1_000), maxPagesPerModel: integer(raw.maxPagesPerModel, "page limit", 1_000),
    maxEvidenceItems: integer(raw.maxEvidenceItems, "evidence limit", 100_000), cacheMaxTtlSeconds: integer(raw.cacheMaxTtlSeconds, "cache TTL", 31_536_000, 0) });
}

function dateSnapshot(value: unknown) {
  const milliseconds = observe("capture time", () => {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Date.prototype
      || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length) invalid("Invalid tenant purge capture time.");
    return Date.prototype.getTime.call(value) as number;
  });
  if (!Number.isFinite(milliseconds)) invalid("Invalid tenant purge capture time.");
  return new Date(milliseconds).toISOString();
}

function topologySnapshot(value: unknown) {
  const raw = exactRecord(value, ["capturedAt", "workspace", "deployment", "account", "trial", "blockers"], "topology");
  const workspace = raw.workspace === null ? null : exactRecord(raw.workspace, ["id", "managedDeploymentIds", "trialIds"], "workspace topology");
  const deployment = raw.deployment === null ? null : exactRecord(raw.deployment, ["id", "managedWorkspaceId", "accountId", "primaryAccountIds", "sharedResourceAmbiguous", "hasManagedReleaseLease", "hasProviderCutover", "hasClientMigration"], "deployment topology");
  const account = raw.account === null ? null : exactRecord(raw.account, ["id", "deploymentIds", "primaryDeploymentId"], "account topology");
  const trial = raw.trial === null ? null : exactRecord(raw.trial, ["id", "workspaceId", "expired"], "trial topology");
  const suppliedBlockers = exactArray(raw.blockers, "blockers");
  if (new Set(suppliedBlockers).size !== suppliedBlockers.length || suppliedBlockers.some((code) => !TENANT_PURGE_BLOCKER_CODES.includes(code as never))) invalid("Invalid tenant purge blockers.");
  return freezeDeep({
    topology: {
      capturedAt: dateSnapshot(raw.capturedAt),
      workspace: workspace && { id: uuid(workspace.id, "workspace topology ID"), managedDeploymentIds: uuidList(workspace.managedDeploymentIds, "workspace deployment IDs"), trialIds: uuidList(workspace.trialIds, "workspace trial IDs") },
      deployment: deployment && { id: uuid(deployment.id, "deployment topology ID"), managedWorkspaceId: deployment.managedWorkspaceId === null ? null : uuid(deployment.managedWorkspaceId, "managed workspace ID"), accountId: deployment.accountId === null ? null : uuid(deployment.accountId, "deployment account ID"), primaryAccountIds: uuidList(deployment.primaryAccountIds, "primary account IDs"), sharedResourceAmbiguous: boolean(deployment.sharedResourceAmbiguous, "shared resource flag"), hasManagedReleaseLease: boolean(deployment.hasManagedReleaseLease, "release lease flag"), hasProviderCutover: boolean(deployment.hasProviderCutover, "provider cutover flag"), hasClientMigration: boolean(deployment.hasClientMigration, "client migration flag") },
      account: account && { id: uuid(account.id, "account topology ID"), deploymentIds: uuidList(account.deploymentIds, "account deployment IDs"), primaryDeploymentId: account.primaryDeploymentId === null ? null : uuid(account.primaryDeploymentId, "primary deployment ID") },
      trial: trial && { id: uuid(trial.id, "trial topology ID"), workspaceId: trial.workspaceId === null ? null : uuid(trial.workspaceId, "trial workspace ID"), expired: boolean(trial.expired, "expired trial flag") },
    },
    suppliedBlockers: suppliedBlockers as TenantPurgeBlockerCode[],
  });
}

function deriveBlockers(target: TenantPurgeTarget, normalized: ReturnType<typeof topologySnapshot>) {
  const blockers = new Set(normalized.suppliedBlockers);
  const { workspace, deployment, account, trial } = normalized.topology;
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
  return Object.freeze(TENANT_PURGE_BLOCKER_CODES.filter((code) => blockers.has(code)));
}

export function prepareTenantPurgeManifestValues(input: TenantPurgeManifestValueInput): TenantPurgePreparedManifestValues {
  const raw = valueInputSnapshot(input);
  const target = targetSnapshot(raw.target);
  if (typeof raw.capabilitySha !== "string" || !SHA.test(raw.capabilitySha)) invalid("Invalid tenant purge capability SHA.");
  const redactionKeyBytes = keySnapshot(raw.redactionKey);
  const policies = policySnapshot(raw.policies);
  const normalized = topologySnapshot(raw.topology);
  return freezeDeep({ target, capabilitySha: raw.capabilitySha, redactionKeyBytes, policies, topology: normalized.topology, blockers: deriveBlockers(target, normalized) });
}
