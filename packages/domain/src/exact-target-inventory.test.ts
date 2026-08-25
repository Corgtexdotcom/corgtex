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
type ValidationResult = ReturnType<typeof validateExactTargetInventory>;
type ValidResult = Extract<ValidationResult, Readonly<{ ok: true }>>;

const NOW = "2026-08-25T00:00:00Z";
const GENERATED = "2026-08-24T20:00:00Z";
const OBSERVED = "2026-08-24T19:00:00Z";
const EXPIRES = "2026-09-01T00:00:00Z";
const RETAIN = "2026-10-01T00:00:00Z";
const SHA = "a".repeat(40);
const BASE_DIGEST = sha256Hex("generic-offline-artifact");
const authorityDimensions = ["serving", "data", "object", "worker", "scheduler", "queue", "domain", "callback"] as const satisfies readonly ExactTargetAuthorityDimensionName[];

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

function uuid(prefix: number, value: number) {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

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

function authorityDimension(verdict = "PROVEN") {
  return {
    verdict,
    evidenceRefs: [],
    observedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    independentVerifierRef: "independent-verifier",
  };
}

function common(recordType: ExactTargetRecordType, workload: JsonObject, index: number, detail: JsonObject, options: { blocked?: boolean; includeProvider?: boolean; includeProviderOptionals?: boolean } = {}): JsonObject {
  const blocked = options.blocked ?? false;
  const authorityVerdict = blocked ? "AUTHORITY_UNPROVEN" : "PROVEN";
  return {
    recordId: uuid(1, index),
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
      stateEvidenceRef: "",
    },
    disposition: {
      decision: blocked ? "DECISION_REQUIRED" : "ADOPT",
      status: blocked ? "POLICY_PENDING" : "SETTLED",
      decisionRef: "p0-05-policy",
      decidedAt: OBSERVED,
      decisionOwner: "program-owner",
    },
    authority: {
      authorizationState: blocked ? "BLOCKED" : "INVENTORY_ONLY",
      serving: authorityDimension(authorityVerdict),
      data: authorityDimension(authorityVerdict),
      object: authorityDimension(authorityVerdict),
      worker: authorityDimension(authorityVerdict),
      scheduler: authorityDimension(authorityVerdict),
      queue: authorityDimension(authorityVerdict),
      domain: authorityDimension(authorityVerdict),
      callback: authorityDimension(authorityVerdict),
    },
    evidenceRefs: [],
    firstObservedAt: OBSERVED,
    lastObservedAt: OBSERVED,
    verifiedAt: OBSERVED,
    expiresAt: EXPIRES,
    ...(options.includeProvider ? { provider: provider(workload.slug, options.includeProviderOptionals) } : {}),
    [detailKeyByType[recordType]]: detail,
  };
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

function makeEvidence(record: JsonObject, index: number, workloadClass: string, evidenceKind: string, freshness = "CURRENT") {
  const evidence = {
    evidenceId: uuid(2, index),
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
    artifactRef: artifact(`${evidenceKind.toLowerCase()}-${index}`),
    artifactDigest: sha256Hex(`${evidenceKind.toLowerCase()}-${index}`),
  };
  finalizeEvidence(evidence);
  return evidence;
}

function workloadSkeleton(workloadClass: string, group: number) {
  const slug = workloadClass.toLowerCase().replaceAll("_", "-");
  return {
    slug,
    workloadId: uuid(3, group),
    environmentId: uuid(4, group),
  };
}

function assignRecordProofs(records: JsonObject[], evidence: JsonObject[], workloadClass: string, group: number) {
  let serial = group * 100000;
  const add = (record: JsonObject, kind: string) => {
    const item = makeEvidence(record, ++serial, workloadClass, kind);
    evidence.push(item);
    return item.evidenceRef;
  };
  for (const record of records) {
    record.evidenceRefs = [add(record, "CAPTURE")];
    record.lifecycle.stateEvidenceRef = add(record, "LIFECYCLE");
    for (const dimension of authorityDimensions) {
      if (record.authority[dimension].verdict === "PROVEN") {
        record.authority[dimension].evidenceRefs = [add(record, "AUTHORITY")];
      }
    }
    switch (record.recordType as ExactTargetRecordType) {
      case "ENVIRONMENT":
        record.environment.policyEvidenceRef = add(record, "DETAIL");
        break;
      case "PROVIDER_RESOURCE":
        record.resource.providerEvidenceRef = add(record, "DETAIL");
        break;
      case "DATA_STORE":
        record.dataStore.bindingEvidenceRef = add(record, "DETAIL");
        break;
      case "OBJECT_STORE":
        record.objectStore.bindingEvidenceRef = add(record, "DETAIL");
        break;
      case "DOMAIN":
        record.domain.dnsEvidenceRef = add(record, "DETAIL");
        break;
      case "CALLBACK":
        record.callback.externalConfigurationEvidenceRef = add(record, "DETAIL");
        break;
      case "CREDENTIAL_REF":
        record.credentialRef.rotationEvidenceRef = add(record, "DETAIL");
        break;
      case "IMAGE":
        record.image.buildProvenanceEvidenceRef = add(record, "DETAIL");
        break;
      case "ROLLBACK_ASSET":
        record.rollbackAsset.evidenceRef = add(record, "ROLLBACK");
        break;
      case "GAP":
        record.gap.evidenceRef = add(record, "DETAIL");
        break;
    }
  }
  records.forEach(finalizeRecord);
}

function addRelationship(collection: { relationships: JsonObject[]; evidence: JsonObject[] }, group: number, index: number, type: string, from: JsonObject, to: JsonObject, workloadClass: string) {
  const proof = makeEvidence(from, group * 100000 + 50000 + index, workloadClass, "RELATIONSHIP");
  collection.evidence.push(proof);
  collection.relationships.push({
    relationshipId: uuid(5, group * 1000 + index),
    fromRecordRef: from.inventoryRef,
    toRecordRef: to.inventoryRef,
    relationshipType: type,
    evidenceRefs: [proof.evidenceRef],
  });
}

function addCompletenessEvidence(evidence: JsonObject[], workload: JsonObject, workloadClass: string, group: number) {
  const proof = makeEvidence(workload, 900000000 + group, workloadClass, "COMPLETENESS");
  evidence.push(proof);
  return proof.evidenceRef;
}

function makeRollback(workload: JsonObject, target: JsonObject, group: number, offset: number) {
  return common("ROLLBACK_ASSET", workload, group * 100 + offset, {
    rollbackAssetId: `rollback/${workload.slug}/${offset}`,
    assetDigest: sha256Hex(`rollback-${workload.slug}-${offset}`),
    createdAt: OBSERVED,
    verifiedAt: OBSERVED,
    restoreTestedAt: OBSERVED,
    retainUntil: RETAIN,
    targetRecordRef: target.inventoryRef,
    evidenceRef: "",
  }, { includeProvider: true });
}

function makeFullTarget(workloadClass = "ACTIVE_CLIENT_PRIMARY", group = 1) {
  const workload = workloadSkeleton(workloadClass, group);
  const records: JsonObject[] = [];
  const evidence: JsonObject[] = [];
  const relationships: JsonObject[] = [];
  const add = (recordType: ExactTargetRecordType, detail: JsonObject, includeProvider = false, includeProviderOptionals = true) => {
    const record = common(recordType, workload, group * 100 + records.length + 1, detail, { includeProvider, includeProviderOptionals });
    records.push(record);
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
    policyEvidenceRef: "",
  });
  const resource = add("PROVIDER_RESOURCE", {
    providerResourceId: `resource/${workload.slug}`,
    resourceKind: "service",
    resourceNameFingerprint: `sha256:${sha256Hex(`resource-${workload.slug}`)}`,
    region: "offline",
    providerEvidenceRef: "",
  }, true);
  const dataStore = add("DATA_STORE", {
    providerResourceId: `resource/${workload.slug}`,
    databaseId: `database/${workload.slug}`,
    storeRole: "AUTHORITATIVE_CANDIDATE",
    dataClass: "INTERNAL",
    endpointFingerprint: `sha256:${sha256Hex(`data-${workload.slug}`)}`,
    bindingEvidenceRef: "",
    credentialRefs: [],
  }, true, false);
  const objectStore = add("OBJECT_STORE", {
    providerResourceId: `resource/${workload.slug}`,
    bucketId: `bucket/${workload.slug}`,
    storeRole: "AUXILIARY",
    dataClass: "INTERNAL",
    endpointFingerprint: `sha256:${sha256Hex(`object-${workload.slug}`)}`,
    bindingEvidenceRef: "",
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
    dnsEvidenceRef: "",
  }, true);
  const callback = add("CALLBACK", {
    callbackId: `callback/${workload.slug}`,
    callbackUrl: `https://callback-${workload.slug}.example.test/hooks/offline`,
    callbackRole: "WEBHOOK",
    targetResourceRef: "",
    externalConfigurationEvidenceRef: "",
    credentialRefs: [],
  }, true);
  const credential = add("CREDENTIAL_REF", {
    credentialRefId: `credential/${workload.slug}`,
    credentialKind: "WEBHOOK_SECRET",
    valueObserved: false,
    rotationEvidenceRef: "",
    consumerResourceRefs: [],
  }, true);
  const image = add("IMAGE", {
    imageDigest: sha256Hex(`image-${workload.slug}`),
    sourceCommitSha: SHA,
    buildProvenanceEvidenceRef: "",
    consumerResourceRefs: [],
  }, true);

  records.forEach(finalizeRecord);
  worker.worker.imageRef = image.inventoryRef;
  worker.worker.queueRefs = [queue.inventoryRef];
  worker.worker.dataStoreRefs = [dataStore.inventoryRef];
  worker.worker.objectStoreRefs = [objectStore.inventoryRef];
  worker.worker.credentialRefs = [credential.inventoryRef];
  scheduler.scheduler.targetWorkerRef = worker.inventoryRef;
  scheduler.scheduler.credentialRefs = [credential.inventoryRef];
  queue.queue.producerRefs = [scheduler.inventoryRef];
  queue.queue.consumerRefs = [worker.inventoryRef];
  queue.queue.credentialRefs = [credential.inventoryRef];
  domain.domain.targetResourceRef = resource.inventoryRef;
  callback.callback.targetResourceRef = worker.inventoryRef;
  callback.callback.credentialRefs = [credential.inventoryRef];
  credential.credentialRef.consumerResourceRefs = [resource.inventoryRef, dataStore.inventoryRef, objectStore.inventoryRef, worker.inventoryRef, scheduler.inventoryRef, queue.inventoryRef, domain.inventoryRef, callback.inventoryRef];
  image.image.consumerResourceRefs = [resource.inventoryRef, worker.inventoryRef];
  records.forEach(finalizeRecord);

  const rollbacks = [
    makeRollback(workload, resource, group, 31),
    makeRollback(workload, dataStore, group, 32),
    makeRollback(workload, objectStore, group, 33),
    makeRollback(workload, worker, group, 34),
  ];
  records.push(...rollbacks);
  records.forEach(finalizeRecord);
  assignRecordProofs(records, evidence, workloadClass, group);

  const collection = { evidence, relationships };
  let edge = 0;
  addRelationship(collection, group, ++edge, "OWNS", workloadRecord, environmentRecord, workloadClass);
  for (const item of records) {
    if (item !== workloadRecord && item !== environmentRecord) addRelationship(collection, group, ++edge, "OWNS", environmentRecord, item, workloadClass);
  }
  addRelationship(collection, group, ++edge, "USES_IMAGE", worker, image, workloadClass);
  addRelationship(collection, group, ++edge, "DEPENDS_ON", worker, queue, workloadClass);
  addRelationship(collection, group, ++edge, "DEPENDS_ON", worker, dataStore, workloadClass);
  addRelationship(collection, group, ++edge, "DEPENDS_ON", worker, objectStore, workloadClass);
  addRelationship(collection, group, ++edge, "DEPENDS_ON", scheduler, worker, workloadClass);
  addRelationship(collection, group, ++edge, "DEPENDS_ON", scheduler, queue, workloadClass);
  for (const consumer of [resource, dataStore, objectStore, worker, scheduler, queue, domain, callback]) {
    addRelationship(collection, group, ++edge, "USES_CREDENTIAL", consumer, credential, workloadClass);
  }
  addRelationship(collection, group, ++edge, "USES_IMAGE", resource, image, workloadClass);
  addRelationship(collection, group, ++edge, "EXPOSES_DOMAIN", resource, domain, workloadClass);
  addRelationship(collection, group, ++edge, "CALLS_BACK", worker, callback, workloadClass);
  for (const rollback of rollbacks) {
    const target = records.find((item) => item.inventoryRef === rollback.rollbackAsset.targetRecordRef)!;
    addRelationship(collection, group, ++edge, "HAS_ROLLBACK", target, rollback, workloadClass);
  }

  return { records, evidence, relationships, workloadRecord };
}

function makeBlockedTarget(workloadClass: string, group: number, blockerCode: ExactTargetInventoryBlockerCode) {
  const workload = workloadSkeleton(workloadClass, group);
  const records: JsonObject[] = [];
  const evidence: JsonObject[] = [];
  const relationships: JsonObject[] = [];
  const workloadRecord = common("WORKLOAD", workload, group * 100 + 1, {
    workloadId: workload.workloadId,
    workloadSlug: workload.slug,
    workloadClass,
    businessRole: "offline-target-inventory",
    customerAccountId: "generic-account",
    customerDeploymentId: "generic-deployment",
    workspaceId: "generic-workspace",
    runtimeRoles: ["web"],
    systemOfRecordRoles: ["metadata"],
    dispositionRef: "p0-05-policy",
  }, { blocked: true });
  const environmentRecord = common("ENVIRONMENT", workload, group * 100 + 2, {
    environmentId: workload.environmentId,
    workloadId: workload.workloadId,
    environmentClass: "PRODUCTION",
    publicBaseDomain: `${workload.slug}.example.test`,
    deploymentTrack: "stable",
    policyEvidenceRef: "",
  }, { blocked: true });
  const gap = common("GAP", workload, group * 100 + 3, {
    gapId: `gap/${workload.slug}`,
    workloadClass,
    gapType: blockerCode === "AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
    blockerCode,
    evidenceRef: "",
  }, { blocked: true });
  records.push(workloadRecord, environmentRecord, gap);
  records.forEach(finalizeRecord);
  assignRecordProofs(records, evidence, workloadClass, group);
  addRelationship({ evidence, relationships }, group, 1, "OWNS", workloadRecord, environmentRecord, workloadClass);
  addRelationship({ evidence, relationships }, group, 2, "OWNS", environmentRecord, gap, workloadClass);
  return { records, evidence, relationships, workloadRecord };
}

function makeInventory() {
  const primary = makeFullTarget("ACTIVE_CLIENT_PRIMARY", 1);
  const records = [...primary.records];
  const evidence = [...primary.evidence];
  const relationships = [...primary.relationships];
  const workloadRoots: Record<string, JsonObject> = { ACTIVE_CLIENT_PRIMARY: primary.workloadRecord };
  for (const [index, workloadClass] of EXACT_TARGET_WORKLOAD_CLASSES.entries()) {
    if (workloadClass === "ACTIVE_CLIENT_PRIMARY") continue;
    const blocked = makeBlockedTarget(
      workloadClass,
      index + 10,
      workloadClass === "ACTIVE_CLIENT_AUTHORITY_UNPROVEN" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
    );
    workloadRoots[workloadClass] = blocked.workloadRecord;
    records.push(...blocked.records);
    evidence.push(...blocked.evidence);
    relationships.push(...blocked.relationships);
  }
  const completeness = EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass, index) => ({
    workloadClass,
    status: workloadClass === "ACTIVE_CLIENT_PRIMARY" ? "COMPLETE" : "BLOCKED",
    evidenceRefs: [addCompletenessEvidence(evidence, workloadRoots[workloadClass], workloadClass, index + 50)],
  }));
  return rehash({
    schemaVersion: "1.0.0",
    inventoryId: uuid(9, 1),
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

function rawRecordDigestInput(record: JsonObject) {
  const { recordDigest, detailKey, detail, ...rest } = record;
  return rest;
}

function rawDocumentDigestInput(snapshot: JsonObject) {
  const { documentDigest, derived, ...rest } = snapshot;
  return rest;
}

function rehash(snapshot: JsonObject) {
  for (const record of snapshot.records) finalizeRecord(record);
  snapshot.documentDigest = sha256Hex(canonicalJson(rawDocumentDigestInput(snapshot)));
  delete snapshot.derived;
  return snapshot;
}

function validate(snapshot = makeInventory()) {
  return validateExactTargetInventory(JSON.stringify(snapshot), { now: NOW });
}

function requireValid(result: ValidationResult): asserts result is ValidResult {
  if (!result.ok) throw new Error(JSON.stringify(result.issues.slice(0, 30)));
}

function expectIssue(snapshot: JsonObject, code: ExactTargetInventoryBlockerCode) {
  const result = validate(rehash(snapshot));
  expect(result.ok).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain(code);
  expect(JSON.stringify(result.publicProjection.records)).toBe("[]");
  return result;
}

function expectNoEffectsFromInput(input: unknown, calls = deps()) {
  const result = validateExactTargetInventory(input, { now: NOW });
  expect(result.ok).toBe(false);
  for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
  return result;
}

function record(snapshot: JsonObject, type: ExactTargetRecordType) {
  const found = snapshot.records.find((entry: JsonObject) => entry.recordType === type && entry.workloadId === snapshot.records[0].workloadId);
  if (!found) throw new Error(`missing ${type}`);
  return found;
}

function evidenceFor(snapshot: JsonObject, ref: string) {
  const found = snapshot.evidence.find((entry: JsonObject) => entry.evidenceRef === ref);
  if (!found) throw new Error(`missing evidence ${ref}`);
  return found;
}

function discardEvidence(snapshot: JsonObject, refs: string[]) {
  snapshot.evidence = snapshot.evidence.filter((entry: JsonObject) => !refs.includes(entry.evidenceRef));
}

function relationship(snapshot: JsonObject, type: string) {
  const found = snapshot.relationships.find((entry: JsonObject) => entry.relationshipType === type);
  if (!found) throw new Error(`missing relationship ${type}`);
  return found;
}

function dataStoreRef(snapshot: JsonObject) {
  return record(snapshot, "DATA_STORE").dataStore.bindingEvidenceRef;
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

function assertBlockedZero(snapshot: JsonObject, code: ExactTargetInventoryBlockerCode) {
  const result = validate(rehash(snapshot));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected valid blocked inventory");
  expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_PRIMARY).toContain(code);
  const calls = offlineConsumer(selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_PRIMARY"), true);
  for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
}

describe("exact target inventory replacement contract", () => {
  it("selects one validated closed graph and emits only opaque public projection", () => {
    const result = validate();
    requireValid(result);
    expect(result.ok).toBe(true);
    expect(new Set(result.snapshot.records.map((entry: { recordType: ExactTargetRecordType }) => entry.recordType))).toEqual(new Set(EXACT_TARGET_RECORD_TYPES));
    expect(result.snapshot.derived.artifactValidity).toBe("VALID");
    expect(result.snapshot.derived.authorizationState).toBe("BLOCKED");
    expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_PRIMARY).toEqual([]);
    expect(result.snapshot.derived.targetBlockers.ACTIVE_CLIENT_AUTHORITY_UNPROVEN).toContain("AUTHORITY_UNPROVEN");
    const selected = selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_PRIMARY");
    expect(selected?.records).toHaveLength(16);
    expect(selected?.relationships.every((entry) => selected.inventoryRefs.includes(entry.fromRecordRef) && selected.inventoryRefs.includes(entry.toRecordRef))).toBe(true);
    expect(selectExactTargetInventoryTarget(result.snapshot, "ACTIVE_CLIENT_AUTHORITY_UNPROVEN")).toBeNull();
    expect(selectExactTargetInventoryRecord(result.snapshot, selected!.records[0].inventoryRef)).toBeTruthy();
    expect(selectExactTargetInventoryTarget({ ...result.snapshot } as any, "ACTIVE_CLIENT_PRIMARY")).toBeNull();
    expect(() => ((result.snapshot.records as any[])[0].ownerRef = "changed")).toThrow();
    expect(result.publicProjection.records.every((entry) => /^managed-inventory-[a-f0-9]{64}$/.test(entry.inventoryRef))).toBe(true);
    expect(JSON.stringify(result.publicProjection)).not.toContain("callback-");
    expect(JSON.stringify(result.publicProjection)).not.toContain("generic-account");
  });

  it("accepts only bounded JSON text and rejects objects and proxies before reflection", () => {
    const baseline = validate();
    requireValid(baseline);
    expect(baseline.ok).toBe(true);
    const replayed = validateExactTargetInventory(baseline.canonicalJson, { now: NOW });
    expect(replayed.ok).toBe(true);
    expect(replayed.ok && replayed.documentDigest).toBe(baseline.documentDigest);

    const getter = vi.fn();
    const objectInput: any = { ...makeInventory() };
    Object.defineProperty(objectInput, "records", { enumerable: true, get: getter });
    const objectResult = validateExactTargetInventory(objectInput, { now: NOW });
    expect(objectResult.ok).toBe(false);
    expect(objectResult.issues).toEqual([{ code: "INVALID_JSON", path: "/" }]);
    expect(getter).not.toHaveBeenCalled();

    for (const trap of ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "get"] as const) {
      const counter = vi.fn();
      const proxy = new Proxy({}, {
        ownKeys(target) {
          if (trap === "ownKeys") counter();
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, property) {
          if (trap === "getOwnPropertyDescriptor") counter();
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
        getPrototypeOf(target) {
          if (trap === "getPrototypeOf") counter();
          return Reflect.getPrototypeOf(target);
        },
        get(target, property, receiver) {
          if (trap === "get") counter();
          return Reflect.get(target, property, receiver);
        },
      });
      expectNoEffectsFromInput(proxy);
      expect(counter).not.toHaveBeenCalled();
    }

    expect(validateExactTargetInventory(" ".repeat(2_000_001), { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    expect(validateExactTargetInventory(`"${"é".repeat(1_000_001)}"`, { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    expect(validateExactTargetInventory("{", { now: NOW }).issues[0].code).toBe("INVALID_JSON");
    expect(validateExactTargetInventory("{\"private-client-secret\":1,\"private-client-secret\":2}", { now: NOW }).issues).toEqual([{ code: "DUPLICATE_JSON_KEY", path: "/duplicate-key" }]);
    expect(validateExactTargetInventory(`${"[".repeat(26)}null${"]".repeat(26)}`, { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    expect(validateExactTargetInventory(JSON.stringify({ records: Array.from({ length: 513 }, () => null) }), { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    expect(validateExactTargetInventory(JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`k${index}`, index]))), { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    expect(validateExactTargetInventory(JSON.stringify({ value: "a".repeat(2049) }), { now: NOW }).issues[0].code).toBe("STRUCTURAL_LIMIT");
    const unknownPrivate = validateExactTargetInventory("{\"schemaVersion\":\"1.0.0\",\"private-client-secret\":1}", { now: NOW });
    expect(unknownPrivate.ok).toBe(false);
    expect(unknownPrivate.issues.map((issue) => issue.path).join(" ")).not.toContain("private-client-secret");
  });

  it("rejects wrong evidence ownership, kind, finality, chronology, reuse, and unattached proofs", () => {
    const useSites: Array<[string, () => [JsonObject, string]]> = [
      ["CAPTURE", () => { const snapshot = makeInventory(); return [snapshot, record(snapshot, "WORKLOAD").evidenceRefs[0]]; }],
      ["LIFECYCLE", () => { const snapshot = makeInventory(); return [snapshot, record(snapshot, "WORKLOAD").lifecycle.stateEvidenceRef]; }],
      ["DETAIL", () => { const snapshot = makeInventory(); return [snapshot, record(snapshot, "DATA_STORE").dataStore.bindingEvidenceRef]; }],
      ["AUTHORITY", () => { const snapshot = makeInventory(); return [snapshot, record(snapshot, "WORKLOAD").authority.data.evidenceRefs[0]]; }],
      ["RELATIONSHIP", () => { const snapshot = makeInventory(); return [snapshot, relationship(snapshot, "DEPENDS_ON").evidenceRefs[0]]; }],
      ["ROLLBACK", () => { const snapshot = makeInventory(); return [snapshot, record(snapshot, "ROLLBACK_ASSET").rollbackAsset.evidenceRef]; }],
      ["COMPLETENESS", () => { const snapshot = makeInventory(); return [snapshot, snapshot.validationSummary.completeness[0].evidenceRefs[0]]; }],
    ];
    for (const [expectedKind, build] of useSites) {
      const [snapshot, ref] = build();
      evidenceFor(snapshot, ref).evidenceKind = expectedKind === "DETAIL" ? "LIFECYCLE" : "DETAIL";
      expectIssue(snapshot, "INVALID_REFERENCE");
    }

    let snapshot = makeInventory();
    const dataStore = record(snapshot, "DATA_STORE");
    const worker = record(snapshot, "WORKER");
    evidenceFor(snapshot, dataStore.dataStore.bindingEvidenceRef).sourceRecordRef = worker.inventoryRef;
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    evidenceFor(snapshot, dataStoreRef(snapshot)).artifactRef.status = "EVIDENCE_PENDING";
    expectIssue(snapshot, "POLICY_PENDING");

    snapshot = makeInventory();
    evidenceFor(snapshot, dataStoreRef(snapshot)).freshness = "STALE";
    expectIssue(snapshot, "STALE_OR_EXPIRED");

    snapshot = makeInventory();
    evidenceFor(snapshot, dataStoreRef(snapshot)).artifactRef.digest = sha256Hex("other");
    expectIssue(snapshot, "DERIVED_DIGEST_MISMATCH");

    snapshot = makeInventory();
    evidenceFor(snapshot, dataStoreRef(snapshot)).verifiedAt = "2026-08-24T23:00:00Z";
    expectIssue(snapshot, "STALE_OR_EXPIRED");

    snapshot = makeInventory();
    record(snapshot, "DATA_STORE").dataStore.bindingEvidenceRef = record(snapshot, "OBJECT_STORE").objectStore.bindingEvidenceRef;
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    record(snapshot, "WORKLOAD").authority.data.evidenceRefs = [...record(snapshot, "WORKLOAD").authority.serving.evidenceRefs];
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    const unattached = { ...snapshot.evidence[0], evidenceId: uuid(2, 999999), evidenceRef: "" };
    finalizeEvidence(unattached);
    snapshot.evidence.push(unattached);
    expectIssue(snapshot, "INVALID_REFERENCE");
  });

  it("rejects ambiguous roots, duplicate identities, invalid endpoints, reciprocity gaps, and unreachable records", () => {
    let snapshot = makeInventory();
    const duplicateWorkload = JSON.parse(JSON.stringify(record(snapshot, "WORKLOAD")));
    duplicateWorkload.recordId = uuid(1, 900000);
    duplicateWorkload.workloadId = uuid(3, 900000);
    duplicateWorkload.environmentId = uuid(4, 900000);
    duplicateWorkload.workload.workloadId = duplicateWorkload.workloadId;
    finalizeRecord(duplicateWorkload);
    snapshot.records.push(duplicateWorkload);
    expectIssue(snapshot, "DUPLICATE_IDENTITY");

    snapshot = makeInventory();
    const duplicateEnvironment = JSON.parse(JSON.stringify(record(snapshot, "ENVIRONMENT")));
    duplicateEnvironment.recordId = uuid(1, 900001);
    duplicateEnvironment.environment.deploymentTrack = "canary";
    finalizeRecord(duplicateEnvironment);
    snapshot.records.push(duplicateEnvironment);
    expectIssue(snapshot, "DUPLICATE_IDENTITY");

    snapshot = makeInventory();
    const otherWorkload = snapshot.records.find((entry: JsonObject) => entry.recordType === "WORKLOAD" && entry.workload.workloadClass === "CORE_WEB");
    otherWorkload.workloadId = snapshot.records[0].workloadId;
    otherWorkload.environmentId = snapshot.records[0].environmentId;
    otherWorkload.workload.workloadId = snapshot.records[0].workloadId;
    expectIssue(snapshot, "DUPLICATE_IDENTITY");

    snapshot = makeInventory();
    snapshot.records[1].recordId = snapshot.records[0].recordId;
    expectIssue(snapshot, "DUPLICATE_IDENTITY");

    for (const type of ["OWNS", "DEPENDS_ON", "USES_CREDENTIAL", "USES_IMAGE", "HAS_ROLLBACK", "EXPOSES_DOMAIN", "CALLS_BACK"]) {
      snapshot = makeInventory();
      const rel = relationship(snapshot, type);
      rel.fromRecordRef = record(snapshot, "WORKER").inventoryRef;
      rel.toRecordRef = record(snapshot, "WORKER").inventoryRef;
      expectIssue(snapshot, "INVALID_REFERENCE");
    }

    snapshot = makeInventory();
    record(snapshot, "WORKER").worker.queueRefs = [];
    record(snapshot, "QUEUE").queue.consumerRefs = [];
    expectIssue(snapshot, "CLAIM_MISMATCH");

    snapshot = makeInventory();
    relationship(snapshot, "USES_IMAGE").toRecordRef = record(snapshot, "WORKER").inventoryRef;
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    relationship(snapshot, "OWNS").toRecordRef = snapshot.records.find((entry: JsonObject) => entry.workloadId !== snapshot.records[0].workloadId).inventoryRef;
    expectIssue(snapshot, "INVALID_REFERENCE");

    snapshot = makeInventory();
    const ownedDataStore = record(snapshot, "DATA_STORE");
    snapshot.relationships = snapshot.relationships.filter((entry: JsonObject) => !(entry.relationshipType === "OWNS" && entry.toRecordRef === ownedDataStore.inventoryRef));
    expectIssue(snapshot, "INVALID_REFERENCE");
  });

  it("rejects missing, duplicate, expired, wrong-target, wrong-proof, and missing-edge rollback coverage", () => {
    for (const type of ["PROVIDER_RESOURCE", "DATA_STORE", "OBJECT_STORE", "WORKER"] as const) {
      let snapshot = makeInventory();
      const target = record(snapshot, type);
      snapshot.records = snapshot.records.filter((entry: JsonObject) => !(entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset?.targetRecordRef === target.inventoryRef));
      expectIssue(snapshot, "INVALID_REFERENCE");

      snapshot = makeInventory();
      const rollback = snapshot.records.find((entry: JsonObject) => entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset.targetRecordRef === record(snapshot, type).inventoryRef);
      const copy = JSON.parse(JSON.stringify(rollback));
      copy.recordId = uuid(1, 910000);
      copy.rollbackAsset.rollbackAssetId = `${copy.rollbackAsset.rollbackAssetId}-copy`;
      finalizeRecord(copy);
      snapshot.records.push(copy);
      expectIssue(snapshot, "INVALID_REFERENCE");

      snapshot = makeInventory();
      snapshot.records.find((entry: JsonObject) => entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset.targetRecordRef === record(snapshot, type).inventoryRef).rollbackAsset.retainUntil = "2026-08-24T00:00:00Z";
      expectIssue(snapshot, "STALE_OR_EXPIRED");

      snapshot = makeInventory();
      snapshot.records.find((entry: JsonObject) => entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset.targetRecordRef === record(snapshot, type).inventoryRef).rollbackAsset.targetRecordRef = record(snapshot, "SCHEDULER").inventoryRef;
      expectIssue(snapshot, "INVALID_REFERENCE");

      snapshot = makeInventory();
      const rollbackForProof = snapshot.records.find((entry: JsonObject) => entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset.targetRecordRef === record(snapshot, type).inventoryRef);
      evidenceFor(snapshot, rollbackForProof.rollbackAsset.evidenceRef).evidenceKind = "DETAIL";
      expectIssue(snapshot, "INVALID_REFERENCE");

      snapshot = makeInventory();
      const rollbackForEdge = snapshot.records.find((entry: JsonObject) => entry.recordType === "ROLLBACK_ASSET" && entry.rollbackAsset.targetRecordRef === record(snapshot, type).inventoryRef);
      snapshot.relationships = snapshot.relationships.filter((entry: JsonObject) => !(entry.relationshipType === "HAS_ROLLBACK" && entry.toRecordRef === rollbackForEdge.inventoryRef));
      expectIssue(snapshot, "INVALID_REFERENCE");
    }
  });

  it("keeps all non-proven, pending, gap, lifecycle, policy, retirement, and invalid paths zero-effect", () => {
    const baseline = validate();
    requireValid(baseline);
    expect(baseline.ok).toBe(true);
    const selected = selectExactTargetInventoryTarget(baseline.snapshot, "ACTIVE_CLIENT_PRIMARY");
    expect(selected).not.toBeNull();
    let calls = offlineConsumer(selected, false);
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();
    calls = offlineConsumer(selected, true);
    for (const fn of Object.values(calls)) expect(fn).toHaveBeenCalledTimes(1);
    calls = offlineConsumer(selectExactTargetInventoryTarget(baseline.snapshot, "CORE_WEB"), true);
    for (const fn of Object.values(calls)) expect(fn).not.toHaveBeenCalled();

    const blockers: Array<[ExactTargetInventoryBlockerCode, (snapshot: JsonObject) => void]> = [
      ["POLICY_PENDING", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        target.disposition.status = "POLICY_PENDING";
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
      ["LIFECYCLE_NOT_SELECTABLE", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        target.lifecycle.releaseEligibility = "INELIGIBLE";
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
      ["AUTHORITY_UNPROVEN", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        discardEvidence(snapshot, target.authority.data.evidenceRefs);
        target.authority.data.verdict = "AUTHORITY_UNPROVEN";
        target.authority.data.evidenceRefs = [];
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
      ["AUTHORITY_UNPROVEN", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        discardEvidence(snapshot, target.authority.data.evidenceRefs);
        target.authority.data.verdict = "CONFLICTED";
        target.authority.data.evidenceRefs = [];
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
      ["AUTHORITY_UNPROVEN", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        discardEvidence(snapshot, target.authority.data.evidenceRefs);
        target.authority.data.verdict = "POLICY_PENDING";
        target.authority.data.evidenceRefs = [];
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
      ["AUTHORITY_UNPROVEN", (snapshot) => {
        const target = record(snapshot, "WORKLOAD");
        discardEvidence(snapshot, target.authority.data.evidenceRefs);
        target.authority.data.verdict = "NOT_APPLICABLE";
        target.authority.data.evidenceRefs = [];
        target.authority.authorizationState = "BLOCKED";
        snapshot.validationSummary.completeness[0].status = "BLOCKED";
      }],
    ];
    for (const [code, mutate] of blockers) {
      const snapshot = makeInventory();
      mutate(snapshot);
      assertBlockedZero(snapshot, code);
    }

    const retired = makeInventory();
    (record(retired, "WORKLOAD").lifecycle as JsonObject).retirementEligibility = "UNKNOWN";
    expectIssue(retired, "INVALID_VALUE");

    expectNoEffectsFromInput("{");
    expectNoEffectsFromInput({ ...makeInventory() });
  });
});
