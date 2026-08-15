import { captureTenantPurgeRootFields } from "./tenant-purge-observation-kernel";
import { invalidTenantPurgeValue } from "./tenant-purge-value-scalar-kernel";
import {
  createTenantPurgeOwnedVector,
  pushTenantPurgeOwnedVector,
  type TenantPurgeOwnedVector,
} from "./tenant-purge-owned-vector-kernel";
import {
  captureTenantPurgeOwnedSchema,
  createTenantPurgeOwnedField,
  createTenantPurgeOwnedSchema,
  type TenantPurgeOwnedCompiledSchema,
  type TenantPurgeOwnedField,
  type TenantPurgeOwnedSchema,
} from "./tenant-purge-owned-schema-kernel";
import {
  copyTenantPurgeOwnedCollection,
  type TenantPurgeOwnedCopy,
  type TenantPurgeOwnedOrderedEntry,
} from "./tenant-purge-owned-collection-kernel";

const CREATE = Object.create;
const DEFINE = Object.defineProperty;
const FREEZE = Object.freeze;
const SET_PROTOTYPE = Object.setPrototypeOf;
const APPLY = Reflect.apply;
const CONSTRUCT = Reflect.construct;
const ARRAY = Array;
const SET = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const NO_ARGUMENTS = FREEZE([]);

function descriptor(value: unknown): PropertyDescriptor {
  const result = CREATE(null) as PropertyDescriptor;
  result.value = value;
  result.enumerable = true;
  result.configurable = true;
  result.writable = true;
  return result;
}

function list<T>(values: readonly T[]): readonly T[] {
  const result = CONSTRUCT(ARRAY, [values.length]) as T[];
  SET_PROTOTYPE(result, null);
  for (let index = 0; index < values.length; index += 1) {
    DEFINE(result, index, descriptor(values[index]));
  }
  return FREEZE(result);
}

export const TENANT_PURGE_TARGET_MODES = list([
  "ACCOUNT_WORKSPACE",
  "SELF_SERVE_TRIAL_WORKSPACE",
] as const) as readonly ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"];

export const TENANT_PURGE_BLOCKER_CODES = list([
  "TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "LINKED_DEPLOYMENT", "LINKED_TRIAL",
  "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING", "TRIAL_NOT_EXPIRED", "SHARED_RESOURCE_AMBIGUITY",
  "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION", "ACTIVE_CREDENTIAL",
  "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING",
  "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED", "LEGAL_HOLD", "RETENTION_HOLD",
  "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER", "CLIENT_MIGRATION",
] as const) as readonly [
  "TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "LINKED_DEPLOYMENT", "LINKED_TRIAL",
  "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING", "TRIAL_NOT_EXPIRED", "SHARED_RESOURCE_AMBIGUITY",
  "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION", "ACTIVE_CREDENTIAL",
  "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING",
  "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED", "LEGAL_HOLD", "RETENTION_HOLD",
  "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER", "CLIENT_MIGRATION",
];

export type TenantPurgeTargetMode = (typeof TENANT_PURGE_TARGET_MODES)[number];
export type TenantPurgeBlockerCode = (typeof TENANT_PURGE_BLOCKER_CODES)[number];
export type TenantPurgeTarget =
  | Readonly<{ mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }>
  | Readonly<{ mode: "SELF_SERVE_TRIAL_WORKSPACE"; trialId: string; deploymentId: string; workspaceId: string }>;
export type TenantPurgePolicies = Readonly<{
  pageSize: number; maxPagesPerModel: number; maxEvidenceItems: number; cacheMaxTtlSeconds: number;
}>;
export type TenantPurgeTopology = Readonly<{
  capturedAt: string;
  workspace: null | Readonly<{ id: string; managedDeploymentIds: readonly string[]; trialIds: readonly string[] }>;
  deployment: null | Readonly<{ id: string; managedWorkspaceId: string | null; accountId: string | null; primaryAccountIds: readonly string[]; sharedResourceAmbiguous: boolean; hasManagedReleaseLease: boolean; hasProviderCutover: boolean; hasClientMigration: boolean }>;
  account: null | Readonly<{ id: string; deploymentIds: readonly string[]; primaryDeploymentId: string | null }>;
  trial: null | Readonly<{ id: string; workspaceId: string | null; expired: boolean }>;
}>;
export type TenantPurgeNormalizedManifestValues = Readonly<{
  target: TenantPurgeTarget; capabilitySha: string; redactionKeyBytes: readonly number[];
  policies: TenantPurgePolicies; topology: TenantPurgeTopology; suppliedBlockers: readonly TenantPurgeBlockerCode[];
}>;

function record(fields: readonly (readonly [string, TenantPurgeOwnedSchema])[]): TenantPurgeOwnedSchema {
  let vector: TenantPurgeOwnedVector<TenantPurgeOwnedField> = createTenantPurgeOwnedVector(fields.length);
  for (let index = 0; index < fields.length; index += 1) {
    vector = pushTenantPurgeOwnedVector(vector, createTenantPurgeOwnedField(fields[index][0], fields[index][1]));
  }
  return createTenantPurgeOwnedSchema("record", vector);
}

const UUID = createTenantPurgeOwnedSchema("uuid");
const NULLABLE_UUID = createTenantPurgeOwnedSchema("nullable", UUID);
const UUID_LIST = createTenantPurgeOwnedSchema("array", UUID, 100_000, true);
const MODE = createTenantPurgeOwnedSchema("string", 32);
const BOOLEAN = createTenantPurgeOwnedSchema("boolean");
const WORKSPACE = record([["id", UUID], ["managedDeploymentIds", UUID_LIST], ["trialIds", UUID_LIST]]);
const DEPLOYMENT = record([["id", UUID], ["managedWorkspaceId", NULLABLE_UUID], ["accountId", NULLABLE_UUID], ["primaryAccountIds", UUID_LIST], ["sharedResourceAmbiguous", BOOLEAN], ["hasManagedReleaseLease", BOOLEAN], ["hasProviderCutover", BOOLEAN], ["hasClientMigration", BOOLEAN]]);
const ACCOUNT = record([["id", UUID], ["deploymentIds", UUID_LIST], ["primaryDeploymentId", NULLABLE_UUID]]);
const TRIAL = record([["id", UUID], ["workspaceId", NULLABLE_UUID], ["expired", BOOLEAN]]);
const TOPOLOGY = record([["capturedAt", createTenantPurgeOwnedSchema("dateIso")], ["workspace", createTenantPurgeOwnedSchema("nullable", WORKSPACE)], ["deployment", createTenantPurgeOwnedSchema("nullable", DEPLOYMENT)], ["account", createTenantPurgeOwnedSchema("nullable", ACCOUNT)], ["trial", createTenantPurgeOwnedSchema("nullable", TRIAL)]]);
const POLICIES = record([["pageSize", createTenantPurgeOwnedSchema("integer", 1, 1000)], ["maxPagesPerModel", createTenantPurgeOwnedSchema("integer", 1, 1000)], ["maxEvidenceItems", createTenantPurgeOwnedSchema("integer", 1, 100_000)], ["cacheMaxTtlSeconds", createTenantPurgeOwnedSchema("integer", 0, 31_536_000)]]);
const ACCOUNT_TARGET = record([["mode", MODE], ["accountId", UUID], ["deploymentId", UUID], ["workspaceId", UUID]]);
const TRIAL_TARGET = record([["mode", MODE], ["trialId", UUID], ["deploymentId", UUID], ["workspaceId", UUID]]);
const BLOCKERS = createTenantPurgeOwnedSchema("array", createTenantPurgeOwnedSchema("string", 64), 23, true);
const ROOT = (target: TenantPurgeOwnedSchema) => record([["target", target], ["capabilitySha", createTenantPurgeOwnedSchema("sha")], ["redactionKeyBytes", createTenantPurgeOwnedSchema("redactionKey")], ["policies", POLICIES], ["topology", TOPOLOGY], ["suppliedBlockers", BLOCKERS]]);
const ACCOUNT_ROOT = ROOT(ACCOUNT_TARGET);
const TRIAL_ROOT = ROOT(TRIAL_TARGET);
const BLOCKER_SET = CONSTRUCT(SET, NO_ARGUMENTS) as Set<string>;
for (let index = 0; index < TENANT_PURGE_BLOCKER_CODES.length; index += 1) {
  APPLY(SET_ADD, BLOCKER_SET, [TENANT_PURGE_BLOCKER_CODES[index]]);
}
const AUTHORITY_SENTINEL = CREATE(null) as Record<string, unknown>;
DEFINE(AUTHORITY_SENTINEL, "privateAuthority", descriptor(false));
FREEZE(AUTHORITY_SENTINEL);

function materialize(value: TenantPurgeOwnedCopy, schema: TenantPurgeOwnedCompiledSchema): unknown {
  if (schema.kind === "scalar") return value;
  if (schema.kind === "nullable") return value === null ? null : materialize(value, captureTenantPurgeOwnedSchema(schema.value));
  if (schema.kind === "array") {
    const source = value as readonly TenantPurgeOwnedCopy[];
    const output = CONSTRUCT(ARRAY, [source.length]) as unknown[];
    SET_PROTOTYPE(output, null);
    const child = captureTenantPurgeOwnedSchema(schema.value);
    for (let index = 0; index < source.length; index += 1) DEFINE(output, index, descriptor(materialize(source[index], child)));
    return FREEZE(output);
  }
  const source = value as readonly TenantPurgeOwnedOrderedEntry[];
  const output = CREATE(null) as Record<string, unknown>;
  for (let index = 0; index < schema.fields.length; index += 1) {
    DEFINE(output, schema.fields[index].name, descriptor(materialize(source[index][1], captureTenantPurgeOwnedSchema(schema.fields[index].value))));
  }
  return FREEZE(output);
}

export function normalizeTenantPurgeManifestValues(
  privateAuthority: unknown,
  targetMode: unknown,
  ownedValues: unknown,
): TenantPurgeNormalizedManifestValues {
  if (privateAuthority !== true) return captureTenantPurgeRootFields(AUTHORITY_SENTINEL) as never;
  const schema = targetMode === "ACCOUNT_WORKSPACE" ? ACCOUNT_ROOT
    : targetMode === "SELF_SERVE_TRIAL_WORKSPACE" ? TRIAL_ROOT : invalidTenantPurgeValue();
  const copied = copyTenantPurgeOwnedCollection(ownedValues, schema) as readonly TenantPurgeOwnedOrderedEntry[];
  const copiedMode = ((copied[0][1] as readonly TenantPurgeOwnedOrderedEntry[])[0][1]);
  if (copiedMode !== targetMode) return invalidTenantPurgeValue();
  const supplied = copied[5][1] as readonly string[];
  for (let index = 0; index < supplied.length; index += 1) {
    if (!APPLY(SET_HAS, BLOCKER_SET, [supplied[index]])) return invalidTenantPurgeValue();
  }
  return materialize(copied, captureTenantPurgeOwnedSchema(schema)) as TenantPurgeNormalizedManifestValues;
}
