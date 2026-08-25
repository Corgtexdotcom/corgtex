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

const WORKLOAD_CLASS_SET = new Set<string>(EXACT_TARGET_WORKLOAD_CLASSES);

const RECORD_TYPES = new Set([
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
]);

const PROVIDER_KINDS = new Set(["AZURE", "RAILWAY", "GOOGLE_CLOUD_DNS", "GITHUB", "POSTHOG", "EXTERNAL_SAAS", "LOCAL_RECOVERY"]);
const ENVIRONMENT_CLASSES = new Set(["PRODUCTION", "STAGING", "TEST", "E2E", "DEMO", "INTERNAL"]);
const LIFECYCLE_STATES = new Set(["DRAFT", "PROVISIONING", "ACTIVE", "DEGRADED", "SUSPENDED", "QUARANTINED", "ROLLBACK_ONLY", "EVIDENCE_ONLY", "RETIRED", "UNKNOWN"]);
const RELEASE_ELIGIBILITY = new Set(["ELIGIBLE", "INELIGIBLE", "POLICY_PENDING", "UNKNOWN"]);
const DISPOSITION_DECISIONS = new Set(["ADOPT", "REBUILD", "MIGRATE_LAST", "PRESERVE_QUARANTINE", "RETIRE_ONLY_FUTURE", "DECISION_REQUIRED"]);
const DISPOSITION_STATUSES = new Set(["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING"]);
const AUTHORITY_VERDICTS = new Set(["PROVEN", "AUTHORITY_UNPROVEN", "CONFLICTED", "POLICY_PENDING", "NOT_APPLICABLE"]);
const EVIDENCE_FRESHNESS = new Set(["CURRENT", "STALE", "CONFLICTED", "MISSING", "POLICY_PENDING"]);
const AUTHORITY_DIMENSIONS = ["serving", "data", "object", "worker", "scheduler", "queue", "domain", "callback"] as const;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type ExactTargetInventoryBlockerCode =
  | "INVALID_JSON"
  | "DUPLICATE_JSON_KEY"
  | "UNKNOWN_FIELD"
  | "REQUIRED_FIELD"
  | "INVALID_VALUE"
  | "INVALID_TIMESTAMP"
  | "INVALID_DIGEST"
  | "INVALID_UUID"
  | "PRIVATE_IDENTITY"
  | "DERIVED_REF_MISMATCH"
  | "DERIVED_DIGEST_MISMATCH"
  | "DUPLICATE_IDENTITY"
  | "DANGLING_REFERENCE"
  | "MISSING_WORKLOAD_COVERAGE"
  | "POLICY_PENDING"
  | "AUTHORITY_UNPROVEN"
  | "RETIREMENT_NOT_BLOCKED"
  | "SECRET_SENTINEL";

export type ExactTargetInventoryIssue = {
  code: ExactTargetInventoryBlockerCode;
  path: string;
  inventoryRef?: string;
};

export type ExactTargetInventoryPublicProjection = {
  schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  inventoryId?: string;
  documentDigest?: string;
  authorizationState: "INVENTORY_ONLY" | "BLOCKED";
  records: Array<{
    inventoryRef: string;
    recordType: string;
    workloadId: string;
    environmentId: string;
    blockerCodes: ExactTargetInventoryBlockerCode[];
  }>;
  completeness: Array<{
    workloadClass: string;
    status: string;
    blockerCodes: ExactTargetInventoryBlockerCode[];
  }>;
  blockerCodes: ExactTargetInventoryBlockerCode[];
};

export type ExactTargetInventoryValidationResult =
  | {
      ok: true;
      snapshot: JsonObject;
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

const ROOT_KEYS = new Set([
  "schemaVersion",
  "inventoryId",
  "snapshotSequence",
  "generatedAt",
  "validFrom",
  "expiresAt",
  "policyRef",
  "dispositionRef",
  "collectorContractRef",
  "collectorArtifactDigest",
  "sourceSnapshotRefs",
  "records",
  "relationships",
  "evidence",
  "validationSummary",
  "documentDigest",
]);

const RECORD_KEYS = new Set([
  "recordId",
  "recordType",
  "inventoryKey",
  "inventoryRef",
  "recordRevision",
  "recordDigest",
  "workloadId",
  "environmentId",
  "ownerRef",
  "criticality",
  "lifecycle",
  "disposition",
  "authority",
  "evidenceRefs",
  "firstObservedAt",
  "lastObservedAt",
  "verifiedAt",
  "expiresAt",
  "provider",
  "resource",
  "workload",
  "environment",
  "dataStore",
  "objectStore",
  "worker",
  "scheduler",
  "queue",
  "domain",
  "callback",
  "credentialRef",
  "image",
  "rollbackAsset",
  "gap",
]);

const LIFECYCLE_KEYS = new Set(["state", "provisioningState", "releaseEligibility", "retirementEligibility", "stateObservedAt", "stateEvidenceRef"]);
const DISPOSITION_KEYS = new Set(["decision", "status", "decisionRef", "decidedAt", "decisionOwner"]);
const AUTHORITY_DIMENSION_KEYS = new Set(["verdict", "evidenceRefs", "observedAt", "verifiedAt", "expiresAt", "independentVerifierRef"]);
const AUTHORITY_KEYS = new Set([...AUTHORITY_DIMENSIONS, "authorizationState"]);
const COMPLETENESS_KEYS = new Set(["workloadClass", "status", "evidenceRefs", "blockingGaps", "policyStatus", "dispositionDecision", "authorityGate"]);
const VALIDATION_SUMMARY_KEYS = new Set(["completenessLedger", "blockerCodes", "validatedAt"]);
const EVIDENCE_KEYS = new Set(["evidenceId", "evidenceType", "sourceAuthority", "sourceRecordId", "positiveFieldProjection", "collectorIdentityRef", "collectorVersionDigest", "collectedAt", "sourceObservedAt", "verifiedAt", "expiresAt", "sanitizationClass", "artifactRef", "artifactDigest", "freshnessStatus", "limitations"]);
const RELATIONSHIP_KEYS = new Set(["relationshipId", "fromRecordId", "toRecordId", "relationshipType", "evidenceRefs"]);

const RECORD_DETAIL_KEYS: Record<string, Set<string>> = {
  WORKLOAD: new Set(["workloadId", "workloadSlug", "workloadClass", "businessRole", "customerAccountId", "customerDeploymentId", "workspaceId", "runtimeRoles", "systemOfRecordRoles", "dispositionRef"]),
  ENVIRONMENT: new Set(["environmentId", "environmentName", "environmentClass", "isolationBoundary", "dataClass", "ownerRef", "policyStatus"]),
  PROVIDER_RESOURCE: new Set(["providerResourceId", "providerResourceType", "providerNativeName", "resourceRole", "region", "parentResourceId", "deploymentOrRevisionId", "instanceId", "networkExposure", "canonicalOrigin", "providerState"]),
  DATA_STORE: new Set(["providerResourceId", "databaseId", "databaseName", "engine", "region", "workloadBinding", "role", "endpointFingerprint", "schemaMigrationIdentityRefs", "backupRefs", "bindingEvidenceRef"]),
  OBJECT_STORE: new Set(["providerResourceId", "namespace", "region", "workloadBinding", "role", "endpointFingerprint", "versioningRetentionPolicyRef", "inventoryParityEvidenceRefs", "backupRefs"]),
  WORKER: new Set(["providerAppId", "providerServiceId", "deploymentOrRevisionId", "instanceIds", "processRole", "replicaState", "imageRef", "dataStoreRef", "queueRefs", "schedulerRefs", "bindingEvidenceRef", "concurrencyPolicyRef", "authorityVerdict"]),
  SCHEDULER: new Set(["schedulerId", "scheduleIdentity", "timezone", "enabledState", "enqueueTargetRefs", "credentialRef", "lastObservedAt", "authorityVerdict"]),
  QUEUE: new Set(["queueId", "semantics", "availabilityPolicyRef", "lockPolicyRef", "retryPolicyRef", "producerRefs", "consumerRefs", "schedulerRefs", "authorityVerdict"]),
  DOMAIN: new Set(["fqdn", "dnsZoneResourceId", "dnsRecordId", "recordType", "recordTarget", "certificateResourceId", "boundRuntimeResourceId", "canonicalPurpose", "authorityVerdict"]),
  CALLBACK: new Set(["callbackId", "integrationProvider", "callbackKind", "canonicalUrl", "canonicalOrigin", "canonicalPath", "boundResourceRef", "credentialRef", "externalConfigurationEvidenceRef", "authorityVerdict"]),
  CREDENTIAL_REF: new Set(["secretProvider", "vaultOrProjectId", "secretObjectId", "versionSelectorPolicy", "consumerResourceRefs", "purpose", "ownerRef", "rotationMetadataTimestamp", "valueObserved"]),
  IMAGE: new Set(["registryResourceId", "repository", "digestAlgorithm", "digest", "imageRole", "sourceGitSha", "buildProvenanceEvidenceRef", "consumingResourceRefs"]),
  ROLLBACK_ASSET: new Set(["assetId", "assetType", "providerArtifactRef", "sourceSnapshotDigest", "independenceBoundary", "createdAt", "verifiedAt", "restoreTestedAt", "retainUntil", "recoveryOwner", "readinessVerdict"]),
  GAP: new Set(["gapId", "workloadClass", "missingField", "blockerCode", "description"]),
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

export function validateExactTargetInventory(raw: string | JsonObject): ExactTargetInventoryValidationResult {
  const parsed = typeof raw === "string" ? parseStrictJson(raw) : { ok: true as const, value: raw };
  if (!parsed.ok) {
    return invalid([parsed.issue]);
  }

  const issues: ExactTargetInventoryIssue[] = [];
  const snapshot = parsed.value;
  validateRoot(snapshot, issues);

  if (!Array.isArray(snapshot.records) || !Array.isArray(snapshot.relationships) || !Array.isArray(snapshot.evidence) || !isObject(snapshot.validationSummary)) {
    return invalid(issues, snapshot);
  }

  const documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));
  if (snapshot.documentDigest !== documentDigest) {
    issues.push({ code: "DERIVED_DIGEST_MISMATCH", path: "/documentDigest" });
  }

  const records = snapshot.records as JsonObject[];
  for (const [index, record] of records.entries()) {
    const digest = sha256Hex(canonicalJson(withoutKey(record, "recordDigest")));
    if (record.recordDigest !== digest) {
      issues.push({ code: "DERIVED_DIGEST_MISMATCH", path: `/records/${index}/recordDigest`, inventoryRef: stringValue(record.inventoryRef) });
    }
  }

  validateInventorySemantics(snapshot, issues);

  if (issues.length > 0) return invalid(issues, snapshot);

  return {
    ok: true,
    snapshot,
    canonicalJson: canonicalJson(snapshot),
    documentDigest,
    publicProjection: projectPublicInventory(snapshot, []),
    issues: [],
  };
}

export function projectPublicInventory(snapshot: JsonObject | null, issues: ExactTargetInventoryIssue[]): ExactTargetInventoryPublicProjection {
  const blockerCodes = uniqueIssues(issues);
  if (!snapshot) {
    return {
      schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
      authorizationState: "BLOCKED",
      records: [],
      completeness: [],
      blockerCodes,
    };
  }

  const recordIssues = new Map<string, ExactTargetInventoryBlockerCode[]>();
  for (const issue of issues) {
    if (issue.inventoryRef) {
      const codes = recordIssues.get(issue.inventoryRef) ?? [];
      codes.push(issue.code);
      recordIssues.set(issue.inventoryRef, codes);
    }
  }

  const records = Array.isArray(snapshot.records)
    ? snapshot.records.filter(isObject).map((record) => {
        const inventoryRef = typeof record.inventoryRef === "string" ? record.inventoryRef : "";
        return {
          inventoryRef,
          recordType: typeof record.recordType === "string" ? record.recordType : "INVALID",
          workloadId: typeof record.workloadId === "string" ? opaqueId(record.workloadId) : "",
          environmentId: typeof record.environmentId === "string" ? opaqueId(record.environmentId) : "",
          blockerCodes: uniqueCodes(recordIssues.get(inventoryRef) ?? []),
        };
      })
    : [];

  const completenessLedger = getCompletenessLedger(snapshot);
  const completeness = completenessLedger.map((row) => {
    const rowBlockers = Array.isArray(row.blockingGaps)
      ? row.blockingGaps.filter((value): value is ExactTargetInventoryBlockerCode => typeof value === "string" && isBlockerCode(value))
      : [];
    if (row.policyStatus === "POLICY_PENDING") rowBlockers.push("POLICY_PENDING");
    if (row.authorityGate === "AUTHORITY_UNPROVEN") rowBlockers.push("AUTHORITY_UNPROVEN");
    return {
      workloadClass: typeof row.workloadClass === "string" ? row.workloadClass : "INVALID",
      status: typeof row.status === "string" ? row.status : "BLOCKED",
      blockerCodes: uniqueCodes(rowBlockers),
    };
  });

  const authorizationState = blockerCodes.length > 0 || completeness.some((row) => row.blockerCodes.length > 0)
    ? "BLOCKED"
    : "INVENTORY_ONLY";

  return {
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    inventoryId: typeof snapshot.inventoryId === "string" ? opaqueId(snapshot.inventoryId) : undefined,
    documentDigest: typeof snapshot.documentDigest === "string" ? snapshot.documentDigest : undefined,
    authorizationState,
    records,
    completeness,
    blockerCodes,
  };
}

function parseStrictJson(raw: string): { ok: true; value: JsonObject } | { ok: false; issue: ExactTargetInventoryIssue } {
  const duplicatePath = findDuplicateJsonKey(raw);
  if (duplicatePath) return { ok: false, issue: { code: "DUPLICATE_JSON_KEY", path: duplicatePath } };

  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) return { ok: false, issue: { code: "INVALID_JSON", path: "/" } };
    return { ok: true, value };
  } catch {
    return { ok: false, issue: { code: "INVALID_JSON", path: "/" } };
  }
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
        try {
          lastString = JSON.parse(`"${token}"`) as string;
        } catch {
          lastString = null;
        }
        token = "";
      } else {
        token += char;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      token = "";
      continue;
    }

    if (char === "{") {
      const parent = stack.at(-1);
      const path = parent?.pendingKey ? `${parent.path}/${parent.pendingKey}` : parent?.path ?? "";
      if (parent) parent.pendingKey = undefined;
      stack.push({ keys: new Set(), path, expectingKey: true });
      continue;
    }

    if (char === "}") {
      stack.pop();
      lastString = null;
      continue;
    }

    if (char === ":" && lastString !== null) {
      const current = stack.at(-1);
      if (current?.expectingKey) {
        if (current.keys.has(lastString)) return `${current.path}/${lastString}`;
        current.keys.add(lastString);
        current.pendingKey = lastString;
        current.expectingKey = false;
      }
      lastString = null;
      continue;
    }

    if (char === ",") {
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

function validateRoot(snapshot: JsonObject, issues: ExactTargetInventoryIssue[]) {
  rejectNulls(snapshot, "/", issues);
  rejectUnknownKeys(snapshot, ROOT_KEYS, "/", issues);
  requireString(snapshot, "schemaVersion", "/", issues);
  if (snapshot.schemaVersion !== EXACT_TARGET_INVENTORY_SCHEMA_VERSION) issues.push({ code: "INVALID_VALUE", path: "/schemaVersion" });
  requireUuid(snapshot, "inventoryId", "/", issues);
  requirePositiveInteger(snapshot, "snapshotSequence", "/", issues);
  requireTimestamp(snapshot, "generatedAt", "/", issues);
  requireTimestamp(snapshot, "validFrom", "/", issues);
  requireTimestamp(snapshot, "expiresAt", "/", issues);
  requireArtifactRef(snapshot, "policyRef", "/", issues);
  requireArtifactRef(snapshot, "dispositionRef", "/", issues);
  requireArtifactRef(snapshot, "collectorContractRef", "/", issues);
  requireDigest(snapshot, "collectorArtifactDigest", "/", issues);
  requireArray(snapshot, "sourceSnapshotRefs", "/", issues);
  requireArray(snapshot, "records", "/", issues);
  requireArray(snapshot, "relationships", "/", issues);
  requireArray(snapshot, "evidence", "/", issues);
  requireObject(snapshot, "validationSummary", "/", issues);
  requireDigest(snapshot, "documentDigest", "/", issues);

  if (isObject(snapshot.policyRef) && snapshot.policyRef.status !== "POLICY_PENDING") {
    issues.push({ code: "INVALID_VALUE", path: "/policyRef/status" });
  }

  if (!Array.isArray(snapshot.records) || !Array.isArray(snapshot.relationships) || !Array.isArray(snapshot.evidence) || !isObject(snapshot.validationSummary)) return;

  validateValidationSummary(snapshot.validationSummary, issues);
  snapshot.records.forEach((record, index) => validateRecord(record, `/records/${index}`, issues));
  snapshot.relationships.forEach((relationship, index) => validateRelationship(relationship, `/relationships/${index}`, issues));
  snapshot.evidence.forEach((evidence, index) => validateEvidence(evidence, `/evidence/${index}`, issues));
}

function validateValidationSummary(summary: JsonObject, issues: ExactTargetInventoryIssue[]) {
  rejectUnknownKeys(summary, VALIDATION_SUMMARY_KEYS, "/validationSummary", issues);
  requireArray(summary, "completenessLedger", "/validationSummary", issues);
  requireArray(summary, "blockerCodes", "/validationSummary", issues);
  requireTimestamp(summary, "validatedAt", "/validationSummary", issues);

  if (Array.isArray(summary.completenessLedger)) {
    summary.completenessLedger.forEach((row, index) => {
      const path = `/validationSummary/completenessLedger/${index}`;
      if (!isObject(row)) {
        issues.push({ code: "REQUIRED_FIELD", path });
        return;
      }
      rejectUnknownKeys(row, COMPLETENESS_KEYS, path, issues);
      requireEnum(row, "workloadClass", WORKLOAD_CLASS_SET, path, issues);
      requireString(row, "status", path, issues);
      requireArray(row, "evidenceRefs", path, issues);
      requireArray(row, "blockingGaps", path, issues);
      requireString(row, "policyStatus", path, issues);
      requireEnum(row, "dispositionDecision", DISPOSITION_DECISIONS, path, issues);
      requireString(row, "authorityGate", path, issues);
    });
  }
}

function validateRecord(value: JsonValue, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!isObject(value)) {
    issues.push({ code: "REQUIRED_FIELD", path });
    return;
  }
  rejectUnknownKeys(value, RECORD_KEYS, path, issues);
  requireUuid(value, "recordId", path, issues);
  requireEnum(value, "recordType", RECORD_TYPES, path, issues);
  requireInventoryKey(value, "inventoryKey", path, issues);
  requireDigest(value, "inventoryRef", path, issues);
  requirePositiveInteger(value, "recordRevision", path, issues);
  requireDigest(value, "recordDigest", path, issues);
  requireString(value, "workloadId", path, issues);
  requireString(value, "environmentId", path, issues);
  requireString(value, "ownerRef", path, issues);
  requireString(value, "criticality", path, issues);
  requireObject(value, "lifecycle", path, issues);
  requireObject(value, "disposition", path, issues);
  requireObject(value, "authority", path, issues);
  requireArray(value, "evidenceRefs", path, issues);
  requireTimestamp(value, "firstObservedAt", path, issues);
  requireTimestamp(value, "lastObservedAt", path, issues);
  requireTimestamp(value, "verifiedAt", path, issues);
  requireTimestamp(value, "expiresAt", path, issues);

  if (typeof value.inventoryKey === "string" && typeof value.inventoryRef === "string" && deriveInventoryRef(value.inventoryKey) !== value.inventoryRef) {
    issues.push({ code: "DERIVED_REF_MISMATCH", path: `${path}/inventoryRef`, inventoryRef: value.inventoryRef });
  }

  if (isObject(value.lifecycle)) validateLifecycle(value.lifecycle, `${path}/lifecycle`, issues, stringValue(value.inventoryRef));
  if (isObject(value.disposition)) validateDisposition(value.disposition, `${path}/disposition`, issues);
  if (isObject(value.authority)) validateAuthority(value.authority, `${path}/authority`, issues);
  if (isObject(value.provider)) validateProvider(value.provider, `${path}/provider`, issues);

  const recordType = stringValue(value.recordType);
  const detailKey = recordTypeToDetailKey(recordType);
  if (!detailKey || !isObject(value[detailKey])) {
    issues.push({ code: "REQUIRED_FIELD", path: `${path}/${detailKey ?? "detail"}`, inventoryRef: stringValue(value.inventoryRef) });
    return;
  }
  if (!recordType) return;
  rejectUnknownKeys(value[detailKey] as JsonObject, RECORD_DETAIL_KEYS[recordType], `${path}/${detailKey}`, issues);
  validateRecordDetail(recordType, value[detailKey] as JsonObject, `${path}/${detailKey}`, issues);
}

function validateLifecycle(lifecycle: JsonObject, path: string, issues: ExactTargetInventoryIssue[], inventoryRef?: string) {
  rejectUnknownKeys(lifecycle, LIFECYCLE_KEYS, path, issues);
  requireEnum(lifecycle, "state", LIFECYCLE_STATES, path, issues);
  requireString(lifecycle, "provisioningState", path, issues);
  requireEnum(lifecycle, "releaseEligibility", RELEASE_ELIGIBILITY, path, issues);
  requireString(lifecycle, "retirementEligibility", path, issues);
  requireTimestamp(lifecycle, "stateObservedAt", path, issues);
  requireString(lifecycle, "stateEvidenceRef", path, issues);
  if (lifecycle.retirementEligibility !== "BLOCKED") {
    issues.push({ code: "RETIREMENT_NOT_BLOCKED", path: `${path}/retirementEligibility`, inventoryRef });
  }
}

function validateDisposition(disposition: JsonObject, path: string, issues: ExactTargetInventoryIssue[]) {
  rejectUnknownKeys(disposition, DISPOSITION_KEYS, path, issues);
  requireEnum(disposition, "decision", DISPOSITION_DECISIONS, path, issues);
  requireEnum(disposition, "status", DISPOSITION_STATUSES, path, issues);
  requireString(disposition, "decisionRef", path, issues);
  requireTimestamp(disposition, "decidedAt", path, issues);
  requireString(disposition, "decisionOwner", path, issues);
}

function validateAuthority(authority: JsonObject, path: string, issues: ExactTargetInventoryIssue[]) {
  rejectUnknownKeys(authority, AUTHORITY_KEYS, path, issues);
  requireString(authority, "authorizationState", path, issues);
  if (authority.authorizationState !== "INVENTORY_ONLY") issues.push({ code: "INVALID_VALUE", path: `${path}/authorizationState` });
  for (const dimension of AUTHORITY_DIMENSIONS) {
    requireObject(authority, dimension, path, issues);
    const value = authority[dimension];
    if (isObject(value)) {
      rejectUnknownKeys(value, AUTHORITY_DIMENSION_KEYS, `${path}/${dimension}`, issues);
      requireEnum(value, "verdict", AUTHORITY_VERDICTS, `${path}/${dimension}`, issues);
      requireArray(value, "evidenceRefs", `${path}/${dimension}`, issues);
      requireTimestamp(value, "observedAt", `${path}/${dimension}`, issues);
      requireTimestamp(value, "verifiedAt", `${path}/${dimension}`, issues);
      requireTimestamp(value, "expiresAt", `${path}/${dimension}`, issues);
      requireString(value, "independentVerifierRef", `${path}/${dimension}`, issues);
    }
  }
}

function validateProvider(provider: JsonObject, path: string, issues: ExactTargetInventoryIssue[]) {
  const keys = new Set(["providerKind", "providerAccountId", "providerTenantId", "providerSubscriptionOrProjectId", "providerScopeId", "managementPlane", "authorityBoundary"]);
  rejectUnknownKeys(provider, keys, path, issues);
  requireEnum(provider, "providerKind", PROVIDER_KINDS, path, issues);
  requireString(provider, "providerAccountId", path, issues);
  requireString(provider, "providerScopeId", path, issues);
  requireString(provider, "managementPlane", path, issues);
  requireString(provider, "authorityBoundary", path, issues);
}

function validateRecordDetail(recordType: string, detail: JsonObject, path: string, issues: ExactTargetInventoryIssue[]) {
  if (recordType === "WORKLOAD") {
    requireEnum(detail, "workloadClass", WORKLOAD_CLASS_SET, path, issues);
    requireArray(detail, "runtimeRoles", path, issues);
    requireArray(detail, "systemOfRecordRoles", path, issues);
  }
  if (recordType === "ENVIRONMENT") {
    requireEnum(detail, "environmentClass", ENVIRONMENT_CLASSES, path, issues);
  }
  if (recordType === "CREDENTIAL_REF" && detail.valueObserved !== false) {
    issues.push({ code: "SECRET_SENTINEL", path: `${path}/valueObserved` });
  }
  if (recordType === "IMAGE") {
    if (detail.digestAlgorithm !== "sha256") issues.push({ code: "INVALID_VALUE", path: `${path}/digestAlgorithm` });
    requireDigest(detail, "digest", path, issues);
  }
  if (recordType === "DOMAIN" && typeof detail.fqdn === "string" && detail.fqdn !== detail.fqdn.toLowerCase()) {
    issues.push({ code: "INVALID_VALUE", path: `${path}/fqdn` });
  }
  if (recordType === "CALLBACK" && typeof detail.canonicalUrl === "string" && detail.canonicalUrl.includes("?")) {
    issues.push({ code: "SECRET_SENTINEL", path: `${path}/canonicalUrl` });
  }
}

function validateRelationship(value: JsonValue, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!isObject(value)) {
    issues.push({ code: "REQUIRED_FIELD", path });
    return;
  }
  rejectUnknownKeys(value, RELATIONSHIP_KEYS, path, issues);
  requireString(value, "relationshipId", path, issues);
  requireUuid(value, "fromRecordId", path, issues);
  requireUuid(value, "toRecordId", path, issues);
  requireString(value, "relationshipType", path, issues);
  requireArray(value, "evidenceRefs", path, issues);
}

function validateEvidence(value: JsonValue, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!isObject(value)) {
    issues.push({ code: "REQUIRED_FIELD", path });
    return;
  }
  rejectUnknownKeys(value, EVIDENCE_KEYS, path, issues);
  requireString(value, "evidenceId", path, issues);
  requireString(value, "evidenceType", path, issues);
  requireString(value, "sourceAuthority", path, issues);
  requireUuid(value, "sourceRecordId", path, issues);
  requireArray(value, "positiveFieldProjection", path, issues);
  requireString(value, "collectorIdentityRef", path, issues);
  requireDigest(value, "collectorVersionDigest", path, issues);
  requireTimestamp(value, "collectedAt", path, issues);
  requireTimestamp(value, "sourceObservedAt", path, issues);
  requireTimestamp(value, "verifiedAt", path, issues);
  requireTimestamp(value, "expiresAt", path, issues);
  requireString(value, "sanitizationClass", path, issues);
  requireArtifactRef(value, "artifactRef", path, issues);
  requireDigest(value, "artifactDigest", path, issues);
  requireEnum(value, "freshnessStatus", EVIDENCE_FRESHNESS, path, issues);
  requireArray(value, "limitations", path, issues);
}

function validateInventorySemantics(snapshot: JsonObject, issues: ExactTargetInventoryIssue[]) {
  const records = snapshot.records as JsonObject[];
  const recordIds = new Set<string>();
  const inventoryKeys = new Set<string>();
  const inventoryRefs = new Set<string>();
  const providerIdentities = new Set<string>();
  const workloadClasses = new Set<string>();

  for (const [index, record] of records.entries()) {
    const path = `/records/${index}`;
    unique(recordIds, stringValue(record.recordId), `${path}/recordId`, issues);
    unique(inventoryKeys, stringValue(record.inventoryKey), `${path}/inventoryKey`, issues, stringValue(record.inventoryRef));
    unique(inventoryRefs, stringValue(record.inventoryRef), `${path}/inventoryRef`, issues, stringValue(record.inventoryRef));
    const providerIdentity = providerExactIdentity(record);
    if (providerIdentity) unique(providerIdentities, providerIdentity, `${path}/provider`, issues, stringValue(record.inventoryRef));

    if (isObject(record.workload) && typeof record.workload.workloadClass === "string") {
      workloadClasses.add(record.workload.workloadClass);
    }

    if (isObject(record.workload)) {
      enforceWorkloadPolicy(record.workload.workloadClass, record, path, issues);
    }
  }

  for (const relationship of snapshot.relationships as JsonObject[]) {
    if (typeof relationship.fromRecordId === "string" && !recordIds.has(relationship.fromRecordId)) {
      issues.push({ code: "DANGLING_REFERENCE", path: "/relationships/fromRecordId" });
    }
    if (typeof relationship.toRecordId === "string" && !recordIds.has(relationship.toRecordId)) {
      issues.push({ code: "DANGLING_REFERENCE", path: "/relationships/toRecordId" });
    }
  }

  const ledgerClasses = new Set<string>();
  for (const row of getCompletenessLedger(snapshot)) {
    if (typeof row.workloadClass === "string") ledgerClasses.add(row.workloadClass);
  }
  for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) {
    if (!ledgerClasses.has(workloadClass)) {
      issues.push({ code: "MISSING_WORKLOAD_COVERAGE", path: `/validationSummary/completenessLedger/${workloadClass}` });
    }
    if (!workloadClasses.has(workloadClass)) {
      issues.push({ code: "MISSING_WORKLOAD_COVERAGE", path: `/records/workload/${workloadClass}` });
    }
  }
}

function enforceWorkloadPolicy(workloadClassValue: JsonValue | undefined, record: JsonObject, path: string, issues: ExactTargetInventoryIssue[]) {
  if (typeof workloadClassValue !== "string" || !isObject(record.disposition) || !isObject(record.authority)) return;
  const inventoryRef = stringValue(record.inventoryRef);
  if (workloadClassValue === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN") {
    for (const dimension of ["data", "worker", "queue"] as const) {
      const value = record.authority[dimension];
      if (!isObject(value) || value.verdict !== "AUTHORITY_UNPROVEN") {
        issues.push({ code: "AUTHORITY_UNPROVEN", path: `${path}/authority/${dimension}/verdict`, inventoryRef });
      }
    }
  }
  if (["ACTIVE_CLIENT_DECISION_REQUIRED", "STAGING_TEST_E2E", "DEMO"].includes(workloadClassValue)) {
    if (record.disposition.decision !== "DECISION_REQUIRED" || record.disposition.status !== "POLICY_PENDING") {
      issues.push({ code: "POLICY_PENDING", path: `${path}/disposition`, inventoryRef });
    }
  }
}

function invalid(issues: ExactTargetInventoryIssue[], snapshot: JsonObject | null = null): ExactTargetInventoryValidationResult {
  return {
    ok: false,
    issues,
    publicProjection: projectPublicInventory(snapshot, issues),
  };
}

function getCompletenessLedger(snapshot: JsonObject) {
  const validationSummary = snapshot.validationSummary;
  if (!isObject(validationSummary) || !Array.isArray(validationSummary.completenessLedger)) return [];
  return validationSummary.completenessLedger.filter(isObject);
}

function withoutKey(value: JsonObject, keyToRemove: string): JsonObject {
  const copy: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key !== keyToRemove) copy[key] = nestedValue;
  }
  return copy;
}

function recordTypeToDetailKey(recordType: string | undefined) {
  if (!recordType) return undefined;
  const detailKeys: Record<string, string> = {
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
  return detailKeys[recordType];
}

function providerExactIdentity(record: JsonObject) {
  if (!isObject(record.provider)) return null;
  const provider = record.provider;
  const resource = isObject(record.resource) ? record.resource : {};
  const identity = [
    provider.providerKind,
    provider.providerAccountId,
    provider.providerScopeId,
    resource.providerResourceType,
    resource.providerResourceId,
    resource.deploymentOrRevisionId,
    resource.instanceId,
  ];
  return identity.every((value) => typeof value === "string" && value.length > 0) ? identity.join("|") : null;
}

function unique(set: Set<string>, value: string | undefined, path: string, issues: ExactTargetInventoryIssue[], inventoryRef?: string) {
  if (!value) return;
  if (set.has(value)) issues.push({ code: "DUPLICATE_IDENTITY", path, inventoryRef });
  set.add(value);
}

function rejectNulls(value: JsonValue, path: string, issues: ExactTargetInventoryIssue[]) {
  if (value === null) {
    issues.push({ code: "REQUIRED_FIELD", path });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectNulls(item, `${path}/${index}`, issues));
    return;
  }
  if (isObject(value)) {
    for (const [key, nestedValue] of Object.entries(value)) rejectNulls(nestedValue, `${path}/${key}`, issues);
  }
}

function rejectUnknownKeys(value: JsonObject, allowed: Set<string>, path: string, issues: ExactTargetInventoryIssue[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ code: "UNKNOWN_FIELD", path: joinPath(path, key) });
  }
}

function requireString(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (typeof value[key] !== "string" || value[key].trim() !== value[key] || value[key].length === 0) {
    issues.push({ code: "REQUIRED_FIELD", path: `${path}/${key}` });
  }
}

function requirePositiveInteger(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!Number.isInteger(value[key]) || Number(value[key]) < 1) {
    issues.push({ code: "REQUIRED_FIELD", path: `${path}/${key}` });
  }
}

function requireArray(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!Array.isArray(value[key])) issues.push({ code: "REQUIRED_FIELD", path: `${path}/${key}` });
}

function requireObject(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (!isObject(value[key])) issues.push({ code: "REQUIRED_FIELD", path: `${path}/${key}` });
}

function requireEnum(value: JsonObject, key: string, allowed: Set<string>, path: string, issues: ExactTargetInventoryIssue[]) {
  if (typeof value[key] !== "string" || !allowed.has(value[key])) {
    issues.push({ code: "INVALID_VALUE", path: `${path}/${key}` });
  }
}

function requireTimestamp(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  const timestamp = value[key];
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    issues.push({ code: "INVALID_TIMESTAMP", path: `${path}/${key}` });
  }
}

function requireDigest(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) {
    issues.push({ code: "INVALID_DIGEST", path: `${path}/${key}` });
  }
}

function requireUuid(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  if (typeof value[key] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value[key])) {
    issues.push({ code: "INVALID_UUID", path: `${path}/${key}` });
  }
}

function requireArtifactRef(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  const ref = value[key];
  if (!isObject(ref)) {
    issues.push({ code: "REQUIRED_FIELD", path: `${path}/${key}` });
    return;
  }
  const keys = new Set(["path", "digest", "status"]);
  rejectUnknownKeys(ref, keys, `${path}/${key}`, issues);
  requireString(ref, "path", `${path}/${key}`, issues);
  requireDigest(ref, "digest", `${path}/${key}`, issues);
  requireString(ref, "status", `${path}/${key}`, issues);
}

function requireInventoryKey(value: JsonObject, key: string, path: string, issues: ExactTargetInventoryIssue[]) {
  requireString(value, key, path, issues);
  if (typeof value[key] !== "string") return;
  const parts = value[key].split("|");
  if (parts.length !== 7 || parts.some((part) => part.length === 0)) {
    issues.push({ code: "PRIVATE_IDENTITY", path: `${path}/${key}` });
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" ? value : undefined;
}

function uniqueIssues(issues: ExactTargetInventoryIssue[]) {
  return uniqueCodes(issues.map((issue) => issue.code));
}

function uniqueCodes(codes: ExactTargetInventoryBlockerCode[]) {
  return Array.from(new Set(codes)).sort();
}

function isBlockerCode(value: string): value is ExactTargetInventoryBlockerCode {
  return [
    "INVALID_JSON",
    "DUPLICATE_JSON_KEY",
    "UNKNOWN_FIELD",
    "REQUIRED_FIELD",
    "INVALID_VALUE",
    "INVALID_TIMESTAMP",
    "INVALID_DIGEST",
    "INVALID_UUID",
    "PRIVATE_IDENTITY",
    "DERIVED_REF_MISMATCH",
    "DERIVED_DIGEST_MISMATCH",
    "DUPLICATE_IDENTITY",
    "DANGLING_REFERENCE",
    "MISSING_WORKLOAD_COVERAGE",
    "POLICY_PENDING",
    "AUTHORITY_UNPROVEN",
    "RETIREMENT_NOT_BLOCKED",
    "SECRET_SENTINEL",
  ].includes(value);
}

function opaqueId(value: string) {
  return sha256Hex(value).slice(0, 16);
}

function joinPath(path: string, key: string) {
  return path === "/" ? `/${key}` : `${path}/${key}`;
}
