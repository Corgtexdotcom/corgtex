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

export interface TenantPurgeManifestValueInput {
  target: TenantPurgeTarget;
  capabilitySha: string;
  redactionKey: Uint8Array;
  privateAuthority: true;
  policies: TenantPurgeManifestPolicies;
  topology: TenantPurgeTopologyInput;
}

export interface TenantPurgeNormalizedTopology {
  readonly capturedAt: string;
  readonly workspace: Readonly<{ id: string; managedDeploymentIds: readonly string[]; trialIds: readonly string[] }> | null;
  readonly deployment: Readonly<{ id: string; managedWorkspaceId: string | null; accountId: string | null; primaryAccountIds: readonly string[]; sharedResourceAmbiguous: boolean; hasManagedReleaseLease: boolean; hasProviderCutover: boolean; hasClientMigration: boolean }> | null;
  readonly account: Readonly<{ id: string; deploymentIds: readonly string[]; primaryDeploymentId: string | null }> | null;
  readonly trial: Readonly<{ id: string; workspaceId: string | null; expired: boolean }> | null;
}

export interface TenantPurgeNormalizedManifestValues {
  readonly target: Readonly<TenantPurgeTarget>;
  readonly capabilitySha: string;
  readonly redactionKeyBytes: readonly number[];
  readonly policies: Readonly<TenantPurgeManifestPolicies>;
  readonly topology: TenantPurgeNormalizedTopology;
  readonly suppliedBlockers: readonly TenantPurgeBlockerCode[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const INDEX = /^(0|[1-9]\d*)$/;
const MAX_ARRAY_LENGTH = 100_000;
const TO_OBJECT = Object;
const TO_NUMBER = Number;
const TO_STRING = String;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_PROTOTYPE = Array.prototype;
const DATE_PROTOTYPE = Date.prototype;
const OBJECT_CREATE = Object.create;
const DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_IS_FROZEN = Object.isFrozen;
const OBJECT_VALUES = Object.values;
const GET_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const GET_PROTOTYPE = Object.getPrototypeOf;
const SET_PROTOTYPE = Object.setPrototypeOf;
const OWN_KEYS = Reflect.ownKeys;
const APPLY = Reflect.apply;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_INCLUDES = Array.prototype.includes;
const REGEXP_EXEC = RegExp.prototype.exec;
const IS_SAFE_INTEGER = Number.isSafeInteger;
const IS_INTEGER = Number.isInteger;
const IS_FINITE = Number.isFinite;
const SET = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const UINT8_ARRAY = Uint8Array;
const DATE = Date;
const TYPED_ARRAY_PROTOTYPE = GET_PROTOTYPE(Uint8Array.prototype);
const TYPED_ARRAY_KIND = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get!;
const TYPED_ARRAY_BYTE_LENGTH = GET_DESCRIPTOR(TYPED_ARRAY_PROTOTYPE, "byteLength")!.get!;
const UINT8_SET = Uint8Array.prototype.set;
const DATE_TIME = Date.prototype.getTime;
const DATE_TO_ISO = Date.prototype.toISOString;
const CONSTRUCT = Reflect.construct;
const ERROR = Error;
function StableAppError() {}
StableAppError.prototype = AppError.prototype;

function fail(status: number, code: string, message: string): never { const error = CONSTRUCT(ERROR, [message], StableAppError) as AppError; DEFINE_PROPERTY(error, "status", { value: status, enumerable: true, configurable: true, writable: true }); DEFINE_PROPERTY(error, "code", { value: code, enumerable: true, configurable: true, writable: true }); throw OBJECT_FREEZE(error); }
function invalid(label: string): never { return fail(400, "TENANT_PURGE_CONTRACT_INVALID", `Invalid tenant purge ${label}.`); }
function malformed(): never { return fail(400, "TENANT_PURGE_CONTRACT_INVALID", "Invalid tenant purge contract input."); }
function observe<T>(operation: () => T): T { try { return operation(); } catch { return malformed(); } }
function keysMatch(keys: readonly PropertyKey[], shape: readonly string[]) { if (keys.length !== shape.length) return false; for (let index = 0; index < keys.length; index += 1) if (typeof keys[index] !== "string" || !APPLY(ARRAY_INCLUDES, shape, [keys[index]])) return false; return true; }
function shapeMatches(keys: readonly PropertyKey[], shapes: readonly (readonly string[])[]) { for (let index = 0; index < shapes.length; index += 1) if (keysMatch(keys, shapes[index]!)) return true; return false; }
function arrayKeysMatch(keys: readonly PropertyKey[], length: number) { if (keys.length !== length + 1) return false; for (let index = 0; index < keys.length; index += 1) { const key = keys[index]; if (typeof key !== "string" || (key !== "length" && (!APPLY(REGEXP_EXEC, INDEX, [key]) || TO_NUMBER(key) >= length))) return false; } return true; }
function append<T>(values: T[], value: T) { DEFINE_PROPERTY(values, TO_STRING(values.length), { value, enumerable: true, configurable: true, writable: true }); }
function hasDuplicate(values: readonly unknown[]) { const seen = new SET<unknown>(); for (let index = 0; index < values.length; index += 1) { if (APPLY(SET_HAS, seen, [values[index]])) return true; APPLY(SET_ADD, seen, [values[index]]); } return false; }

function exactRecord(value: unknown, shapes: readonly (readonly string[])[], label: string) {
  const observed = observe(() => ({ prototype: GET_PROTOTYPE(value as object), keys: OWN_KEYS(value as object) }));
  if ((observed.prototype !== OBJECT_PROTOTYPE && observed.prototype !== null) || !shapeMatches(observed.keys, shapes)) invalid(label);
  const snapshot = OBJECT_CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < observed.keys.length; index += 1) {
    const key = observed.keys[index] as string;
    const descriptor = observe(() => GET_DESCRIPTOR(value as object, key));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(label);
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactArray(value: unknown, label: string): unknown[] {
  const lengthDescriptor = observe(() => GET_DESCRIPTOR(value as object, "length"));
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : -1;
  if (typeof length !== "number" || !IS_SAFE_INTEGER(length) || length < 0 || length > MAX_ARRAY_LENGTH || lengthDescriptor?.enumerable !== false) invalid(label);
  const observed = observe(() => ({ array: ARRAY_IS_ARRAY(value), prototype: GET_PROTOTYPE(value as object), keys: OWN_KEYS(value as object) }));
  if (!observed.array || observed.prototype !== ARRAY_PROTOTYPE || !arrayKeysMatch(observed.keys, length)) invalid(label);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = observe(() => GET_DESCRIPTOR(value as object, TO_STRING(index)));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid(label);
    append(result, descriptor.value);
  }
  return result;
}

function inputSnapshot(value: unknown) {
  const authority = observe(() => GET_DESCRIPTOR(TO_OBJECT(value), "privateAuthority"));
  if (!authority || !("value" in authority) || authority.value !== true) fail(403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED", "Private tenant purge authority is required.");
  const required = ["target", "capabilitySha", "redactionKey", "privateAuthority", "policies", "topology"];
  const observed = observe(() => ({ prototype: GET_PROTOTYPE(value as object), keys: OWN_KEYS(value as object) }));
  if ((observed.prototype !== OBJECT_PROTOTYPE && observed.prototype !== null) || !authority.enumerable || !keysMatch(observed.keys, required)) invalid("value input");
  const snapshot = OBJECT_CREATE(null) as Record<string, unknown>; snapshot.privateAuthority = true;
  for (let index = 0; index < required.length; index += 1) { const key = required[index]!; if (key !== "privateAuthority") {
    const descriptor = observe(() => GET_DESCRIPTOR(value as object, key));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid("value input");
    snapshot[key] = descriptor.value;
  } }
  return snapshot;
}

function uuid(value: unknown, label: string): string { if (typeof value !== "string" || !APPLY(REGEXP_EXEC, UUID, [value])) invalid(label); return value; }
function sha(value: unknown): string { if (typeof value !== "string" || !APPLY(REGEXP_EXEC, SHA, [value])) invalid("capability SHA"); return value; }
function boolean(value: unknown, label: string): boolean { if (typeof value !== "boolean") invalid(label); return value; }
function integer(value: unknown, label: string, maximum: number, minimum = 1): number { if (typeof value !== "number" || !IS_INTEGER(value) || value < minimum || value > maximum) invalid(label); return value; }
function nullableUuid(value: unknown, label: string) { return value === null ? null : uuid(value, label); }
function uuidList(value: unknown, label: string) { const items = exactArray(value, label); const result: string[] = []; for (let index = 0; index < items.length; index += 1) append(result, uuid(items[index], label)); if (hasDuplicate(result)) invalid(label); return result; }
function freezeDeep<T>(value: T): T { if (typeof value === "object" && value !== null && !OBJECT_IS_FROZEN(value)) { const children = OBJECT_VALUES(value); for (let index = 0; index < children.length; index += 1) freezeDeep(children[index]); SET_PROTOTYPE(value, null); OBJECT_FREEZE(value); } return value; }

function targetSnapshot(value: unknown): TenantPurgeTarget {
  const accountShape = ["mode", "accountId", "deploymentId", "workspaceId"];
  const trialShape = ["mode", "trialId", "deploymentId", "workspaceId"];
  const raw = exactRecord(value, [accountShape, trialShape], "target");
  const common = { deploymentId: uuid(raw.deploymentId, "deployment ID"), workspaceId: uuid(raw.workspaceId, "workspace ID") };
  if (raw.mode === "ACCOUNT_WORKSPACE") return { mode: raw.mode, accountId: uuid(raw.accountId, "account ID"), ...common };
  if (raw.mode === "SELF_SERVE_TRIAL_WORKSPACE") return { mode: raw.mode, trialId: uuid(raw.trialId, "trial ID"), ...common };
  return invalid("target mode");
}

function keySnapshot(value: unknown) {
  const observed = observe(() => ({ kind: APPLY(TYPED_ARRAY_KIND, value, []), length: APPLY(TYPED_ARRAY_BYTE_LENGTH, value, []) as number }));
  if (observed.kind !== "Uint8Array" || !IS_SAFE_INTEGER(observed.length) || observed.length < 32 || observed.length > 64) invalid("redaction key");
  const copy = new UINT8_ARRAY(observed.length);
  observe(() => APPLY(UINT8_SET, copy, [value]));
  const bytes: number[] = [];
  for (let index = 0; index < observed.length; index += 1) append(bytes, copy[index]!);
  return bytes;
}

function policySnapshot(value: unknown): TenantPurgeManifestPolicies {
  const raw = exactRecord(value, [["pageSize", "maxPagesPerModel", "maxEvidenceItems", "cacheMaxTtlSeconds"]], "policies");
  return { pageSize: integer(raw.pageSize, "page size", 1_000), maxPagesPerModel: integer(raw.maxPagesPerModel, "page limit", 1_000), maxEvidenceItems: integer(raw.maxEvidenceItems, "evidence limit", 100_000), cacheMaxTtlSeconds: integer(raw.cacheMaxTtlSeconds, "cache TTL", 31_536_000, 0) };
}

function dateSnapshot(value: unknown) {
  const observed = observe(() => ({ prototype: GET_PROTOTYPE(value as object), keys: OWN_KEYS(value as object), milliseconds: APPLY(DATE_TIME, value, []) as number }));
  if (observed.prototype !== DATE_PROTOTYPE || observed.keys.length || !IS_FINITE(observed.milliseconds)) invalid("capture time");
  return APPLY(DATE_TO_ISO, new DATE(observed.milliseconds), []);
}

function topologySnapshot(value: unknown) {
  const raw = exactRecord(value, [["capturedAt", "workspace", "deployment", "account", "trial", "blockers"]], "topology");
  const workspace = raw.workspace === null ? null : exactRecord(raw.workspace, [["id", "managedDeploymentIds", "trialIds"]], "workspace topology");
  const deployment = raw.deployment === null ? null : exactRecord(raw.deployment, [["id", "managedWorkspaceId", "accountId", "primaryAccountIds", "sharedResourceAmbiguous", "hasManagedReleaseLease", "hasProviderCutover", "hasClientMigration"]], "deployment topology");
  const account = raw.account === null ? null : exactRecord(raw.account, [["id", "deploymentIds", "primaryDeploymentId"]], "account topology");
  const trial = raw.trial === null ? null : exactRecord(raw.trial, [["id", "workspaceId", "expired"]], "trial topology");
  const suppliedBlockers = exactArray(raw.blockers, "blockers");
  if (hasDuplicate(suppliedBlockers)) invalid("blockers");
  for (let index = 0; index < suppliedBlockers.length; index += 1) if (!APPLY(ARRAY_INCLUDES, TENANT_PURGE_BLOCKER_CODES, [suppliedBlockers[index]])) invalid("blockers");
  return {
    topology: {
      capturedAt: dateSnapshot(raw.capturedAt),
      workspace: workspace && { id: uuid(workspace.id, "workspace topology ID"), managedDeploymentIds: uuidList(workspace.managedDeploymentIds, "workspace deployment IDs"), trialIds: uuidList(workspace.trialIds, "workspace trial IDs") },
      deployment: deployment && { id: uuid(deployment.id, "deployment topology ID"), managedWorkspaceId: nullableUuid(deployment.managedWorkspaceId, "managed workspace ID"), accountId: nullableUuid(deployment.accountId, "deployment account ID"), primaryAccountIds: uuidList(deployment.primaryAccountIds, "primary account IDs"), sharedResourceAmbiguous: boolean(deployment.sharedResourceAmbiguous, "shared resource flag"), hasManagedReleaseLease: boolean(deployment.hasManagedReleaseLease, "release lease flag"), hasProviderCutover: boolean(deployment.hasProviderCutover, "provider cutover flag"), hasClientMigration: boolean(deployment.hasClientMigration, "client migration flag") },
      account: account && { id: uuid(account.id, "account topology ID"), deploymentIds: uuidList(account.deploymentIds, "account deployment IDs"), primaryDeploymentId: nullableUuid(account.primaryDeploymentId, "primary deployment ID") },
      trial: trial && { id: uuid(trial.id, "trial topology ID"), workspaceId: nullableUuid(trial.workspaceId, "trial workspace ID"), expired: boolean(trial.expired, "expired trial flag") },
    },
    suppliedBlockers: suppliedBlockers as TenantPurgeBlockerCode[],
  };
}

export function normalizeTenantPurgeManifestValues(input: unknown): TenantPurgeNormalizedManifestValues {
  const raw = inputSnapshot(input);
  const normalized = topologySnapshot(raw.topology);
  return freezeDeep({ target: targetSnapshot(raw.target), capabilitySha: sha(raw.capabilitySha), redactionKeyBytes: keySnapshot(raw.redactionKey), policies: policySnapshot(raw.policies), topology: normalized.topology, suppliedBlockers: normalized.suppliedBlockers });
}
