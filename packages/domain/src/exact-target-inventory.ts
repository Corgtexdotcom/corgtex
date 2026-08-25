import { createHash } from "node:crypto";

export const EXACT_TARGET_INVENTORY_SCHEMA_VERSION = "1.0.0";

export const EXACT_TARGET_WORKLOAD_CLASSES = [
  "ACTIVE_CLIENT_PRIMARY",
  "ACTIVE_CLIENT_AUTHORITY_UNPROVEN",
  "ACTIVE_CLIENT_CANARY",
  "ACTIVE_CLIENT_DECISION_REQUIRED",
  "CORE_WEB",
  "CORE_WORKER",
  "MCP",
  "PUBLIC_SITE",
  "SELFSERVE",
  "STAGING_TEST_E2E",
  "DEMO",
  "OPS_CONTROL_PLANE",
  "RESIDUAL_RAILWAY",
  "DUPLICATE_AZURE",
] as const;

export const EXACT_TARGET_RECORD_TYPES = [
  "WORKLOAD",
  "ENVIRONMENT",
  "PROVIDER_RESOURCE",
  "DATA_STORE",
  "OBJECT_STORE",
  "WORKER",
  "SCHEDULER",
  "QUEUE",
  "DOMAIN",
  "CALLBACK",
  "CREDENTIAL_REF",
  "IMAGE",
  "ROLLBACK_ASSET",
  "GAP",
] as const;

const AUTHORITY_DIMENSIONS = ["serving", "data", "object", "worker", "scheduler", "queue", "domain", "callback"] as const;
const PROVIDER_BACKED_TYPES = new Set(["PROVIDER_RESOURCE", "DATA_STORE", "OBJECT_STORE", "WORKER", "SCHEDULER", "QUEUE", "DOMAIN", "CALLBACK", "CREDENTIAL_REF", "IMAGE", "ROLLBACK_ASSET"]);
const WORKLOAD_CLASS_SET = new Set<string>(EXACT_TARGET_WORKLOAD_CLASSES);
const RECORD_TYPE_SET = new Set<string>(EXACT_TARGET_RECORD_TYPES);
const PROVIDER_KINDS = new Set(["AZURE", "RAILWAY", "GOOGLE_CLOUD_DNS", "GITHUB", "POSTHOG", "EXTERNAL_SAAS", "LOCAL_RECOVERY"]);
const ENVIRONMENT_CLASSES = new Set(["PRODUCTION", "STAGING", "TEST", "E2E", "DEMO", "INTERNAL"]);
const DATA_CLASSES = new Set(["PUBLIC_SYNTHETIC", "INTERNAL", "PRODUCTION_METADATA", "POLICY_PENDING"]);
const POLICY_STATUSES = new Set(["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING"]);
const LIFECYCLE_STATES = new Set(["DRAFT", "PROVISIONING", "ACTIVE", "DEGRADED", "SUSPENDED", "QUARANTINED", "ROLLBACK_ONLY", "EVIDENCE_ONLY", "RETIRED", "UNKNOWN"]);
const RELEASE_ELIGIBILITY = new Set(["ELIGIBLE", "INELIGIBLE", "POLICY_PENDING", "UNKNOWN"]);
const DISPOSITION_DECISIONS = new Set(["ADOPT", "REBUILD", "MIGRATE_LAST", "PRESERVE_QUARANTINE", "RETIRE_ONLY_FUTURE", "DECISION_REQUIRED"]);
const DISPOSITION_STATUSES = new Set(["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING"]);
const AUTHORITY_VERDICTS = new Set(["PROVEN", "AUTHORITY_UNPROVEN", "CONFLICTED", "POLICY_PENDING", "NOT_APPLICABLE"]);
const EVIDENCE_FRESHNESS = new Set(["CURRENT", "STALE", "CONFLICTED", "MISSING", "POLICY_PENDING"]);
const RECORD_ROLES = new Set(["WORKLOAD_ROOT", "ENVIRONMENT_ROOT", "RUNTIME", "DATA", "OBJECT", "WORKER", "SCHEDULER", "QUEUE", "DOMAIN", "CALLBACK", "CREDENTIAL", "IMAGE", "ROLLBACK", "GAP"]);
const DATA_STORE_ROLES = new Set(["AUTHORITATIVE_CANDIDATE", "ROLLBACK_CANDIDATE", "AUXILIARY", "EVIDENCE_ONLY"]);
const OBJECT_STORE_ROLES = new Set(["AUTHORITATIVE_CANDIDATE", "ROLLBACK_CANDIDATE", "AUXILIARY", "EVIDENCE_ONLY"]);
const QUEUE_SEMANTICS = new Set(["POSTGRES_OUTBOX", "WORKFLOW_JOB", "SYNTHETIC_QUEUE"]);
const RECORD_TYPES_WITH_REF_ARRAYS = new Set(["WORKER", "SCHEDULER", "QUEUE", "CREDENTIAL_REF", "IMAGE"]);
const CREDENTIAL_CONSUMER_TYPES = new Set<ExactTargetRecordType>(["PROVIDER_RESOURCE", "DATA_STORE", "OBJECT_STORE", "WORKER", "SCHEDULER", "QUEUE", "DOMAIN", "CALLBACK"]);
const IMAGE_CONSUMER_TYPES = new Set<ExactTargetRecordType>(["PROVIDER_RESOURCE", "WORKER"]);
const BLOCKING_VERDICTS = new Set(["AUTHORITY_UNPROVEN", "CONFLICTED", "POLICY_PENDING"]);
const BLOCKING_DISPOSITIONS = new Set(["POLICY_PENDING", "EVIDENCE_PENDING"]);
const DETAIL_KEYS: Record<ExactTargetRecordType, string> = {
  WORKLOAD: "workload",
  ENVIRONMENT: "environment",
  PROVIDER_RESOURCE: "resource",
  DATA_STORE: "dataStore",
  OBJECT_STORE: "objectStore",
  WORKER: "worker",
  SCHEDULER: "scheduler",
  QUEUE: "queue",
  DOMAIN: "domain",
  CALLBACK: "callback",
  CREDENTIAL_REF: "credentialRef",
  IMAGE: "image",
  ROLLBACK_ASSET: "rollbackAsset",
  GAP: "gap",
};
const ALL_DETAIL_KEYS = new Set(Object.values(DETAIL_KEYS));
const MAX_INPUT_BYTES = 512_000;
const MAX_DEPTH = 24;
const MAX_NODES = 20_000;
const MAX_KEYS = 64;
const MAX_ARRAY_ITEMS = 512;
const MAX_STRING_LENGTH = 2_048;
const MAX_ISSUES = 200;
const VALIDATED_SNAPSHOTS = new WeakSet<ExactTargetInventorySnapshot>();

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type ExactTargetRecordType = typeof EXACT_TARGET_RECORD_TYPES[number];
export type ExactTargetWorkloadClass = typeof EXACT_TARGET_WORKLOAD_CLASSES[number];

export type ExactTargetInventoryBlockerCode =
  | "INVALID_JSON"
  | "DUPLICATE_JSON_KEY"
  | "STRUCTURAL_LIMIT"
  | "UNKNOWN_FIELD"
  | "REQUIRED_FIELD"
  | "INVALID_VALUE"
  | "INVALID_TIMESTAMP"
  | "INVALID_DIGEST"
  | "INVALID_UUID"
  | "INVALID_REFERENCE"
  | "DERIVED_REF_MISMATCH"
  | "DERIVED_DIGEST_MISMATCH"
  | "DUPLICATE_IDENTITY"
  | "MISSING_WORKLOAD_COVERAGE"
  | "CLAIM_MISMATCH"
  | "POLICY_PENDING"
  | "AUTHORITY_UNPROVEN"
  | "RETIREMENT_NOT_BLOCKED"
  | "LIFECYCLE_NOT_SELECTABLE"
  | "STALE_OR_EXPIRED"
  | "SECRET_SENTINEL"
  | "ISSUE_LIMIT";

export type ExactTargetInventoryIssue = {
  code: ExactTargetInventoryBlockerCode;
  path: string;
  inventoryRef?: string;
};

export type ExactTargetInventoryPublicProjection = {
  schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  documentDigest?: string;
  authorizationState: "INVENTORY_ONLY" | "BLOCKED";
  records: Array<{
    inventoryRef: string;
    recordType: ExactTargetRecordType;
    workloadClass: ExactTargetWorkloadClass | "UNKNOWN";
    blockerCodes: ExactTargetInventoryBlockerCode[];
  }>;
  completeness: Array<{
    workloadClass: ExactTargetWorkloadClass;
    status: "COMPLETE" | "BLOCKED";
    blockerCodes: ExactTargetInventoryBlockerCode[];
  }>;
  blockerCodes: ExactTargetInventoryBlockerCode[];
};

export type ExactTargetInventoryValidationOptions = {
  now: string;
};

export type ExactTargetInventoryValidationResult =
  | {
      ok: true;
      snapshot: ExactTargetInventorySnapshot;
      canonicalJson: string;
      documentDigest: string;
      publicProjection: ExactTargetInventoryPublicProjection;
      issues: [];
    }
  | {
      ok: false;
      publicProjection: ExactTargetInventoryPublicProjection;
      issues: ExactTargetInventoryIssue[];
    };

export type ExactTargetInventorySnapshot = Readonly<{
  schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  inventoryId: string;
  snapshotSequence: number;
  generatedAt: string;
  validFrom: string;
  expiresAt: string;
  policyRef: ArtifactRef;
  dispositionRef: ArtifactRef;
  collectorContractRef: ArtifactRef;
  collectorArtifactDigest: string;
  sourceSnapshotRefs: string[];
  records: ExactTargetRecord[];
  relationships: ExactTargetRelationship[];
  evidence: ExactTargetEvidence[];
  validationSummary: ExactTargetValidationSummary;
  documentDigest: string;
  derived: ExactTargetDerivedState;
}>;

export type ExactTargetRecord = Readonly<{
  recordId: string;
  recordType: ExactTargetRecordType;
  inventoryKey: string;
  inventoryRef: string;
  recordRevision: number;
  recordDigest: string;
  workloadId: string;
  environmentId: string;
  ownerRef: string;
  criticality: string;
  lifecycle: Lifecycle;
  disposition: Disposition;
  authority: Authority;
  evidenceRefs: string[];
  firstObservedAt: string;
  lastObservedAt: string;
  verifiedAt: string;
  expiresAt: string;
  provider?: Provider;
  detailKey: string;
  detail: JsonObject;
}>;

export type ExactTargetDerivedState = Readonly<{
  authorizationState: "INVENTORY_ONLY" | "BLOCKED";
  completeness: Array<{ workloadClass: ExactTargetWorkloadClass; status: "COMPLETE" | "BLOCKED"; blockerCodes: ExactTargetInventoryBlockerCode[] }>;
  blockerCodes: ExactTargetInventoryBlockerCode[];
  recordBlockers: Record<string, ExactTargetInventoryBlockerCode[]>;
}>;

type ArtifactRef = Readonly<{ path: string; digest: string; status: string }>;
type Provider = Readonly<{ providerKind: string; providerAccountId: string; providerTenantId?: string; providerSubscriptionOrProjectId?: string; providerScopeId: string; managementPlane: string; authorityBoundary: string }>;
type Lifecycle = Readonly<{ state: string; provisioningState: string; releaseEligibility: string; retirementEligibility: "BLOCKED"; stateObservedAt: string; stateEvidenceRef: string }>;
type Disposition = Readonly<{ decision: string; status: string; decisionRef: string; decidedAt: string; decisionOwner: string }>;
type AuthorityDimension = Readonly<{ verdict: string; evidenceRefs: string[]; observedAt: string; verifiedAt: string; expiresAt: string; independentVerifierRef: string }>;
type Authority = Readonly<Record<typeof AUTHORITY_DIMENSIONS[number], AuthorityDimension> & { authorizationState: "INVENTORY_ONLY" | "BLOCKED" }>;
type ExactTargetRelationship = Readonly<{ relationshipId: string; fromRecordId: string; toRecordId: string; relationshipType: string; evidenceRefs: string[] }>;
type ExactTargetEvidence = Readonly<{ evidenceId: string; evidenceType: string; sourceAuthority: string; sourceRecordId: string; positiveFieldProjection: string[]; collectorIdentityRef: string; collectorVersionDigest: string; collectedAt: string; sourceObservedAt: string; verifiedAt: string; expiresAt: string; sanitizationClass: string; artifactRef: ArtifactRef; artifactDigest: string; freshnessStatus: string; limitations: string[] }>;
type ExactTargetValidationSummary = Readonly<{ completenessLedger: Array<{ workloadClass: ExactTargetWorkloadClass; status: string; evidenceRefs: string[]; blockingGaps: string[]; policyStatus: string; dispositionDecision: string; authorityGate: string }>; blockerCodes: string[]; validatedAt: string }>;
type ParseContext = { issues: ExactTargetInventoryIssue[]; nowMs: number; nowIso: string };
type FieldKind = "string" | "uuid" | "digest" | "gitSha" | "timestamp" | "booleanFalse" | "stringArray" | "url" | "fqdn" | "integer" | "enum" | "endpointFingerprint";
type FieldSpec = { kind: FieldKind; enum?: Set<string>; optional?: boolean };
type RecordSpec = { detailKey: string; requiresProvider: boolean; identityFields: string[]; fields: Record<string, FieldSpec> };

const ROOT_KEYS = new Set(["schemaVersion", "inventoryId", "snapshotSequence", "generatedAt", "validFrom", "expiresAt", "policyRef", "dispositionRef", "collectorContractRef", "collectorArtifactDigest", "sourceSnapshotRefs", "records", "relationships", "evidence", "validationSummary", "documentDigest"]);
const ARTIFACT_KEYS = new Set(["path", "digest", "status"]);
const RECORD_KEYS = new Set(["recordId", "recordType", "inventoryKey", "inventoryRef", "recordRevision", "recordDigest", "workloadId", "environmentId", "ownerRef", "criticality", "lifecycle", "disposition", "authority", "evidenceRefs", "firstObservedAt", "lastObservedAt", "verifiedAt", "expiresAt", "provider", ...ALL_DETAIL_KEYS]);
const LIFECYCLE_KEYS = new Set(["state", "provisioningState", "releaseEligibility", "retirementEligibility", "stateObservedAt", "stateEvidenceRef"]);
const DISPOSITION_KEYS = new Set(["decision", "status", "decisionRef", "decidedAt", "decisionOwner"]);
const AUTHORITY_KEYS = new Set([...AUTHORITY_DIMENSIONS, "authorizationState"]);
const AUTHORITY_DIMENSION_KEYS = new Set(["verdict", "evidenceRefs", "observedAt", "verifiedAt", "expiresAt", "independentVerifierRef"]);
const PROVIDER_KEYS = new Set(["providerKind", "providerAccountId", "providerTenantId", "providerSubscriptionOrProjectId", "providerScopeId", "managementPlane", "authorityBoundary"]);
const RELATIONSHIP_KEYS = new Set(["relationshipId", "fromRecordId", "toRecordId", "relationshipType", "evidenceRefs"]);
const EVIDENCE_KEYS = new Set(["evidenceId", "evidenceType", "sourceAuthority", "sourceRecordId", "positiveFieldProjection", "collectorIdentityRef", "collectorVersionDigest", "collectedAt", "sourceObservedAt", "verifiedAt", "expiresAt", "sanitizationClass", "artifactRef", "artifactDigest", "freshnessStatus", "limitations"]);
const SUMMARY_KEYS = new Set(["completenessLedger", "blockerCodes", "validatedAt"]);
const COMPLETENESS_KEYS = new Set(["workloadClass", "status", "evidenceRefs", "blockingGaps", "policyStatus", "dispositionDecision", "authorityGate"]);

const COMMON_STRING: FieldSpec = { kind: "string" };
const RECORD_SPECS: Record<ExactTargetRecordType, RecordSpec> = {
  WORKLOAD: { detailKey: "workload", requiresProvider: false, identityFields: ["workloadId", "workloadClass"], fields: { workloadId: COMMON_STRING, workloadSlug: COMMON_STRING, workloadClass: { kind: "enum", enum: WORKLOAD_CLASS_SET }, businessRole: COMMON_STRING, customerAccountId: COMMON_STRING, customerDeploymentId: COMMON_STRING, workspaceId: COMMON_STRING, runtimeRoles: { kind: "stringArray" }, systemOfRecordRoles: { kind: "stringArray" }, dispositionRef: COMMON_STRING } },
  ENVIRONMENT: { detailKey: "environment", requiresProvider: false, identityFields: ["environmentId", "environmentClass"], fields: { environmentId: COMMON_STRING, environmentName: COMMON_STRING, environmentClass: { kind: "enum", enum: ENVIRONMENT_CLASSES }, isolationBoundary: COMMON_STRING, dataClass: { kind: "enum", enum: DATA_CLASSES }, ownerRef: COMMON_STRING, policyStatus: { kind: "enum", enum: POLICY_STATUSES } } },
  PROVIDER_RESOURCE: { detailKey: "resource", requiresProvider: true, identityFields: ["providerResourceId", "providerResourceType", "resourceRole", "deploymentOrRevisionId", "instanceId"], fields: { providerResourceId: COMMON_STRING, providerResourceType: COMMON_STRING, providerNativeName: COMMON_STRING, resourceRole: { kind: "enum", enum: RECORD_ROLES }, region: COMMON_STRING, parentResourceId: COMMON_STRING, deploymentOrRevisionId: COMMON_STRING, instanceId: COMMON_STRING, networkExposure: COMMON_STRING, canonicalOrigin: COMMON_STRING, providerState: COMMON_STRING } },
  DATA_STORE: { detailKey: "dataStore", requiresProvider: true, identityFields: ["providerResourceId", "databaseId", "role"], fields: { providerResourceId: COMMON_STRING, databaseId: COMMON_STRING, databaseName: COMMON_STRING, engine: COMMON_STRING, region: COMMON_STRING, workloadBinding: COMMON_STRING, role: { kind: "enum", enum: DATA_STORE_ROLES }, endpointFingerprint: { kind: "endpointFingerprint" }, schemaMigrationIdentityRefs: { kind: "stringArray" }, backupRefs: { kind: "stringArray" }, bindingEvidenceRef: COMMON_STRING } },
  OBJECT_STORE: { detailKey: "objectStore", requiresProvider: true, identityFields: ["providerResourceId", "namespace", "role"], fields: { providerResourceId: COMMON_STRING, namespace: COMMON_STRING, region: COMMON_STRING, workloadBinding: COMMON_STRING, role: { kind: "enum", enum: OBJECT_STORE_ROLES }, endpointFingerprint: { kind: "endpointFingerprint" }, versioningRetentionPolicyRef: COMMON_STRING, inventoryParityEvidenceRefs: { kind: "stringArray" }, backupRefs: { kind: "stringArray" } } },
  WORKER: { detailKey: "worker", requiresProvider: true, identityFields: ["providerAppId", "providerServiceId", "deploymentOrRevisionId", "processRole"], fields: { providerAppId: COMMON_STRING, providerServiceId: COMMON_STRING, deploymentOrRevisionId: COMMON_STRING, instanceIds: { kind: "stringArray" }, processRole: { kind: "enum", enum: RECORD_ROLES }, replicaState: COMMON_STRING, imageRef: COMMON_STRING, dataStoreRef: COMMON_STRING, queueRefs: { kind: "stringArray" }, schedulerRefs: { kind: "stringArray" }, bindingEvidenceRef: COMMON_STRING, concurrencyPolicyRef: COMMON_STRING, authorityVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  SCHEDULER: { detailKey: "scheduler", requiresProvider: true, identityFields: ["schedulerId", "scheduleIdentity"], fields: { schedulerId: COMMON_STRING, scheduleIdentity: COMMON_STRING, timezone: COMMON_STRING, enabledState: COMMON_STRING, enqueueTargetRefs: { kind: "stringArray" }, credentialRef: COMMON_STRING, lastObservedAt: { kind: "timestamp" }, authorityVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  QUEUE: { detailKey: "queue", requiresProvider: true, identityFields: ["queueId", "semantics"], fields: { queueId: COMMON_STRING, semantics: { kind: "enum", enum: QUEUE_SEMANTICS }, availabilityPolicyRef: COMMON_STRING, lockPolicyRef: COMMON_STRING, retryPolicyRef: COMMON_STRING, producerRefs: { kind: "stringArray" }, consumerRefs: { kind: "stringArray" }, schedulerRefs: { kind: "stringArray" }, authorityVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  DOMAIN: { detailKey: "domain", requiresProvider: true, identityFields: ["fqdn", "dnsRecordId"], fields: { fqdn: { kind: "fqdn" }, dnsZoneResourceId: COMMON_STRING, dnsRecordId: COMMON_STRING, recordType: COMMON_STRING, recordTarget: COMMON_STRING, certificateResourceId: COMMON_STRING, boundRuntimeResourceId: COMMON_STRING, canonicalPurpose: COMMON_STRING, authorityVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  CALLBACK: { detailKey: "callback", requiresProvider: true, identityFields: ["callbackId", "canonicalOrigin", "canonicalPath"], fields: { callbackId: COMMON_STRING, integrationProvider: COMMON_STRING, callbackKind: COMMON_STRING, canonicalUrl: { kind: "url" }, canonicalOrigin: COMMON_STRING, canonicalPath: COMMON_STRING, boundResourceRef: COMMON_STRING, credentialRef: COMMON_STRING, externalConfigurationEvidenceRef: COMMON_STRING, authorityVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  CREDENTIAL_REF: { detailKey: "credentialRef", requiresProvider: true, identityFields: ["secretProvider", "vaultOrProjectId", "secretObjectId"], fields: { secretProvider: COMMON_STRING, vaultOrProjectId: COMMON_STRING, secretObjectId: COMMON_STRING, versionSelectorPolicy: COMMON_STRING, consumerResourceRefs: { kind: "stringArray" }, purpose: COMMON_STRING, ownerRef: COMMON_STRING, rotationMetadataTimestamp: { kind: "timestamp" }, valueObserved: { kind: "booleanFalse" } } },
  IMAGE: { detailKey: "image", requiresProvider: true, identityFields: ["registryResourceId", "repository", "digest"], fields: { registryResourceId: COMMON_STRING, repository: COMMON_STRING, digestAlgorithm: COMMON_STRING, digest: { kind: "digest" }, imageRole: COMMON_STRING, sourceGitSha: { kind: "gitSha" }, buildProvenanceEvidenceRef: COMMON_STRING, consumingResourceRefs: { kind: "stringArray" } } },
  ROLLBACK_ASSET: { detailKey: "rollbackAsset", requiresProvider: true, identityFields: ["assetId", "assetType", "providerArtifactRef"], fields: { assetId: COMMON_STRING, assetType: COMMON_STRING, providerArtifactRef: COMMON_STRING, sourceSnapshotDigest: { kind: "digest" }, independenceBoundary: COMMON_STRING, createdAt: { kind: "timestamp" }, verifiedAt: { kind: "timestamp" }, restoreTestedAt: { kind: "timestamp" }, retainUntil: { kind: "timestamp" }, recoveryOwner: COMMON_STRING, readinessVerdict: { kind: "enum", enum: AUTHORITY_VERDICTS } } },
  GAP: { detailKey: "gap", requiresProvider: false, identityFields: ["gapId", "workloadClass", "missingField"], fields: { gapId: COMMON_STRING, workloadClass: { kind: "enum", enum: WORKLOAD_CLASS_SET }, missingField: COMMON_STRING, blockerCode: COMMON_STRING, description: COMMON_STRING } },
};

export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function deriveInventoryRef(inventoryKey: string) {
  return sha256Hex(inventoryKey);
}

export function deriveExactTargetInventoryKey(input: {
  recordType: ExactTargetRecordType;
  workloadId: string;
  environmentId: string;
  provider?: Provider | JsonObject;
  detail: JsonObject;
}): string | null {
  if (!RECORD_TYPE_SET.has(input.recordType)) return null;
  const recordType = input.recordType;
  const spec = RECORD_SPECS[recordType];
  const provider = input.provider;
  const providerTuple = provider
    ? [
        stringOrEmpty(provider.providerKind),
        stringOrEmpty(provider.providerAccountId),
        stringOrEmpty(provider.providerTenantId),
        stringOrEmpty(provider.providerSubscriptionOrProjectId),
        stringOrEmpty(provider.providerScopeId),
        stringOrEmpty(provider.managementPlane),
        stringOrEmpty(provider.authorityBoundary),
      ]
    : ["NO_PROVIDER"];
  const detailTuple = spec.identityFields.map((field) => [field, stringOrEmpty(input.detail[field])]);
  return canonicalJson([
    "exact-target-inventory/v1",
    recordType,
    input.workloadId,
    input.environmentId,
    providerTuple,
    detailTuple,
  ]);
}

export function validateExactTargetInventory(raw: unknown, options: ExactTargetInventoryValidationOptions): ExactTargetInventoryValidationResult {
  const now = parseNow(options);
  if (!now.ok) return invalid([{ code: "INVALID_TIMESTAMP", path: "/options/now" }]);

  const captured = capturePlainJson(raw);
  if (!captured.ok) return invalid(captured.issues);

  const ctx: ParseContext = { issues: [], nowMs: now.ms, nowIso: options.now };
  const parsed = parseSnapshot(captured.value, ctx);
  if (!parsed) return invalid(ctx.issues);

  const semanticIssues = [...ctx.issues];
  verifyDigestsAndGraph(parsed, semanticIssues, now.ms);
  const derived = deriveState(parsed, semanticIssues);
  reconcileRecordAuthorization(parsed.records, derived, semanticIssues);
  compareCallerSummary(parsed.validationSummary, derived, parsed.records, semanticIssues);
  const closedSnapshot = deepFreeze({ ...parsed, derived }) as ExactTargetInventorySnapshot;

  if (semanticIssues.length > 0) {
    return invalid(semanticIssues, closedSnapshot);
  }

  VALIDATED_SNAPSHOTS.add(closedSnapshot);
  return {
      ok: true,
      snapshot: closedSnapshot,
      canonicalJson: canonicalJson(snapshotForReplay(closedSnapshot)),
    documentDigest: closedSnapshot.documentDigest,
    publicProjection: projectPublicInventory(closedSnapshot, []),
    issues: [],
  };
}

export function selectExactTargetInventoryRecord(snapshot: ExactTargetInventorySnapshot, inventoryRef: string) {
  if (!VALIDATED_SNAPSHOTS.has(snapshot)) {
    throw new TypeError("Exact target inventory snapshot is not module-validated.");
  }
  if (!/^[a-f0-9]{64}$/.test(inventoryRef)) {
    return null;
  }
  const record = snapshot.records.find((candidate) => candidate.inventoryRef === inventoryRef) ?? null;
  if (!record) return null;
  if (snapshot.derived.authorizationState !== "INVENTORY_ONLY") return null;
  if ((snapshot.derived.recordBlockers[record.inventoryRef] ?? []).length > 0) return null;
  const workloadClass = workloadClassForRecord(snapshot, record);
  if (workloadClass === "UNKNOWN") return null;
  const completeness = snapshot.derived.completeness.find((row) => row.workloadClass === workloadClass);
  if (!completeness || completeness.status !== "COMPLETE") return null;
  return deepFreeze({
    inventoryRef: record.inventoryRef,
    recordType: record.recordType,
    workloadClass,
    blockerCodes: snapshot.derived.recordBlockers[record.inventoryRef] ?? [],
    record,
  });
}

export function projectPublicInventory(snapshot: ExactTargetInventorySnapshot | null, issues: ExactTargetInventoryIssue[]): ExactTargetInventoryPublicProjection {
  const blockerCodes = uniqueCodes(issues.map((issue) => issue.code));
  if (!snapshot) {
    return {
      schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
      authorizationState: "BLOCKED",
      records: [],
      completeness: [],
      blockerCodes,
    };
  }

  return {
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    documentDigest: snapshot.documentDigest,
    authorizationState: blockerCodes.length > 0 ? "BLOCKED" : snapshot.derived.authorizationState,
    records: snapshot.records.slice(0, MAX_ARRAY_ITEMS).map((record) => ({
      inventoryRef: record.inventoryRef,
      recordType: record.recordType,
      workloadClass: workloadClassForRecord(snapshot, record),
      blockerCodes: uniqueCodes([...(snapshot.derived.recordBlockers[record.inventoryRef] ?? []), ...issues.filter((issue) => issue.inventoryRef === record.inventoryRef).map((issue) => issue.code)]),
    })),
    completeness: snapshot.derived.completeness,
    blockerCodes: uniqueCodes([...snapshot.derived.blockerCodes, ...blockerCodes]),
  };
}

function parseNow(options: ExactTargetInventoryValidationOptions) {
  if (!options || typeof options.now !== "string") return { ok: false as const };
  const ms = parseTimestampMs(options.now);
  return ms === null ? { ok: false as const } : { ok: true as const, ms };
}

function capturePlainJson(raw: unknown): { ok: true; value: JsonObject } | { ok: false; issues: ExactTargetInventoryIssue[] } {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return { ok: false, issues: [{ code: "STRUCTURAL_LIMIT", path: "/" }] };
    const duplicatePath = findDuplicateJsonKey(raw);
    if (duplicatePath) return { ok: false, issues: [{ code: "DUPLICATE_JSON_KEY", path: "/" }] };
    try {
      return capturePlainJson(JSON.parse(raw));
    } catch {
      return { ok: false, issues: [{ code: "INVALID_JSON", path: "/" }] };
    }
  }

  const issues: ExactTargetInventoryIssue[] = [];
  let nodes = 0;
  const seen = new WeakSet<object>();
  const copy = copyJson(raw, "/", 0, seen, () => {
    nodes += 1;
    return nodes;
  }, issues);
  if (issues.length > 0 || !isPlainObject(copy)) return { ok: false, issues: issues.length > 0 ? capIssues(issues) : [{ code: "INVALID_JSON", path: "/" }] };
  return { ok: true, value: copy };
}

function copyJson(value: unknown, path: string, depth: number, seen: WeakSet<object>, nodeCount: () => number, issues: ExactTargetInventoryIssue[]): JsonValue | undefined {
  if (issues.length >= MAX_ISSUES) return undefined;
  if (depth > MAX_DEPTH || nodeCount() > MAX_NODES) {
    addIssue(issues, "STRUCTURAL_LIMIT", path);
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      addIssue(issues, "INVALID_VALUE", path);
      return undefined;
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH || /[\u0000-\u001f]/.test(value)) {
      addIssue(issues, "INVALID_VALUE", path);
      return undefined;
    }
    return value;
  }
  if (typeof value !== "object" || value === undefined) {
    addIssue(issues, "INVALID_JSON", path);
    return undefined;
  }
  if (seen.has(value)) {
    addIssue(issues, "STRUCTURAL_LIMIT", path);
    return undefined;
  }
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || value.length > MAX_ARRAY_ITEMS) {
        addIssue(issues, "STRUCTURAL_LIMIT", path);
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const expectedKeys = new Set<PropertyKey>(["length"]);
      for (let index = 0; index < value.length; index += 1) expectedKeys.add(String(index));
      for (const key of Reflect.ownKeys(value)) {
        if (!expectedKeys.has(key)) {
          addIssue(issues, "STRUCTURAL_LIMIT", path);
          return undefined;
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || "get" in descriptor || "set" in descriptor || descriptor.value === undefined) {
          addIssue(issues, "STRUCTURAL_LIMIT", `${path}/${index}`);
          return undefined;
        }
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        result.push(copyJson(descriptors[String(index)]!.value, `${path}/${index}`, depth + 1, seen, nodeCount, issues) ?? null);
      }
      return result;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      addIssue(issues, "STRUCTURAL_LIMIT", path);
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_KEYS || keys.some((key) => typeof key !== "string")) {
      addIssue(issues, "STRUCTURAL_LIMIT", path);
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as JsonObject;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || "get" in descriptor || "set" in descriptor || descriptor.value === undefined) {
        addIssue(issues, "STRUCTURAL_LIMIT", joinPath(path, key));
        continue;
      }
      Object.defineProperty(result, key, {
        value: copyJson(descriptor.value, joinPath(path, key), depth + 1, seen, nodeCount, issues) ?? null,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } catch {
    addIssue(issues, "STRUCTURAL_LIMIT", path);
    return undefined;
  }
}

function parseSnapshot(raw: JsonObject, ctx: ParseContext): Omit<ExactTargetInventorySnapshot, "derived"> | null {
  rejectUnknown(raw, ROOT_KEYS, "/", ctx.issues);
  const schemaVersion = requiredString(raw, "schemaVersion", "/", ctx);
  if (schemaVersion !== EXACT_TARGET_INVENTORY_SCHEMA_VERSION) addIssue(ctx.issues, "INVALID_VALUE", "/schemaVersion");
  const inventoryId = requiredUuid(raw, "inventoryId", "/", ctx);
  const snapshotSequence = requiredInteger(raw, "snapshotSequence", "/", ctx);
  const generatedAt = requiredTimestamp(raw, "generatedAt", "/", ctx);
  const validFrom = requiredTimestamp(raw, "validFrom", "/", ctx);
  const expiresAt = requiredTimestamp(raw, "expiresAt", "/", ctx);
  const policyRef = requiredArtifact(raw, "policyRef", "/", ctx);
  const dispositionRef = requiredArtifact(raw, "dispositionRef", "/", ctx);
  const collectorContractRef = requiredArtifact(raw, "collectorContractRef", "/", ctx);
  const collectorArtifactDigest = requiredDigest(raw, "collectorArtifactDigest", "/", ctx);
  const sourceSnapshotRefs = requiredStringArray(raw, "sourceSnapshotRefs", "/", ctx);
  const relationshipsRaw = requiredArray(raw, "relationships", "/", ctx);
  const evidenceRaw = requiredArray(raw, "evidence", "/", ctx);
  const recordsRaw = requiredArray(raw, "records", "/", ctx);
  const validationSummary = parseValidationSummary(requiredObject(raw, "validationSummary", "/", ctx), ctx);
  const documentDigest = requiredDigest(raw, "documentDigest", "/", ctx);

  if (ctx.issues.length > 0) return null;
  if (!inventoryId || !generatedAt || !validFrom || !expiresAt || !policyRef || !dispositionRef || !collectorContractRef || !collectorArtifactDigest || !documentDigest || snapshotSequence < 1) return null;
  if (!timeOrder([generatedAt, validFrom, ctx.nowIso, expiresAt])) addIssue(ctx.issues, "STALE_OR_EXPIRED", "/expiresAt");
  if (validationSummary.validatedAt && !timeOrder([generatedAt, validationSummary.validatedAt, ctx.nowIso])) addIssue(ctx.issues, "STALE_OR_EXPIRED", "/validationSummary/validatedAt");

  const records = recordsRaw.map((record, index) => parseRecord(record, `/records/${index}`, ctx)).filter((record): record is ExactTargetRecord => record !== null);
  const relationships = relationshipsRaw.map((relationship, index) => parseRelationship(relationship, `/relationships/${index}`, ctx)).filter((relationship): relationship is ExactTargetRelationship => relationship !== null);
  const evidence = evidenceRaw.map((item, index) => parseEvidence(item, `/evidence/${index}`, ctx)).filter((item): item is ExactTargetEvidence => item !== null);
  if (ctx.issues.length > 0) return null;

  return {
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    inventoryId,
    snapshotSequence,
    generatedAt,
    validFrom,
    expiresAt,
    policyRef,
    dispositionRef,
    collectorContractRef,
    collectorArtifactDigest,
    sourceSnapshotRefs,
    records,
    relationships,
    evidence,
    validationSummary,
    documentDigest,
  };
}

function parseRecord(value: JsonValue, path: string, ctx: ParseContext): ExactTargetRecord | null {
  if (!isPlainObject(value)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", path);
    return null;
  }
  rejectUnknown(value, RECORD_KEYS, path, ctx.issues);
  const recordType = requiredEnum(value, "recordType", RECORD_TYPE_SET, path, ctx) as ExactTargetRecordType | undefined;
  if (!recordType) return null;
  const spec = RECORD_SPECS[recordType];
  const detailKey = spec.detailKey;
  for (const alternateKey of ALL_DETAIL_KEYS) {
    if (alternateKey !== detailKey && Object.hasOwn(value, alternateKey)) addIssue(ctx.issues, "UNKNOWN_FIELD", `${path}/${alternateKey}`);
  }

  const recordId = requiredUuid(value, "recordId", path, ctx);
  const recordRevision = requiredInteger(value, "recordRevision", path, ctx);
  const workloadId = requiredString(value, "workloadId", path, ctx);
  const environmentId = requiredString(value, "environmentId", path, ctx);
  const ownerRef = requiredString(value, "ownerRef", path, ctx);
  const criticality = requiredString(value, "criticality", path, ctx);
  const evidenceRefs = requiredStringArray(value, "evidenceRefs", path, ctx);
  const firstObservedAt = requiredTimestamp(value, "firstObservedAt", path, ctx);
  const lastObservedAt = requiredTimestamp(value, "lastObservedAt", path, ctx);
  const verifiedAt = requiredTimestamp(value, "verifiedAt", path, ctx);
  const expiresAt = requiredTimestamp(value, "expiresAt", path, ctx);
  const lifecycle = parseLifecycle(requiredObject(value, "lifecycle", path, ctx), `${path}/lifecycle`, ctx);
  const disposition = parseDisposition(requiredObject(value, "disposition", path, ctx), `${path}/disposition`, ctx);
  const authority = parseAuthority(requiredObject(value, "authority", path, ctx), `${path}/authority`, ctx);
  const provider = Object.hasOwn(value, "provider") ? parseProvider(requiredObject(value, "provider", path, ctx), `${path}/provider`, ctx) : undefined;
  const detail = parseDetail(recordType, requiredObject(value, detailKey, path, ctx), `${path}/${detailKey}`, ctx);
  const inventoryKey = requiredLooseString(value, "inventoryKey", path, ctx);
  const inventoryRef = requiredDigest(value, "inventoryRef", path, ctx);
  const recordDigest = requiredDigest(value, "recordDigest", path, ctx);

  if (spec.requiresProvider && !provider) addIssue(ctx.issues, "REQUIRED_FIELD", `${path}/provider`);
  if (!spec.requiresProvider && provider) addIssue(ctx.issues, "UNKNOWN_FIELD", `${path}/provider`);
  if (!timeOrder([firstObservedAt, lastObservedAt, verifiedAt, ctx.nowIso, expiresAt])) addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/expiresAt`, inventoryRef);
  if (lifecycle && !timeOrder([lifecycle.stateObservedAt, verifiedAt, ctx.nowIso])) addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/lifecycle/stateObservedAt`, inventoryRef);
  if (disposition && !timeOrder([disposition.decidedAt, verifiedAt, ctx.nowIso])) addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/disposition/decidedAt`, inventoryRef);

  if (!recordId || !workloadId || !environmentId || !ownerRef || !criticality || !firstObservedAt || !lastObservedAt || !verifiedAt || !expiresAt || !lifecycle || !disposition || !authority || !detail || !inventoryKey || !inventoryRef || !recordDigest) return null;
  validateRootDetailIdentity(recordType, workloadId, environmentId, detail, path, ctx, inventoryRef);
  const derivedKey = deriveExactTargetInventoryKey({ recordType, workloadId, environmentId, provider, detail });
  if (!derivedKey || inventoryKey !== derivedKey) addIssue(ctx.issues, "DERIVED_REF_MISMATCH", `${path}/inventoryKey`, inventoryRef);
  if (!derivedKey || inventoryRef !== deriveInventoryRef(derivedKey)) addIssue(ctx.issues, "DERIVED_REF_MISMATCH", `${path}/inventoryRef`, inventoryRef);

  return { recordId, recordType, inventoryKey, inventoryRef, recordRevision, recordDigest, workloadId, environmentId, ownerRef, criticality, lifecycle, disposition, authority, evidenceRefs, firstObservedAt, lastObservedAt, verifiedAt, expiresAt, provider, detailKey, detail };
}

function parseLifecycle(value: JsonObject | null, path: string, ctx: ParseContext): Lifecycle | null {
  if (!value) return null;
  rejectUnknown(value, LIFECYCLE_KEYS, path, ctx.issues);
  const state = requiredEnum(value, "state", LIFECYCLE_STATES, path, ctx);
  const provisioningState = requiredString(value, "provisioningState", path, ctx);
  const releaseEligibility = requiredEnum(value, "releaseEligibility", RELEASE_ELIGIBILITY, path, ctx);
  const retirementEligibility = requiredString(value, "retirementEligibility", path, ctx);
  const stateObservedAt = requiredTimestamp(value, "stateObservedAt", path, ctx);
  const stateEvidenceRef = requiredString(value, "stateEvidenceRef", path, ctx);
  if (retirementEligibility !== "BLOCKED") addIssue(ctx.issues, "RETIREMENT_NOT_BLOCKED", `${path}/retirementEligibility`);
  if (!state || !provisioningState || !releaseEligibility || retirementEligibility !== "BLOCKED" || !stateObservedAt || !stateEvidenceRef) return null;
  return { state, provisioningState, releaseEligibility, retirementEligibility: "BLOCKED", stateObservedAt, stateEvidenceRef };
}

function parseDisposition(value: JsonObject | null, path: string, ctx: ParseContext): Disposition | null {
  if (!value) return null;
  rejectUnknown(value, DISPOSITION_KEYS, path, ctx.issues);
  const decision = requiredEnum(value, "decision", DISPOSITION_DECISIONS, path, ctx);
  const status = requiredEnum(value, "status", DISPOSITION_STATUSES, path, ctx);
  const decisionRef = requiredString(value, "decisionRef", path, ctx);
  const decidedAt = requiredTimestamp(value, "decidedAt", path, ctx);
  const decisionOwner = requiredString(value, "decisionOwner", path, ctx);
  return decision && status && decisionRef && decidedAt && decisionOwner ? { decision, status, decisionRef, decidedAt, decisionOwner } : null;
}

function parseAuthority(value: JsonObject | null, path: string, ctx: ParseContext): Authority | null {
  if (!value) return null;
  rejectUnknown(value, AUTHORITY_KEYS, path, ctx.issues);
  const authorizationState = requiredString(value, "authorizationState", path, ctx);
  if (authorizationState !== "INVENTORY_ONLY" && authorizationState !== "BLOCKED") addIssue(ctx.issues, "INVALID_VALUE", `${path}/authorizationState`);
  const dimensions: Partial<Record<typeof AUTHORITY_DIMENSIONS[number], AuthorityDimension>> = {};
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const parsed = parseAuthorityDimension(requiredObject(value, dimension, path, ctx), `${path}/${dimension}`, ctx);
    if (parsed) dimensions[dimension] = parsed;
  }
  if (AUTHORITY_DIMENSIONS.some((dimension) => !dimensions[dimension])) return null;
  return { authorizationState: authorizationState === "INVENTORY_ONLY" ? "INVENTORY_ONLY" : "BLOCKED", ...(dimensions as Record<typeof AUTHORITY_DIMENSIONS[number], AuthorityDimension>) };
}

function parseAuthorityDimension(value: JsonObject | null, path: string, ctx: ParseContext): AuthorityDimension | null {
  if (!value) return null;
  rejectUnknown(value, AUTHORITY_DIMENSION_KEYS, path, ctx.issues);
  const verdict = requiredEnum(value, "verdict", AUTHORITY_VERDICTS, path, ctx);
  const evidenceRefs = requiredStringArray(value, "evidenceRefs", path, ctx);
  const observedAt = requiredTimestamp(value, "observedAt", path, ctx);
  const verifiedAt = requiredTimestamp(value, "verifiedAt", path, ctx);
  const expiresAt = requiredTimestamp(value, "expiresAt", path, ctx);
  const independentVerifierRef = requiredString(value, "independentVerifierRef", path, ctx);
  if (!timeOrder([observedAt, verifiedAt, ctx.nowIso, expiresAt])) addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/expiresAt`);
  if (verdict === "PROVEN" && evidenceRefs.length === 0) addIssue(ctx.issues, "INVALID_REFERENCE", `${path}/evidenceRefs`);
  return verdict && observedAt && verifiedAt && expiresAt && independentVerifierRef ? { verdict, evidenceRefs, observedAt, verifiedAt, expiresAt, independentVerifierRef } : null;
}

function parseProvider(value: JsonObject | null, path: string, ctx: ParseContext): Provider | undefined {
  if (!value) return undefined;
  rejectUnknown(value, PROVIDER_KEYS, path, ctx.issues);
  const providerKind = requiredEnum(value, "providerKind", PROVIDER_KINDS, path, ctx);
  const providerAccountId = requiredString(value, "providerAccountId", path, ctx);
  const providerTenantId = optionalString(value, "providerTenantId", path, ctx);
  const providerSubscriptionOrProjectId = optionalString(value, "providerSubscriptionOrProjectId", path, ctx);
  const providerScopeId = requiredString(value, "providerScopeId", path, ctx);
  const managementPlane = requiredString(value, "managementPlane", path, ctx);
  const authorityBoundary = requiredString(value, "authorityBoundary", path, ctx);
  if (!providerKind || !providerAccountId || !providerScopeId || !managementPlane || !authorityBoundary) return undefined;
  const provider: Mutable<Provider> = { providerKind, providerAccountId, providerScopeId, managementPlane, authorityBoundary };
  if (providerTenantId !== undefined) provider.providerTenantId = providerTenantId;
  if (providerSubscriptionOrProjectId !== undefined) provider.providerSubscriptionOrProjectId = providerSubscriptionOrProjectId;
  return provider;
}

function parseDetail(recordType: ExactTargetRecordType, value: JsonObject | null, path: string, ctx: ParseContext): JsonObject | null {
  if (!value) return null;
  const spec = RECORD_SPECS[recordType];
  const allowed = new Set(Object.keys(spec.fields));
  rejectUnknown(value, allowed, path, ctx.issues);
  const detail: JsonObject = {};
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    const parsed = parseField(value, field, fieldSpec, path, ctx);
    if (parsed !== undefined) detail[field] = parsed as JsonValue;
  }
  if (Object.keys(detail).length !== Object.keys(spec.fields).length) return null;
  if (recordType === "WORKLOAD" && detail.workloadId !== undefined && detail.workloadId !== undefined && typeof detail.workloadId === "string" && typeof detail.workloadClass === "string" && !WORKLOAD_CLASS_SET.has(detail.workloadClass)) addIssue(ctx.issues, "INVALID_VALUE", `${path}/workloadClass`);
  if (recordType === "ENVIRONMENT" && typeof detail.environmentId === "string" && detail.environmentId.length === 0) addIssue(ctx.issues, "REQUIRED_FIELD", `${path}/environmentId`);
  if (recordType === "IMAGE" && detail.digestAlgorithm !== "sha256") addIssue(ctx.issues, "INVALID_VALUE", `${path}/digestAlgorithm`);
  if (recordType === "CALLBACK") validateCallbackDetail(detail, path, ctx);
  if (recordType === "ROLLBACK_ASSET") validateRollbackDetail(detail, path, ctx);
  return detail;
}

function parseField(value: JsonObject, field: string, spec: FieldSpec, path: string, ctx: ParseContext): JsonValue | undefined {
  if (!Object.hasOwn(value, field)) {
    if (!spec.optional) addIssue(ctx.issues, "REQUIRED_FIELD", `${path}/${field}`);
    return undefined;
  }
  if (spec.kind === "string") return requiredString(value, field, path, ctx);
  if (spec.kind === "uuid") return requiredUuid(value, field, path, ctx);
  if (spec.kind === "digest") return requiredDigest(value, field, path, ctx);
  if (spec.kind === "gitSha") return requiredGitSha(value, field, path, ctx);
  if (spec.kind === "timestamp") return requiredTimestamp(value, field, path, ctx);
  if (spec.kind === "integer") return requiredInteger(value, field, path, ctx);
  if (spec.kind === "stringArray") return requiredStringArray(value, field, path, ctx);
  if (spec.kind === "enum") return requiredEnum(value, field, spec.enum ?? new Set(), path, ctx);
  if (spec.kind === "booleanFalse") {
    if (value[field] !== false) addIssue(ctx.issues, "SECRET_SENTINEL", `${path}/${field}`);
    return value[field] === false ? false : undefined;
  }
  if (spec.kind === "endpointFingerprint") return requiredEndpointFingerprint(value, field, path, ctx);
  if (spec.kind === "fqdn") return requiredFqdn(value, field, path, ctx);
  if (spec.kind === "url") return requiredUrl(value, field, path, ctx);
  return undefined;
}

function validateRootDetailIdentity(recordType: ExactTargetRecordType, workloadId: string, environmentId: string, detail: JsonObject, path: string, ctx: ParseContext, inventoryRef: string) {
  if (recordType === "WORKLOAD" && detail.workloadId !== workloadId) addIssue(ctx.issues, "DERIVED_REF_MISMATCH", `${path}/workload/workloadId`, inventoryRef);
  if (recordType === "ENVIRONMENT" && detail.environmentId !== environmentId) addIssue(ctx.issues, "DERIVED_REF_MISMATCH", `${path}/environment/environmentId`, inventoryRef);
}

function validateRollbackDetail(detail: JsonObject, path: string, ctx: ParseContext) {
  const createdAt = typeof detail.createdAt === "string" ? parseTimestampMs(detail.createdAt) : null;
  const verifiedAt = typeof detail.verifiedAt === "string" ? parseTimestampMs(detail.verifiedAt) : null;
  const restoreTestedAt = typeof detail.restoreTestedAt === "string" ? parseTimestampMs(detail.restoreTestedAt) : null;
  const retainUntil = typeof detail.retainUntil === "string" ? parseTimestampMs(detail.retainUntil) : null;
  if (createdAt === null || verifiedAt === null || restoreTestedAt === null || retainUntil === null) return;
  if (createdAt > verifiedAt || verifiedAt > restoreTestedAt || restoreTestedAt > ctx.nowMs || ctx.nowMs >= retainUntil) {
    addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/retainUntil`);
  }
}

function validateCallbackDetail(detail: JsonObject, path: string, ctx: ParseContext) {
  if (typeof detail.canonicalUrl !== "string" || typeof detail.canonicalOrigin !== "string" || typeof detail.canonicalPath !== "string") return;
  try {
    const url = new URL(detail.canonicalUrl);
    if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" || url.origin !== detail.canonicalOrigin || url.pathname !== detail.canonicalPath) {
      addIssue(ctx.issues, "SECRET_SENTINEL", `${path}/canonicalUrl`);
    }
  } catch {
    addIssue(ctx.issues, "INVALID_VALUE", `${path}/canonicalUrl`);
  }
}

function parseRelationship(value: JsonValue, path: string, ctx: ParseContext): ExactTargetRelationship | null {
  if (!isPlainObject(value)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", path);
    return null;
  }
  rejectUnknown(value, RELATIONSHIP_KEYS, path, ctx.issues);
  const relationshipId = requiredString(value, "relationshipId", path, ctx);
  const fromRecordId = requiredUuid(value, "fromRecordId", path, ctx);
  const toRecordId = requiredUuid(value, "toRecordId", path, ctx);
  const relationshipType = requiredString(value, "relationshipType", path, ctx);
  const evidenceRefs = requiredStringArray(value, "evidenceRefs", path, ctx);
  return relationshipId && fromRecordId && toRecordId && relationshipType ? { relationshipId, fromRecordId, toRecordId, relationshipType, evidenceRefs } : null;
}

function parseEvidence(value: JsonValue, path: string, ctx: ParseContext): ExactTargetEvidence | null {
  if (!isPlainObject(value)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", path);
    return null;
  }
  rejectUnknown(value, EVIDENCE_KEYS, path, ctx.issues);
  const evidenceId = requiredString(value, "evidenceId", path, ctx);
  const evidenceType = requiredString(value, "evidenceType", path, ctx);
  const sourceAuthority = requiredString(value, "sourceAuthority", path, ctx);
  const sourceRecordId = requiredUuid(value, "sourceRecordId", path, ctx);
  const positiveFieldProjection = requiredStringArray(value, "positiveFieldProjection", path, ctx);
  const collectorIdentityRef = requiredString(value, "collectorIdentityRef", path, ctx);
  const collectorVersionDigest = requiredDigest(value, "collectorVersionDigest", path, ctx);
  const collectedAt = requiredTimestamp(value, "collectedAt", path, ctx);
  const sourceObservedAt = requiredTimestamp(value, "sourceObservedAt", path, ctx);
  const verifiedAt = requiredTimestamp(value, "verifiedAt", path, ctx);
  const expiresAt = requiredTimestamp(value, "expiresAt", path, ctx);
  const sanitizationClass = requiredString(value, "sanitizationClass", path, ctx);
  const artifactRef = requiredArtifact(value, "artifactRef", path, ctx);
  const artifactDigest = requiredDigest(value, "artifactDigest", path, ctx);
  const freshnessStatus = requiredEnum(value, "freshnessStatus", EVIDENCE_FRESHNESS, path, ctx);
  const limitations = requiredStringArray(value, "limitations", path, ctx);
  if (!timeOrder([sourceObservedAt, collectedAt, verifiedAt, ctx.nowIso, expiresAt])) addIssue(ctx.issues, "STALE_OR_EXPIRED", `${path}/expiresAt`);
  if (artifactRef && artifactDigest && artifactRef.digest !== artifactDigest) addIssue(ctx.issues, "DERIVED_DIGEST_MISMATCH", `${path}/artifactDigest`);
  return evidenceId && evidenceType && sourceAuthority && sourceRecordId && collectorIdentityRef && collectorVersionDigest && collectedAt && sourceObservedAt && verifiedAt && expiresAt && sanitizationClass && artifactRef && artifactDigest && freshnessStatus ? { evidenceId, evidenceType, sourceAuthority, sourceRecordId, positiveFieldProjection, collectorIdentityRef, collectorVersionDigest, collectedAt, sourceObservedAt, verifiedAt, expiresAt, sanitizationClass, artifactRef, artifactDigest, freshnessStatus, limitations } : null;
}

function parseValidationSummary(value: JsonObject | null, ctx: ParseContext): ExactTargetValidationSummary {
  if (!value) return { completenessLedger: [], blockerCodes: [], validatedAt: "" };
  rejectUnknown(value, SUMMARY_KEYS, "/validationSummary", ctx.issues);
  const rowsRaw = requiredArray(value, "completenessLedger", "/validationSummary", ctx);
  const blockerCodes = requiredStringArray(value, "blockerCodes", "/validationSummary", ctx);
  const validatedAt = requiredTimestamp(value, "validatedAt", "/validationSummary", ctx);
  const completenessLedger = rowsRaw.map((row, index) => {
    const path = `/validationSummary/completenessLedger/${index}`;
    if (!isPlainObject(row)) {
      addIssue(ctx.issues, "REQUIRED_FIELD", path);
      return null;
    }
    rejectUnknown(row, COMPLETENESS_KEYS, path, ctx.issues);
    const workloadClass = requiredEnum(row, "workloadClass", WORKLOAD_CLASS_SET, path, ctx) as ExactTargetWorkloadClass | undefined;
    const status = requiredString(row, "status", path, ctx);
    const evidenceRefs = requiredStringArray(row, "evidenceRefs", path, ctx);
    const blockingGaps = requiredStringArray(row, "blockingGaps", path, ctx);
    const policyStatus = requiredString(row, "policyStatus", path, ctx);
    const dispositionDecision = requiredEnum(row, "dispositionDecision", DISPOSITION_DECISIONS, path, ctx);
    const authorityGate = requiredString(row, "authorityGate", path, ctx);
    return workloadClass && status && policyStatus && dispositionDecision && authorityGate ? { workloadClass, status, evidenceRefs, blockingGaps, policyStatus, dispositionDecision, authorityGate } : null;
  }).filter((row): row is ExactTargetValidationSummary["completenessLedger"][number] => row !== null);
  return { completenessLedger, blockerCodes, validatedAt: validatedAt ?? "" };
}

function verifyDigestsAndGraph(snapshot: Omit<ExactTargetInventorySnapshot, "derived">, issues: ExactTargetInventoryIssue[], nowMs: number) {
  const recordsById = new Map(snapshot.records.map((record) => [record.recordId, record]));
  const recordsByRef = new Map(snapshot.records.map((record) => [record.inventoryRef, record]));
  const evidenceById = new Map(snapshot.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  uniqueBy(snapshot.records, (record) => record.recordId, "/records/recordId", issues);
  uniqueBy(snapshot.records, (record) => record.inventoryKey, "/records/inventoryKey", issues);
  uniqueBy(snapshot.records, (record) => record.inventoryRef, "/records/inventoryRef", issues);
  uniqueBy(snapshot.records, (record) => `${record.recordType}|${record.workloadId}|${record.environmentId}|${canonicalJson(record.detail)}`, "/records/detailIdentity", issues);
  uniqueBy(snapshot.relationships, (relationship) => relationship.relationshipId, "/relationships/relationshipId", issues);
  uniqueBy(snapshot.evidence, (evidence) => evidence.evidenceId, "/evidence/evidenceId", issues);

  for (const record of snapshot.records) {
    const normalized = recordForDigest(record);
    if (record.recordDigest !== sha256Hex(canonicalJson(normalized))) addIssue(issues, "DERIVED_DIGEST_MISMATCH", "/records/recordDigest", record.inventoryRef);
    for (const evidenceRef of record.evidenceRefs) validateEvidenceForRecord(evidenceRef, record, recordsById, evidenceById, "/records/evidenceRefs", issues);
    validateEvidenceForRecord(record.lifecycle.stateEvidenceRef, record, recordsById, evidenceById, "/records/lifecycle/stateEvidenceRef", issues);
    for (const dimension of AUTHORITY_DIMENSIONS) {
      for (const evidenceRef of record.authority[dimension].evidenceRefs) validateEvidenceForRecord(evidenceRef, record, recordsById, evidenceById, `/records/authority/${dimension}/evidenceRefs`, issues);
    }
    validateDetailReferences(record, recordsByRef, recordsById, evidenceById, issues);
  }

  for (const relationship of snapshot.relationships) {
    const from = recordsById.get(relationship.fromRecordId);
    const to = recordsById.get(relationship.toRecordId);
    if (!from || !to) addIssue(issues, "INVALID_REFERENCE", "/relationships");
    if (from && to && (from.workloadId !== to.workloadId || from.environmentId !== to.environmentId)) addIssue(issues, "INVALID_REFERENCE", "/relationships/target");
    for (const evidenceRef of relationship.evidenceRefs) {
      if (from) validateEvidenceForRecord(evidenceRef, from, recordsById, evidenceById, "/relationships/evidenceRefs", issues);
      else if (!evidenceById.has(evidenceRef)) addIssue(issues, "INVALID_REFERENCE", "/relationships/evidenceRefs");
    }
  }

  for (const evidence of snapshot.evidence) {
    if (!recordsById.has(evidence.sourceRecordId)) addIssue(issues, "INVALID_REFERENCE", "/evidence/sourceRecordId");
    if (evidence.freshnessStatus !== "CURRENT" && evidence.freshnessStatus !== "POLICY_PENDING") addIssue(issues, "STALE_OR_EXPIRED", "/evidence/freshnessStatus");
    if (parseTimestampMs(evidence.expiresAt)! <= nowMs) addIssue(issues, "STALE_OR_EXPIRED", "/evidence/expiresAt");
  }

  validateCompletenessEvidence(snapshot, recordsById, evidenceById, issues);

  const actualDocumentDigest = sha256Hex(canonicalJson(snapshotForDigest(snapshot)));
  if (snapshot.documentDigest !== actualDocumentDigest) addIssue(issues, "DERIVED_DIGEST_MISMATCH", "/documentDigest");
}

function validateEvidenceForRecord(evidenceRef: string, record: ExactTargetRecord, recordsById: Map<string, ExactTargetRecord>, evidenceById: Map<string, ExactTargetEvidence>, path: string, issues: ExactTargetInventoryIssue[]) {
  const evidence = evidenceById.get(evidenceRef);
  const source = evidence ? recordsById.get(evidence.sourceRecordId) : undefined;
  if (!evidence || !source || source.workloadId !== record.workloadId || source.environmentId !== record.environmentId) {
    addIssue(issues, "INVALID_REFERENCE", path, record.inventoryRef);
  }
}

function validateCompletenessEvidence(snapshot: Omit<ExactTargetInventorySnapshot, "derived">, recordsById: Map<string, ExactTargetRecord>, evidenceById: Map<string, ExactTargetEvidence>, issues: ExactTargetInventoryIssue[]) {
  const seenClasses = new Set<ExactTargetWorkloadClass>();
  for (const row of snapshot.validationSummary.completenessLedger) {
    if (seenClasses.has(row.workloadClass)) addIssue(issues, "DUPLICATE_IDENTITY", "/validationSummary/completenessLedger/workloadClass");
    seenClasses.add(row.workloadClass);
    if (row.evidenceRefs.length === 0) addIssue(issues, "INVALID_REFERENCE", "/validationSummary/completenessLedger/evidenceRefs");
    for (const evidenceRef of row.evidenceRefs) {
      const evidence = evidenceById.get(evidenceRef);
      const source = evidence ? recordsById.get(evidence.sourceRecordId) : undefined;
      if (!source || workloadClassForRecordFromRecords(snapshot.records, source) !== row.workloadClass) {
        addIssue(issues, "INVALID_REFERENCE", "/validationSummary/completenessLedger/evidenceRefs");
      }
    }
  }
  for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) {
    if (!seenClasses.has(workloadClass)) addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/completenessLedger");
  }
}

function validateDetailReferences(record: ExactTargetRecord, recordsByRef: Map<string, ExactTargetRecord>, recordsById: Map<string, ExactTargetRecord>, evidenceById: Map<string, ExactTargetEvidence>, issues: ExactTargetInventoryIssue[]) {
  const refKind = (ref: JsonValue | undefined, expected: ExactTargetRecordType, path: string) => {
    if (typeof ref !== "string") return;
    const target = recordsByRef.get(ref);
    if (!target || target.recordType !== expected || target.workloadId !== record.workloadId || target.environmentId !== record.environmentId) addIssue(issues, "INVALID_REFERENCE", path, record.inventoryRef);
  };
  const refsKind = (refs: JsonValue | undefined, expected: ExactTargetRecordType, path: string) => {
    if (!Array.isArray(refs)) return;
    for (const ref of refs) refKind(ref, expected, path);
  };
  const evidenceRef = (ref: JsonValue | undefined, path: string) => {
    if (typeof ref === "string") validateEvidenceForRecord(ref, record, recordsById, evidenceById, path, issues);
  };
  const refAllowedKinds = (ref: JsonValue | undefined, allowed: Set<ExactTargetRecordType>, path: string) => {
    if (typeof ref !== "string") return;
    const target = recordsByRef.get(ref);
    if (!target || !allowed.has(target.recordType) || target.workloadId !== record.workloadId || target.environmentId !== record.environmentId) addIssue(issues, "INVALID_REFERENCE", path, record.inventoryRef);
  };
  const d = record.detail;
  if (record.recordType === "WORKER") {
    refKind(d.imageRef, "IMAGE", "/worker/imageRef");
    refKind(d.dataStoreRef, "DATA_STORE", "/worker/dataStoreRef");
    refsKind(d.queueRefs, "QUEUE", "/worker/queueRefs");
    refsKind(d.schedulerRefs, "SCHEDULER", "/worker/schedulerRefs");
    evidenceRef(d.bindingEvidenceRef, "/worker/bindingEvidenceRef");
  } else if (record.recordType === "SCHEDULER") {
    refsKind(d.enqueueTargetRefs, "QUEUE", "/scheduler/enqueueTargetRefs");
    refKind(d.credentialRef, "CREDENTIAL_REF", "/scheduler/credentialRef");
  } else if (record.recordType === "QUEUE") {
    refsKind(d.producerRefs, "WORKER", "/queue/producerRefs");
    refsKind(d.consumerRefs, "WORKER", "/queue/consumerRefs");
    refsKind(d.schedulerRefs, "SCHEDULER", "/queue/schedulerRefs");
  } else if (record.recordType === "DOMAIN") {
    refKind(d.boundRuntimeResourceId, "PROVIDER_RESOURCE", "/domain/boundRuntimeResourceId");
  } else if (record.recordType === "CALLBACK") {
    refKind(d.boundResourceRef, "PROVIDER_RESOURCE", "/callback/boundResourceRef");
    refKind(d.credentialRef, "CREDENTIAL_REF", "/callback/credentialRef");
    evidenceRef(d.externalConfigurationEvidenceRef, "/callback/externalConfigurationEvidenceRef");
  } else if (record.recordType === "CREDENTIAL_REF") {
    if (Array.isArray(d.consumerResourceRefs)) {
      for (const ref of d.consumerResourceRefs) {
        refAllowedKinds(ref, CREDENTIAL_CONSUMER_TYPES, "/credentialRef/consumerResourceRefs");
      }
    }
  } else if (record.recordType === "IMAGE") {
    evidenceRef(d.buildProvenanceEvidenceRef, "/image/buildProvenanceEvidenceRef");
    if (Array.isArray(d.consumingResourceRefs)) {
      for (const ref of d.consumingResourceRefs) {
        refAllowedKinds(ref, IMAGE_CONSUMER_TYPES, "/image/consumingResourceRefs");
      }
    }
  } else if (record.recordType === "DATA_STORE") {
    evidenceRef(d.bindingEvidenceRef, "/dataStore/bindingEvidenceRef");
  } else if (record.recordType === "OBJECT_STORE") {
    if (Array.isArray(d.inventoryParityEvidenceRefs)) for (const ref of d.inventoryParityEvidenceRefs) evidenceRef(ref, "/objectStore/inventoryParityEvidenceRefs");
  }
}

function deriveState(snapshot: Omit<ExactTargetInventorySnapshot, "derived">, existingIssues: ExactTargetInventoryIssue[]): ExactTargetDerivedState {
  const records = snapshot.records;
  const evidenceById = new Map(snapshot.evidence.map((evidence) => [evidence.evidenceId, evidence]));
  const recordBlockers: Record<string, ExactTargetInventoryBlockerCode[]> = {};
  for (const issue of existingIssues) {
    if (issue.inventoryRef) recordBlockers[issue.inventoryRef] = uniqueCodes([...(recordBlockers[issue.inventoryRef] ?? []), issue.code]);
  }
  const blockerCodes: ExactTargetInventoryBlockerCode[] = existingIssues.map((issue) => issue.code);
  const completeness = EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => {
    const classRecords = records.filter((record) => workloadClassForRecordFromRecords(records, record) === workloadClass);
    const classBlockers: ExactTargetInventoryBlockerCode[] = [];
    const workloads = classRecords.filter((record) => record.recordType === "WORKLOAD");
    const environments = classRecords.filter((record) => record.recordType === "ENVIRONMENT");
    const gaps = classRecords.filter((record) => record.recordType === "GAP");
    if (snapshot.policyRef.status !== "SETTLED" || snapshot.dispositionRef.status !== "SETTLED" || snapshot.collectorContractRef.status !== "SETTLED") classBlockers.push("POLICY_PENDING");
    if (workloads.length !== 1 || environments.length < 1) classBlockers.push("MISSING_WORKLOAD_COVERAGE");
    if (gaps.length > 0) classBlockers.push("MISSING_WORKLOAD_COVERAGE");
    for (const record of classRecords) {
      const blockers = blockersForRecord(record, workloadClass, evidenceById);
      if (blockers.length > 0) recordBlockers[record.inventoryRef] = uniqueCodes([...(recordBlockers[record.inventoryRef] ?? []), ...blockers]);
      classBlockers.push(...blockers);
    }
    blockerCodes.push(...classBlockers);
    return { workloadClass, status: classBlockers.length > 0 ? "BLOCKED" as const : "COMPLETE" as const, blockerCodes: uniqueCodes(classBlockers) };
  });
  return {
    authorizationState: blockerCodes.length > 0 || completeness.some((row) => row.status === "BLOCKED") ? "BLOCKED" : "INVENTORY_ONLY",
    completeness,
    blockerCodes: uniqueCodes(blockerCodes),
    recordBlockers,
  };
}

function blockersForRecord(record: ExactTargetRecord, workloadClass: ExactTargetWorkloadClass | "UNKNOWN", evidenceById: Map<string, ExactTargetEvidence>): ExactTargetInventoryBlockerCode[] {
  const blockers: ExactTargetInventoryBlockerCode[] = [];
  if (record.lifecycle.retirementEligibility !== "BLOCKED") blockers.push("RETIREMENT_NOT_BLOCKED");
  if (record.lifecycle.releaseEligibility === "INELIGIBLE" || record.lifecycle.state === "RETIRED") blockers.push("LIFECYCLE_NOT_SELECTABLE");
  if (record.lifecycle.releaseEligibility === "POLICY_PENDING" || record.lifecycle.releaseEligibility === "UNKNOWN" || record.lifecycle.state === "UNKNOWN") blockers.push("POLICY_PENDING");
  if (BLOCKING_DISPOSITIONS.has(record.disposition.status) || record.disposition.decision === "DECISION_REQUIRED") blockers.push("POLICY_PENDING");
  if (record.recordType === "ENVIRONMENT" && (record.detail.policyStatus !== "SETTLED" || record.detail.dataClass === "POLICY_PENDING")) blockers.push("POLICY_PENDING");
  for (const evidenceRef of uniqueStrings([
    ...record.evidenceRefs,
    record.lifecycle.stateEvidenceRef,
    ...AUTHORITY_DIMENSIONS.flatMap((dimension) => record.authority[dimension].evidenceRefs),
  ])) {
    const evidence = evidenceById.get(evidenceRef);
    if (evidence && evidence.freshnessStatus !== "CURRENT") blockers.push("POLICY_PENDING");
  }
  for (const dimension of AUTHORITY_DIMENSIONS) {
    if (BLOCKING_VERDICTS.has(record.authority[dimension].verdict)) blockers.push(record.authority[dimension].verdict === "AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING");
  }
  if ((record.recordType === "WORKER" || record.recordType === "SCHEDULER" || record.recordType === "QUEUE" || record.recordType === "DOMAIN" || record.recordType === "CALLBACK") && typeof record.detail.authorityVerdict === "string" && BLOCKING_VERDICTS.has(record.detail.authorityVerdict)) {
    blockers.push(record.detail.authorityVerdict === "AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING");
  }
  if (record.recordType === "ROLLBACK_ASSET" && typeof record.detail.readinessVerdict === "string" && BLOCKING_VERDICTS.has(record.detail.readinessVerdict)) {
    blockers.push(record.detail.readinessVerdict === "AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING");
  }
  if (workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN") {
    for (const dimension of ["data", "worker", "queue"] as const) {
      if (record.authority[dimension].verdict !== "AUTHORITY_UNPROVEN") blockers.push("AUTHORITY_UNPROVEN");
    }
  }
  if (["ACTIVE_CLIENT_DECISION_REQUIRED", "STAGING_TEST_E2E", "DEMO"].includes(workloadClass) && (record.disposition.decision !== "DECISION_REQUIRED" || record.disposition.status !== "POLICY_PENDING")) blockers.push("POLICY_PENDING");
  return uniqueCodes(blockers);
}

function reconcileRecordAuthorization(records: ExactTargetRecord[], derived: ExactTargetDerivedState, issues: ExactTargetInventoryIssue[]) {
  for (const record of records) {
    const expected = (derived.recordBlockers[record.inventoryRef] ?? []).length > 0 ? "BLOCKED" : "INVENTORY_ONLY";
    if (record.authority.authorizationState !== expected) {
      addIssue(issues, "CLAIM_MISMATCH", "/records/authority/authorizationState", record.inventoryRef);
    }
  }
}

function compareCallerSummary(summary: ExactTargetValidationSummary, derived: ExactTargetDerivedState, records: ExactTargetRecord[], issues: ExactTargetInventoryIssue[]) {
  const rowsByClass = new Map(summary.completenessLedger.map((row) => [row.workloadClass, row]));
  if (rowsByClass.size !== summary.completenessLedger.length) addIssue(issues, "DUPLICATE_IDENTITY", "/validationSummary/completenessLedger/workloadClass");
  for (const row of derived.completeness) {
    const caller = rowsByClass.get(row.workloadClass);
    if (!caller) {
      addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/completenessLedger");
      continue;
    }
    if (caller.status !== row.status || !sameStringSet(caller.blockingGaps, row.blockerCodes)) addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/completenessLedger");
    const classRecords = records.filter((record) => workloadClassForRecordFromRecords(records, record) === row.workloadClass);
    const expectedPolicyStatus = row.blockerCodes.includes("POLICY_PENDING") ? "POLICY_PENDING" : "SETTLED";
    const expectedAuthorityGate = row.blockerCodes.includes("AUTHORITY_UNPROVEN") ? "AUTHORITY_UNPROVEN" : row.blockerCodes.includes("POLICY_PENDING") ? "POLICY_PENDING" : "PROVEN";
    const decisions = uniqueStrings(classRecords.map((record) => record.disposition.decision));
    const expectedDecision = decisions.length === 1 ? decisions[0] : "DECISION_REQUIRED";
    if (caller.policyStatus !== expectedPolicyStatus || caller.authorityGate !== expectedAuthorityGate || caller.dispositionDecision !== expectedDecision) {
      addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/completenessLedger");
    }
  }
  for (const caller of summary.completenessLedger) {
    if (!EXACT_TARGET_WORKLOAD_CLASSES.includes(caller.workloadClass)) addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/completenessLedger");
  }
  if (!sameStringSet(summary.blockerCodes, derived.blockerCodes)) addIssue(issues, "CLAIM_MISMATCH", "/validationSummary/blockerCodes");
}

function invalid(issues: ExactTargetInventoryIssue[], snapshot: ExactTargetInventorySnapshot | null = null): ExactTargetInventoryValidationResult {
  return {
    ok: false,
    publicProjection: projectPublicInventory(snapshot, capIssues(issues)),
    issues: capIssues(issues),
  };
}

function snapshotForDigest(snapshot: Omit<ExactTargetInventorySnapshot, "derived"> | ExactTargetInventorySnapshot): JsonObject {
  return {
    schemaVersion: snapshot.schemaVersion,
    inventoryId: snapshot.inventoryId,
    snapshotSequence: snapshot.snapshotSequence,
    generatedAt: snapshot.generatedAt,
    validFrom: snapshot.validFrom,
    expiresAt: snapshot.expiresAt,
    policyRef: snapshot.policyRef as unknown as JsonObject,
    dispositionRef: snapshot.dispositionRef as unknown as JsonObject,
    collectorContractRef: snapshot.collectorContractRef as unknown as JsonObject,
    collectorArtifactDigest: snapshot.collectorArtifactDigest,
    sourceSnapshotRefs: snapshot.sourceSnapshotRefs,
    records: snapshot.records.map(recordForDigest),
    relationships: snapshot.relationships as unknown as JsonObject[],
    evidence: snapshot.evidence as unknown as JsonObject[],
    validationSummary: snapshot.validationSummary as unknown as JsonObject,
  };
}

function snapshotForReplay(snapshot: ExactTargetInventorySnapshot): JsonObject {
  return {
    ...snapshotForDigest(snapshot),
    records: snapshot.records.map(recordForReplay),
    documentDigest: snapshot.documentDigest,
  };
}

function recordForReplay(record: ExactTargetRecord): JsonObject {
  return {
    ...recordForDigest(record),
    recordDigest: record.recordDigest,
  };
}

function recordForDigest(record: ExactTargetRecord): JsonObject {
  const result: JsonObject = {
    recordId: record.recordId,
    recordType: record.recordType,
    inventoryKey: record.inventoryKey,
    inventoryRef: record.inventoryRef,
    recordRevision: record.recordRevision,
    workloadId: record.workloadId,
    environmentId: record.environmentId,
    ownerRef: record.ownerRef,
    criticality: record.criticality,
    lifecycle: record.lifecycle as unknown as JsonObject,
    disposition: record.disposition as unknown as JsonObject,
    authority: record.authority as unknown as JsonObject,
    evidenceRefs: record.evidenceRefs,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt,
    verifiedAt: record.verifiedAt,
    expiresAt: record.expiresAt,
    [record.detailKey]: record.detail,
  };
  if (record.provider) result.provider = record.provider as unknown as JsonObject;
  return result;
}

function workloadClassForRecord(snapshot: ExactTargetInventorySnapshot, record: ExactTargetRecord): ExactTargetWorkloadClass | "UNKNOWN" {
  return workloadClassForRecordFromRecords(snapshot.records, record);
}

function workloadClassForRecordFromRecords(records: ExactTargetRecord[], record: ExactTargetRecord): ExactTargetWorkloadClass | "UNKNOWN" {
  if (record.recordType === "WORKLOAD" && typeof record.detail.workloadClass === "string" && WORKLOAD_CLASS_SET.has(record.detail.workloadClass)) return record.detail.workloadClass as ExactTargetWorkloadClass;
  if (record.recordType === "GAP" && typeof record.detail.workloadClass === "string" && WORKLOAD_CLASS_SET.has(record.detail.workloadClass)) return record.detail.workloadClass as ExactTargetWorkloadClass;
  const workload = records.find((candidate) => candidate.recordType === "WORKLOAD" && candidate.workloadId === record.workloadId);
  return typeof workload?.detail.workloadClass === "string" && WORKLOAD_CLASS_SET.has(workload.detail.workloadClass) ? workload.detail.workloadClass as ExactTargetWorkloadClass : "UNKNOWN";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function requiredObject(value: JsonObject, key: string, path: string, ctx: ParseContext): JsonObject | null {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return null;
  }
  const candidate = value[key];
  if (!isPlainObject(candidate)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return null;
  }
  return candidate;
}

function requiredArray(value: JsonObject, key: string, path: string, ctx: ParseContext): JsonValue[] {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return [];
  }
  const candidate = value[key];
  if (!Array.isArray(candidate)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return [];
  }
  return candidate;
}

function requiredString(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return undefined;
  }
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() !== candidate || candidate.length === 0 || candidate.length > MAX_STRING_LENGTH || /[|]/.test(candidate)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredLooseString(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return undefined;
  }
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim() !== candidate || candidate.length === 0 || candidate.length > MAX_STRING_LENGTH) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function optionalString(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return requiredString(value, key, path, ctx);
}

function requiredStringArray(value: JsonObject, key: string, path: string, ctx: ParseContext): string[] {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return [];
  }
  const candidate = value[key];
  if (!Array.isArray(candidate) || candidate.length > MAX_ARRAY_ITEMS) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of candidate.entries()) {
    if (typeof item !== "string" || item.trim() !== item || item.length === 0 || item.length > MAX_STRING_LENGTH || seen.has(item)) {
      addIssue(ctx.issues, "INVALID_VALUE", `${joinPath(path, key)}/${index}`);
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function requiredInteger(value: JsonObject, key: string, path: string, ctx: ParseContext): number {
  if (!Object.hasOwn(value, key)) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return 0;
  }
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 1) {
    addIssue(ctx.issues, "REQUIRED_FIELD", joinPath(path, key));
    return 0;
  }
  return candidate as number;
}

function requiredUuid(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
    addIssue(ctx.issues, "INVALID_UUID", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredDigest(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && !/^[a-f0-9]{64}$/.test(candidate)) {
    addIssue(ctx.issues, "INVALID_DIGEST", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredEndpointFingerprint(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && !/^[a-f0-9]{64}$/.test(candidate)) {
    addIssue(ctx.issues, "SECRET_SENTINEL", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredGitSha(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && !/^[a-f0-9]{40}$/.test(candidate)) {
    addIssue(ctx.issues, "INVALID_VALUE", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredTimestamp(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && parseTimestampMs(candidate) === null) {
    addIssue(ctx.issues, "INVALID_TIMESTAMP", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredEnum(value: JsonObject, key: string, allowed: Set<string>, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && !allowed.has(candidate)) {
    addIssue(ctx.issues, "INVALID_VALUE", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredFqdn(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (candidate && (candidate !== candidate.toLowerCase() || !/^[a-z0-9.-]+$/.test(candidate) || candidate.includes("..") || candidate.startsWith(".") || candidate.endsWith("."))) {
    addIssue(ctx.issues, "INVALID_VALUE", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredUrl(value: JsonObject, key: string, path: string, ctx: ParseContext): string | undefined {
  const candidate = requiredString(value, key, path, ctx);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
      addIssue(ctx.issues, "SECRET_SENTINEL", joinPath(path, key));
      return undefined;
    }
  } catch {
    addIssue(ctx.issues, "INVALID_VALUE", joinPath(path, key));
    return undefined;
  }
  return candidate;
}

function requiredArtifact(value: JsonObject, key: string, path: string, ctx: ParseContext): ArtifactRef | null {
  const ref = requiredObject(value, key, path, ctx);
  if (!ref) return null;
  const refPath = joinPath(path, key);
  rejectUnknown(ref, ARTIFACT_KEYS, refPath, ctx.issues);
  const artifactPath = requiredString(ref, "path", refPath, ctx);
  const digest = requiredDigest(ref, "digest", refPath, ctx);
  const status = requiredString(ref, "status", refPath, ctx);
  return artifactPath && digest && status ? { path: artifactPath, digest, status } : null;
}

function rejectUnknown(value: JsonObject, allowed: Set<string>, path: string, issues: ExactTargetInventoryIssue[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, "UNKNOWN_FIELD", joinPath(path, key));
  }
}

function uniqueBy<T>(values: T[], derive: (value: T) => string, path: string, issues: ExactTargetInventoryIssue[]) {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = derive(value);
    if (seen.has(identity)) addIssue(issues, "DUPLICATE_IDENTITY", path);
    seen.add(identity);
  }
}

function parseTimestampMs(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === value ? ms : null;
}

function timeOrder(values: Array<string | undefined>) {
  const timestamps = values.map((value) => typeof value === "string" ? parseTimestampMs(value) : null);
  if (timestamps.some((value) => value === null)) return false;
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index - 1]! > timestamps[index]!) return false;
  }
  return timestamps.at(-2)! < timestamps.at(-1)! || values.length < 4;
}

function findDuplicateJsonKey(raw: string) {
  const stack: Array<{ keys: Set<string>; path: string; pendingKey?: string; expectingKey: boolean }> = [];
  let inString = false;
  let escaped = false;
  let token = "";
  let lastString: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        token += char;
        escaped = false;
      } else if (char === "\\") {
        token += char;
        escaped = true;
      } else if (char === "\"") {
        inString = false;
        try { lastString = JSON.parse(`"${token}"`) as string; } catch { lastString = null; }
        token = "";
      } else {
        token += char;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      token = "";
    } else if (char === "{") {
      const parent = stack.at(-1);
      const path = parent?.pendingKey ? `${parent.path}/${parent.pendingKey}` : parent?.path ?? "";
      if (parent) parent.pendingKey = undefined;
      stack.push({ keys: new Set(), path, expectingKey: true });
    } else if (char === "}") {
      stack.pop();
      lastString = null;
    } else if (char === ":" && lastString !== null) {
      const current = stack.at(-1);
      if (current?.expectingKey) {
        if (current.keys.has(lastString)) return `${current.path}/${lastString}`;
        current.keys.add(lastString);
        current.pendingKey = lastString;
        current.expectingKey = false;
      }
      lastString = null;
    } else if (char === ",") {
      const current = stack.at(-1);
      if (current) {
        current.pendingKey = undefined;
        current.expectingKey = true;
      }
      lastString = null;
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(issues: ExactTargetInventoryIssue[], code: ExactTargetInventoryBlockerCode, path: string, inventoryRef?: string) {
  if (issues.length >= MAX_ISSUES) {
    if (!issues.some((issue) => issue.code === "ISSUE_LIMIT")) issues.push({ code: "ISSUE_LIMIT", path: "/" });
    return;
  }
  issues.push({ code, path: sanitizePath(path), inventoryRef });
}

function capIssues(issues: ExactTargetInventoryIssue[]) {
  if (issues.length <= MAX_ISSUES) return issues;
  return [...issues.slice(0, MAX_ISSUES), { code: "ISSUE_LIMIT" as const, path: "/" }];
}

function uniqueCodes(codes: ExactTargetInventoryBlockerCode[]) {
  return Array.from(new Set(codes)).sort();
}

function sameStringSet(left: string[], right: string[]) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function joinPath(path: string, key: string) {
  return path === "/" ? `/${key}` : `${path}/${key}`;
}

function sanitizePath(path: string) {
  return path.split("/").map((part) => /^\d+$/.test(part) ? "#" : part.replace(/[^A-Za-z0-9_-]/g, "")).join("/") || "/";
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

function stringOrEmpty(value: JsonValue | undefined) {
  return typeof value === "string" ? value : "";
}
