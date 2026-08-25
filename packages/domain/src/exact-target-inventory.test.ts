import { describe, expect, it, vi } from "vitest";
import {
  EXACT_TARGET_RECORD_TYPES,
  EXACT_TARGET_WORKLOAD_CLASSES,
  type ExactTargetInventoryBlockerCode,
  canonicalJson,
  deriveExactTargetInventoryKey,
  deriveInventoryRef,
  selectExactTargetInventoryRecord,
  sha256Hex,
  validateExactTargetInventory,
} from "./exact-target-inventory";

type JsonObject = { [key: string]: any };

const NOW = "2026-08-25T00:00:00Z";
const OBSERVED = "2026-08-24T20:00:00Z";
const EXPIRES = "2026-09-01T00:00:00Z";
const DIGEST = sha256Hex("fixture");
const SHA = "a".repeat(40);

const detailKeyByType: Record<string, string> = {
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

const baseBlockers = ["MISSING_WORKLOAD_COVERAGE", "POLICY_PENDING"];

function evidenceRefFor(workloadClass: string) {
  return `evidence-${workloadClass.toLowerCase().replaceAll("_", "-")}`;
}

function authorityDimension(workloadClass: string, verdict = "PROVEN") {
  return {
    verdict,
    evidenceRefs: [evidenceRefFor(workloadClass)],
    observedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    independentVerifierRef: "offline-validator",
  };
}

function authorityFor(workloadClass: string) {
  return {
    authorizationState: "BLOCKED",
    serving: authorityDimension(workloadClass),
    data: authorityDimension(workloadClass, workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "PROVEN"),
    object: authorityDimension(workloadClass),
    worker: authorityDimension(workloadClass, workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "PROVEN"),
    scheduler: authorityDimension(workloadClass),
    queue: authorityDimension(workloadClass, workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "PROVEN"),
    domain: authorityDimension(workloadClass),
    callback: authorityDimension(workloadClass),
  };
}

function dispositionFor(workloadClass: string) {
  if (["ACTIVE_CLIENT_DECISION_REQUIRED", "STAGING_TEST_E2E", "DEMO"].includes(workloadClass)) {
    return {
      decision: "DECISION_REQUIRED",
      status: "POLICY_PENDING",
      decisionRef: "p0-05-offline-plan",
      decidedAt: OBSERVED,
      decisionOwner: "program-owner",
    };
  }
  return {
    decision: workloadClass === "OPS_CONTROL_PLANE"
      ? "MIGRATE_LAST"
      : workloadClass === "RESIDUAL_RAILWAY" || workloadClass === "DUPLICATE_AZURE"
        ? "PRESERVE_QUARANTINE"
        : workloadClass === "CORE_WEB" || workloadClass === "CORE_WORKER" || workloadClass === "MCP" || workloadClass === "PUBLIC_SITE"
          ? "REBUILD"
          : "ADOPT",
    status: "POLICY_PENDING",
    decisionRef: "p0-05-offline-plan",
    decidedAt: OBSERVED,
    decisionOwner: "program-owner",
  };
}

function provider() {
  return {
    providerKind: "LOCAL_RECOVERY",
    providerAccountId: "offline-account",
    providerTenantId: "offline-tenant",
    providerSubscriptionOrProjectId: "offline-project",
    providerScopeId: "offline-scope",
    managementPlane: "offline",
    authorityBoundary: "inventory-only",
  };
}

function common(recordType: string, workloadClass: string, index: number, detail: JsonObject, extra: JsonObject = {}) {
  const slug = workloadClass.toLowerCase().replaceAll("_", "-");
  const evidenceRef = evidenceRefFor(workloadClass);
  return {
    recordId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    recordType,
    inventoryKey: "",
    inventoryRef: "",
    recordRevision: 1,
    recordDigest: "",
    workloadId: `wl-${slug}`,
    environmentId: `env-${slug}`,
    ownerRef: "program-owner",
    criticality: "P0",
    lifecycle: {
      state: "EVIDENCE_ONLY",
      provisioningState: "POLICY_PENDING",
      releaseEligibility: "POLICY_PENDING",
      retirementEligibility: "BLOCKED",
      stateObservedAt: OBSERVED,
      stateEvidenceRef: evidenceRef,
    },
    disposition: dispositionFor(workloadClass),
    authority: authorityFor(workloadClass),
    evidenceRefs: [evidenceRef],
    firstObservedAt: OBSERVED,
    lastObservedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    [detailKeyByType[recordType]]: detail,
    ...extra,
  };
}

function finaliseRecord(record: JsonObject) {
  const detail = record[detailKeyByType[record.recordType]];
  record.inventoryKey = deriveExactTargetInventoryKey({
    recordType: record.recordType,
    workloadId: record.workloadId,
    environmentId: record.environmentId,
    provider: record.provider,
    detail,
  });
  record.inventoryRef = deriveInventoryRef(record.inventoryKey);
  record.recordDigest = sha256Hex(canonicalJson(withoutKey(record, "recordDigest")));
}

function rehash(snapshot: JsonObject) {
  for (const record of snapshot.records as JsonObject[]) finaliseRecord(record);
  snapshot.documentDigest = sha256Hex(canonicalJson({
    ...withoutKey(snapshot, "documentDigest"),
    records: (snapshot.records as JsonObject[]).map((record) => withoutKey(record, "recordDigest")),
  }));
  return snapshot;
}

function workloadRecords(workloadClass: string, offset: number) {
  const slug = workloadClass.toLowerCase().replaceAll("_", "-");
  return [
    common("WORKLOAD", workloadClass, offset, {
      workloadId: `wl-${slug}`,
      workloadSlug: slug,
      workloadClass,
      businessRole: "offline-target-inventory",
      customerAccountId: "opaque-account",
      customerDeploymentId: "opaque-deployment",
      workspaceId: "opaque-workspace",
      runtimeRoles: ["GAP"],
      systemOfRecordRoles: ["POLICY_PENDING"],
      dispositionRef: "p0-05-offline-plan",
    }),
    common("ENVIRONMENT", workloadClass, offset + 1, {
      environmentId: `env-${slug}`,
      environmentName: "offline",
      environmentClass: workloadClass === "DEMO" ? "DEMO" : workloadClass === "STAGING_TEST_E2E" ? "TEST" : "PRODUCTION",
      isolationBoundary: "synthetic",
      dataClass: "POLICY_PENDING",
      ownerRef: "program-owner",
      policyStatus: "POLICY_PENDING",
    }),
    common("GAP", workloadClass, offset + 2, {
      gapId: `gap-${slug}`,
      workloadClass,
      missingField: "provider-role-graph",
      blockerCode: "POLICY_PENDING",
      description: "generic offline gap",
    }),
  ];
}

function inventedInventory() {
  const records: JsonObject[] = [];
  EXACT_TARGET_WORKLOAD_CLASSES.forEach((workloadClass, index) => records.push(...workloadRecords(workloadClass, index * 20 + 1)));
  const primaryClass = EXACT_TARGET_WORKLOAD_CLASSES[0];
  const primaryEvidenceRef = evidenceRefFor(primaryClass);
  const runtime = common("PROVIDER_RESOURCE", primaryClass, 400, {
    providerResourceId: "resource-runtime",
    providerResourceType: "container-app",
    providerNativeName: "runtime",
    resourceRole: "RUNTIME",
    region: "offline-region",
    parentResourceId: "parent-runtime",
    deploymentOrRevisionId: "revision-runtime",
    instanceId: "instance-runtime",
    networkExposure: "internal",
    canonicalOrigin: "origin-runtime",
    providerState: "EVIDENCE_ONLY",
  }, { provider: provider() });
  const dataStore = common("DATA_STORE", primaryClass, 401, {
    providerResourceId: "resource-data",
    databaseId: "database-main",
    databaseName: "database-main",
    engine: "postgres",
    region: "offline-region",
    workloadBinding: "primary",
    role: "AUTHORITATIVE_CANDIDATE",
    endpointFingerprint: sha256Hex("endpoint-data"),
    schemaMigrationIdentityRefs: ["schema-v1"],
    backupRefs: ["backup-data"],
    bindingEvidenceRef: primaryEvidenceRef,
  }, { provider: provider() });
  const objectStore = common("OBJECT_STORE", primaryClass, 402, {
    providerResourceId: "resource-object",
    namespace: "namespace-main",
    region: "offline-region",
    workloadBinding: "primary",
    role: "AUTHORITATIVE_CANDIDATE",
    endpointFingerprint: sha256Hex("endpoint-object"),
    versioningRetentionPolicyRef: "retention-policy",
    inventoryParityEvidenceRefs: [primaryEvidenceRef],
    backupRefs: ["backup-object"],
  }, { provider: provider() });
  const credential = common("CREDENTIAL_REF", primaryClass, 403, {
    secretProvider: "LOCAL_RECOVERY",
    vaultOrProjectId: "vault-offline",
    secretObjectId: "secret-runtime",
    versionSelectorPolicy: "CURRENT_BY_POLICY",
    consumerResourceRefs: [],
    purpose: "runtime-binding",
    ownerRef: "security-owner",
    rotationMetadataTimestamp: OBSERVED,
    valueObserved: false,
  }, { provider: provider() });
  const image = common("IMAGE", primaryClass, 404, {
    registryResourceId: "registry-offline",
    repository: "repo/web",
    digestAlgorithm: "sha256",
    digest: sha256Hex("image"),
    imageRole: "web",
    sourceGitSha: SHA,
    buildProvenanceEvidenceRef: primaryEvidenceRef,
    consumingResourceRefs: [],
  }, { provider: provider() });
  const scheduler = common("SCHEDULER", primaryClass, 405, {
    schedulerId: "scheduler-main",
    scheduleIdentity: "schedule-main",
    timezone: "UTC",
    enabledState: "disabled",
    enqueueTargetRefs: [],
    credentialRef: "",
    lastObservedAt: OBSERVED,
    authorityVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  const queue = common("QUEUE", primaryClass, 406, {
    queueId: "queue-main",
    semantics: "POSTGRES_OUTBOX",
    availabilityPolicyRef: "availability-policy",
    lockPolicyRef: "lock-policy",
    retryPolicyRef: "retry-policy",
    producerRefs: [],
    consumerRefs: [],
    schedulerRefs: [],
    authorityVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  const worker = common("WORKER", primaryClass, 407, {
    providerAppId: "worker-app",
    providerServiceId: "worker-service",
    deploymentOrRevisionId: "worker-revision",
    instanceIds: ["worker-instance"],
    processRole: "WORKER",
    replicaState: "stopped",
    imageRef: "",
    dataStoreRef: "",
    queueRefs: [],
    schedulerRefs: [],
    bindingEvidenceRef: primaryEvidenceRef,
    concurrencyPolicyRef: "concurrency-policy",
    authorityVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  const domain = common("DOMAIN", primaryClass, 408, {
    fqdn: "inventory.example",
    dnsZoneResourceId: "zone-main",
    dnsRecordId: "record-main",
    recordType: "CNAME",
    recordTarget: "target.example",
    certificateResourceId: "cert-main",
    boundRuntimeResourceId: "",
    canonicalPurpose: "offline",
    authorityVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  const callback = common("CALLBACK", primaryClass, 409, {
    callbackId: "callback-main",
    integrationProvider: "external",
    callbackKind: "webhook",
    canonicalUrl: "https://hooks.example/callback",
    canonicalOrigin: "https://hooks.example",
    canonicalPath: "/callback",
    boundResourceRef: "",
    credentialRef: "",
    externalConfigurationEvidenceRef: primaryEvidenceRef,
    authorityVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  const rollback = common("ROLLBACK_ASSET", primaryClass, 410, {
    assetId: "rollback-main",
    assetType: "PRIOR_IMAGE",
    providerArtifactRef: "artifact-main",
    sourceSnapshotDigest: sha256Hex("snapshot"),
    independenceBoundary: "offline",
    createdAt: OBSERVED,
    verifiedAt: OBSERVED,
    restoreTestedAt: OBSERVED,
    retainUntil: EXPIRES,
    recoveryOwner: "recovery-owner",
    readinessVerdict: "POLICY_PENDING",
  }, { provider: provider() });
  records.push(runtime, dataStore, objectStore, credential, image, scheduler, queue, worker, domain, callback, rollback);

  for (const record of records) finaliseRecord(record);
  worker.worker.imageRef = image.inventoryRef;
  worker.worker.dataStoreRef = dataStore.inventoryRef;
  worker.worker.queueRefs = [queue.inventoryRef];
  worker.worker.schedulerRefs = [scheduler.inventoryRef];
  scheduler.scheduler.enqueueTargetRefs = [queue.inventoryRef];
  scheduler.scheduler.credentialRef = credential.inventoryRef;
  queue.queue.producerRefs = [worker.inventoryRef];
  queue.queue.consumerRefs = [worker.inventoryRef];
  queue.queue.schedulerRefs = [scheduler.inventoryRef];
  credential.credentialRef.consumerResourceRefs = [worker.inventoryRef, scheduler.inventoryRef, callback.inventoryRef];
  image.image.consumingResourceRefs = [worker.inventoryRef];
  domain.domain.boundRuntimeResourceId = runtime.inventoryRef;
  callback.callback.boundResourceRef = runtime.inventoryRef;
  callback.callback.credentialRef = credential.inventoryRef;
  for (const record of records) finaliseRecord(record);

  const snapshot: JsonObject = {
    schemaVersion: "1.0.0",
    inventoryId: "11111111-1111-4111-8111-111111111111",
    snapshotSequence: 1,
    generatedAt: OBSERVED,
    validFrom: OBSERVED,
    expiresAt: EXPIRES,
    policyRef: { path: "artifact/policy", digest: DIGEST, status: "POLICY_PENDING" },
    dispositionRef: { path: "artifact/disposition", digest: DIGEST, status: "POLICY_PENDING" },
    collectorContractRef: { path: "artifact/collector", digest: DIGEST, status: "POLICY_PENDING" },
    collectorArtifactDigest: DIGEST,
    sourceSnapshotRefs: ["offline-snapshot"],
    records,
    relationships: [{
      relationshipId: "relationship-runtime-worker",
      fromRecordId: runtime.recordId,
      toRecordId: worker.recordId,
      relationshipType: "BINDS",
      evidenceRefs: [primaryEvidenceRef],
    }],
    evidence: EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => {
      const sourceRecord = records.find((record) => record.recordType === "WORKLOAD" && record.workload.workloadClass === workloadClass)!;
      return {
      evidenceId: evidenceRefFor(workloadClass),
      evidenceType: "SANITIZED_HANDOFF",
      sourceAuthority: "P0_05_OFFLINE_PLAN",
      sourceRecordId: sourceRecord.recordId,
      positiveFieldProjection: ["genericClass", "policyStatus"],
      collectorIdentityRef: "offline-validator",
      collectorVersionDigest: DIGEST,
      collectedAt: OBSERVED,
      sourceObservedAt: OBSERVED,
      verifiedAt: OBSERVED,
      expiresAt: EXPIRES,
      sanitizationClass: "PUBLIC_SAFE_OPAQUE",
      artifactRef: { path: "artifact/evidence", digest: DIGEST, status: "POLICY_PENDING" },
      artifactDigest: DIGEST,
      freshnessStatus: "POLICY_PENDING",
      limitations: ["invented offline fixture"],
    };
    }),
    validationSummary: {
      completenessLedger: EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => ({
        workloadClass,
        status: "BLOCKED",
        evidenceRefs: [evidenceRefFor(workloadClass)],
        blockingGaps: workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? [...baseBlockers, "AUTHORITY_UNPROVEN"] : [...baseBlockers],
        policyStatus: "POLICY_PENDING",
        dispositionDecision: dispositionFor(workloadClass).decision,
        authorityGate: workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
      })),
      blockerCodes: ["AUTHORITY_UNPROVEN", "MISSING_WORKLOAD_COVERAGE", "POLICY_PENDING"],
      validatedAt: OBSERVED,
    },
    documentDigest: "",
  };
  return rehash(snapshot);
}

function withoutKey(value: JsonObject, keyToRemove: string) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToRemove));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validate(snapshot: unknown) {
  return validateExactTargetInventory(snapshot, { now: NOW });
}

function firstRecordOf(snapshot: JsonObject, recordType: string) {
  return (snapshot.records as JsonObject[]).find((record) => record.recordType === recordType)!;
}

function dependencyHarness(input: unknown, deps: Record<string, () => void>) {
  const result = validate(input);
  if (!result.ok) return result;
  const selected = selectExactTargetInventoryRecord(result.snapshot, result.snapshot.records[0].inventoryRef);
  if (!selected) return result;
  deps.snapshotRead();
  deps.providerRead();
  deps.hook();
  deps.observation();
  deps.probe();
  deps.alert();
  deps.release();
  deps.snapshotEmission();
  return result;
}

function fanOutControl(deps: Record<string, () => void>) {
  deps.snapshotRead();
  deps.providerRead();
  deps.hook();
  deps.observation();
  deps.probe();
  deps.alert();
  deps.release();
  deps.snapshotEmission();
}

function deps() {
  return {
    snapshotRead: vi.fn(),
    providerRead: vi.fn(),
    hook: vi.fn(),
    observation: vi.fn(),
    probe: vi.fn(),
    alert: vi.fn(),
    release: vi.fn(),
    snapshotEmission: vi.fn(),
  };
}

describe("exact target inventory correction contract", () => {
  it("AC-01 AC-02 hostile raw structures return closed blockers and never throw", () => {
    const cyclic: JsonObject = {};
    cyclic.self = cyclic;
    const shared = { value: "shared" };
    const accessor = {};
    Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error("private"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("private"); } });
    const sparse: any[] = [];
    sparse[1] = "value";
    const wrongRecord = { ...inventedInventory(), records: [null] };

    for (const input of [null, 7, [], "{\"schemaVersion\":\"1.0.0\",", { bad: Number.NaN }, { bad: Number.POSITIVE_INFINITY }, { bad: -0 }, cyclic, { left: shared, right: shared }, accessor, proxy, { records: sparse }, wrongRecord]) {
      expect(() => validate(input)).not.toThrow();
      expect(validate(input)).toMatchObject({ ok: false });
    }
  });

  it("AC-03 AC-12 public projection is bounded and opaque for invalid and valid paths", () => {
    const invalid = validate({ records: [{ inventoryRef: "secret-target", recordType: "CALLBACK", canonicalUrl: "https://user:pass@example.test/hook?token=secret" }], validationSummary: { completenessLedger: [{ workloadClass: "ACTIVE_CLIENT_PRIMARY", status: "COMPLETE", blockingGaps: ["secret"] }] }, documentDigest: "secret-digest" });
    expect(JSON.stringify(invalid.publicProjection)).not.toContain("secret");
    expect(JSON.stringify(invalid.publicProjection)).not.toContain("example.test");

    const valid = validate(inventedInventory());
    expect(valid.ok).toBe(true);
    expect(JSON.stringify(valid.publicProjection)).not.toContain("wl-active");
    expect(JSON.stringify(valid.publicProjection)).not.toContain("artifact/");
    expect(JSON.stringify(valid.publicProjection)).not.toContain("hooks.example");
    expect(valid.publicProjection.records[0].inventoryRef).toMatch(/^[a-f0-9]{64}$/);
  });

  it("AC-04 AC-05 derives blocker state and rejects forged caller summary claims", () => {
    const snapshot = inventedInventory();
    (snapshot.validationSummary.completenessLedger[0] as JsonObject).status = "COMPLETE";
    (snapshot.validationSummary.completenessLedger[0] as JsonObject).blockingGaps = [];
    snapshot.validationSummary.blockerCodes = [];
    rehash(snapshot);
    const result = validate(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("CLAIM_MISMATCH");

    const valid = validate(inventedInventory());
    expect(valid.publicProjection.authorizationState).toBe("BLOCKED");
    expect(valid.publicProjection.blockerCodes).toEqual(expect.arrayContaining(["AUTHORITY_UNPROVEN", "MISSING_WORKLOAD_COVERAGE", "POLICY_PENDING"]));
  });

  it("AC-06 AC-10 binds key ref and digest to normalized identity and deterministic replay", () => {
    const snapshot = inventedInventory();
    const target = firstRecordOf(snapshot, "DATA_STORE");
    target.dataStore.databaseId = "database-other";
    rehash(snapshot);
    target.inventoryKey = "wrong|identity";
    target.inventoryRef = deriveInventoryRef(target.inventoryKey);
    target.recordDigest = sha256Hex(canonicalJson(withoutKey(target, "recordDigest")));
    snapshot.documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));
    const mismatch = validate(snapshot);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.issues.map((issue) => issue.code)).toContain("DERIVED_REF_MISMATCH");

    const valid = validate(inventedInventory());
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      const replay = validate(valid.canonicalJson);
      expect(replay).toMatchObject({ ok: true, documentDigest: valid.documentDigest });
    }
  });

  it.each(EXACT_TARGET_RECORD_TYPES)("AC-07 rejects missing required detail fields for %s", (recordType) => {
    const snapshot = inventedInventory();
    const record = firstRecordOf(snapshot, recordType);
    const detailKey = detailKeyByType[recordType];
    const field = Object.keys(record[detailKey])[0];
    delete record[detailKey][field];
    rehash(snapshot);
    const result = validate(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["REQUIRED_FIELD"]));
  });

  it.each(EXACT_TARGET_RECORD_TYPES)("AC-07 rejects alternate detail block injection for %s", (recordType) => {
    const snapshot = inventedInventory();
    const record = firstRecordOf(snapshot, recordType);
    const alternateKey = recordType === "CALLBACK" ? "credentialRef" : "callback";
    record[alternateKey] = { leaked: "private" };
    rehash(snapshot);
    const result = validate(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("UNKNOWN_FIELD");
    expect(JSON.stringify(result.publicProjection)).not.toContain("private");
  });

  it("AC-08 resolves references and rejects wrong-kind cross-target edges", () => {
    const snapshot = inventedInventory();
    firstRecordOf(snapshot, "WORKER").worker.imageRef = firstRecordOf(snapshot, "QUEUE").inventoryRef;
    rehash(snapshot);
    const result = validate(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");
  });

  it("AC-09 enforces uniqueness and generic workload coverage", () => {
    const duplicate = inventedInventory();
    duplicate.records[1].recordId = duplicate.records[0].recordId;
    rehash(duplicate);
    expect(validate(duplicate).issues.map((issue) => issue.code)).toContain("DUPLICATE_IDENTITY");

    const missing = inventedInventory();
    missing.records = missing.records.filter((record: JsonObject) => record.workload?.workloadClass !== "ACTIVE_CLIENT_PRIMARY");
    rehash(missing);
    expect(validate(missing).publicProjection.blockerCodes).toContain("MISSING_WORKLOAD_COVERAGE");
  });

  it("AC-11 validates injected-now chronology and expiry without ambient clock dependence", () => {
    const expired = inventedInventory();
    expired.expiresAt = "2026-08-24T21:00:00Z";
    rehash(expired);
    expect(validate(expired).issues.map((issue) => issue.code)).toContain("STALE_OR_EXPIRED");

    const future = inventedInventory();
    future.records[0].verifiedAt = "2026-08-26T00:00:00Z";
    rehash(future);
    expect(validate(future).issues.map((issue) => issue.code)).toContain("STALE_OR_EXPIRED");
  });

  it("AC-12 rejects callback credential surfaces and credential value observation", () => {
    const callback = inventedInventory();
    firstRecordOf(callback, "CALLBACK").callback.canonicalUrl = "https://user:pass@hooks.example/callback?token=value";
    rehash(callback);
    expect(validate(callback).issues.map((issue) => issue.code)).toContain("SECRET_SENTINEL");

    const credential = inventedInventory();
    firstRecordOf(credential, "CREDENTIAL_REF").credentialRef.valueObserved = true;
    rehash(credential);
    expect(validate(credential).issues.map((issue) => issue.code)).toContain("SECRET_SENTINEL");
  });

  it("AC-01 AC-02 captures descriptors without invoking accessors or inherited fields", () => {
    let getterHits = 0;
    const accessorArray: any[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get() { getterHits += 1; return inventedInventory().records[0]; } });
    expect(validate({ records: accessorArray })).toMatchObject({ ok: false });
    expect(getterHits).toBe(0);

    const inherited = Object.create(inventedInventory());
    expect(validate(inherited).issues.map((issue) => issue.code)).toContain("STRUCTURAL_LIMIT");

    const protoPayload = JSON.parse("{\"__proto__\":{\"schemaVersion\":\"1.0.0\"},\"records\":[]}");
    const result = validate(protoPayload);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["UNKNOWN_FIELD", "REQUIRED_FIELD"]));
  });

  it("AC-06 uses collision-free identity and requires root/detail agreement", () => {
    const commonIdentity = { recordType: "DATA_STORE" as const, workloadId: "wl", environmentId: "env", provider: provider() };
    const first = deriveExactTargetInventoryKey({ ...commonIdentity, detail: { providerResourceId: "a/b", databaseId: "c", role: "AUTHORITATIVE_CANDIDATE" } });
    const second = deriveExactTargetInventoryKey({ ...commonIdentity, detail: { providerResourceId: "a", databaseId: "b/c", role: "AUTHORITATIVE_CANDIDATE" } });
    expect(first).not.toBe(second);
    expect(deriveInventoryRef(first)).not.toBe(deriveInventoryRef(second));

    const mismatch = inventedInventory();
    mismatch.records[0].workload.workloadId = "wl-contradiction";
    rehash(mismatch);
    const result = validate(mismatch);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("DERIVED_REF_MISMATCH");
  });

  it("AC-04 AC-08 reconciles authority, completeness, evidence, credential, and image references", () => {
    const authority = inventedInventory();
    firstRecordOf(authority, "WORKLOAD").authority.authorizationState = "INVENTORY_ONLY";
    rehash(authority);
    expect(validate(authority).issues.map((issue) => issue.code)).toContain("CLAIM_MISMATCH");

    const evidence = inventedInventory();
    firstRecordOf(evidence, "DATA_STORE").dataStore.bindingEvidenceRef = evidenceRefFor(EXACT_TARGET_WORKLOAD_CLASSES[1]);
    rehash(evidence);
    expect(validate(evidence).issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");

    const completeness = inventedInventory();
    completeness.validationSummary.completenessLedger[0].evidenceRefs = [evidenceRefFor(EXACT_TARGET_WORKLOAD_CLASSES[1])];
    rehash(completeness);
    expect(validate(completeness).issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");

    const credential = inventedInventory();
    firstRecordOf(credential, "CREDENTIAL_REF").credentialRef.consumerResourceRefs = [firstRecordOf(credential, "IMAGE").inventoryRef];
    rehash(credential);
    expect(validate(credential).issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");

    const image = inventedInventory();
    firstRecordOf(image, "IMAGE").image.consumingResourceRefs = [firstRecordOf(image, "QUEUE").inventoryRef];
    rehash(image);
    expect(validate(image).issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");
  });

  it("AC-08 permits only same-target credential and image consumer classes", () => {
    const base = inventedInventory();
    const credentialAllowedTypes = ["PROVIDER_RESOURCE", "DATA_STORE", "OBJECT_STORE", "WORKER", "SCHEDULER", "QUEUE", "DOMAIN", "CALLBACK"];
    for (const recordType of credentialAllowedTypes) {
      const candidate = inventedInventory();
      firstRecordOf(candidate, "CREDENTIAL_REF").credentialRef.consumerResourceRefs = [firstRecordOf(candidate, recordType).inventoryRef];
      rehash(candidate);
      expect(validate(candidate).ok, recordType).toBe(true);
    }
    for (const recordType of ["PROVIDER_RESOURCE", "WORKER"]) {
      const candidate = inventedInventory();
      firstRecordOf(candidate, "IMAGE").image.consumingResourceRefs = [firstRecordOf(candidate, recordType).inventoryRef];
      rehash(candidate);
      expect(validate(candidate).ok, recordType).toBe(true);
    }
    const otherClass = EXACT_TARGET_WORKLOAD_CLASSES[1];
    const otherSlug = otherClass.toLowerCase().replaceAll("_", "-");
    const otherTargetRuntime = common("PROVIDER_RESOURCE", otherClass, 800, {
      providerResourceId: "resource-runtime-cross-target",
      providerResourceType: "container-app",
      providerNativeName: "runtime-cross-target",
      resourceRole: "RUNTIME",
      region: "offline-region",
      parentResourceId: "parent-runtime",
      deploymentOrRevisionId: "revision-runtime",
      instanceId: "instance-runtime",
      networkExposure: "internal",
      canonicalOrigin: "origin-runtime",
      providerState: "EVIDENCE_ONLY",
    }, { provider: provider(), workloadId: `wl-${otherSlug}`, environmentId: `env-${otherSlug}` });
    finaliseRecord(otherTargetRuntime);
    base.records.push(otherTargetRuntime);
    firstRecordOf(base, "CREDENTIAL_REF").credentialRef.consumerResourceRefs = [otherTargetRuntime.inventoryRef];
    rehash(base);
    expect(validate(base).issues.map((issue) => issue.code)).toContain("INVALID_REFERENCE");
  });

  it("AC-12 keeps endpoint observations opaque and rejects credential-bearing endpoint strings", () => {
    const endpoint = inventedInventory();
    firstRecordOf(endpoint, "DATA_STORE").dataStore.endpointFingerprint = "postgres://user:pass@host.example:5432/db";
    rehash(endpoint);
    const result = validate(endpoint);
    expect(result.issues.map((issue) => issue.code)).toContain("SECRET_SENTINEL");
    expect(JSON.stringify(result.publicProjection)).not.toContain("postgres");
    expect(JSON.stringify(validate(inventedInventory()).publicProjection)).not.toContain("endpoint");
  });

  it("AC-11 rejects rollback assets that are stale, expired, future, or chronologically impossible", () => {
    for (const [field, value] of [
      ["createdAt", "2026-08-24T21:00:00Z"],
      ["verifiedAt", "2026-08-23T20:00:00Z"],
      ["restoreTestedAt", "2026-08-26T00:00:00Z"],
      ["retainUntil", "2026-08-24T23:00:00Z"],
    ] as const) {
      const snapshot = inventedInventory();
      firstRecordOf(snapshot, "ROLLBACK_ASSET").rollbackAsset[field] = value;
      rehash(snapshot);
      expect(validate(snapshot).issues.map((issue) => issue.code), field).toContain("STALE_OR_EXPIRED");
    }
  });

  it("AC-13 blocked non-dry harness validates but reaches zero dependencies", () => {
    const controlDeps = deps();
    fanOutControl(controlDeps);
    for (const call of Object.values(controlDeps)) expect(call).toHaveBeenCalledTimes(1);

    const blockedValidDeps = deps();
    const blockedValid = dependencyHarness(inventedInventory(), blockedValidDeps);
    expect(blockedValid).toMatchObject({ ok: true });
    expect(blockedValid.publicProjection.authorizationState).toBe("BLOCKED");
    for (const call of Object.values(blockedValidDeps)) expect(call).not.toHaveBeenCalled();

    const cases: Array<[ExactTargetInventoryBlockerCode, unknown]> = [
      ["INVALID_JSON", "{"],
      ["DUPLICATE_JSON_KEY", "{\"schemaVersion\":\"1.0.0\",\"schemaVersion\":\"1.0.0\"}"],
      ["STRUCTURAL_LIMIT", (() => { const value: JsonObject = {}; value.self = value; return value; })()],
      ["UNKNOWN_FIELD", { ...inventedInventory(), unknown: true }],
      ["REQUIRED_FIELD", (() => { const value = inventedInventory(); delete value.schemaVersion; return value; })()],
      ["INVALID_VALUE", (() => { const value = inventedInventory(); value.records[0].recordType = "BAD"; return value; })()],
      ["INVALID_TIMESTAMP", (() => { const value = inventedInventory(); value.generatedAt = "bad"; return value; })()],
      ["INVALID_DIGEST", (() => { const value = inventedInventory(); value.documentDigest = "bad"; return value; })()],
      ["INVALID_UUID", (() => { const value = inventedInventory(); value.inventoryId = "bad"; return value; })()],
      ["INVALID_REFERENCE", (() => { const value = inventedInventory(); firstRecordOf(value, "WORKER").worker.imageRef = "f".repeat(64); return rehash(value); })()],
      ["DERIVED_REF_MISMATCH", (() => { const value = inventedInventory(); value.records[0].inventoryRef = "f".repeat(64); return value; })()],
      ["DERIVED_DIGEST_MISMATCH", (() => { const value = inventedInventory(); value.records[0].recordDigest = "f".repeat(64); return value; })()],
      ["DUPLICATE_IDENTITY", (() => { const value = inventedInventory(); value.records[1].recordId = value.records[0].recordId; return rehash(value); })()],
      ["CLAIM_MISMATCH", (() => { const value = inventedInventory(); value.validationSummary.blockerCodes = []; return rehash(value); })()],
      ["RETIREMENT_NOT_BLOCKED", (() => { const value = inventedInventory(); value.records[0].lifecycle.retirementEligibility = "ELIGIBLE"; return rehash(value); })()],
      ["STALE_OR_EXPIRED", (() => { const value = inventedInventory(); value.records[0].expiresAt = OBSERVED; return rehash(value); })()],
      ["SECRET_SENTINEL", (() => { const value = inventedInventory(); firstRecordOf(value, "CREDENTIAL_REF").credentialRef.valueObserved = true; return rehash(value); })()],
    ];

    for (const [code, input] of cases) {
      const blockedDeps = deps();
      const result = dependencyHarness(input, blockedDeps);
      expect(result.ok, code).toBe(false);
      expect(result.issues.map((issue) => issue.code), code).toContain(code);
      for (const call of Object.values(blockedDeps)) expect(call, code).not.toHaveBeenCalled();
    }
  });

  it("AC-14 AC-16 exports immutable blocked snapshots and rejects forged raw handles", () => {
    const result = validate(inventedInventory());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    const selected = selectExactTargetInventoryRecord(result.snapshot, result.snapshot.records[0].inventoryRef);
    expect(selected).toBeNull();
    expect(() => selectExactTargetInventoryRecord({ records: [] } as any, result.snapshot.records[0].inventoryRef)).toThrow("module-validated");
  });

  it("AC-15 uses generic workload classes only and has no scanner-evasion tokens in projection", () => {
    const sourceText = JSON.stringify(inventedInventory()) + JSON.stringify(validate(inventedInventory()).publicProjection);
    expect(sourceText).not.toMatch(/CLIENT_ALPHA|CLIENT_BETA|CUSTOMER_ONE|customer-one/);
    for (const workloadClass of EXACT_TARGET_WORKLOAD_CLASSES) expect(sourceText).toContain(workloadClass);
  });
});
