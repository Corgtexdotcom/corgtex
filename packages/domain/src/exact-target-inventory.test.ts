import { describe, expect, it, vi } from "vitest";
import {
  EXACT_TARGET_RECORD_TYPES,
  EXACT_TARGET_WORKLOAD_CLASSES,
  type ExactTargetAuthorityDimensionName,
  type ExactTargetInventoryBlockerCode,
  type ExactTargetRecordType,
  canonicalJson,
  deriveEvidenceRef,
  deriveExactTargetInventoryKey,
  deriveInventoryRef,
  selectExactTargetInventoryRecord,
  selectExactTargetInventoryTarget,
  sha256Hex,
  validateExactTargetInventory,
} from "./exact-target-inventory";

type JsonObject = { [key: string]: any };

const NOW = "2026-08-25T00:00:00Z";
const GENERATED = "2026-08-24T20:00:00Z";
const OBSERVED = "2026-08-24T19:00:00Z";
const EXPIRES = "2026-09-01T00:00:00Z";
const RETAIN = "2026-10-01T00:00:00Z";
const SHA = "a".repeat(40);
const BASE_DIGEST = sha256Hex("generic-offline-artifact");

const detailKeyByType: Record<ExactTargetRecordType, string> = {
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

function artifact(name: string, status = "SETTLED") {
  return {
    path: `artifacts/${name}`,
    digest: sha256Hex(name),
    status,
  };
}

function provider(slug: string, includeOptionals = true) {
  return {
    providerKind: "LOCAL_RECOVERY",
    providerAccountId: `${slug}:account`,
    ...(includeOptionals ? { providerTenantId: `${slug}:tenant`, providerSubscriptionOrProjectId: `${slug}:project` } : {}),
    providerScopeId: `${slug}:scope`,
    managementPlane: "offline",
    authorityBoundary: "inventory-only",
  };
}

const authorityDimensions = ["serving", "data", "object", "worker", "scheduler", "queue", "domain", "callback"] as const satisfies readonly ExactTargetAuthorityDimensionName[];

function authorityDimension(evidenceRef: string, verdict = "PROVEN") {
  return {
    verdict,
    evidenceRefs: verdict === "PROVEN" ? [evidenceRef] : [],
    observedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    independentVerifierRef: "independent-verifier",
  };
}

function common(recordType: ExactTargetRecordType, workload: JsonObject, index: number, detail: JsonObject, options: { blocked?: boolean; includeProvider?: boolean; authorityVerdict?: string; includeProviderOptionals?: boolean } = {}): JsonObject {
  const blocked = options.blocked ?? false;
  const evidenceRef = placeholderEvidenceRef(workload.slug, index);
  const authorityVerdict = options.authorityVerdict ?? (blocked ? "AUTHORITY_UNPROVEN" : "PROVEN");
  return {
    recordId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    recordType,
    inventoryKey: "",
    inventoryRef: "",
    recordRevision: 1,
    recordDigest: "",
    workloadId: workload.workloadId,
    environmentId: workload.environmentId,
    ownerRef: "program-owner",
    criticality: "P0",
    lifecycle: {
      state: blocked ? "EVIDENCE_ONLY" : "ACTIVE",
      provisioningState: blocked ? "POLICY_PENDING" : "SETTLED",
      releaseEligibility: blocked ? "POLICY_PENDING" : "ELIGIBLE",
      retirementEligibility: "BLOCKED",
      stateObservedAt: OBSERVED,
      stateEvidenceRef: evidenceRef,
    },
    disposition: {
      decision: blocked ? "DECISION_REQUIRED" : "ADOPT",
      status: blocked ? "POLICY_PENDING" : "SETTLED",
      decisionRef: "p0-05-policy",
      decidedAt: OBSERVED,
      decisionOwner: "program-owner",
    },
    authority: {
      authorizationState: blocked || authorityVerdict !== "PROVEN" ? "BLOCKED" : "INVENTORY_ONLY",
      serving: authorityDimension(evidenceRef, authorityVerdict),
      data: authorityDimension(evidenceRef, authorityVerdict),
      object: authorityDimension(evidenceRef, authorityVerdict),
      worker: authorityDimension(evidenceRef, authorityVerdict),
      scheduler: authorityDimension(evidenceRef, authorityVerdict),
      queue: authorityDimension(evidenceRef, authorityVerdict),
      domain: authorityDimension(evidenceRef, authorityVerdict),
      callback: authorityDimension(evidenceRef, authorityVerdict),
    },
    evidenceRefs: [evidenceRef],
    firstObservedAt: OBSERVED,
    lastObservedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    ...(options.includeProvider ? { provider: provider(workload.slug, options.includeProviderOptionals) } : {}),
    [detailKeyByType[recordType]]: detail,
  };
}

function placeholderEvidenceRef(slug: string, index: number) {
  return deriveInventoryRef(canonicalJson(["evidence-placeholder", slug, index]));
}

function finalizeRecord(record: JsonObject) {
  const detail = record[detailKeyByType[record.recordType as ExactTargetRecordType]];
  const inventoryKey = deriveExactTargetInventoryKey({
    recordType: record.recordType,
    workloadId: record.workloadId,
    environmentId: record.environmentId,
    provider: record.provider ?? null,
    detail,
  });
  if (!inventoryKey) throw new Error(`fixture identity failed for ${record.recordType}`);
  record.inventoryKey = inventoryKey;
  record.inventoryRef = deriveInventoryRef(inventoryKey);
  record.recordDigest = sha256Hex(canonicalJson(rawRecordDigestInput(record)));
}

function finalizeEvidence(evidence: JsonObject) {
  const evidenceRef = deriveEvidenceRef({
    evidenceId: evidence.evidenceId,
    sourceRecordRef: evidence.sourceRecordRef,
    artifactDigest: evidence.artifactDigest,
  });
  if (!evidenceRef) throw new Error("fixture evidence ref failed");
  evidence.evidenceRef = evidenceRef;
}

function makeEvidence(record: JsonObject, index: number, workloadClass: string, freshness = "CURRENT", evidenceKind = "DETAIL") {
  return {
    evidenceId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    evidenceRef: "",
    sourceRecordRef: record.inventoryRef,
    sourceRecordType: record.recordType,
    workloadId: record.workloadId,
    environmentId: record.environmentId,
    workloadClass,
    evidenceKind,
    freshness,
    observedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    artifactRef: artifact(`evidence-${index}`),
    artifactDigest: sha256Hex(`evidence-${index}`),
  };
}

function workloadSkeleton(workloadClass: string, group: number) {
  const slug = workloadClass.toLowerCase().replaceAll("_", "-");
  return {
    slug,
    workloadId: `00000000-0000-4000-9000-${String(group).padStart(12, "0")}`,
    environmentId: `00000000-0000-4000-9001-${String(group).padStart(12, "0")}`,
  };
}

function makeFullTarget(workloadClass = "ACTIVE_CLIENT_PRIMARY", group = 1, blocked = false) {
  const workload = workloadSkeleton(workloadClass, group);
  const rows: JsonObject[] = [];
  const add = (recordType: ExactTargetRecordType, detail: JsonObject, includeProvider = false, includeProviderOptionals = true, authorityVerdict?: string) => {
    const record = common(recordType, workload, group * 100 + rows.length + 1, detail, { blocked, includeProvider, includeProviderOptionals, authorityVerdict });
    rows.push(record);
    return record;
  };
  const workloadRecord = add("WORKLOAD", {
    workloadId: workload.workloadId,
    workloadSlug: workload.slug,
    workloadClass,
    businessRole: "offline-target-inventory",
    customerAccountId: "generic-account",
    customerDeploymentId: "generic-deployment",
    workspaceId: "generic-workspace",
    runtimeRoles: ["web", "worker"],
    systemOfRecordRoles: ["metadata"],
    dispositionRef: "p0-05-policy",
  });
  const environmentRecord = add("ENVIRONMENT", {
    environmentId: workload.environmentId,
    workloadId: workload.workloadId,
    environmentClass: "PRODUCTION",
    publicBaseDomain: `${workload.slug}.example.test`,
    deploymentTrack: "stable",
    policyEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 2),
  });
  const resource = add("PROVIDER_RESOURCE", {
    providerResourceId: `resource/${workload.slug}`,
    resourceKind: "service",
    resourceNameFingerprint: `sha256:${sha256Hex(`resource-${workload.slug}`)}`,
    region: "offline",
    providerEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 3),
  }, true);
  const dataStore = add("DATA_STORE", {
    providerResourceId: `resource/${workload.slug}`,
    databaseId: `database/${workload.slug}`,
    storeRole: "AUTHORITATIVE_CANDIDATE",
    dataClass: blocked ? "POLICY_PENDING" : "INTERNAL",
    endpointFingerprint: `sha256:${sha256Hex(`data-${workload.slug}`)}`,
    bindingEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 4),
    credentialRefs: [],
  }, true, false);
  const objectStore = add("OBJECT_STORE", {
    providerResourceId: `resource/${workload.slug}`,
    bucketId: `bucket/${workload.slug}`,
    storeRole: "AUXILIARY",
    dataClass: "INTERNAL",
    endpointFingerprint: `sha256:${sha256Hex(`object-${workload.slug}`)}`,
    bindingEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 5),
    credentialRefs: [],
  }, true);
  const worker = add("WORKER", {
    workerId: `worker/${workload.slug}`,
    runtime: "node",
    imageRef: "",
    queueRefs: [],
    dataStoreRefs: [],
    objectStoreRefs: [],
    credentialRefs: [],
  }, true);
  const scheduler = add("SCHEDULER", {
    schedulerId: `scheduler/${workload.slug}`,
    scheduleKind: "CRON",
    targetWorkerRef: "",
    credentialRefs: [],
  }, true);
  const queue = add("QUEUE", {
    queueId: `queue/${workload.slug}`,
    queueSemantics: "WORKFLOW_JOB",
    producerRefs: [],
    consumerRefs: [],
    credentialRefs: [],
  }, true);
  const domain = add("DOMAIN", {
    fqdn: `svc-${workload.slug}.example.test`,
    domainRole: "PRIMARY",
    targetResourceRef: "",
    dnsEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 9),
  }, true);
  const callback = add("CALLBACK", {
    callbackId: `callback/${workload.slug}`,
    callbackUrl: `https://callback-${workload.slug}.example.test/hooks/offline`,
    callbackRole: "WEBHOOK",
    targetResourceRef: "",
    externalConfigurationEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 10),
    credentialRefs: [],
  }, true);
  const credential = add("CREDENTIAL_REF", {
    credentialRefId: `credential/${workload.slug}`,
    credentialKind: "WEBHOOK_SECRET",
    valueObserved: false,
    rotationEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 11),
    consumerResourceRefs: [],
  }, true);
  const image = add("IMAGE", {
    imageDigest: sha256Hex(`image-${workload.slug}`),
    sourceCommitSha: SHA,
    buildProvenanceEvidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 12),
    consumerResourceRefs: [],
  }, true);
  const rollback = add("ROLLBACK_ASSET", {
    rollbackAssetId: `rollback/${workload.slug}`,
    assetDigest: sha256Hex(`rollback-${workload.slug}`),
    createdAt: OBSERVED,
    verifiedAt: OBSERVED,
    restoreTestedAt: OBSERVED,
    retainUntil: RETAIN,
    targetRecordRef: "",
    evidenceRef: placeholderEvidenceRef(workload.slug, group * 100 + 13),
  }, true);

  finalizeAll(rows);

  (worker.worker as JsonObject).imageRef = image.inventoryRef;
  (worker.worker as JsonObject).queueRefs = [queue.inventoryRef];
  (worker.worker as JsonObject).dataStoreRefs = [dataStore.inventoryRef];
  (worker.worker as JsonObject).objectStoreRefs = [objectStore.inventoryRef];
  (worker.worker as JsonObject).credentialRefs = [credential.inventoryRef];
  (scheduler.scheduler as JsonObject).targetWorkerRef = worker.inventoryRef;
  (scheduler.scheduler as JsonObject).credentialRefs = [credential.inventoryRef];
  (queue.queue as JsonObject).producerRefs = [scheduler.inventoryRef];
  (queue.queue as JsonObject).consumerRefs = [worker.inventoryRef];
  (queue.queue as JsonObject).credentialRefs = [credential.inventoryRef];
  (domain.domain as JsonObject).targetResourceRef = resource.inventoryRef;
  (callback.callback as JsonObject).targetResourceRef = worker.inventoryRef;
  (callback.callback as JsonObject).credentialRefs = [credential.inventoryRef];
  (credential.credentialRef as JsonObject).consumerResourceRefs = [resource.inventoryRef, dataStore.inventoryRef, objectStore.inventoryRef, worker.inventoryRef, scheduler.inventoryRef, queue.inventoryRef, domain.inventoryRef, callback.inventoryRef];
  (image.image as JsonObject).consumerResourceRefs = [resource.inventoryRef, worker.inventoryRef];
  (rollback.rollbackAsset as JsonObject).targetRecordRef = dataStore.inventoryRef;
  finalizeAll(rows);

  const evidence = rows.map((record, index) => makeEvidence(record, group * 100 + index + 1, workloadClass));
  evidence.forEach(finalizeEvidence);
  for (const [index, record] of rows.entries()) {
    const ref = evidence[index].evidenceRef;
    replacePlaceholderRefs(record, ref);
  }
  const authorityEvidence: JsonObject[] = [];
  for (const [recordIndex, record] of rows.entries()) {
    for (const [dimensionIndex, dimension] of authorityDimensions.entries()) {
      if ((record.authority as JsonObject)[dimension].verdict !== "PROVEN") continue;
      const authorityRef = makeEvidence(record, group * 10000 + recordIndex * 100 + dimensionIndex, workloadClass, "CURRENT", "AUTHORITY");
      authorityRef.artifactRef = artifact(`authority-${workload.slug}-${recordIndex}-${dimension}`);
      authorityRef.artifactDigest = authorityRef.artifactRef.digest;
      finalizeEvidence(authorityRef);
      (record.authority as JsonObject)[dimension].evidenceRefs = [authorityRef.evidenceRef];
      authorityEvidence.push(authorityRef);
    }
  }
  finalizeAll(rows);
  const relationships = [
    relationship(1, workloadRecord, environmentRecord, evidence[0]),
    relationship(2, workloadRecord, resource, evidence[1]),
    relationship(3, worker, dataStore, evidence[2]),
    relationship(4, worker, objectStore, evidence[3]),
    relationship(5, worker, queue, evidence[4]),
    relationship(6, scheduler, worker, evidence[5]),
    relationship(7, domain, resource, evidence[6]),
    relationship(8, callback, worker, evidence[7]),
    relationship(9, worker, image, evidence[8]),
    relationship(10, dataStore, rollback, evidence[9]),
  ];
  return { records: rows, evidence: [...evidence, ...authorityEvidence], relationships };
}

function relationship(index: number, from: JsonObject, to: JsonObject, evidence: JsonObject) {
  return {
    relationshipId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    fromRecordRef: from.inventoryRef,
    toRecordRef: to.inventoryRef,
    relationshipType: "DEPENDS_ON",
    evidenceRefs: [evidence.evidenceRef],
  };
}

function makeBlockedGapTarget(workloadClass: string, group: number, blockerCode: ExactTargetInventoryBlockerCode) {
  const target = makeFullTarget(workloadClass, group, true);
  const workload = workloadSkeleton(workloadClass, group);
  const gap = common("GAP", workload, group * 100 + 99, {
    gapId: `gap/${workload.slug}`,
    workloadClass,
    gapType: blockerCode === "AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
    blockerCode,
    evidenceRef: target.evidence[0].evidenceRef,
  }, { blocked: true });
  finalizeRecord(gap);
  const gapEvidence = makeEvidence(gap, group * 100 + 99, workloadClass);
  finalizeEvidence(gapEvidence);
  replacePlaceholderRefs(gap, gapEvidence.evidenceRef);
  finalizeRecord(gap);
  return {
    records: [...target.records, gap],
    evidence: [...target.evidence, gapEvidence],
    relationships: target.relationships,
  };
}

function finalizeAll(records: JsonObject[]) {
  records.forEach(finalizeRecord);
}

function replacePlaceholderRefs(value: unknown, ref: string) {
  if (Array.isArray(value)) {
    for (const entry of value) replacePlaceholderRefs(entry, ref);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.startsWith("managed-inventory-") && (key === "evidenceRef" || key === "stateEvidenceRef" || key.endsWith("EvidenceRef"))) {
      (value as JsonObject)[key] = ref;
    } else if (Array.isArray(entry) && (key === "evidenceRefs" || key.endsWith("EvidenceRefs"))) {
      (value as JsonObject)[key] = entry.map((candidate) => typeof candidate === "string" && candidate.startsWith("managed-inventory-") ? ref : candidate);
    } else {
      replacePlaceholderRefs(entry, ref);
    }
  }
}

function rehash(snapshot: JsonObject) {
  for (const record of snapshot.records) finalizeRecord(record);
  snapshot.documentDigest = sha256Hex(canonicalJson(rawDocumentDigestInput(snapshot)));
  delete snapshot.derived;
  return snapshot;
}

function rawRecordDigestInput(record: JsonObject) {
  const { recordDigest, detailKey, detail, ...rest } = record;
  return rest;
}

function rawDocumentDigestInput(snapshot: JsonObject) {
  const { documentDigest, derived, ...rest } = snapshot;
  return rest;
}

function makeInventory() {
  const primary = makeFullTarget("ACTIVE_CLIENT_PRIMARY", 1, false);
  const records = [...primary.records];
  const evidence = [...primary.evidence];
  const relationships = [...primary.relationships];
  for (const [index, workloadClass] of EXACT_TARGET_WORKLOAD_CLASSES.entries()) {
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY") continue;
    const blocked = makeBlockedGapTarget(
      workloadClass,
      index + 10,
      workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
    );
    records.push(...blocked.records);
    evidence.push(...blocked.evidence);
    relationships.push(...blocked.relationships.map((relationship, relIndex) => ({
      ...relationship,
      relationshipId: `30000000-0000-4000-8000-${String((index + 1) * 100 + relIndex).padStart(12, "0")}`,
    })));
  }
  const completeness = EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => {
    const classEvidence = evidence.find((entry) => entry.workloadClass === workloadClass);
    if (!classEvidence) throw new Error(`missing fixture evidence for ${workloadClass}`);
    return {
      workloadClass,
      status: workloadClass === "ACTIVE_CLIENT_PRIMARY" ? "COMPLETE" : "BLOCKED",
      evidenceRefs: [classEvidence.evidenceRef],
    };
  });
  return rehash({
    schemaVersion: "1.0.0",
    inventoryId: "90000000-0000-4000-8000-000000000001",
    snapshotSequence: 1,
    generatedAt: GENERATED,
    validFrom: OBSERVED,
    expiresAt: EXPIRES,
    policyRef: artifact("p0-05-policy"),
    dispositionRef: artifact("p0-05-disposition"),
    collectorContractRef: artifact("p0-05-collector"),
    collectorArtifactDigest: sha256Hex("p0-05-collector"),
    sourceSnapshotRefs: [BASE_DIGEST],
    records,
    relationships,
    evidence,
    validationSummary: {
      validatedAt: GENERATED,
      validatorRef: "offline-validator",
      completeness,
      blockerCodes: ["AUTHORITY_UNPROVEN", "LIFECYCLE_NOT_SELECTABLE", "POLICY_PENDING"],
    },
    documentDigest: "",
  });
}

function validate(snapshot = makeInventory()) {
  return validateExactTargetInventory(JSON.parse(JSON.stringify(snapshot)), { now: NOW });
}

function expectIssue(snapshot: JsonObject, code: ExactTargetInventoryBlockerCode) {
  const result = validate(rehash(snapshot));
  expect(result.ok).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain(code);
  return result;
}

function deps() {
  return {
    snapshot: vi.fn(),
    provider: vi.fn(),
    hook: vi.fn(),
    observation: vi.fn(),
    probe: vi.fn(),
    alert: vi.fn(),
    release: vi.fn(),
    emitSnapshot: vi.fn(),
  };
}

function offlineConsumer(selected: ReturnType<typeof selectExactTargetInventoryTarget>, externalPermit: boolean, calls = deps()) {
  if (!selected || !externalPermit) return calls;
  calls.snapshot(selected);
  calls.provider(selected);
  calls.hook(selected);
  calls.observation(selected);
  calls.probe(selected);
  calls.alert(selected);
  calls.release(selected);
  calls.emitSnapshot(selected);
  return calls;
}

describe("exact target inventory replacement contract", () => {
  it("validates invented coverage while keeping authority-unproven targets blocked and primary selectable", () => {
    const result = validate();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid inventory");
    expect(result.snapshot.derived.artifactValidity).toBe("VALID");
    expect(result.snapshot.derived.authorizationState).toBe("BLOCKED");
    expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_PRIMARY).toEqual([]);
    expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_AUTHORITY_UNPROVEN).toContain("AUTHORITY_UNPROVEN");
    const selected = selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_PRIMARY");
    expect(selected?.records).toHaveLength(13);
    expect(selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_AUTHORITY_UNPROVEN")).toBeNull();
    expect(selectExactTargetInventoryRecord(result.snapshot, selected!.records[0].inventoryRef)).toBeTruthy();
    expect(selectExactTargetInventoryTarget({ ...result.snapshot } as any, "ACTIVE_CLIENT_PRIMARY")).toBeNull();
    expect(() => ((result.snapshot.records as any[])[0].ownerRef = "changed")).toThrow();
    expect(result.publicProjection.records.every((record) => /^managed-inventory-[a-f0-9]{64}$/.test(record.inventoryRef))).toBe(true);
  });

  it("canonical replay is deterministic and omits absent provider optionals", () => {
    const result = validate();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid inventory");
    expect(result.canonicalJson).not.toContain("undefined");
    const replayed = validateExactTargetInventory(result.canonicalJson, { now: NOW });
    expect(replayed.ok).toBe(true);
    expect(replayed.ok && replayed.documentDigest).toBe(result.documentDigest);
  });

  it("strictly accepts all 14 record detail kinds and rejects alternate detail injection", () => {
    const snapshot = makeInventory();
    const primaryRecords = snapshot.records.filter((record: JsonObject) => record.workloadId === snapshot.records[0].workloadId);
    expect(new Set(snapshot.records.map((record: JsonObject) => record.recordType))).toEqual(new Set(EXACT_TARGET_RECORD_TYPES));
    const target = primaryRecords.find((record: JsonObject) => record.recordType === "WORKLOAD");
    target.credentialRef = { valueObserved: true };
    const result = validate(snapshot);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("UNKNOWN_FIELD");
    expect(JSON.stringify(result.publicProjection)).not.toContain("credential");
  });

  it("rejects hostile structures before dedupe, semantic checks, projection, or accessors", () => {
    const getter = vi.fn();
    const records: any[] = [];
    Object.defineProperty(records, "sideChannel", { enumerable: true, get: getter });
    const result = validateExactTargetInventory({ ...makeInventory(), records }, { now: NOW });
    expect(result.ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(result.issues[0].path).toBe("/field/unknown-field");

    const polluted = JSON.parse("{\"__proto__\":{\"schemaVersion\":\"1.0.0\"},\"private-client-secret\":1}");
    const rejected = validateExactTargetInventory(polluted, { now: NOW });
    expect(rejected.ok).toBe(false);
    expect(rejected.issues.map((issue) => issue.path).join(" ")).not.toContain("private-client-secret");
    expect(rejected.publicProjection.records).toEqual([]);

    const duplicate = validateExactTargetInventory("{\"private-client-secret\":1,\"private-client-secret\":2}", { now: NOW });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.issues).toEqual([{ code: "DUPLICATE_JSON_KEY", path: "/duplicate-key" }]);
  });

  it("rejects authority, completeness, evidence freshness, chronology, GAP class, identity, and FQDN defects", () => {
    let snapshot = makeInventory();
    snapshot.validationSummary.completeness[0].evidenceRefs = [];
    expectIssue(snapshot, "REQUIRED_FIELD");

    snapshot = makeInventory();
    const primaryData = snapshot.records.find((record: JsonObject) => record.recordType === "DATA_STORE" && record.workloadId === snapshot.records[0].workloadId);
    const bindingRef = primaryData.dataStore.bindingEvidenceRef;
    snapshot.evidence.find((entry: JsonObject) => entry.evidenceRef === bindingRef).freshness = "POLICY_PENDING";
    expectIssue(snapshot, "STALE_OR_EXPIRED");

    snapshot = makeInventory();
    snapshot.records[0].authority.data.evidenceRefs = [];
    expectIssue(snapshot, "AUTHORITY_UNPROVEN");

    snapshot = makeInventory();
    snapshot.records[0].authority.data.verdict = "NOT_APPLICABLE";
    snapshot.records[0].authority.data.evidenceRefs = [];
    snapshot.records[0].authority.authorizationState = "BLOCKED";
    snapshot.validationSummary.completeness[0].status = "BLOCKED";
    const notApplicable = validate(rehash(snapshot));
    expect(notApplicable.ok).toBe(true);
    if (!notApplicable.ok) throw new Error("expected valid blocked inventory");
    expect(notApplicable.snapshot.derived.targetBlockers.ACTIVE_CLIENT_PRIMARY).toContain("AUTHORITY_UNPROVEN");
    expect(selectExactTargetInventoryTarget(notApplicable.snapshot, "ACTIVE_CLIENT_PRIMARY")).toBeNull();

    snapshot = makeInventory();
    snapshot.records[0].authority.data.verdict = "NOT_APPLICABLE";
    snapshot.records[0].authority.data.evidenceRefs = [];
    snapshot.records[0].authority.authorizationState = "INVENTORY_ONLY";
    expectIssue(snapshot, "CLAIM_MISMATCH");

    snapshot = makeInventory();
    snapshot.records[0].authority.data.evidenceRefs = [snapshot.records[0].evidenceRefs[0]];
    expectIssue(snapshot, "AUTHORITY_UNPROVEN");

    snapshot = makeInventory();
    snapshot.records[0].authority.data.evidenceRefs = [...snapshot.records[0].authority.serving.evidenceRefs];
    expectIssue(snapshot, "AUTHORITY_UNPROVEN");

    snapshot = makeInventory();
    snapshot.records[0].authority.data.independentVerifierRef = snapshot.validationSummary.validatorRef;
    expectIssue(snapshot, "AUTHORITY_UNPROVEN");

    snapshot = makeInventory();
    snapshot.records[0].verifiedAt = "2026-08-24T23:00:00Z";
    expectIssue(snapshot, "STALE_OR_EXPIRED");

    snapshot = makeInventory();
    const gap = snapshot.records.find((record: JsonObject) => record.recordType === "GAP");
    gap.gap.workloadClass = "CORE_WEB";
    expectIssue(snapshot, "CLAIM_MISMATCH");

    snapshot = makeInventory();
    const domain = snapshot.records.find((record: JsonObject) => record.recordType === "DOMAIN");
    domain.domain.fqdn = "-invalid.example";
    const invalidDomain = validate(snapshot);
    expect(invalidDomain.ok).toBe(false);
    expect(invalidDomain.issues.map((issue) => issue.code)).toContain("INVALID_VALUE");

    expect(deriveExactTargetInventoryKey({
      recordType: "TYPO",
      workloadId: snapshot.records[0].workloadId,
      environmentId: snapshot.records[0].environmentId,
      detail: {},
    })).toBeNull();
  });

  it("rejects cross-target refs, unsupported authority evidence, credential endpoints, and expired rollback", () => {
    let snapshot = makeInventory();
    const credential = snapshot.records.find((record: JsonObject) => record.recordType === "CREDENTIAL_REF" && record.workloadId === snapshot.records[0].workloadId);
    const foreign = snapshot.records.find((record: JsonObject) => record.recordType === "WORKER" && record.workloadId !== snapshot.records[0].workloadId);
    credential.credentialRef.consumerResourceRefs = [foreign.inventoryRef];
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    const evidence = snapshot.evidence[0];
    evidence.artifactRef.digest = sha256Hex("other");
    expectIssue(snapshot, "DERIVED_DIGEST_MISMATCH");

    snapshot = makeInventory();
    const dataStore = snapshot.records.find((record: JsonObject) => record.recordType === "DATA_STORE" && record.workloadId === snapshot.records[0].workloadId);
    dataStore.dataStore.endpointFingerprint = "postgres://user:password@example.test/db";
    expectIssue(snapshot, "INVALID_DIGEST");

    snapshot = makeInventory();
    const rollback = snapshot.records.find((record: JsonObject) => record.recordType === "ROLLBACK_ASSET" && record.workloadId === snapshot.records[0].workloadId);
    rollback.rollbackAsset.retainUntil = "2026-08-24T00:00:00Z";
    expectIssue(snapshot, "STALE_OR_EXPIRED");
  });

  it("proves the non-dry-run zero-effect contract causally per target blocker", () => {
    const baseline = validate();
    expect(baseline.ok).toBe(true);
    if (!baseline.ok) throw new Error("expected valid inventory");
    const selected = selectExactTargetInventoryTarget(baseline.snapshot, "ACTIVE_CLIENT_PRIMARY");
    expect(selected).not.toBeNull();
    let calls = offlineConsumer(selected, false);
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    calls = offlineConsumer(selected, true);
    for (const fn of Object.values(calls)) expect(fn).toHaveBeenCalledTimes(1);

    const blockerMutations: Array<[ExactTargetInventoryBlockerCode, (snapshot: JsonObject) => void]> = [
      ["POLICY_PENDING", (snapshot) => {
        const record = snapshot.records[0];
        record.disposition.status = "POLICY_PENDING";
        record.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
        snapshot.validationSummary.blockerCodes = ["AUTHORITY_UNPROVEN", "LIFECYCLE_NOT_SELECTABLE", "POLICY_PENDING"];
      }],
      ["AUTHORITY_UNPROVEN", (snapshot) => {
        const record = snapshot.records[0];
        record.authority.data.verdict = "AUTHORITY_UNPROVEN";
        record.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
        snapshot.validationSummary.blockerCodes = ["AUTHORITY_UNPROVEN", "LIFECYCLE_NOT_SELECTABLE", "POLICY_PENDING"];
      }],
      ["LIFECYCLE_NOT_SELECTABLE", (snapshot) => {
        const record = snapshot.records[0];
        record.lifecycle.releaseEligibility = "INELIGIBLE";
        record.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
        snapshot.validationSummary.blockerCodes = ["AUTHORITY_UNPROVEN", "LIFECYCLE_NOT_SELECTABLE", "POLICY_PENDING"];
      }],
    ];
    for (const [code, mutate] of blockerMutations) {
      const snapshot = makeInventory();
      mutate(snapshot);
      const result = validate(rehash(snapshot));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected valid blocked inventory");
      expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_PRIMARY).toContain(code);
      const blockedSelection = selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_PRIMARY");
      expect(blockedSelection).toBeNull();
      calls = offlineConsumer(blockedSelection, true);
      for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    }

    const invalid = validateExactTargetInventory({ ...makeInventory(), documentDigest: "not-a-digest" }, { now: NOW });
    expect(invalid.ok).toBe(false);
    calls = deps();
    if (invalid.ok) offlineConsumer(selectExactTargetInventoryTarget(invalid.snapshot, "ACTIVE_CLIENT_PRIMARY"), true, calls);
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
  });
});
