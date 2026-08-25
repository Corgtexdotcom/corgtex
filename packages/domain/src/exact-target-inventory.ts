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

const DETAIL_KEYS = {
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
} as const satisfies Record<ExactTargetRecordType, string>;

const ALL_DETAIL_KEYS = new Set<string>(Object.values(DETAIL_KEYS));
const RECORD_TYPE_SET = new Set<string>(EXACT_TARGET_RECORD_TYPES);
const WORKLOAD_CLASS_SET = new Set<string>(EXACT_TARGET_WORKLOAD_CLASSES);
const PROVIDER_BACKED_TYPES = new Set<ExactTargetRecordType>([
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
]);
const CREDENTIAL_CONSUMER_TYPES = new Set<ExactTargetRecordType>([
  "PROVIDER_RESOURCE",
  "DATA_STORE",
  "OBJECT_STORE",
  "WORKER",
  "SCHEDULER",
  "QUEUE",
  "DOMAIN",
  "CALLBACK",
]);
const IMAGE_CONSUMER_TYPES = new Set<ExactTargetRecordType>(["PROVIDER_RESOURCE", "WORKER"]);
const ROLLBACK_REQUIRED_TYPES = new Set<ExactTargetRecordType>(["PROVIDER_RESOURCE", "DATA_STORE", "OBJECT_STORE", "WORKER"]);
const TARGET_DEPENDENCY_TYPES = new Set<ExactTargetRecordType>([
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
]);
const SELECTABLE_LIFECYCLE_STATES = new Set(["ACTIVE", "DEGRADED"]);
const BLOCKING_AUTHORITY_VERDICTS = new Set(["AUTHORITY_UNPROVEN", "CONFLICTED", "POLICY_PENDING", "NOT_APPLICABLE"]);

const MAX_INPUT_BYTES = 2_000_000;
const MAX_DEPTH = 24;
const MAX_NODES = 100_000;
const MAX_KEYS = 64;
const MAX_ARRAY_ITEMS = 512;
const MAX_STRING_LENGTH = 2_048;
const MAX_ISSUES = 240;

const VALIDATED_SNAPSHOTS = new WeakSet<ExactTargetInventorySnapshot>();

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type ExactTargetRecordType = (typeof EXACT_TARGET_RECORD_TYPES)[number];
export type ExactTargetWorkloadClass = (typeof EXACT_TARGET_WORKLOAD_CLASSES)[number];
export type ExactTargetAuthorityDimensionName = (typeof AUTHORITY_DIMENSIONS)[number];

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

export type ExactTargetInventoryIssue = Readonly<{
  code: ExactTargetInventoryBlockerCode;
  path: string;
  inventoryRef?: string;
}>;

export type ExactTargetInventoryPublicProjection = Readonly<{
  schemaVersion: typeof EXACT_TARGET_INVENTORY_SCHEMA_VERSION;
  documentDigest?: string;
  artifactValidity: "VALID" | "INVALID";
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
}>;

export type ExactTargetInventoryValidationOptions = Readonly<{
  now: string;
}>;

export type ExactTargetInventoryValidationResult =
  | Readonly<{
      ok: true;
      snapshot: ExactTargetInventorySnapshot;
      canonicalJson: string;
      documentDigest: string;
      publicProjection: ExactTargetInventoryPublicProjection;
      issues: [];
    }>
  | Readonly<{
      ok: false;
      publicProjection: ExactTargetInventoryPublicProjection;
      issues: ExactTargetInventoryIssue[];
    }>;

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

export type ExactTargetInventorySelectedTarget = Readonly<{
  workloadClass: ExactTargetWorkloadClass;
  workloadId: string;
  environmentId: string;
  records: ExactTargetRecord[];
  relationships: ExactTargetRelationship[];
  evidence: ExactTargetEvidence[];
  inventoryRefs: string[];
}>;

export type ExactTargetDerivedState = Readonly<{
  artifactValidity: "VALID";
  authorizationState: "INVENTORY_ONLY" | "BLOCKED";
  completeness: Array<{ workloadClass: ExactTargetWorkloadClass; status: "COMPLETE" | "BLOCKED"; blockerCodes: ExactTargetInventoryBlockerCode[] }>;
  targetBlockers: Record<ExactTargetWorkloadClass, ExactTargetInventoryBlockerCode[]>;
  recordBlockers: Record<string, ExactTargetInventoryBlockerCode[]>;
  blockerCodes: ExactTargetInventoryBlockerCode[];
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
  criticality: "P0" | "P1" | "P2" | "P3";
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
  detail: RecordDetail;
}>;

export type ArtifactRef = Readonly<{ path: string; digest: string; status: "SETTLED" | "POLICY_PENDING" | "EVIDENCE_PENDING" }>;
export type Provider = Readonly<{
  providerKind: "AZURE" | "RAILWAY" | "GOOGLE_CLOUD_DNS" | "GITHUB" | "POSTHOG" | "EXTERNAL_SAAS" | "LOCAL_RECOVERY";
  providerAccountId: string;
  providerTenantId?: string;
  providerSubscriptionOrProjectId?: string;
  providerScopeId: string;
  managementPlane: string;
  authorityBoundary: string;
}>;
export type Lifecycle = Readonly<{
  state: "DRAFT" | "PROVISIONING" | "ACTIVE" | "DEGRADED" | "SUSPENDED" | "QUARANTINED" | "ROLLBACK_ONLY" | "EVIDENCE_ONLY" | "RETIRED" | "UNKNOWN";
  provisioningState: "SETTLED" | "POLICY_PENDING" | "EVIDENCE_PENDING" | "FAILED";
  releaseEligibility: "ELIGIBLE" | "INELIGIBLE" | "POLICY_PENDING" | "UNKNOWN";
  retirementEligibility: "BLOCKED";
  stateObservedAt: string;
  stateEvidenceRef: string;
}>;
export type Disposition = Readonly<{
  decision: "ADOPT" | "REBUILD" | "MIGRATE_LAST" | "PRESERVE_QUARANTINE" | "RETIRE_ONLY_FUTURE" | "DECISION_REQUIRED";
  status: "SETTLED" | "POLICY_PENDING" | "EVIDENCE_PENDING";
  decisionRef: string;
  decidedAt: string;
  decisionOwner: string;
}>;
export type AuthorityDimension = Readonly<{
  verdict: "PROVEN" | "AUTHORITY_UNPROVEN" | "CONFLICTED" | "POLICY_PENDING" | "NOT_APPLICABLE";
  evidenceRefs: string[];
  observedAt: string;
  verifiedAt: string;
  expiresAt: string;
  independentVerifierRef: string;
}>;
export type Authority = Readonly<Record<ExactTargetAuthorityDimensionName, AuthorityDimension> & { authorizationState: "INVENTORY_ONLY" | "BLOCKED" }>;
export type ExactTargetRelationship = Readonly<{
  relationshipId: string;
  fromRecordRef: string;
  toRecordRef: string;
  relationshipType: "OWNS" | "DEPENDS_ON" | "USES_CREDENTIAL" | "USES_IMAGE" | "HAS_ROLLBACK" | "EXPOSES_DOMAIN" | "CALLS_BACK";
  evidenceRefs: string[];
}>;
export type ExactTargetEvidence = Readonly<{
  evidenceId: string;
  evidenceRef: string;
  sourceRecordRef: string;
  sourceRecordType: ExactTargetRecordType;
  workloadId: string;
  environmentId: string;
  workloadClass: ExactTargetWorkloadClass;
  evidenceKind: "CAPTURE" | "AUTHORITY" | "COMPLETENESS" | "LIFECYCLE" | "RELATIONSHIP" | "DETAIL" | "ROLLBACK";
  freshness: "CURRENT" | "STALE" | "CONFLICTED" | "MISSING" | "POLICY_PENDING";
  observedAt: string;
  verifiedAt: string;
  expiresAt: string;
  artifactRef: ArtifactRef;
  artifactDigest: string;
}>;
export type ExactTargetValidationSummary = Readonly<{
  validatedAt: string;
  validatorRef: string;
  completeness: Array<{ workloadClass: ExactTargetWorkloadClass; status: "COMPLETE" | "BLOCKED"; evidenceRefs: string[] }>;
  blockerCodes: ExactTargetInventoryBlockerCode[];
}>;

export type WorkloadDetail = Readonly<{
  workloadId: string;
  workloadSlug: string;
  workloadClass: ExactTargetWorkloadClass;
  businessRole: string;
  customerAccountId: string;
  customerDeploymentId: string;
  workspaceId: string;
  runtimeRoles: string[];
  systemOfRecordRoles: string[];
  dispositionRef: string;
}>;
export type EnvironmentDetail = Readonly<{
  environmentId: string;
  workloadId: string;
  environmentClass: "PRODUCTION" | "STAGING" | "TEST" | "E2E" | "DEMO" | "INTERNAL";
  publicBaseDomain: string;
  deploymentTrack: string;
  policyEvidenceRef: string;
}>;
export type ProviderResourceDetail = Readonly<{
  providerResourceId: string;
  resourceKind: string;
  resourceNameFingerprint: string;
  region: string;
  providerEvidenceRef: string;
}>;
export type DataStoreDetail = Readonly<{
  providerResourceId: string;
  databaseId: string;
  storeRole: "AUTHORITATIVE_CANDIDATE" | "ROLLBACK_CANDIDATE" | "AUXILIARY" | "EVIDENCE_ONLY";
  dataClass: "PUBLIC_SYNTHETIC" | "INTERNAL" | "PRODUCTION_METADATA" | "POLICY_PENDING";
  endpointFingerprint: string;
  bindingEvidenceRef: string;
  credentialRefs: string[];
}>;
export type ObjectStoreDetail = Readonly<{
  providerResourceId: string;
  bucketId: string;
  storeRole: "AUTHORITATIVE_CANDIDATE" | "ROLLBACK_CANDIDATE" | "AUXILIARY" | "EVIDENCE_ONLY";
  dataClass: "PUBLIC_SYNTHETIC" | "INTERNAL" | "PRODUCTION_METADATA" | "POLICY_PENDING";
  endpointFingerprint: string;
  bindingEvidenceRef: string;
  credentialRefs: string[];
}>;
export type WorkerDetail = Readonly<{
  workerId: string;
  runtime: string;
  imageRef: string;
  queueRefs: string[];
  dataStoreRefs: string[];
  objectStoreRefs: string[];
  credentialRefs: string[];
}>;
export type SchedulerDetail = Readonly<{
  schedulerId: string;
  scheduleKind: "CRON" | "EVENT" | "MANUAL";
  targetWorkerRef: string;
  credentialRefs: string[];
}>;
export type QueueDetail = Readonly<{
  queueId: string;
  queueSemantics: "POSTGRES_OUTBOX" | "WORKFLOW_JOB" | "SYNTHETIC_QUEUE";
  producerRefs: string[];
  consumerRefs: string[];
  credentialRefs: string[];
}>;
export type DomainDetail = Readonly<{
  fqdn: string;
  domainRole: "PRIMARY" | "CANARY" | "CALLBACK" | "LEGACY" | "INTERNAL";
  targetResourceRef: string;
  dnsEvidenceRef: string;
}>;
export type CallbackDetail = Readonly<{
  callbackId: string;
  callbackUrl: string;
  callbackRole: "WEBHOOK" | "OAUTH_REDIRECT" | "HEALTH" | "INTERNAL";
  targetResourceRef: string;
  externalConfigurationEvidenceRef: string;
  credentialRefs: string[];
}>;
export type CredentialRefDetail = Readonly<{
  credentialRefId: string;
  credentialKind: "API_TOKEN" | "DATABASE_URL" | "WEBHOOK_SECRET" | "OAUTH_CLIENT" | "SERVICE_PRINCIPAL";
  valueObserved: false;
  rotationEvidenceRef: string;
  consumerResourceRefs: string[];
}>;
export type ImageDetail = Readonly<{
  imageDigest: string;
  sourceCommitSha: string;
  buildProvenanceEvidenceRef: string;
  consumerResourceRefs: string[];
}>;
export type RollbackAssetDetail = Readonly<{
  rollbackAssetId: string;
  assetDigest: string;
  createdAt: string;
  verifiedAt: string;
  restoreTestedAt: string;
  retainUntil: string;
  targetRecordRef: string;
  evidenceRef: string;
}>;
export type GapDetail = Readonly<{
  gapId: string;
  workloadClass: ExactTargetWorkloadClass;
  gapType: "AUTHORITY_UNPROVEN" | "POLICY_PENDING" | "DECISION_REQUIRED" | "MISSING_REFERENCE" | "STALE_EVIDENCE" | "INELIGIBLE" | "RETIRED";
  blockerCode: ExactTargetInventoryBlockerCode;
  evidenceRef: string;
}>;
export type RecordDetail =
  | WorkloadDetail
  | EnvironmentDetail
  | ProviderResourceDetail
  | DataStoreDetail
  | ObjectStoreDetail
  | WorkerDetail
  | SchedulerDetail
  | QueueDetail
  | DomainDetail
  | CallbackDetail
  | CredentialRefDetail
  | ImageDetail
  | RollbackAssetDetail
  | GapDetail;

type SchemaIssue = { code: ExactTargetInventoryBlockerCode; path: string; inventoryRef?: string };
type Parser = {
  readonly issues: SchemaIssue[];
  add(code: ExactTargetInventoryBlockerCode, path: string, inventoryRef?: string): void;
};
type EvidenceKind = ExactTargetEvidence["evidenceKind"];
type RelationshipType = ExactTargetRelationship["relationshipType"];
type TargetRoot = {
  workloadClass: ExactTargetWorkloadClass;
  workload: ExactTargetRecord;
  environment: ExactTargetRecord;
  records: ExactTargetRecord[];
  recordRefs: Set<string>;
};
type RelationshipExpectation = {
  type: RelationshipType;
  fromRecordRef: string;
  toRecordRef: string;
  path: string;
};

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson only accepts finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function deriveInventoryRef(inventoryKey: string): string {
  return `managed-inventory-${sha256Hex(inventoryKey)}`;
}

export function deriveEvidenceRef(input: {
  evidenceId: string;
  sourceRecordRef: string;
  artifactDigest: string;
}): string | null {
  if (!isUuid(input.evidenceId) || !isInventoryRef(input.sourceRecordRef) || !isSha256(input.artifactDigest)) {
    return null;
  }
  return `managed-inventory-${sha256Hex(canonicalJson(["evidence", input.evidenceId, input.sourceRecordRef, input.artifactDigest]))}`;
}

export function deriveExactTargetInventoryKey(input: {
  recordType: ExactTargetRecordType | string;
  workloadId: string;
  environmentId: string;
  provider?: Provider | null;
  detail: unknown;
}): string | null {
  if (!isRecordType(input.recordType) || !isUuid(input.workloadId) || !isUuid(input.environmentId) || !isPlainRecord(input.detail)) {
    return null;
  }
  const identity = detailIdentity(input.recordType, input.detail as Partial<RecordDetail>);
  if (!identity) return null;
  const providerTuple = input.provider
    ? [
        input.provider.providerKind,
        input.provider.providerAccountId,
        input.provider.providerTenantId ?? null,
        input.provider.providerSubscriptionOrProjectId ?? null,
        input.provider.providerScopeId,
        input.provider.managementPlane,
        input.provider.authorityBoundary,
      ]
    : null;
  return canonicalJson([
    "CORGTEX_EXACT_TARGET_INVENTORY_V1",
    input.recordType,
    input.workloadId,
    input.environmentId,
    providerTuple,
    identity,
  ]);
}

export function recordDigestInput(record: ExactTargetRecord): JsonObject {
  return withoutKeys(recordToJson(record), ["recordDigest"]) as JsonObject;
}

export function documentDigestInput(snapshot: ExactTargetInventorySnapshot): JsonObject {
  const json = snapshotToJson(snapshot);
  return withoutKeys(json, ["documentDigest", "derived"]) as JsonObject;
}

export function validateExactTargetInventory(input: unknown, options: ExactTargetInventoryValidationOptions): ExactTargetInventoryValidationResult {
  const now = parseTimestamp(options.now);
  if (!now) {
    return invalid([{ code: "INVALID_TIMESTAMP", path: "/now" }]);
  }

  if (typeof input !== "string") {
    return invalid([{ code: "INVALID_JSON", path: "/" }]);
  }
  if (input.length > MAX_INPUT_BYTES || new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) {
    return invalid([{ code: "STRUCTURAL_LIMIT", path: "/" }]);
  }
  if (findDuplicateJsonKey(input)) {
    return invalid([{ code: "DUPLICATE_JSON_KEY", path: "/duplicate-key" }]);
  }
  try {
    input = JSON.parse(input) as unknown;
  } catch {
    return invalid([{ code: "INVALID_JSON", path: "/" }]);
  }

  const captured = capturePlainJson(input);
  if (!captured.ok) {
    return invalid(captured.issues);
  }

  const parser = createParser();
  const snapshot = parseSnapshot(captured.value, parser);
  if (parser.issues.length > 0 || !snapshot) {
    return invalid(parser.issues);
  }

  const semanticIssues = validateSemanticContract(snapshot, now);
  if (semanticIssues.length > 0) {
    return invalid(semanticIssues);
  }

  const derived = deriveState(snapshot as ExactTargetInventorySnapshot);
  const completeSnapshot = deepFreeze({ ...snapshot, derived });
  VALIDATED_SNAPSHOTS.add(completeSnapshot);
  const canonical = canonicalJson(withoutKeys(snapshotToJson(completeSnapshot), ["derived"]));
  return {
    ok: true,
    snapshot: completeSnapshot,
    canonicalJson: canonical,
    documentDigest: completeSnapshot.documentDigest,
    publicProjection: projectValid(completeSnapshot),
    issues: [],
  };
}

export function selectExactTargetInventoryTarget(
  snapshot: ExactTargetInventorySnapshot,
  workloadClass: ExactTargetWorkloadClass,
): ExactTargetInventorySelectedTarget | null {
  if (!VALIDATED_SNAPSHOTS.has(snapshot) || !WORKLOAD_CLASS_SET.has(workloadClass)) return null;
  if (snapshot.derived.targetBlockers[workloadClass].length > 0) return null;
  const root = selectTargetRoot(snapshot, workloadClass);
  if (!root) return null;
  const reachableRefs = reachableOwnedRefs(snapshot.relationships, root.workload.inventoryRef);
  const records = snapshot.records.filter((record) => reachableRefs.has(record.inventoryRef));
  const refs = new Set(records.map((record) => record.inventoryRef));
  const relationships = snapshot.relationships.filter((relationship) => refs.has(relationship.fromRecordRef) && refs.has(relationship.toRecordRef));
  const evidenceRefs = new Set<string>();
  for (const record of records) {
    collectRecordEvidenceRefs(record).forEach((ref) => evidenceRefs.add(ref));
  }
  relationships.flatMap((relationship) => relationship.evidenceRefs).forEach((ref) => evidenceRefs.add(ref));
  snapshot.validationSummary.completeness
    .find((row) => row.workloadClass === workloadClass)
    ?.evidenceRefs.forEach((ref) => evidenceRefs.add(ref));
  return deepFreeze({
    workloadClass,
    workloadId: root.workload.workloadId,
    environmentId: root.workload.environmentId,
    records,
    relationships,
    evidence: snapshot.evidence.filter((evidence) => evidenceRefs.has(evidence.evidenceRef)),
    inventoryRefs: [...refs].sort(),
  });
}

export function selectExactTargetInventoryRecord(
  snapshot: ExactTargetInventorySnapshot,
  inventoryRef: string,
): ExactTargetRecord | null {
  if (!VALIDATED_SNAPSHOTS.has(snapshot) || !isInventoryRef(inventoryRef)) return null;
  const record = snapshot.records.find((candidate) => candidate.inventoryRef === inventoryRef);
  if (!record || !TARGET_DEPENDENCY_TYPES.has(record.recordType)) return null;
  const workloadClass = workloadClassForRecord(snapshot, record);
  if (!workloadClass || snapshot.derived.targetBlockers[workloadClass].length > 0) return null;
  const selected = selectExactTargetInventoryTarget(snapshot, workloadClass);
  if (!selected?.inventoryRefs.includes(record.inventoryRef)) return null;
  return record;
}

function createParser(): Parser {
  const issues: SchemaIssue[] = [];
  return {
    issues,
    add(code, path, inventoryRef) {
      if (issues.length >= MAX_ISSUES) {
        if (issues.length === MAX_ISSUES) issues.push({ code: "ISSUE_LIMIT", path: "/" });
        return;
      }
      issues.push({ code, path, ...(inventoryRef ? { inventoryRef } : {}) });
    },
  };
}

function invalid(issues: SchemaIssue[]): ExactTargetInventoryValidationResult {
  return {
    ok: false,
    publicProjection: {
      schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
      artifactValidity: "INVALID",
      authorizationState: "BLOCKED",
      records: [],
      completeness: [],
      blockerCodes: uniq(issues.map((issue) => issue.code)),
    },
    issues: issues.map((issue) => ({ code: issue.code, path: issue.path })),
  };
}

function parseSnapshot(value: JsonValue, parser: Parser): Omit<ExactTargetInventorySnapshot, "derived"> | null {
  const object = objectAt(value, "/", parser);
  if (!object) return null;
  rejectUnknown(object, new Set([
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
  ]), "/", parser);

  const records = arrayAt(object.records, "/records", parser, (entry, path) => parseRecord(entry, path, parser));
  const relationships = arrayAt(object.relationships, "/relationships", parser, (entry, path) => parseRelationship(entry, path, parser));
  const evidence = arrayAt(object.evidence, "/evidence", parser, (entry, path) => parseEvidence(entry, path, parser));
  const validationSummary = parseValidationSummary(object.validationSummary, "/validationSummary", parser);
  const snapshot = {
    schemaVersion: enumAt(object.schemaVersion, [EXACT_TARGET_INVENTORY_SCHEMA_VERSION], "/schemaVersion", parser),
    inventoryId: uuidAt(object.inventoryId, "/inventoryId", parser),
    snapshotSequence: intAt(object.snapshotSequence, "/snapshotSequence", parser, { min: 1 }),
    generatedAt: timestampAt(object.generatedAt, "/generatedAt", parser),
    validFrom: timestampAt(object.validFrom, "/validFrom", parser),
    expiresAt: timestampAt(object.expiresAt, "/expiresAt", parser),
    policyRef: parseArtifactRef(object.policyRef, "/policyRef", parser),
    dispositionRef: parseArtifactRef(object.dispositionRef, "/dispositionRef", parser),
    collectorContractRef: parseArtifactRef(object.collectorContractRef, "/collectorContractRef", parser),
    collectorArtifactDigest: shaAt(object.collectorArtifactDigest, "/collectorArtifactDigest", parser),
    sourceSnapshotRefs: stringArrayAt(object.sourceSnapshotRefs, "/sourceSnapshotRefs", parser, { digest: true }),
    records,
    relationships,
    evidence,
    validationSummary,
    documentDigest: shaAt(object.documentDigest, "/documentDigest", parser),
  };
  if (!hasAll(snapshot)) return null;
  return snapshot as Omit<ExactTargetInventorySnapshot, "derived">;
}

function parseRecord(value: JsonValue, path: string, parser: Parser): ExactTargetRecord | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  const recordType = enumAt(object.recordType, EXACT_TARGET_RECORD_TYPES, `${path}/recordType`, parser);
  const detailKey = recordType ? DETAIL_KEYS[recordType] : null;
  const allowed = new Set([
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
    ...(detailKey ? [detailKey] : []),
  ]);
  rejectUnknown(object, allowed, path, parser);
  for (const candidate of ALL_DETAIL_KEYS) {
    if (candidate !== detailKey && own(object, candidate)) {
      parser.add("UNKNOWN_FIELD", `${path}/detail`);
    }
  }
  const provider = own(object, "provider") ? parseProvider(object.provider, `${path}/provider`, parser) : undefined;
  if (recordType && PROVIDER_BACKED_TYPES.has(recordType) && !provider) {
    parser.add("REQUIRED_FIELD", `${path}/provider`);
  }
  if (recordType && !PROVIDER_BACKED_TYPES.has(recordType) && provider) {
    parser.add("INVALID_VALUE", `${path}/provider`);
  }
  const detail = recordType && detailKey ? parseDetail(recordType, object[detailKey], `${path}/${detailKey}`, parser) : null;
  const record = {
    recordId: uuidAt(object.recordId, `${path}/recordId`, parser),
    recordType,
    inventoryKey: stringAt(object.inventoryKey, `${path}/inventoryKey`, parser),
    inventoryRef: inventoryRefAt(object.inventoryRef, `${path}/inventoryRef`, parser),
    recordRevision: intAt(object.recordRevision, `${path}/recordRevision`, parser, { min: 1 }),
    recordDigest: shaAt(object.recordDigest, `${path}/recordDigest`, parser),
    workloadId: uuidAt(object.workloadId, `${path}/workloadId`, parser),
    environmentId: uuidAt(object.environmentId, `${path}/environmentId`, parser),
    ownerRef: safeTokenAt(object.ownerRef, `${path}/ownerRef`, parser),
    criticality: enumAt(object.criticality, ["P0", "P1", "P2", "P3"], `${path}/criticality`, parser),
    lifecycle: parseLifecycle(object.lifecycle, `${path}/lifecycle`, parser),
    disposition: parseDisposition(object.disposition, `${path}/disposition`, parser),
    authority: parseAuthority(object.authority, `${path}/authority`, parser),
    evidenceRefs: stringArrayAt(object.evidenceRefs, `${path}/evidenceRefs`, parser, { inventoryRef: true, min: 1 }),
    firstObservedAt: timestampAt(object.firstObservedAt, `${path}/firstObservedAt`, parser),
    lastObservedAt: timestampAt(object.lastObservedAt, `${path}/lastObservedAt`, parser),
    verifiedAt: timestampAt(object.verifiedAt, `${path}/verifiedAt`, parser),
    expiresAt: timestampAt(object.expiresAt, `${path}/expiresAt`, parser),
    ...(provider ? { provider } : {}),
    detailKey: detailKey ?? "",
    detail,
  };
  if (!hasAll(record) || !record.recordType || !record.detail) return null;
  return record as ExactTargetRecord;
}

function parseDetail(recordType: ExactTargetRecordType, value: JsonValue | undefined, path: string, parser: Parser): RecordDetail | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  switch (recordType) {
    case "WORKLOAD": {
      rejectUnknown(object, new Set(["workloadId", "workloadSlug", "workloadClass", "businessRole", "customerAccountId", "customerDeploymentId", "workspaceId", "runtimeRoles", "systemOfRecordRoles", "dispositionRef"]), path, parser);
      const detail = {
        workloadId: uuidAt(object.workloadId, `${path}/workloadId`, parser),
        workloadSlug: safeTokenAt(object.workloadSlug, `${path}/workloadSlug`, parser),
        workloadClass: enumAt(object.workloadClass, EXACT_TARGET_WORKLOAD_CLASSES, `${path}/workloadClass`, parser),
        businessRole: safeTokenAt(object.businessRole, `${path}/businessRole`, parser),
        customerAccountId: safeTokenAt(object.customerAccountId, `${path}/customerAccountId`, parser),
        customerDeploymentId: safeTokenAt(object.customerDeploymentId, `${path}/customerDeploymentId`, parser),
        workspaceId: safeTokenAt(object.workspaceId, `${path}/workspaceId`, parser),
        runtimeRoles: stringArrayAt(object.runtimeRoles, `${path}/runtimeRoles`, parser),
        systemOfRecordRoles: stringArrayAt(object.systemOfRecordRoles, `${path}/systemOfRecordRoles`, parser),
        dispositionRef: safeTokenAt(object.dispositionRef, `${path}/dispositionRef`, parser),
      };
      return hasAll(detail) ? detail as WorkloadDetail : null;
    }
    case "ENVIRONMENT": {
      rejectUnknown(object, new Set(["environmentId", "workloadId", "environmentClass", "publicBaseDomain", "deploymentTrack", "policyEvidenceRef"]), path, parser);
      const detail = {
        environmentId: uuidAt(object.environmentId, `${path}/environmentId`, parser),
        workloadId: uuidAt(object.workloadId, `${path}/workloadId`, parser),
        environmentClass: enumAt(object.environmentClass, ["PRODUCTION", "STAGING", "TEST", "E2E", "DEMO", "INTERNAL"], `${path}/environmentClass`, parser),
        publicBaseDomain: fqdnAt(object.publicBaseDomain, `${path}/publicBaseDomain`, parser),
        deploymentTrack: safeTokenAt(object.deploymentTrack, `${path}/deploymentTrack`, parser),
        policyEvidenceRef: inventoryRefAt(object.policyEvidenceRef, `${path}/policyEvidenceRef`, parser),
      };
      return hasAll(detail) ? detail as EnvironmentDetail : null;
    }
    case "PROVIDER_RESOURCE": {
      rejectUnknown(object, new Set(["providerResourceId", "resourceKind", "resourceNameFingerprint", "region", "providerEvidenceRef"]), path, parser);
      const detail = {
        providerResourceId: safeIdentifierAt(object.providerResourceId, `${path}/providerResourceId`, parser),
        resourceKind: safeTokenAt(object.resourceKind, `${path}/resourceKind`, parser),
        resourceNameFingerprint: opaqueFingerprintAt(object.resourceNameFingerprint, `${path}/resourceNameFingerprint`, parser),
        region: safeTokenAt(object.region, `${path}/region`, parser),
        providerEvidenceRef: inventoryRefAt(object.providerEvidenceRef, `${path}/providerEvidenceRef`, parser),
      };
      return hasAll(detail) ? detail as ProviderResourceDetail : null;
    }
    case "DATA_STORE": {
      rejectUnknown(object, new Set(["providerResourceId", "databaseId", "storeRole", "dataClass", "endpointFingerprint", "bindingEvidenceRef", "credentialRefs"]), path, parser);
      const detail = {
        providerResourceId: safeIdentifierAt(object.providerResourceId, `${path}/providerResourceId`, parser),
        databaseId: safeIdentifierAt(object.databaseId, `${path}/databaseId`, parser),
        storeRole: enumAt(object.storeRole, ["AUTHORITATIVE_CANDIDATE", "ROLLBACK_CANDIDATE", "AUXILIARY", "EVIDENCE_ONLY"], `${path}/storeRole`, parser),
        dataClass: enumAt(object.dataClass, ["PUBLIC_SYNTHETIC", "INTERNAL", "PRODUCTION_METADATA", "POLICY_PENDING"], `${path}/dataClass`, parser),
        endpointFingerprint: opaqueFingerprintAt(object.endpointFingerprint, `${path}/endpointFingerprint`, parser),
        bindingEvidenceRef: inventoryRefAt(object.bindingEvidenceRef, `${path}/bindingEvidenceRef`, parser),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as DataStoreDetail : null;
    }
    case "OBJECT_STORE": {
      rejectUnknown(object, new Set(["providerResourceId", "bucketId", "storeRole", "dataClass", "endpointFingerprint", "bindingEvidenceRef", "credentialRefs"]), path, parser);
      const detail = {
        providerResourceId: safeIdentifierAt(object.providerResourceId, `${path}/providerResourceId`, parser),
        bucketId: safeIdentifierAt(object.bucketId, `${path}/bucketId`, parser),
        storeRole: enumAt(object.storeRole, ["AUTHORITATIVE_CANDIDATE", "ROLLBACK_CANDIDATE", "AUXILIARY", "EVIDENCE_ONLY"], `${path}/storeRole`, parser),
        dataClass: enumAt(object.dataClass, ["PUBLIC_SYNTHETIC", "INTERNAL", "PRODUCTION_METADATA", "POLICY_PENDING"], `${path}/dataClass`, parser),
        endpointFingerprint: opaqueFingerprintAt(object.endpointFingerprint, `${path}/endpointFingerprint`, parser),
        bindingEvidenceRef: inventoryRefAt(object.bindingEvidenceRef, `${path}/bindingEvidenceRef`, parser),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as ObjectStoreDetail : null;
    }
    case "WORKER": {
      rejectUnknown(object, new Set(["workerId", "runtime", "imageRef", "queueRefs", "dataStoreRefs", "objectStoreRefs", "credentialRefs"]), path, parser);
      const detail = {
        workerId: safeIdentifierAt(object.workerId, `${path}/workerId`, parser),
        runtime: safeTokenAt(object.runtime, `${path}/runtime`, parser),
        imageRef: inventoryRefAt(object.imageRef, `${path}/imageRef`, parser),
        queueRefs: stringArrayAt(object.queueRefs, `${path}/queueRefs`, parser, { inventoryRef: true }),
        dataStoreRefs: stringArrayAt(object.dataStoreRefs, `${path}/dataStoreRefs`, parser, { inventoryRef: true }),
        objectStoreRefs: stringArrayAt(object.objectStoreRefs, `${path}/objectStoreRefs`, parser, { inventoryRef: true }),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as WorkerDetail : null;
    }
    case "SCHEDULER": {
      rejectUnknown(object, new Set(["schedulerId", "scheduleKind", "targetWorkerRef", "credentialRefs"]), path, parser);
      const detail = {
        schedulerId: safeIdentifierAt(object.schedulerId, `${path}/schedulerId`, parser),
        scheduleKind: enumAt(object.scheduleKind, ["CRON", "EVENT", "MANUAL"], `${path}/scheduleKind`, parser),
        targetWorkerRef: inventoryRefAt(object.targetWorkerRef, `${path}/targetWorkerRef`, parser),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as SchedulerDetail : null;
    }
    case "QUEUE": {
      rejectUnknown(object, new Set(["queueId", "queueSemantics", "producerRefs", "consumerRefs", "credentialRefs"]), path, parser);
      const detail = {
        queueId: safeIdentifierAt(object.queueId, `${path}/queueId`, parser),
        queueSemantics: enumAt(object.queueSemantics, ["POSTGRES_OUTBOX", "WORKFLOW_JOB", "SYNTHETIC_QUEUE"], `${path}/queueSemantics`, parser),
        producerRefs: stringArrayAt(object.producerRefs, `${path}/producerRefs`, parser, { inventoryRef: true }),
        consumerRefs: stringArrayAt(object.consumerRefs, `${path}/consumerRefs`, parser, { inventoryRef: true }),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as QueueDetail : null;
    }
    case "DOMAIN": {
      rejectUnknown(object, new Set(["fqdn", "domainRole", "targetResourceRef", "dnsEvidenceRef"]), path, parser);
      const detail = {
        fqdn: fqdnAt(object.fqdn, `${path}/fqdn`, parser),
        domainRole: enumAt(object.domainRole, ["PRIMARY", "CANARY", "CALLBACK", "LEGACY", "INTERNAL"], `${path}/domainRole`, parser),
        targetResourceRef: inventoryRefAt(object.targetResourceRef, `${path}/targetResourceRef`, parser),
        dnsEvidenceRef: inventoryRefAt(object.dnsEvidenceRef, `${path}/dnsEvidenceRef`, parser),
      };
      return hasAll(detail) ? detail as DomainDetail : null;
    }
    case "CALLBACK": {
      rejectUnknown(object, new Set(["callbackId", "callbackUrl", "callbackRole", "targetResourceRef", "externalConfigurationEvidenceRef", "credentialRefs"]), path, parser);
      const detail = {
        callbackId: safeIdentifierAt(object.callbackId, `${path}/callbackId`, parser),
        callbackUrl: callbackUrlAt(object.callbackUrl, `${path}/callbackUrl`, parser),
        callbackRole: enumAt(object.callbackRole, ["WEBHOOK", "OAUTH_REDIRECT", "HEALTH", "INTERNAL"], `${path}/callbackRole`, parser),
        targetResourceRef: inventoryRefAt(object.targetResourceRef, `${path}/targetResourceRef`, parser),
        externalConfigurationEvidenceRef: inventoryRefAt(object.externalConfigurationEvidenceRef, `${path}/externalConfigurationEvidenceRef`, parser),
        credentialRefs: stringArrayAt(object.credentialRefs, `${path}/credentialRefs`, parser, { inventoryRef: true }),
      };
      return hasAll(detail) ? detail as CallbackDetail : null;
    }
    case "CREDENTIAL_REF": {
      rejectUnknown(object, new Set(["credentialRefId", "credentialKind", "valueObserved", "rotationEvidenceRef", "consumerResourceRefs"]), path, parser);
      const valueObserved = object.valueObserved;
      if (valueObserved !== false) parser.add("SECRET_SENTINEL", `${path}/valueObserved`);
      const detail = {
        credentialRefId: safeIdentifierAt(object.credentialRefId, `${path}/credentialRefId`, parser),
        credentialKind: enumAt(object.credentialKind, ["API_TOKEN", "DATABASE_URL", "WEBHOOK_SECRET", "OAUTH_CLIENT", "SERVICE_PRINCIPAL"], `${path}/credentialKind`, parser),
        valueObserved: false as const,
        rotationEvidenceRef: inventoryRefAt(object.rotationEvidenceRef, `${path}/rotationEvidenceRef`, parser),
        consumerResourceRefs: stringArrayAt(object.consumerResourceRefs, `${path}/consumerResourceRefs`, parser, { inventoryRef: true, min: 1 }),
      };
      return hasAll(detail) ? detail as CredentialRefDetail : null;
    }
    case "IMAGE": {
      rejectUnknown(object, new Set(["imageDigest", "sourceCommitSha", "buildProvenanceEvidenceRef", "consumerResourceRefs"]), path, parser);
      const detail = {
        imageDigest: shaAt(object.imageDigest, `${path}/imageDigest`, parser),
        sourceCommitSha: gitShaAt(object.sourceCommitSha, `${path}/sourceCommitSha`, parser),
        buildProvenanceEvidenceRef: inventoryRefAt(object.buildProvenanceEvidenceRef, `${path}/buildProvenanceEvidenceRef`, parser),
        consumerResourceRefs: stringArrayAt(object.consumerResourceRefs, `${path}/consumerResourceRefs`, parser, { inventoryRef: true, min: 1 }),
      };
      return hasAll(detail) ? detail as ImageDetail : null;
    }
    case "ROLLBACK_ASSET": {
      rejectUnknown(object, new Set(["rollbackAssetId", "assetDigest", "createdAt", "verifiedAt", "restoreTestedAt", "retainUntil", "targetRecordRef", "evidenceRef"]), path, parser);
      const detail = {
        rollbackAssetId: safeIdentifierAt(object.rollbackAssetId, `${path}/rollbackAssetId`, parser),
        assetDigest: shaAt(object.assetDigest, `${path}/assetDigest`, parser),
        createdAt: timestampAt(object.createdAt, `${path}/createdAt`, parser),
        verifiedAt: timestampAt(object.verifiedAt, `${path}/verifiedAt`, parser),
        restoreTestedAt: timestampAt(object.restoreTestedAt, `${path}/restoreTestedAt`, parser),
        retainUntil: timestampAt(object.retainUntil, `${path}/retainUntil`, parser),
        targetRecordRef: inventoryRefAt(object.targetRecordRef, `${path}/targetRecordRef`, parser),
        evidenceRef: inventoryRefAt(object.evidenceRef, `${path}/evidenceRef`, parser),
      };
      return hasAll(detail) ? detail as RollbackAssetDetail : null;
    }
    case "GAP": {
      rejectUnknown(object, new Set(["gapId", "workloadClass", "gapType", "blockerCode", "evidenceRef"]), path, parser);
      const detail = {
        gapId: safeIdentifierAt(object.gapId, `${path}/gapId`, parser),
        workloadClass: enumAt(object.workloadClass, EXACT_TARGET_WORKLOAD_CLASSES, `${path}/workloadClass`, parser),
        gapType: enumAt(object.gapType, ["AUTHORITY_UNPROVEN", "POLICY_PENDING", "DECISION_REQUIRED", "MISSING_REFERENCE", "STALE_EVIDENCE", "INELIGIBLE", "RETIRED"], `${path}/gapType`, parser),
        blockerCode: enumAt(object.blockerCode, ["POLICY_PENDING", "AUTHORITY_UNPROVEN", "MISSING_WORKLOAD_COVERAGE", "LIFECYCLE_NOT_SELECTABLE", "STALE_OR_EXPIRED"], `${path}/blockerCode`, parser),
        evidenceRef: inventoryRefAt(object.evidenceRef, `${path}/evidenceRef`, parser),
      };
      return hasAll(detail) ? detail as GapDetail : null;
    }
  }
}

function parseProvider(value: JsonValue | undefined, path: string, parser: Parser): Provider | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["providerKind", "providerAccountId", "providerTenantId", "providerSubscriptionOrProjectId", "providerScopeId", "managementPlane", "authorityBoundary"]), path, parser);
  const provider: Mutable<Provider> = {
    providerKind: enumAt(object.providerKind, ["AZURE", "RAILWAY", "GOOGLE_CLOUD_DNS", "GITHUB", "POSTHOG", "EXTERNAL_SAAS", "LOCAL_RECOVERY"], `${path}/providerKind`, parser)!,
    providerAccountId: safeTokenAt(object.providerAccountId, `${path}/providerAccountId`, parser)!,
    providerScopeId: safeTokenAt(object.providerScopeId, `${path}/providerScopeId`, parser)!,
    managementPlane: safeTokenAt(object.managementPlane, `${path}/managementPlane`, parser)!,
    authorityBoundary: safeTokenAt(object.authorityBoundary, `${path}/authorityBoundary`, parser)!,
  };
  if (own(object, "providerTenantId")) {
    const value = safeTokenAt(object.providerTenantId, `${path}/providerTenantId`, parser);
    if (value) provider.providerTenantId = value;
  }
  if (own(object, "providerSubscriptionOrProjectId")) {
    const value = safeTokenAt(object.providerSubscriptionOrProjectId, `${path}/providerSubscriptionOrProjectId`, parser);
    if (value) provider.providerSubscriptionOrProjectId = value;
  }
  return hasAll(provider) ? provider : null;
}

function parseLifecycle(value: JsonValue | undefined, path: string, parser: Parser): Lifecycle | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["state", "provisioningState", "releaseEligibility", "retirementEligibility", "stateObservedAt", "stateEvidenceRef"]), path, parser);
  const lifecycle = {
    state: enumAt(object.state, ["DRAFT", "PROVISIONING", "ACTIVE", "DEGRADED", "SUSPENDED", "QUARANTINED", "ROLLBACK_ONLY", "EVIDENCE_ONLY", "RETIRED", "UNKNOWN"], `${path}/state`, parser),
    provisioningState: enumAt(object.provisioningState, ["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING", "FAILED"], `${path}/provisioningState`, parser),
    releaseEligibility: enumAt(object.releaseEligibility, ["ELIGIBLE", "INELIGIBLE", "POLICY_PENDING", "UNKNOWN"], `${path}/releaseEligibility`, parser),
    retirementEligibility: enumAt(object.retirementEligibility, ["BLOCKED"], `${path}/retirementEligibility`, parser),
    stateObservedAt: timestampAt(object.stateObservedAt, `${path}/stateObservedAt`, parser),
    stateEvidenceRef: inventoryRefAt(object.stateEvidenceRef, `${path}/stateEvidenceRef`, parser),
  };
  if (object.retirementEligibility !== "BLOCKED") parser.add("RETIREMENT_NOT_BLOCKED", `${path}/retirementEligibility`);
  return hasAll(lifecycle) ? lifecycle as Lifecycle : null;
}

function parseDisposition(value: JsonValue | undefined, path: string, parser: Parser): Disposition | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["decision", "status", "decisionRef", "decidedAt", "decisionOwner"]), path, parser);
  const disposition = {
    decision: enumAt(object.decision, ["ADOPT", "REBUILD", "MIGRATE_LAST", "PRESERVE_QUARANTINE", "RETIRE_ONLY_FUTURE", "DECISION_REQUIRED"], `${path}/decision`, parser),
    status: enumAt(object.status, ["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING"], `${path}/status`, parser),
    decisionRef: safeTokenAt(object.decisionRef, `${path}/decisionRef`, parser),
    decidedAt: timestampAt(object.decidedAt, `${path}/decidedAt`, parser),
    decisionOwner: safeTokenAt(object.decisionOwner, `${path}/decisionOwner`, parser),
  };
  return hasAll(disposition) ? disposition as Disposition : null;
}

function parseAuthority(value: JsonValue | undefined, path: string, parser: Parser): Authority | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["authorizationState", ...AUTHORITY_DIMENSIONS]), path, parser);
  const authorizationState = enumAt(object.authorizationState, ["INVENTORY_ONLY", "BLOCKED"], `${path}/authorizationState`, parser);
  const authority: Partial<Mutable<Authority>> = {};
  if (authorizationState) authority.authorizationState = authorizationState;
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const parsed = parseAuthorityDimension(object[dimension], `${path}/${dimension}`, parser);
    if (parsed) authority[dimension] = parsed;
  }
  return hasAll(authority) ? authority as Authority : null;
}

function parseAuthorityDimension(value: JsonValue | undefined, path: string, parser: Parser): AuthorityDimension | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["verdict", "evidenceRefs", "observedAt", "verifiedAt", "expiresAt", "independentVerifierRef"]), path, parser);
  const verdict = enumAt(object.verdict, ["PROVEN", "AUTHORITY_UNPROVEN", "CONFLICTED", "POLICY_PENDING", "NOT_APPLICABLE"], `${path}/verdict`, parser);
  const refs = stringArrayAt(object.evidenceRefs, `${path}/evidenceRefs`, parser, { inventoryRef: true });
  if (verdict === "PROVEN" && refs.length === 0) parser.add("AUTHORITY_UNPROVEN", `${path}/evidenceRefs`);
  const dimension = {
    verdict,
    evidenceRefs: refs,
    observedAt: timestampAt(object.observedAt, `${path}/observedAt`, parser),
    verifiedAt: timestampAt(object.verifiedAt, `${path}/verifiedAt`, parser),
    expiresAt: timestampAt(object.expiresAt, `${path}/expiresAt`, parser),
    independentVerifierRef: safeTokenAt(object.independentVerifierRef, `${path}/independentVerifierRef`, parser),
  };
  return hasAll(dimension) ? dimension as AuthorityDimension : null;
}

function parseRelationship(value: JsonValue, path: string, parser: Parser): ExactTargetRelationship | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["relationshipId", "fromRecordRef", "toRecordRef", "relationshipType", "evidenceRefs"]), path, parser);
  const relationship = {
    relationshipId: uuidAt(object.relationshipId, `${path}/relationshipId`, parser),
    fromRecordRef: inventoryRefAt(object.fromRecordRef, `${path}/fromRecordRef`, parser),
    toRecordRef: inventoryRefAt(object.toRecordRef, `${path}/toRecordRef`, parser),
    relationshipType: enumAt(object.relationshipType, ["OWNS", "DEPENDS_ON", "USES_CREDENTIAL", "USES_IMAGE", "HAS_ROLLBACK", "EXPOSES_DOMAIN", "CALLS_BACK"], `${path}/relationshipType`, parser),
    evidenceRefs: stringArrayAt(object.evidenceRefs, `${path}/evidenceRefs`, parser, { inventoryRef: true, min: 1 }),
  };
  return hasAll(relationship) ? relationship as ExactTargetRelationship : null;
}

function parseEvidence(value: JsonValue, path: string, parser: Parser): ExactTargetEvidence | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["evidenceId", "evidenceRef", "sourceRecordRef", "sourceRecordType", "workloadId", "environmentId", "workloadClass", "evidenceKind", "freshness", "observedAt", "verifiedAt", "expiresAt", "artifactRef", "artifactDigest"]), path, parser);
  const evidence = {
    evidenceId: uuidAt(object.evidenceId, `${path}/evidenceId`, parser),
    evidenceRef: inventoryRefAt(object.evidenceRef, `${path}/evidenceRef`, parser),
    sourceRecordRef: inventoryRefAt(object.sourceRecordRef, `${path}/sourceRecordRef`, parser),
    sourceRecordType: enumAt(object.sourceRecordType, EXACT_TARGET_RECORD_TYPES, `${path}/sourceRecordType`, parser),
    workloadId: uuidAt(object.workloadId, `${path}/workloadId`, parser),
    environmentId: uuidAt(object.environmentId, `${path}/environmentId`, parser),
    workloadClass: enumAt(object.workloadClass, EXACT_TARGET_WORKLOAD_CLASSES, `${path}/workloadClass`, parser),
    evidenceKind: enumAt(object.evidenceKind, ["CAPTURE", "AUTHORITY", "COMPLETENESS", "LIFECYCLE", "RELATIONSHIP", "DETAIL", "ROLLBACK"], `${path}/evidenceKind`, parser),
    freshness: enumAt(object.freshness, ["CURRENT", "STALE", "CONFLICTED", "MISSING", "POLICY_PENDING"], `${path}/freshness`, parser),
    observedAt: timestampAt(object.observedAt, `${path}/observedAt`, parser),
    verifiedAt: timestampAt(object.verifiedAt, `${path}/verifiedAt`, parser),
    expiresAt: timestampAt(object.expiresAt, `${path}/expiresAt`, parser),
    artifactRef: parseArtifactRef(object.artifactRef, `${path}/artifactRef`, parser),
    artifactDigest: shaAt(object.artifactDigest, `${path}/artifactDigest`, parser),
  };
  return hasAll(evidence) ? evidence as ExactTargetEvidence : null;
}

function parseArtifactRef(value: JsonValue | undefined, path: string, parser: Parser): ArtifactRef | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["path", "digest", "status"]), path, parser);
  const artifact = {
    path: artifactPathAt(object.path, `${path}/path`, parser),
    digest: shaAt(object.digest, `${path}/digest`, parser),
    status: enumAt(object.status, ["SETTLED", "POLICY_PENDING", "EVIDENCE_PENDING"], `${path}/status`, parser),
  };
  return hasAll(artifact) ? artifact as ArtifactRef : null;
}

function parseValidationSummary(value: JsonValue | undefined, path: string, parser: Parser): ExactTargetValidationSummary | null {
  const object = objectAt(value, path, parser);
  if (!object) return null;
  rejectUnknown(object, new Set(["validatedAt", "validatorRef", "completeness", "blockerCodes"]), path, parser);
  const summary = {
    validatedAt: timestampAt(object.validatedAt, `${path}/validatedAt`, parser),
    validatorRef: safeTokenAt(object.validatorRef, `${path}/validatorRef`, parser),
    completeness: arrayAt(object.completeness, `${path}/completeness`, parser, (entry, entryPath) => {
      const row = objectAt(entry, entryPath, parser);
      if (!row) return null;
      rejectUnknown(row, new Set(["workloadClass", "status", "evidenceRefs"]), entryPath, parser);
      const parsed = {
        workloadClass: enumAt(row.workloadClass, EXACT_TARGET_WORKLOAD_CLASSES, `${entryPath}/workloadClass`, parser),
        status: enumAt(row.status, ["COMPLETE", "BLOCKED"], `${entryPath}/status`, parser),
        evidenceRefs: stringArrayAt(row.evidenceRefs, `${entryPath}/evidenceRefs`, parser, { inventoryRef: true, min: 1 }),
      };
      return hasAll(parsed) ? parsed as ExactTargetValidationSummary["completeness"][number] : null;
    }),
    blockerCodes: arrayAt(object.blockerCodes, `${path}/blockerCodes`, parser, (entry, entryPath) => enumAt(entry, [
      "INVALID_JSON",
      "DUPLICATE_JSON_KEY",
      "STRUCTURAL_LIMIT",
      "UNKNOWN_FIELD",
      "REQUIRED_FIELD",
      "INVALID_VALUE",
      "INVALID_TIMESTAMP",
      "INVALID_DIGEST",
      "INVALID_UUID",
      "INVALID_REFERENCE",
      "DERIVED_REF_MISMATCH",
      "DERIVED_DIGEST_MISMATCH",
      "DUPLICATE_IDENTITY",
      "MISSING_WORKLOAD_COVERAGE",
      "CLAIM_MISMATCH",
      "POLICY_PENDING",
      "AUTHORITY_UNPROVEN",
      "RETIREMENT_NOT_BLOCKED",
      "LIFECYCLE_NOT_SELECTABLE",
      "STALE_OR_EXPIRED",
      "SECRET_SENTINEL",
      "ISSUE_LIMIT",
    ], entryPath, parser)),
  };
  return hasAll(summary) ? summary as ExactTargetValidationSummary : null;
}

function validateSemanticContract(snapshot: Omit<ExactTargetInventorySnapshot, "derived">, now: number): SchemaIssue[] {
  const parser = createParser();
  const generatedAt = parseTimestamp(snapshot.generatedAt)!;
  const validFrom = parseTimestamp(snapshot.validFrom)!;
  const expiresAt = parseTimestamp(snapshot.expiresAt)!;
  if (validFrom > generatedAt || generatedAt > now || now >= expiresAt) parser.add("STALE_OR_EXPIRED", "/generatedAt");
  for (const ref of [snapshot.policyRef, snapshot.dispositionRef, snapshot.collectorContractRef]) {
    if (ref.status !== "SETTLED") parser.add("POLICY_PENDING", "/artifactRef/status");
  }
  if (snapshot.collectorArtifactDigest !== snapshot.collectorContractRef.digest) parser.add("DERIVED_DIGEST_MISMATCH", "/collectorArtifactDigest");

  const recordByRef = new Map<string, ExactTargetRecord>();
  const evidenceByRef = new Map<string, ExactTargetEvidence>();
  const inventoryKeys = new Set<string>();
  const recordIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const recordPathByRef = new Map<string, string>();
  for (const [recordIndex, record] of snapshot.records.entries()) {
    const recordPath = `/records/${recordIndex}`;
    recordPathByRef.set(record.inventoryRef, recordPath);
    const expectedKey = deriveExactTargetInventoryKey({
      recordType: record.recordType,
      workloadId: record.workloadId,
      environmentId: record.environmentId,
      provider: record.provider ?? null,
      detail: record.detail,
    });
    if (!expectedKey || record.inventoryKey !== expectedKey) parser.add("DERIVED_REF_MISMATCH", `${recordPath}/inventoryKey`, record.inventoryRef);
    if (!expectedKey || record.inventoryRef !== deriveInventoryRef(expectedKey)) parser.add("DERIVED_REF_MISMATCH", `${recordPath}/inventoryRef`, record.inventoryRef);
    if (record.recordDigest !== sha256Hex(canonicalJson(recordDigestInput(record)))) parser.add("DERIVED_DIGEST_MISMATCH", `${recordPath}/recordDigest`, record.inventoryRef);
    if (inventoryKeys.has(record.inventoryKey) || recordByRef.has(record.inventoryRef) || recordIds.has(record.recordId)) {
      parser.add("DUPLICATE_IDENTITY", `${recordPath}/inventoryRef`, record.inventoryRef);
    }
    inventoryKeys.add(record.inventoryKey);
    recordByRef.set(record.inventoryRef, record);
    recordIds.add(record.recordId);
    validateRecordChronology(record, generatedAt, now, parser, recordPath);
    validateRootDetailAgreement(record, parser, recordPath);
  }

  for (const [evidenceIndex, evidence] of snapshot.evidence.entries()) {
    const evidencePath = `/evidence/${evidenceIndex}`;
    const expectedRef = deriveEvidenceRef({
      evidenceId: evidence.evidenceId,
      sourceRecordRef: evidence.sourceRecordRef,
      artifactDigest: evidence.artifactDigest,
    });
    if (expectedRef !== evidence.evidenceRef) parser.add("DERIVED_REF_MISMATCH", `${evidencePath}/evidenceRef`, evidence.evidenceRef);
    if (evidence.artifactDigest !== evidence.artifactRef.digest) parser.add("DERIVED_DIGEST_MISMATCH", `${evidencePath}/artifactDigest`, evidence.evidenceRef);
    if (evidenceByRef.has(evidence.evidenceRef)) parser.add("DUPLICATE_IDENTITY", `${evidencePath}/evidenceRef`, evidence.evidenceRef);
    if (evidenceIds.has(evidence.evidenceId)) parser.add("DUPLICATE_IDENTITY", `${evidencePath}/evidenceId`, evidence.evidenceRef);
    evidenceByRef.set(evidence.evidenceRef, evidence);
    evidenceIds.add(evidence.evidenceId);
    validateEvidenceChronology(evidence, generatedAt, now, parser, evidencePath);
    const source = recordByRef.get(evidence.sourceRecordRef);
    if (!source || source.recordType !== evidence.sourceRecordType || source.workloadId !== evidence.workloadId || source.environmentId !== evidence.environmentId) {
      parser.add("INVALID_REFERENCE", `${evidencePath}/sourceRecordRef`, evidence.evidenceRef);
    }
    const sourceClass = source ? workloadClassForRecord({ records: snapshot.records } as ExactTargetInventorySnapshot, source) : null;
    if (sourceClass !== evidence.workloadClass) {
      parser.add("INVALID_REFERENCE", `${evidencePath}/workloadClass`, evidence.evidenceRef);
    }
  }

  const roots = validateTargetRoots(snapshot, recordByRef, recordPathByRef, parser);
  const relationships = validateRelationshipGraph(snapshot, recordByRef, recordPathByRef, roots, parser);
  validateRollbackCoverage(snapshot, recordByRef, recordPathByRef, relationships.byKey, parser);
  const proofRegistry = createEvidenceUseRegistry(
    evidenceByRef,
    (record) => workloadClassForRecord({ records: snapshot.records } as ExactTargetInventorySnapshot, record),
    parser,
  );
  for (const [recordIndex, record] of snapshot.records.entries()) {
    validateRecordReferences(
      record,
      recordByRef,
      evidenceByRef,
      parser,
      `/records/${recordIndex}`,
      new Set([snapshot.validationSummary.validatorRef, snapshot.collectorContractRef.path, snapshot.collectorArtifactDigest]),
    );
    registerRecordEvidenceClaims(record, proofRegistry, `/records/${recordIndex}`);
  }
  for (const [relationshipIndex, relationship] of snapshot.relationships.entries()) {
    const relationshipPath = `/relationships/${relationshipIndex}`;
    const from = recordByRef.get(relationship.fromRecordRef);
    const to = recordByRef.get(relationship.toRecordRef);
    if (!from || !to || from.workloadId !== to.workloadId || from.environmentId !== to.environmentId) {
      parser.add("INVALID_REFERENCE", `${relationshipPath}/fromRecordRef`);
    }
    if (from) proofRegistry.claimList(relationship.evidenceRefs, from, "RELATIONSHIP", `${relationshipPath}/evidenceRefs`, `relationship:${relationship.relationshipId}`);
  }

  const digest = sha256Hex(canonicalJson(documentDigestInput({ ...snapshot, derived: emptyDerived() } as ExactTargetInventorySnapshot)));
  if (snapshot.documentDigest !== digest) parser.add("DERIVED_DIGEST_MISMATCH", "/documentDigest");

  validateSummary(snapshot, roots, proofRegistry, parser);
  proofRegistry.finish();
  return parser.issues;
}

function validateTargetRoots(
  snapshot: Omit<ExactTargetInventorySnapshot, "derived">,
  recordByRef: Map<string, ExactTargetRecord>,
  recordPathByRef: Map<string, string>,
  parser: Parser,
): Map<ExactTargetWorkloadClass, TargetRoot> {
  const roots = new Map<ExactTargetWorkloadClass, TargetRoot>();
  const workloadsByClass = new Map<ExactTargetWorkloadClass, ExactTargetRecord[]>();
  const tupleClass = new Map<string, ExactTargetWorkloadClass>();
  for (const record of snapshot.records) {
    if (record.recordType !== "WORKLOAD") continue;
    const workloadClass = (record.detail as WorkloadDetail).workloadClass;
    const workloads = workloadsByClass.get(workloadClass) ?? [];
    workloads.push(record);
    workloadsByClass.set(workloadClass, workloads);
    const tuple = targetTuple(record);
    const existingClass = tupleClass.get(tuple);
    if (existingClass && existingClass !== workloadClass) parser.add("DUPLICATE_IDENTITY", `${recordPathByRef.get(record.inventoryRef) ?? "/records"}/workload/workloadClass`);
    tupleClass.set(tuple, workloadClass);
  }

  for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) {
    const workloads = workloadsByClass.get(workloadClass) ?? [];
    if (workloads.length === 0) {
      parser.add("MISSING_WORKLOAD_COVERAGE", "/records");
      continue;
    }
    if (workloads.length > 1) {
      parser.add("DUPLICATE_IDENTITY", `${recordPathByRef.get(workloads[1].inventoryRef) ?? "/records"}/workload/workloadClass`, workloads[1].inventoryRef);
      continue;
    }
    const workload = workloads[0];
    const environments = snapshot.records.filter((record) => record.recordType === "ENVIRONMENT" && targetTuple(record) === targetTuple(workload));
    if (environments.length === 0) {
      parser.add("MISSING_WORKLOAD_COVERAGE", `${recordPathByRef.get(workload.inventoryRef) ?? "/records"}/environment`, workload.inventoryRef);
      continue;
    }
    if (environments.length > 1) {
      parser.add("DUPLICATE_IDENTITY", `${recordPathByRef.get(environments[1].inventoryRef) ?? "/records"}/environment`, environments[1].inventoryRef);
      continue;
    }
    const records = snapshot.records.filter((record) => targetTuple(record) === targetTuple(workload));
    roots.set(workloadClass, {
      workloadClass,
      workload,
      environment: environments[0],
      records,
      recordRefs: new Set(records.map((record) => record.inventoryRef)),
    });
  }

  for (const record of snapshot.records) {
    const matchingRoots = [...roots.values()].filter((root) => root.workload.workloadId === record.workloadId && root.workload.environmentId === record.environmentId);
    if (matchingRoots.length !== 1 || !recordByRef.has(record.inventoryRef)) {
      parser.add("INVALID_REFERENCE", `${recordPathByRef.get(record.inventoryRef) ?? "/records"}/workloadId`, record.inventoryRef);
    }
  }
  return roots;
}

function validateRelationshipGraph(
  snapshot: Omit<ExactTargetInventorySnapshot, "derived">,
  recordByRef: Map<string, ExactTargetRecord>,
  recordPathByRef: Map<string, string>,
  roots: Map<ExactTargetWorkloadClass, TargetRoot>,
  parser: Parser,
): { byKey: Set<string> } {
  const byKey = new Set<string>();
  const relationshipIds = new Set<string>();
  const relationshipTuples = new Set<string>();
  for (const [index, relationship] of snapshot.relationships.entries()) {
    const path = `/relationships/${index}`;
    const from = recordByRef.get(relationship.fromRecordRef);
    const to = recordByRef.get(relationship.toRecordRef);
    if (relationshipIds.has(relationship.relationshipId)) parser.add("DUPLICATE_IDENTITY", `${path}/relationshipId`);
    relationshipIds.add(relationship.relationshipId);
    const tuple = relationshipKey(relationship.relationshipType, relationship.fromRecordRef, relationship.toRecordRef);
    if (relationshipTuples.has(tuple)) parser.add("DUPLICATE_IDENTITY", `${path}/relationshipType`);
    relationshipTuples.add(tuple);
    if (relationship.fromRecordRef === relationship.toRecordRef) parser.add("INVALID_REFERENCE", `${path}/toRecordRef`);
    if (!from || !to) continue;
    if (!isAllowedRelationship(relationship.relationshipType, from.recordType, to.recordType)) {
      parser.add("INVALID_REFERENCE", `${path}/relationshipType`, relationship.fromRecordRef);
    }
    byKey.add(tuple);
  }

  const expected = new Map<string, RelationshipExpectation>();
  const add = (expectation: RelationshipExpectation) => {
    expected.set(relationshipKey(expectation.type, expectation.fromRecordRef, expectation.toRecordRef), expectation);
  };

  for (const root of roots.values()) {
    add({ type: "OWNS", fromRecordRef: root.workload.inventoryRef, toRecordRef: root.environment.inventoryRef, path: `${recordPathByRef.get(root.workload.inventoryRef) ?? "/records"}/workload` });
    for (const record of root.records) {
      if (record.inventoryRef !== root.workload.inventoryRef && record.inventoryRef !== root.environment.inventoryRef) {
        add({ type: "OWNS", fromRecordRef: root.environment.inventoryRef, toRecordRef: record.inventoryRef, path: `${recordPathByRef.get(record.inventoryRef) ?? "/records"}/ownerRef` });
      }
    }
  }

  for (const record of snapshot.records) {
    for (const relation of expectedDetailRelationships(record)) add(relation);
  }

  for (const [key, expectation] of expected) {
    if (!byKey.has(key)) parser.add("INVALID_REFERENCE", expectation.path, expectation.fromRecordRef);
  }
  for (const [index, relationship] of snapshot.relationships.entries()) {
    const key = relationshipKey(relationship.relationshipType, relationship.fromRecordRef, relationship.toRecordRef);
    if (!expected.has(key)) parser.add("CLAIM_MISMATCH", `/relationships/${index}/relationshipType`, relationship.fromRecordRef);
  }

  for (const root of roots.values()) {
    const reachable = new Set<string>();
    const stack = [root.workload.inventoryRef];
    while (stack.length > 0) {
      const ref = stack.pop()!;
      if (reachable.has(ref)) continue;
      reachable.add(ref);
      for (const relationship of snapshot.relationships) {
        if (relationship.relationshipType === "OWNS" && relationship.fromRecordRef === ref) stack.push(relationship.toRecordRef);
      }
    }
    for (const ref of root.recordRefs) {
      if (!reachable.has(ref)) parser.add("INVALID_REFERENCE", `${recordPathByRef.get(ref) ?? "/records"}/ownerRef`, ref);
    }
    for (const ref of reachable) {
      if (!root.recordRefs.has(ref)) parser.add("INVALID_REFERENCE", `${recordPathByRef.get(ref) ?? "/records"}/ownerRef`, ref);
    }
  }

  return { byKey };
}

function validateRollbackCoverage(
  snapshot: Omit<ExactTargetInventorySnapshot, "derived">,
  recordByRef: Map<string, ExactTargetRecord>,
  recordPathByRef: Map<string, string>,
  relationshipKeys: Set<string>,
  parser: Parser,
): void {
  for (const record of snapshot.records) {
    if (!ROLLBACK_REQUIRED_TYPES.has(record.recordType)) continue;
    const assets = snapshot.records.filter((candidate) => candidate.recordType === "ROLLBACK_ASSET" && (candidate.detail as RollbackAssetDetail).targetRecordRef === record.inventoryRef);
    if (assets.length !== 1) {
      parser.add("INVALID_REFERENCE", `${recordPathByRef.get(record.inventoryRef) ?? "/records"}/rollbackAsset`, record.inventoryRef);
      continue;
    }
    if (!relationshipKeys.has(relationshipKey("HAS_ROLLBACK", record.inventoryRef, assets[0].inventoryRef))) {
      parser.add("INVALID_REFERENCE", `${recordPathByRef.get(record.inventoryRef) ?? "/records"}/rollbackAsset`, record.inventoryRef);
    }
    if (!recordByRef.has(assets[0].inventoryRef)) parser.add("INVALID_REFERENCE", `${recordPathByRef.get(assets[0].inventoryRef) ?? "/records"}/inventoryRef`, assets[0].inventoryRef);
  }
}

function expectedDetailRelationships(record: ExactTargetRecord): RelationshipExpectation[] {
  const path = (suffix: string) => `/records/detail/${record.recordType}/${suffix}`;
  const relation = (type: RelationshipType, fromRecordRef: string, toRecordRef: string, suffix: string): RelationshipExpectation => ({
    type,
    fromRecordRef,
    toRecordRef,
    path: path(suffix),
  });
  const detail = record.detail;
  switch (record.recordType) {
    case "WORKER": {
      const worker = detail as WorkerDetail;
      return [
        relation("USES_IMAGE", record.inventoryRef, worker.imageRef, "imageRef"),
        ...worker.queueRefs.map((ref) => relation("DEPENDS_ON", record.inventoryRef, ref, "queueRefs")),
        ...worker.dataStoreRefs.map((ref) => relation("DEPENDS_ON", record.inventoryRef, ref, "dataStoreRefs")),
        ...worker.objectStoreRefs.map((ref) => relation("DEPENDS_ON", record.inventoryRef, ref, "objectStoreRefs")),
        ...worker.credentialRefs.map((ref) => relation("USES_CREDENTIAL", record.inventoryRef, ref, "credentialRefs")),
      ];
    }
    case "SCHEDULER": {
      const scheduler = detail as SchedulerDetail;
      return [
        relation("DEPENDS_ON", record.inventoryRef, scheduler.targetWorkerRef, "targetWorkerRef"),
        ...scheduler.credentialRefs.map((ref) => relation("USES_CREDENTIAL", record.inventoryRef, ref, "credentialRefs")),
      ];
    }
    case "QUEUE": {
      const queue = detail as QueueDetail;
      return [
        ...queue.producerRefs.map((ref) => relation("DEPENDS_ON", ref, record.inventoryRef, "producerRefs")),
        ...queue.consumerRefs.map((ref) => relation("DEPENDS_ON", ref, record.inventoryRef, "consumerRefs")),
        ...queue.credentialRefs.map((ref) => relation("USES_CREDENTIAL", record.inventoryRef, ref, "credentialRefs")),
      ];
    }
    case "DOMAIN": {
      return [relation("EXPOSES_DOMAIN", (detail as DomainDetail).targetResourceRef, record.inventoryRef, "targetResourceRef")];
    }
    case "CALLBACK": {
      const callback = detail as CallbackDetail;
      return [
        relation("CALLS_BACK", callback.targetResourceRef, record.inventoryRef, "targetResourceRef"),
        ...callback.credentialRefs.map((ref) => relation("USES_CREDENTIAL", record.inventoryRef, ref, "credentialRefs")),
      ];
    }
    case "CREDENTIAL_REF": {
      return (detail as CredentialRefDetail).consumerResourceRefs.map((ref) => relation("USES_CREDENTIAL", ref, record.inventoryRef, "consumerResourceRefs"));
    }
    case "IMAGE": {
      return (detail as ImageDetail).consumerResourceRefs.map((ref) => relation("USES_IMAGE", ref, record.inventoryRef, "consumerResourceRefs"));
    }
    case "ROLLBACK_ASSET": {
      return [relation("HAS_ROLLBACK", (detail as RollbackAssetDetail).targetRecordRef, record.inventoryRef, "targetRecordRef")];
    }
    default:
      return [];
  }
}

function createEvidenceUseRegistry(
  evidenceByRef: Map<string, ExactTargetEvidence>,
  workloadClassForOwner: (record: ExactTargetRecord) => ExactTargetWorkloadClass | null,
  parser: Parser,
): {
  claimList(refs: string[], owner: ExactTargetRecord, expectedKind: EvidenceKind, path: string, useSite: string): void;
  finish(): void;
} {
  const consumed = new Map<string, string>();
  const claim = (ref: string, owner: ExactTargetRecord, expectedKind: EvidenceKind, path: string, useSite: string) => {
    const evidence = evidenceByRef.get(ref);
    const existing = consumed.get(ref);
    if (existing) {
      parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
    } else {
      consumed.set(ref, useSite);
    }
    if (!evidence) {
      parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
      return;
    }
    const ownerClass = workloadClassForOwner(owner);
    if (
      evidence.sourceRecordRef !== owner.inventoryRef ||
      evidence.sourceRecordType !== owner.recordType ||
      evidence.workloadId !== owner.workloadId ||
      evidence.environmentId !== owner.environmentId ||
      evidence.workloadClass !== ownerClass
    ) {
      parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
    }
    if (evidence.evidenceKind !== expectedKind) parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
    if (evidence.artifactRef.status !== "SETTLED") parser.add("POLICY_PENDING", path, owner.inventoryRef);
    if (evidence.artifactDigest !== evidence.artifactRef.digest) parser.add("DERIVED_DIGEST_MISMATCH", path, owner.inventoryRef);
    if (evidence.freshness !== "CURRENT") parser.add("STALE_OR_EXPIRED", path, owner.inventoryRef);
  };
  return {
    claimList(refs, owner, expectedKind, path, useSite) {
      const local = new Set<string>();
      for (const [index, ref] of refs.entries()) {
        if (local.has(ref)) parser.add("DUPLICATE_IDENTITY", `${path}/${index}`, owner.inventoryRef);
        local.add(ref);
        claim(ref, owner, expectedKind, `${path}/${index}`, `${useSite}:${index}`);
      }
    },
    finish() {
      for (const ref of evidenceByRef.keys()) {
        if (!consumed.has(ref)) parser.add("INVALID_REFERENCE", "/evidence");
      }
    },
  };
}

function registerRecordEvidenceClaims(
  record: ExactTargetRecord,
  registry: ReturnType<typeof createEvidenceUseRegistry>,
  recordPath: string,
): void {
  registry.claimList(record.evidenceRefs, record, "CAPTURE", `${recordPath}/evidenceRefs`, `record:${record.inventoryRef}:capture`);
  registry.claimList([record.lifecycle.stateEvidenceRef], record, "LIFECYCLE", `${recordPath}/lifecycle/stateEvidenceRef`, `record:${record.inventoryRef}:lifecycle`);
  for (const dimension of AUTHORITY_DIMENSIONS) {
    registry.claimList(record.authority[dimension].evidenceRefs, record, "AUTHORITY", `${recordPath}/authority/${dimension}/evidenceRefs`, `record:${record.inventoryRef}:authority:${dimension}`);
  }
  switch (record.recordType) {
    case "ENVIRONMENT":
      registry.claimList([(record.detail as EnvironmentDetail).policyEvidenceRef], record, "DETAIL", `${recordPath}/environment/policyEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "PROVIDER_RESOURCE":
      registry.claimList([(record.detail as ProviderResourceDetail).providerEvidenceRef], record, "DETAIL", `${recordPath}/resource/providerEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "DATA_STORE":
      registry.claimList([(record.detail as DataStoreDetail).bindingEvidenceRef], record, "DETAIL", `${recordPath}/dataStore/bindingEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "OBJECT_STORE":
      registry.claimList([(record.detail as ObjectStoreDetail).bindingEvidenceRef], record, "DETAIL", `${recordPath}/objectStore/bindingEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "DOMAIN":
      registry.claimList([(record.detail as DomainDetail).dnsEvidenceRef], record, "DETAIL", `${recordPath}/domain/dnsEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "CALLBACK":
      registry.claimList([(record.detail as CallbackDetail).externalConfigurationEvidenceRef], record, "DETAIL", `${recordPath}/callback/externalConfigurationEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "CREDENTIAL_REF":
      registry.claimList([(record.detail as CredentialRefDetail).rotationEvidenceRef], record, "DETAIL", `${recordPath}/credentialRef/rotationEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "IMAGE":
      registry.claimList([(record.detail as ImageDetail).buildProvenanceEvidenceRef], record, "DETAIL", `${recordPath}/image/buildProvenanceEvidenceRef`, `record:${record.inventoryRef}:detail`);
      break;
    case "ROLLBACK_ASSET":
      registry.claimList([(record.detail as RollbackAssetDetail).evidenceRef], record, "ROLLBACK", `${recordPath}/rollbackAsset/evidenceRef`, `record:${record.inventoryRef}:rollback`);
      break;
    case "GAP":
      registry.claimList([(record.detail as GapDetail).evidenceRef], record, "DETAIL", `${recordPath}/gap/evidenceRef`, `record:${record.inventoryRef}:gap`);
      break;
  }
}

function isAllowedRelationship(type: RelationshipType, from: ExactTargetRecordType, to: ExactTargetRecordType): boolean {
  switch (type) {
    case "OWNS":
      return (from === "WORKLOAD" && to === "ENVIRONMENT") || (from === "ENVIRONMENT" && to !== "WORKLOAD");
    case "DEPENDS_ON":
      return (from === "WORKER" && (to === "DATA_STORE" || to === "OBJECT_STORE" || to === "QUEUE")) || (from === "SCHEDULER" && (to === "WORKER" || to === "QUEUE"));
    case "USES_CREDENTIAL":
      return CREDENTIAL_CONSUMER_TYPES.has(from) && to === "CREDENTIAL_REF";
    case "USES_IMAGE":
      return IMAGE_CONSUMER_TYPES.has(from) && to === "IMAGE";
    case "HAS_ROLLBACK":
      return ROLLBACK_REQUIRED_TYPES.has(from) && to === "ROLLBACK_ASSET";
    case "EXPOSES_DOMAIN":
      return (from === "PROVIDER_RESOURCE" || from === "CALLBACK") && to === "DOMAIN";
    case "CALLS_BACK":
      return (from === "PROVIDER_RESOURCE" || from === "WORKER") && to === "CALLBACK";
  }
}

function relationshipKey(type: RelationshipType, fromRecordRef: string, toRecordRef: string): string {
  return `${type}:${fromRecordRef}:${toRecordRef}`;
}

function targetTuple(record: Pick<ExactTargetRecord, "workloadId" | "environmentId">): string {
  return `${record.workloadId}:${record.environmentId}`;
}

function selectTargetRoot(snapshot: ExactTargetInventorySnapshot, workloadClass: ExactTargetWorkloadClass): { workload: ExactTargetRecord; environment: ExactTargetRecord } | null {
  const workloads = snapshot.records.filter((record) => record.recordType === "WORKLOAD" && (record.detail as WorkloadDetail).workloadClass === workloadClass);
  if (workloads.length !== 1) return null;
  const workload = workloads[0];
  const environments = snapshot.records.filter((record) => record.recordType === "ENVIRONMENT" && record.workloadId === workload.workloadId && record.environmentId === workload.environmentId);
  if (environments.length !== 1) return null;
  return { workload, environment: environments[0] };
}

function reachableOwnedRefs(relationships: readonly ExactTargetRelationship[], workloadRef: string): Set<string> {
  const refs = new Set<string>();
  const stack = [workloadRef];
  while (stack.length > 0) {
    const ref = stack.pop()!;
    if (refs.has(ref)) continue;
    refs.add(ref);
    for (const relationship of relationships) {
      if (relationship.relationshipType === "OWNS" && relationship.fromRecordRef === ref) stack.push(relationship.toRecordRef);
    }
  }
  return refs;
}

function validateRecordChronology(record: ExactTargetRecord, generatedAt: number, now: number, parser: Parser, recordPath: string): void {
  const first = parseTimestamp(record.firstObservedAt)!;
  const last = parseTimestamp(record.lastObservedAt)!;
  const verified = parseTimestamp(record.verifiedAt)!;
  const expires = parseTimestamp(record.expiresAt)!;
  if (first > last || last > verified || verified > generatedAt || verified > now || now >= expires) {
    parser.add("STALE_OR_EXPIRED", `${recordPath}/verifiedAt`, record.inventoryRef);
  }
  const stateObserved = parseTimestamp(record.lifecycle.stateObservedAt)!;
  const decidedAt = parseTimestamp(record.disposition.decidedAt)!;
  if (stateObserved > generatedAt || decidedAt > generatedAt) parser.add("STALE_OR_EXPIRED", `${recordPath}/lifecycle/stateObservedAt`, record.inventoryRef);
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const authority = record.authority[dimension];
    const observed = parseTimestamp(authority.observedAt)!;
    const verifiedAt = parseTimestamp(authority.verifiedAt)!;
    const expiresAt = parseTimestamp(authority.expiresAt)!;
    if (observed > verifiedAt || verifiedAt > generatedAt || now >= expiresAt) {
      parser.add("STALE_OR_EXPIRED", `${recordPath}/authority/${dimension}`, record.inventoryRef);
    }
  }
  if (record.recordType === "ROLLBACK_ASSET") {
    const detail = record.detail as RollbackAssetDetail;
    const created = parseTimestamp(detail.createdAt)!;
    const verifiedRollback = parseTimestamp(detail.verifiedAt)!;
    const restoreTested = parseTimestamp(detail.restoreTestedAt)!;
    const retainUntil = parseTimestamp(detail.retainUntil)!;
    if (created > verifiedRollback || verifiedRollback > restoreTested || restoreTested > generatedAt || now >= retainUntil) {
      parser.add("STALE_OR_EXPIRED", `${recordPath}/rollbackAsset/retainUntil`, record.inventoryRef);
    }
  }
}

function validateEvidenceChronology(evidence: ExactTargetEvidence, generatedAt: number, now: number, parser: Parser, evidencePath: string): void {
  const observed = parseTimestamp(evidence.observedAt)!;
  const verified = parseTimestamp(evidence.verifiedAt)!;
  const expires = parseTimestamp(evidence.expiresAt)!;
  if (observed > verified || verified > generatedAt || verified > now || now >= expires) {
    parser.add("STALE_OR_EXPIRED", `${evidencePath}/verifiedAt`, evidence.evidenceRef);
  }
}

function validateRootDetailAgreement(record: ExactTargetRecord, parser: Parser, recordPath: string): void {
  if (record.recordType === "WORKLOAD" && record.workloadId !== (record.detail as WorkloadDetail).workloadId) {
    parser.add("CLAIM_MISMATCH", `${recordPath}/workload/workloadId`, record.inventoryRef);
  }
  if (record.recordType === "ENVIRONMENT") {
    const detail = record.detail as EnvironmentDetail;
    if (record.environmentId !== detail.environmentId || record.workloadId !== detail.workloadId) {
      parser.add("CLAIM_MISMATCH", `${recordPath}/environment/environmentId`, record.inventoryRef);
    }
  }
}

function validateRecordReferences(
  record: ExactTargetRecord,
  recordByRef: Map<string, ExactTargetRecord>,
  evidenceByRef: Map<string, ExactTargetEvidence>,
  parser: Parser,
  recordPath: string,
  reservedVerifierRefs: Set<string>,
): void {
  const workloadClass = workloadClassForRecord({ records: [...recordByRef.values()] } as ExactTargetInventorySnapshot, record);
  validateEvidenceRefs(collectRecordEvidenceRefs(record), record, evidenceByRef, `${recordPath}/evidenceRefs`, parser, { requireCurrent: true, workloadClass });
  for (const dimension of AUTHORITY_DIMENSIONS) {
    validateEvidenceRefs(record.authority[dimension].evidenceRefs, record, evidenceByRef, `${recordPath}/authority/${dimension}/evidenceRefs`, parser, { requireCurrent: true, workloadClass });
  }
  validateAuthorityIndependence(record, evidenceByRef, parser, recordPath, reservedVerifierRefs);
  const detail = record.detail;
  switch (record.recordType) {
    case "WORKER": {
      const worker = detail as WorkerDetail;
      validateRecordRefs([worker.imageRef], record, recordByRef, `${recordPath}/worker/imageRef`, parser, { allowedTypes: IMAGE_CONSUMER_TYPES.has("WORKER") ? new Set<ExactTargetRecordType>(["IMAGE"]) : new Set() });
      validateRecordRefs(worker.queueRefs, record, recordByRef, `${recordPath}/worker/queueRefs`, parser, { allowedTypes: new Set(["QUEUE"]) });
      validateRecordRefs(worker.dataStoreRefs, record, recordByRef, `${recordPath}/worker/dataStoreRefs`, parser, { allowedTypes: new Set(["DATA_STORE"]) });
      validateRecordRefs(worker.objectStoreRefs, record, recordByRef, `${recordPath}/worker/objectStoreRefs`, parser, { allowedTypes: new Set(["OBJECT_STORE"]) });
      validateRecordRefs(worker.credentialRefs, record, recordByRef, `${recordPath}/worker/credentialRefs`, parser, { allowedTypes: new Set(["CREDENTIAL_REF"]) });
      break;
    }
    case "SCHEDULER": {
      const scheduler = detail as SchedulerDetail;
      validateRecordRefs([scheduler.targetWorkerRef], record, recordByRef, `${recordPath}/scheduler/targetWorkerRef`, parser, { allowedTypes: new Set(["WORKER"]) });
      validateRecordRefs(scheduler.credentialRefs, record, recordByRef, `${recordPath}/scheduler/credentialRefs`, parser, { allowedTypes: new Set(["CREDENTIAL_REF"]) });
      break;
    }
    case "QUEUE": {
      const queue = detail as QueueDetail;
      validateRecordRefs(queue.producerRefs, record, recordByRef, `${recordPath}/queue/producerRefs`, parser, { allowedTypes: new Set(["WORKER", "SCHEDULER"]) });
      validateRecordRefs(queue.consumerRefs, record, recordByRef, `${recordPath}/queue/consumerRefs`, parser, { allowedTypes: new Set(["WORKER"]) });
      validateRecordRefs(queue.credentialRefs, record, recordByRef, `${recordPath}/queue/credentialRefs`, parser, { allowedTypes: new Set(["CREDENTIAL_REF"]) });
      break;
    }
    case "DOMAIN": {
      const domain = detail as DomainDetail;
      validateRecordRefs([domain.targetResourceRef], record, recordByRef, `${recordPath}/domain/targetResourceRef`, parser, { allowedTypes: new Set(["PROVIDER_RESOURCE", "CALLBACK"]) });
      break;
    }
    case "CALLBACK": {
      const callback = detail as CallbackDetail;
      validateRecordRefs([callback.targetResourceRef], record, recordByRef, `${recordPath}/callback/targetResourceRef`, parser, { allowedTypes: new Set(["WORKER", "PROVIDER_RESOURCE"]) });
      validateRecordRefs(callback.credentialRefs, record, recordByRef, `${recordPath}/callback/credentialRefs`, parser, { allowedTypes: new Set(["CREDENTIAL_REF"]) });
      break;
    }
    case "CREDENTIAL_REF": {
      validateRecordRefs((detail as CredentialRefDetail).consumerResourceRefs, record, recordByRef, `${recordPath}/credentialRef/consumerResourceRefs`, parser, { allowedTypes: CREDENTIAL_CONSUMER_TYPES });
      break;
    }
    case "IMAGE": {
      validateRecordRefs((detail as ImageDetail).consumerResourceRefs, record, recordByRef, `${recordPath}/image/consumerResourceRefs`, parser, { allowedTypes: IMAGE_CONSUMER_TYPES });
      break;
    }
    case "ROLLBACK_ASSET": {
      validateRecordRefs([(detail as RollbackAssetDetail).targetRecordRef], record, recordByRef, `${recordPath}/rollbackAsset/targetRecordRef`, parser, { allowedTypes: new Set(["DATA_STORE", "OBJECT_STORE", "WORKER", "PROVIDER_RESOURCE"]) });
      break;
    }
    case "GAP": {
      const gap = detail as GapDetail;
      if (workloadClass !== gap.workloadClass) parser.add("CLAIM_MISMATCH", `${recordPath}/gap/workloadClass`, record.inventoryRef);
      break;
    }
  }
}

function validateAuthorityIndependence(
  record: ExactTargetRecord,
  evidenceByRef: Map<string, ExactTargetEvidence>,
  parser: Parser,
  recordPath: string,
  reservedVerifierRefs: Set<string>,
): void {
  const nonAuthorityRefs = new Set(collectNonAuthorityEvidenceRefs(record));
  const authorityRefs = new Map<string, ExactTargetAuthorityDimensionName>();
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const authority = record.authority[dimension];
    const dimensionPath = `${recordPath}/authority/${dimension}`;
    if (reservedVerifierRefs.has(authority.independentVerifierRef) || authority.independentVerifierRef === record.ownerRef || authority.independentVerifierRef === record.disposition.decisionOwner) {
      parser.add("AUTHORITY_UNPROVEN", `${dimensionPath}/independentVerifierRef`, record.inventoryRef);
    }
    if (authority.verdict !== "PROVEN") continue;
    for (const ref of authority.evidenceRefs) {
      const evidence = evidenceByRef.get(ref);
      if (nonAuthorityRefs.has(ref) || evidence?.evidenceKind !== "AUTHORITY") {
        parser.add("AUTHORITY_UNPROVEN", `${dimensionPath}/evidenceRefs`, record.inventoryRef);
      }
      const priorDimension = authorityRefs.get(ref);
      if (priorDimension && priorDimension !== dimension) {
        parser.add("AUTHORITY_UNPROVEN", `${dimensionPath}/evidenceRefs`, record.inventoryRef);
      }
      authorityRefs.set(ref, dimension);
    }
  }
}

function validateRecordRefs(
  refs: string[],
  owner: ExactTargetRecord,
  recordByRef: Map<string, ExactTargetRecord>,
  path: string,
  parser: Parser,
  options: { allowedTypes: Set<ExactTargetRecordType> },
): void {
  for (const ref of refs) {
    const target = recordByRef.get(ref);
    if (!target || !options.allowedTypes.has(target.recordType) || target.workloadId !== owner.workloadId || target.environmentId !== owner.environmentId) {
      parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
    }
  }
}

function validateEvidenceRefs(
  refs: string[],
  owner: ExactTargetRecord | null,
  evidenceByRef: Map<string, ExactTargetEvidence>,
  path: string,
  parser: Parser,
  options: { requireCurrent: boolean; workloadClass?: ExactTargetWorkloadClass | null },
): void {
  for (const ref of refs) {
    const evidence = evidenceByRef.get(ref);
    if (!evidence) {
      parser.add("INVALID_REFERENCE", path, owner?.inventoryRef);
      continue;
    }
    if (owner && (evidence.workloadId !== owner.workloadId || evidence.environmentId !== owner.environmentId || evidence.workloadClass !== options.workloadClass)) {
      parser.add("INVALID_REFERENCE", path, owner.inventoryRef);
    }
    if (options.requireCurrent && evidence.freshness !== "CURRENT") {
      parser.add("STALE_OR_EXPIRED", path, owner?.inventoryRef ?? evidence.evidenceRef);
    }
  }
}

function validateSummary(
  snapshot: Omit<ExactTargetInventorySnapshot, "derived">,
  roots: Map<ExactTargetWorkloadClass, TargetRoot>,
  registry: ReturnType<typeof createEvidenceUseRegistry>,
  parser: Parser,
): void {
  const validatedAt = parseTimestamp(snapshot.validationSummary.validatedAt)!;
  const generatedAt = parseTimestamp(snapshot.generatedAt)!;
  if (validatedAt > generatedAt) parser.add("STALE_OR_EXPIRED", "/validationSummary/validatedAt");
  const rowsByClass = new Map<ExactTargetWorkloadClass, ExactTargetValidationSummary["completeness"][number]>();
  for (const [index, row] of snapshot.validationSummary.completeness.entries()) {
    const rowPath = `/validationSummary/completeness/${index}`;
    if (rowsByClass.has(row.workloadClass)) parser.add("DUPLICATE_IDENTITY", `${rowPath}/workloadClass`);
    rowsByClass.set(row.workloadClass, row);
    const root = roots.get(row.workloadClass);
    if (root) registry.claimList(row.evidenceRefs, root.workload, "COMPLETENESS", `${rowPath}/evidenceRefs`, `completeness:${row.workloadClass}`);
  }
  for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) {
    if (!rowsByClass.has(workloadClass)) parser.add("MISSING_WORKLOAD_COVERAGE", "/validationSummary/completeness");
  }
  const derived = deriveState({ ...snapshot, derived: emptyDerived() } as ExactTargetInventorySnapshot);
  for (const [index, row] of snapshot.validationSummary.completeness.entries()) {
    const expected = derived.targetBlockers[row.workloadClass].length === 0 ? "COMPLETE" : "BLOCKED";
    if (row.status !== expected) parser.add("CLAIM_MISMATCH", `/validationSummary/completeness/${index}/status`);
  }
  const expectedCodes = new Set(derived.blockerCodes);
  const claimedCodes = new Set(snapshot.validationSummary.blockerCodes);
  if (expectedCodes.size !== claimedCodes.size || [...expectedCodes].some((code) => !claimedCodes.has(code))) {
    parser.add("CLAIM_MISMATCH", "/validationSummary/blockerCodes");
  }
}

function deriveState(snapshot: ExactTargetInventorySnapshot): ExactTargetDerivedState {
  const recordBlockers: Record<string, ExactTargetInventoryBlockerCode[]> = {};
  const targetBlockers = Object.fromEntries(EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => [workloadClass, [] as ExactTargetInventoryBlockerCode[]])) as Record<ExactTargetWorkloadClass, ExactTargetInventoryBlockerCode[]>;
  for (const record of snapshot.records) {
    const blockers = deriveRecordBlockers(record);
    recordBlockers[record.inventoryRef] = blockers;
    const workloadClass = workloadClassForRecord(snapshot, record);
    if (workloadClass) {
      targetBlockers[workloadClass].push(...blockers);
      if (record.recordType === "GAP") targetBlockers[workloadClass].push((record.detail as GapDetail).blockerCode);
    }
  }
  for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) {
    const targetRecords = snapshot.records.filter((record) => workloadClassForRecord(snapshot, record) === workloadClass);
    if (!targetRecords.some((record) => record.recordType === "WORKLOAD") || !targetRecords.some((record) => record.recordType === "ENVIRONMENT")) {
      targetBlockers[workloadClass].push("MISSING_WORKLOAD_COVERAGE");
    }
    targetBlockers[workloadClass] = uniq(targetBlockers[workloadClass]);
  }
  const completeness = EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => ({
    workloadClass,
    status: targetBlockers[workloadClass].length === 0 ? "COMPLETE" as const : "BLOCKED" as const,
    blockerCodes: targetBlockers[workloadClass],
  }));
  const blockerCodes = uniq(completeness.flatMap((row) => row.blockerCodes));
  return {
    artifactValidity: "VALID",
    authorizationState: blockerCodes.length === 0 ? "INVENTORY_ONLY" : "BLOCKED",
    completeness,
    targetBlockers,
    recordBlockers,
    blockerCodes,
  };
}

function deriveRecordBlockers(record: ExactTargetRecord): ExactTargetInventoryBlockerCode[] {
  const blockers: ExactTargetInventoryBlockerCode[] = [];
  if (!SELECTABLE_LIFECYCLE_STATES.has(record.lifecycle.state) || record.lifecycle.releaseEligibility !== "ELIGIBLE" || record.lifecycle.provisioningState !== "SETTLED") {
    blockers.push("LIFECYCLE_NOT_SELECTABLE");
  }
  if (record.disposition.status !== "SETTLED" || record.disposition.decision === "DECISION_REQUIRED") {
    blockers.push("POLICY_PENDING");
  }
  if (record.detailKey === "dataStore" && (record.detail as DataStoreDetail).dataClass === "POLICY_PENDING") {
    blockers.push("POLICY_PENDING");
  }
  if (record.detailKey === "objectStore" && (record.detail as ObjectStoreDetail).dataClass === "POLICY_PENDING") {
    blockers.push("POLICY_PENDING");
  }
  let hasAuthorityBlocker = false;
  for (const dimension of AUTHORITY_DIMENSIONS) {
    const verdict = record.authority[dimension].verdict;
    if (BLOCKING_AUTHORITY_VERDICTS.has(verdict)) hasAuthorityBlocker = true;
  }
  if (hasAuthorityBlocker) blockers.push("AUTHORITY_UNPROVEN");
  const expectedAuthorizationState = blockers.length === 0 ? "INVENTORY_ONLY" : "BLOCKED";
  if (record.authority.authorizationState !== expectedAuthorizationState) {
    blockers.push("CLAIM_MISMATCH");
  }
  return uniq(blockers);
}

function emptyDerived(): ExactTargetDerivedState {
  return {
    artifactValidity: "VALID",
    authorizationState: "BLOCKED",
    completeness: [],
    targetBlockers: Object.fromEntries(EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => [workloadClass, []])) as unknown as Record<ExactTargetWorkloadClass, ExactTargetInventoryBlockerCode[]>,
    recordBlockers: {},
    blockerCodes: [],
  };
}

function projectValid(snapshot: ExactTargetInventorySnapshot): ExactTargetInventoryPublicProjection {
  return {
    schemaVersion: EXACT_TARGET_INVENTORY_SCHEMA_VERSION,
    documentDigest: snapshot.documentDigest,
    artifactValidity: "VALID",
    authorizationState: snapshot.derived.authorizationState,
    records: snapshot.records.map((record) => ({
      inventoryRef: record.inventoryRef,
      recordType: record.recordType,
      workloadClass: workloadClassForRecord(snapshot, record) ?? "UNKNOWN",
      blockerCodes: snapshot.derived.recordBlockers[record.inventoryRef] ?? [],
    })),
    completeness: snapshot.derived.completeness,
    blockerCodes: snapshot.derived.blockerCodes,
  };
}

function workloadClassForRecord(snapshot: Pick<ExactTargetInventorySnapshot, "records">, record: ExactTargetRecord): ExactTargetWorkloadClass | null {
  if (record.recordType === "WORKLOAD") return (record.detail as WorkloadDetail).workloadClass;
  const workload = snapshot.records.find((candidate) => candidate.recordType === "WORKLOAD" && candidate.workloadId === record.workloadId && candidate.environmentId === record.environmentId);
  return workload ? (workload.detail as WorkloadDetail).workloadClass : null;
}

function collectRecordEvidenceRefs(record: ExactTargetRecord): string[] {
  const refs = [
    ...collectNonAuthorityEvidenceRefs(record),
    ...AUTHORITY_DIMENSIONS.flatMap((dimension) => record.authority[dimension].evidenceRefs),
  ];
  return uniq(refs);
}

function collectNonAuthorityEvidenceRefs(record: ExactTargetRecord): string[] {
  const refs = [
    ...record.evidenceRefs,
    record.lifecycle.stateEvidenceRef,
  ];
  const detail = record.detail;
  switch (record.recordType) {
    case "ENVIRONMENT":
      refs.push((detail as EnvironmentDetail).policyEvidenceRef);
      break;
    case "PROVIDER_RESOURCE":
      refs.push((detail as ProviderResourceDetail).providerEvidenceRef);
      break;
    case "DATA_STORE":
      refs.push((detail as DataStoreDetail).bindingEvidenceRef);
      break;
    case "OBJECT_STORE":
      refs.push((detail as ObjectStoreDetail).bindingEvidenceRef);
      break;
    case "DOMAIN":
      refs.push((detail as DomainDetail).dnsEvidenceRef);
      break;
    case "CALLBACK":
      refs.push((detail as CallbackDetail).externalConfigurationEvidenceRef);
      break;
    case "CREDENTIAL_REF":
      refs.push((detail as CredentialRefDetail).rotationEvidenceRef);
      break;
    case "IMAGE":
      refs.push((detail as ImageDetail).buildProvenanceEvidenceRef);
      break;
    case "ROLLBACK_ASSET":
      refs.push((detail as RollbackAssetDetail).evidenceRef);
      break;
    case "GAP":
      refs.push((detail as GapDetail).evidenceRef);
      break;
  }
  return uniq(refs);
}

function detailIdentity(recordType: ExactTargetRecordType, detail: Partial<RecordDetail>): JsonValue[] | null {
  switch (recordType) {
    case "WORKLOAD":
      return isUuid((detail as Partial<WorkloadDetail>).workloadId) && isWorkloadClass((detail as Partial<WorkloadDetail>).workloadClass)
        ? ["workload", (detail as WorkloadDetail).workloadId, (detail as WorkloadDetail).workloadClass]
        : null;
    case "ENVIRONMENT":
      return isUuid((detail as Partial<EnvironmentDetail>).environmentId) && isUuid((detail as Partial<EnvironmentDetail>).workloadId)
        ? ["environment", (detail as EnvironmentDetail).workloadId, (detail as EnvironmentDetail).environmentId]
        : null;
    case "PROVIDER_RESOURCE":
      return hasStrings(detail, ["providerResourceId", "resourceKind"]) ? ["resource", (detail as ProviderResourceDetail).providerResourceId, (detail as ProviderResourceDetail).resourceKind] : null;
    case "DATA_STORE":
      return hasStrings(detail, ["providerResourceId", "databaseId"]) ? ["data-store", (detail as DataStoreDetail).providerResourceId, (detail as DataStoreDetail).databaseId] : null;
    case "OBJECT_STORE":
      return hasStrings(detail, ["providerResourceId", "bucketId"]) ? ["object-store", (detail as ObjectStoreDetail).providerResourceId, (detail as ObjectStoreDetail).bucketId] : null;
    case "WORKER":
      return hasStrings(detail, ["workerId"]) ? ["worker", (detail as WorkerDetail).workerId] : null;
    case "SCHEDULER":
      return hasStrings(detail, ["schedulerId"]) ? ["scheduler", (detail as SchedulerDetail).schedulerId] : null;
    case "QUEUE":
      return hasStrings(detail, ["queueId"]) ? ["queue", (detail as QueueDetail).queueId] : null;
    case "DOMAIN":
      return hasStrings(detail, ["fqdn"]) && isFqdn((detail as DomainDetail).fqdn) ? ["domain", (detail as DomainDetail).fqdn] : null;
    case "CALLBACK":
      return hasStrings(detail, ["callbackId"]) ? ["callback", (detail as CallbackDetail).callbackId] : null;
    case "CREDENTIAL_REF":
      return hasStrings(detail, ["credentialRefId"]) ? ["credential", (detail as CredentialRefDetail).credentialRefId] : null;
    case "IMAGE":
      return hasStrings(detail, ["imageDigest"]) && isSha256((detail as ImageDetail).imageDigest) ? ["image", (detail as ImageDetail).imageDigest] : null;
    case "ROLLBACK_ASSET":
      return hasStrings(detail, ["rollbackAssetId", "assetDigest"]) ? ["rollback", (detail as RollbackAssetDetail).rollbackAssetId, (detail as RollbackAssetDetail).assetDigest] : null;
    case "GAP":
      return hasStrings(detail, ["gapId"]) && isWorkloadClass((detail as GapDetail).workloadClass) ? ["gap", (detail as GapDetail).gapId, (detail as GapDetail).workloadClass] : null;
  }
}

function capturePlainJson(input: unknown): { ok: true; value: JsonValue } | { ok: false; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): JsonValue | undefined => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      issues.push({ code: "STRUCTURAL_LIMIT", path });
      return undefined;
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
        issues.push({ code: "STRUCTURAL_LIMIT", path });
        return undefined;
      }
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        issues.push({ code: "INVALID_VALUE", path });
        return undefined;
      }
      return value;
    }
    if (typeof value !== "object") {
      issues.push({ code: "INVALID_JSON", path });
      return undefined;
    }
    if (seen.has(value)) {
      issues.push({ code: "STRUCTURAL_LIMIT", path });
      return undefined;
    }
    seen.add(value);
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      issues.push({ code: "INVALID_JSON", path });
      return undefined;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      issues.push({ code: "UNKNOWN_FIELD", path: appendPath(path, "unknown-field") });
      return undefined;
    }
    if (Array.isArray(value)) {
      const ownKeys = Object.keys(descriptors);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > MAX_ARRAY_ITEMS) {
        issues.push({ code: "STRUCTURAL_LIMIT", path });
        return undefined;
      }
      const length = lengthDescriptor.value as number;
      const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
      if (ownKeys.some((key) => !expected.has(key)) || ownKeys.length !== expected.size) {
        issues.push({ code: "UNKNOWN_FIELD", path: appendPath(path, "unknown-field") });
        return undefined;
      }
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || "get" in descriptor || "set" in descriptor) {
          issues.push({ code: "INVALID_VALUE", path: appendPath(path, "0") });
          return undefined;
        }
        const child = visit(descriptor.value, `${path}/${index}`, depth + 1);
        if (child === undefined) return undefined;
        copy.push(child);
      }
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push({ code: "INVALID_JSON", path });
      return undefined;
    }
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_KEYS) {
      issues.push({ code: "STRUCTURAL_LIMIT", path });
      return undefined;
    }
    const copy: JsonObject = Object.create(null) as JsonObject;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || "get" in descriptor || "set" in descriptor || key.length > MAX_STRING_LENGTH) {
        issues.push({ code: "INVALID_VALUE", path: appendPath(path, "unknown-field") });
        return undefined;
      }
      const child = visit(descriptor.value, appendPath(path, "field"), depth + 1);
      if (child === undefined) return undefined;
      Object.defineProperty(copy, key, { value: child, enumerable: true, configurable: true, writable: true });
    }
    return copy;
  };
  const value = visit(input, "/", 0);
  if (issues.length > 0 || value === undefined) return { ok: false, issues };
  return { ok: true, value };
}

function findDuplicateJsonKey(input: string): boolean {
  const stack: Array<{ type: "object" | "array"; keys: Set<string>; expectingKey: boolean }> = [];
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(input[index] ?? "")) index += 1;
  };
  const readString = (): string | null => {
    if (input[index] !== "\"") return null;
    let raw = "\"";
    index += 1;
    while (index < input.length) {
      const char = input[index++];
      raw += char;
      if (char === "\\") {
        if (index < input.length) raw += input[index++];
        continue;
      }
      if (char === "\"") {
        try {
          return JSON.parse(raw) as string;
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  while (index < input.length) {
    skipWhitespace();
    const char = input[index];
    if (char === "{") {
      stack.push({ type: "object", keys: new Set(), expectingKey: true });
      index += 1;
      continue;
    }
    if (char === "[") {
      stack.push({ type: "array", keys: new Set(), expectingKey: false });
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      index += 1;
      continue;
    }
    const frame = stack[stack.length - 1];
    if (char === "," && frame?.type === "object") {
      frame.expectingKey = true;
      index += 1;
      continue;
    }
    if (char === ":" && frame?.type === "object") {
      frame.expectingKey = false;
      index += 1;
      continue;
    }
    if (char === "\"") {
      const text = readString();
      if (frame?.type === "object" && frame.expectingKey && text !== null) {
        if (frame.keys.has(text)) return true;
        frame.keys.add(text);
      }
      continue;
    }
    index += 1;
  }
  return false;
}

function objectAt(value: JsonValue | undefined, path: string, parser: Parser): JsonObject | null {
  if (!isPlainRecord(value)) {
    parser.add("REQUIRED_FIELD", path);
    return null;
  }
  return value;
}

function arrayAt<T>(value: JsonValue | undefined, path: string, parser: Parser, itemParser: (entry: JsonValue, path: string) => T | null): T[] {
  if (!Array.isArray(value)) {
    parser.add("REQUIRED_FIELD", path);
    return [];
  }
  return value.map((entry, index) => itemParser(entry, `${path}/${index}`)).filter((entry): entry is T => entry !== null);
}

function stringArrayAt(value: JsonValue | undefined, path: string, parser: Parser, options: { inventoryRef?: boolean; digest?: boolean; min?: number } = {}): string[] {
  const strings = arrayAt(value, path, parser, (entry, entryPath) => {
    const parsed = stringAt(entry, entryPath, parser);
    if (!parsed) return null;
    if (options.inventoryRef && !isInventoryRef(parsed)) parser.add("INVALID_VALUE", entryPath);
    if (options.digest && !isSha256(parsed)) parser.add("INVALID_DIGEST", entryPath);
    return parsed;
  });
  const seen = new Set<string>();
  for (const [index, entry] of strings.entries()) {
    if (seen.has(entry)) parser.add("DUPLICATE_IDENTITY", `${path}/${index}`);
    seen.add(entry);
  }
  if ((options.min ?? 0) > strings.length) parser.add("REQUIRED_FIELD", path);
  return strings;
}

function rejectUnknown(object: JsonObject, allowed: Set<string>, path: string, parser: Parser): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) parser.add("UNKNOWN_FIELD", appendPath(path, "unknown-field"));
  }
}

function appendPath(path: string, segment: string): string {
  return path === "/" ? `/${segment}` : `${path}/${segment}`;
}

function own(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function stringAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_LENGTH) {
    parser.add("REQUIRED_FIELD", path);
    return null;
  }
  if (containsSecretSentinel(value)) parser.add("SECRET_SENTINEL", path);
  return value;
}

function safeTokenAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(parsed)) parser.add("INVALID_VALUE", path);
  return parsed;
}

function safeIdentifierAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(parsed)) parser.add("INVALID_VALUE", path);
  return parsed;
}

function artifactPathAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!/^artifacts\/[a-z0-9][a-z0-9/_:.-]{0,180}$/.test(parsed) || parsed.includes("..")) parser.add("INVALID_VALUE", path);
  return parsed;
}

function opaqueFingerprintAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) parser.add("INVALID_DIGEST", path);
  return parsed;
}

function uuidAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!isUuid(parsed)) parser.add("INVALID_UUID", path);
  return parsed;
}

function shaAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!isSha256(parsed)) parser.add("INVALID_DIGEST", path);
  return parsed;
}

function gitShaAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!/^[a-f0-9]{40}$/.test(parsed)) parser.add("INVALID_DIGEST", path);
  return parsed;
}

function inventoryRefAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!isInventoryRef(parsed)) parser.add("INVALID_DIGEST", path);
  return parsed;
}

function timestampAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (parseTimestamp(parsed) === null) parser.add("INVALID_TIMESTAMP", path);
  return parsed;
}

function intAt(value: JsonValue | undefined, path: string, parser: Parser, options: { min: number }): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < options.min) {
    parser.add("INVALID_VALUE", path);
    return null;
  }
  return value;
}

function enumAt<const T extends readonly string[]>(value: JsonValue | undefined, allowed: T, path: string, parser: Parser): T[number] | null {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    parser.add("INVALID_VALUE", path);
    return null;
  }
  return value as T[number];
}

function fqdnAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  if (!isFqdn(parsed)) parser.add("INVALID_VALUE", path);
  return parsed;
}

function callbackUrlAt(value: JsonValue | undefined, path: string, parser: Parser): string | null {
  const parsed = stringAt(value, path, parser);
  if (!parsed) return null;
  try {
    const url = new URL(parsed);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !isFqdn(url.hostname)) {
      parser.add("SECRET_SENTINEL", path);
    }
  } catch {
    parser.add("INVALID_VALUE", path);
  }
  return parsed;
}

function parseTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value.replace("Z", ".000Z") ? time : null;
}

function isPlainRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordType(value: unknown): value is ExactTargetRecordType {
  return typeof value === "string" && RECORD_TYPE_SET.has(value);
}

function isWorkloadClass(value: unknown): value is ExactTargetWorkloadClass {
  return typeof value === "string" && WORKLOAD_CLASS_SET.has(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isInventoryRef(value: unknown): value is string {
  return typeof value === "string" && /^managed-inventory-[a-f0-9]{64}$/.test(value);
}

function isFqdn(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253 || value !== value.toLowerCase() || value.endsWith(".") || value.includes("..") || value.includes("@") || value.includes("*")) {
    return false;
  }
  const labels = value.split(".");
  return labels.length > 1 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function hasStrings(value: Partial<RecordDetail>, keys: string[]): boolean {
  return keys.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
}

function hasAll(value: object): boolean {
  return Object.values(value).every((entry) => entry !== null && entry !== undefined);
}

function containsSecretSentinel(value: string): boolean {
  return /private|secret|password|token|bearer|pwd|(?:api|access|private)[_-]?key|client[_-]?specific/i.test(value);
}

function withoutKeys(value: JsonObject, keys: string[]): JsonObject {
  const copy: JsonObject = Object.create(null) as JsonObject;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) copy[key] = value[key];
  }
  return copy;
}

function recordToJson(record: ExactTargetRecord): JsonObject {
  const json: JsonObject = {
    recordId: record.recordId,
    recordType: record.recordType,
    inventoryKey: record.inventoryKey,
    inventoryRef: record.inventoryRef,
    recordRevision: record.recordRevision,
    recordDigest: record.recordDigest,
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
    [record.detailKey]: record.detail as unknown as JsonObject,
  };
  if (record.provider) json.provider = record.provider as unknown as JsonObject;
  return json;
}

function snapshotToJson(snapshot: ExactTargetInventorySnapshot): JsonObject {
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
    records: snapshot.records.map(recordToJson),
    relationships: snapshot.relationships as unknown as JsonObject[],
    evidence: snapshot.evidence as unknown as JsonObject[],
    validationSummary: snapshot.validationSummary as unknown as JsonObject,
    documentDigest: snapshot.documentDigest,
    derived: snapshot.derived as unknown as JsonObject,
  };
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
