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

export type TenantPurgePreparedManifestValues = Readonly<{
  schemaVersion: 1;
  target: TenantPurgeTarget;
  capabilitySha: string;
  redactionKeyBytes: readonly number[];
  policies: TenantPurgePolicies;
  topology: TenantPurgeTopology;
  blockers: readonly TenantPurgeBlockerCode[];
}>;

export function prepareTenantPurgeManifestValues(
  privateAuthority: unknown,
  targetMode: unknown,
  ownedValues: unknown,
): TenantPurgePreparedManifestValues {
  const snapshot = normalizeTenantPurgeManifestValues(privateAuthority, targetMode, ownedValues);
  const found = CONSTRUCT(SET, NO_ARGUMENTS) as Set<TenantPurgeBlockerCode>;
  for (let index = 0; index < snapshot.suppliedBlockers.length; index += 1) {
    APPLY(SET_ADD, found, [snapshot.suppliedBlockers[index]]);
  }
  const add = (code: TenantPurgeBlockerCode): void => {
    APPLY(SET_ADD, found, [code]);
  };
  const { target, topology } = snapshot;
  const { workspace, deployment, account, trial } = topology;
  let workspaceHasTargetDeployment = false;
  let workspaceHasOtherDeployment = false;
  if (workspace !== null) {
    for (let index = 0; index < workspace.managedDeploymentIds.length; index += 1) {
      if (workspace.managedDeploymentIds[index] === target.deploymentId) workspaceHasTargetDeployment = true;
      else workspaceHasOtherDeployment = true;
    }
  }
  if (
    workspace === null || workspace.id !== target.workspaceId ||
    deployment === null || deployment.id !== target.deploymentId ||
    deployment.managedWorkspaceId !== target.workspaceId || !workspaceHasTargetDeployment
  ) add("TARGET_TUPLE_MISMATCH");
  if (workspaceHasOtherDeployment) {
    add("LINKED_DEPLOYMENT");
    add("SIBLING_DEPLOYMENT");
  }
  if (
    (deployment !== null && deployment.primaryAccountIds.length > 0) ||
    (account !== null && account.primaryDeploymentId !== null)
  ) add("PRIMARY_ROUTING");
  if (deployment !== null) {
    if (deployment.sharedResourceAmbiguous) add("SHARED_RESOURCE_AMBIGUITY");
    if (deployment.hasManagedReleaseLease) add("MANAGED_RELEASE_LEASE");
    if (deployment.hasProviderCutover) add("PROVIDER_CUTOVER");
    if (deployment.hasClientMigration) add("CLIENT_MIGRATION");
  }
  if (target.mode === "ACCOUNT_WORKSPACE") {
    let accountHasTargetDeployment = false;
    let accountHasOtherDeployment = false;
    if (account !== null) {
      for (let index = 0; index < account.deploymentIds.length; index += 1) {
        if (account.deploymentIds[index] === target.deploymentId) accountHasTargetDeployment = true;
        else accountHasOtherDeployment = true;
      }
    }
    if (
      account === null || account.id !== target.accountId ||
      deployment === null || deployment.accountId !== target.accountId ||
      !accountHasTargetDeployment
    ) add("TARGET_TUPLE_MISMATCH");
    if (
      accountHasOtherDeployment ||
      (account !== null && account.primaryDeploymentId !== null && account.primaryDeploymentId !== target.deploymentId)
    ) {
      add("LINKED_DEPLOYMENT");
      add("SIBLING_DEPLOYMENT");
    }
    if ((workspace !== null && workspace.trialIds.length > 0) || trial !== null) add("LINKED_TRIAL");
  } else {
    let workspaceHasTargetTrial = false;
    let workspaceHasOtherTrial = false;
    if (workspace !== null) {
      for (let index = 0; index < workspace.trialIds.length; index += 1) {
        if (workspace.trialIds[index] === target.trialId) workspaceHasTargetTrial = true;
        else workspaceHasOtherTrial = true;
      }
    }
    if (
      trial === null || trial.id !== target.trialId || trial.workspaceId !== target.workspaceId ||
      workspace === null || !workspaceHasTargetTrial
    ) add("TARGET_TUPLE_MISMATCH");
    if (trial !== null && !trial.expired) add("TRIAL_NOT_EXPIRED");
    if (workspaceHasOtherTrial) add("LINKED_TRIAL");
    if (
      account !== null ||
      (deployment !== null && (deployment.accountId !== null || deployment.primaryAccountIds.length > 0))
    ) add("LINKED_ACCOUNT");
  }
  const blockers = CONSTRUCT(ARRAY, [0]) as TenantPurgeBlockerCode[];
  SET_PROTOTYPE(blockers, null);
  let blockerIndex = 0;
  for (let index = 0; index < TENANT_PURGE_BLOCKER_CODES.length; index += 1) {
    const code = TENANT_PURGE_BLOCKER_CODES[index];
    if (APPLY(SET_HAS, found, [code])) {
      DEFINE(blockers, blockerIndex, descriptor(code));
      blockerIndex += 1;
    }
  }
  FREEZE(blockers);
  const prepared = CREATE(null) as Record<string, unknown>;
  DEFINE(prepared, "schemaVersion", descriptor(1));
  DEFINE(prepared, "target", descriptor(snapshot.target));
  DEFINE(prepared, "capabilitySha", descriptor(snapshot.capabilitySha));
  DEFINE(prepared, "redactionKeyBytes", descriptor(snapshot.redactionKeyBytes));
  DEFINE(prepared, "policies", descriptor(snapshot.policies));
  DEFINE(prepared, "topology", descriptor(snapshot.topology));
  DEFINE(prepared, "blockers", descriptor(blockers));
  return FREEZE(prepared) as TenantPurgePreparedManifestValues;
}
