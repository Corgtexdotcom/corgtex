import { describe, expect, it, vi } from "vitest";
import {
  EXACT_TARGET_WORKLOAD_CLASSES,
  canonicalJson,
  deriveInventoryRef,
  sha256Hex,
  validateExactTargetInventory,
} from "./exact-target-inventory";

type JsonObject = { [key: string]: any };

const timestamp = "2026-08-24T20:00:00Z";
const digest = sha256Hex("fixture");

function authorityDimension(verdict: string) {
  return {
    verdict,
    evidenceRefs: ["evidence-offline-plan"],
    observedAt: timestamp,
    verifiedAt: timestamp,
    expiresAt: "2026-08-31T20:00:00Z",
    independentVerifierRef: "offline-validator",
  };
}

function authorityFor(workloadClass: string) {
  const defaultVerdict = workloadClass === "CHIRONE" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING";
  return {
    authorizationState: "INVENTORY_ONLY",
    serving: authorityDimension(defaultVerdict),
    data: authorityDimension(defaultVerdict),
    object: authorityDimension(defaultVerdict),
    worker: authorityDimension(defaultVerdict),
    scheduler: authorityDimension(defaultVerdict),
    queue: authorityDimension(defaultVerdict),
    domain: authorityDimension(defaultVerdict),
    callback: authorityDimension(defaultVerdict),
  };
}

function dispositionFor(workloadClass: string) {
  if (["ALUMIPRES", "STAGING_TEST_E2E", "DEMO"].includes(workloadClass)) {
    return {
      decision: "DECISION_REQUIRED",
      status: "POLICY_PENDING",
      decisionRef: "p0-05-offline-plan",
      decidedAt: timestamp,
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
    status: workloadClass === "CHIRONE" ? "EVIDENCE_PENDING" : "POLICY_PENDING",
    decisionRef: "p0-05-offline-plan",
    decidedAt: timestamp,
    decisionOwner: "program-owner",
  };
}

function workloadRecord(workloadClass: string, index: number) {
  const recordId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const inventoryKey = `LOCAL_RECOVERY|offline-account|offline-scope|workload|${workloadClass.toLowerCase()}|EVIDENCE_ONLY|p0-05`;
  const record: JsonObject = {
    recordId,
    recordType: "WORKLOAD",
    inventoryKey,
    inventoryRef: deriveInventoryRef(inventoryKey),
    recordRevision: 1,
    workloadId: `workload-${workloadClass.toLowerCase()}`,
    environmentId: "environment-p0-05",
    ownerRef: "program-owner",
    criticality: "P0",
    lifecycle: {
      state: "EVIDENCE_ONLY",
      provisioningState: "POLICY_PENDING",
      releaseEligibility: "POLICY_PENDING",
      retirementEligibility: "BLOCKED",
      stateObservedAt: timestamp,
      stateEvidenceRef: "evidence-offline-plan",
    },
    disposition: dispositionFor(workloadClass),
    authority: authorityFor(workloadClass),
    evidenceRefs: ["evidence-offline-plan"],
    firstObservedAt: timestamp,
    lastObservedAt: timestamp,
    verifiedAt: timestamp,
    expiresAt: "2026-08-31T20:00:00Z",
    workload: {
      workloadId: `workload-${workloadClass.toLowerCase()}`,
      workloadSlug: workloadClass.toLowerCase().replaceAll("_", "-"),
      workloadClass,
      businessRole: "offline-target-inventory",
      customerAccountId: "policy-pending",
      customerDeploymentId: "policy-pending",
      workspaceId: "policy-pending",
      runtimeRoles: ["EVIDENCE_ONLY"],
      systemOfRecordRoles: ["POLICY_PENDING"],
      dispositionRef: "p0-05-offline-plan",
    },
  };
  record.recordDigest = sha256Hex(canonicalJson(withoutKey(record, "recordDigest")));
  return record;
}

function exactInventory(overrides: Partial<JsonObject> = {}) {
  const records = EXACT_TARGET_WORKLOAD_CLASSES.map(workloadRecord);
  const snapshot: JsonObject = {
    schemaVersion: "1.0.0",
    inventoryId: "11111111-1111-4111-8111-111111111111",
    snapshotSequence: 1,
    generatedAt: timestamp,
    validFrom: timestamp,
    expiresAt: "2026-08-31T20:00:00Z",
    policyRef: { path: "/Users/janbrezina/Development /_local-handoffs/CORGTEX/2026-08-24/corgtex-program-execution-checkpoint-plan-2026-08-24.md", digest, status: "POLICY_PENDING" },
    dispositionRef: { path: "/Users/janbrezina/Development /_local-handoffs/CORGTEX/2026-08-24/corgtex-exact-target-inventory-plan-2026-08-24.md", digest, status: "POLICY_PENDING" },
    collectorContractRef: { path: "/offline/p0-05/synthetic-fixture", digest, status: "POLICY_PENDING" },
    collectorArtifactDigest: digest,
    sourceSnapshotRefs: ["p0-03-disposition-stale"],
    records,
    relationships: [],
    evidence: [{
      evidenceId: "evidence-offline-plan",
      evidenceType: "SANITIZED_HANDOFF",
      sourceAuthority: "P0-05_OFFLINE_PLAN",
      sourceRecordId: records[0].recordId,
      positiveFieldProjection: ["workloadClass", "disposition", "policyStatus"],
      collectorIdentityRef: "offline-validator",
      collectorVersionDigest: digest,
      collectedAt: timestamp,
      sourceObservedAt: timestamp,
      verifiedAt: timestamp,
      expiresAt: "2026-08-31T20:00:00Z",
      sanitizationClass: "PUBLIC_SAFE_OPAQUE",
      artifactRef: { path: "/offline/p0-05/synthetic-fixture", digest, status: "POLICY_PENDING" },
      artifactDigest: digest,
      freshnessStatus: "POLICY_PENDING",
      limitations: ["invented offline fixture; no live collection"],
    }],
    validationSummary: {
      completenessLedger: EXACT_TARGET_WORKLOAD_CLASSES.map((workloadClass) => ({
        workloadClass,
        status: "BLOCKED",
        evidenceRefs: ["evidence-offline-plan"],
        blockingGaps: workloadClass === "CHIRONE" ? ["AUTHORITY_UNPROVEN"] : ["POLICY_PENDING"],
        policyStatus: "POLICY_PENDING",
        dispositionDecision: dispositionFor(workloadClass).decision,
        authorityGate: workloadClass === "CHIRONE" ? "AUTHORITY_UNPROVEN" : "POLICY_PENDING",
      })),
      blockerCodes: ["POLICY_PENDING", "AUTHORITY_UNPROVEN"],
      validatedAt: timestamp,
    },
    documentDigest: "",
    ...overrides,
  };
  snapshot.documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));
  return snapshot;
}

function withoutKey(value: JsonObject, keyToRemove: string) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== keyToRemove));
}

function validateBeforeConsumerEffects(snapshot: JsonObject, effects: Array<() => void>) {
  const result = validateExactTargetInventory(snapshot);
  if (result.ok) effects.forEach((effect) => effect());
  return result;
}

describe("exact target inventory", () => {
  it("accepts a deterministic offline invented-fleet snapshot and emits only opaque public projection", () => {
    const snapshot = exactInventory();
    const result = validateExactTargetInventory(JSON.stringify(snapshot));

    expect(result.ok).toBe(true);
    expect(result.publicProjection.authorizationState).toBe("BLOCKED");
    expect(result.publicProjection.completeness).toHaveLength(EXACT_TARGET_WORKLOAD_CLASSES.length);
    expect(result.publicProjection.records).toHaveLength(EXACT_TARGET_WORKLOAD_CLASSES.length);
    expect(JSON.stringify(result.publicProjection)).not.toContain("LOCAL_RECOVERY|offline-account");
    expect(JSON.stringify(result.publicProjection)).not.toContain("chirone");
    expect(JSON.stringify(result.publicProjection)).not.toContain("Development /_local-handoffs");
    if (result.ok) {
      expect(validateExactTargetInventory(result.canonicalJson)).toMatchObject({ ok: true, documentDigest: result.documentDigest });
    }
  });

  it("rejects duplicate JSON keys and unknown fields before parsing can normalize them", () => {
    expect(validateExactTargetInventory("{\"schemaVersion\":\"1.0.0\",\"schemaVersion\":\"1.0.0\"}")).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "DUPLICATE_JSON_KEY" })],
    });

    const snapshot = exactInventory({ unexpected: true });
    expect(validateExactTargetInventory(JSON.stringify(snapshot))).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "UNKNOWN_FIELD", path: "/unexpected" })]),
    });
  });

  it("fails closed on caller-supplied refs, digest mismatches, duplicate identity, and retirement eligibility", () => {
    const snapshot = exactInventory();
    const first = (snapshot.records as JsonObject[])[0];
    const second = (snapshot.records as JsonObject[])[1];
    first.inventoryRef = deriveInventoryRef("LOCAL_RECOVERY|offline-account|offline-scope|workload|wrong|EVIDENCE_ONLY|p0-05");
    second.inventoryKey = first.inventoryKey;
    first.lifecycle = { ...(first.lifecycle as JsonObject), retirementEligibility: "ELIGIBLE" };
    snapshot.documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));

    const result = validateExactTargetInventory(JSON.stringify(snapshot));

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "DERIVED_REF_MISMATCH",
      "DUPLICATE_IDENTITY",
      "RETIREMENT_NOT_BLOCKED",
      "DERIVED_DIGEST_MISMATCH",
    ]));
    expect(JSON.stringify(result.publicProjection)).not.toContain(first.inventoryKey as string);
  });

  it("preserves Chirone AUTHORITY_UNPROVEN and policy-pending DECISION_REQUIRED gates", () => {
    const snapshot = exactInventory();
    const chirone = (snapshot.records as JsonObject[]).find((record) => (record.workload as JsonObject).workloadClass === "CHIRONE")!;
    chirone.authority = {
      ...(chirone.authority as JsonObject),
      worker: authorityDimension("PROVEN"),
    };
    const demo = (snapshot.records as JsonObject[]).find((record) => (record.workload as JsonObject).workloadClass === "DEMO")!;
    demo.disposition = {
      ...(demo.disposition as JsonObject),
      status: "SETTLED",
    };
    snapshot.documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));

    const result = validateExactTargetInventory(snapshot);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["AUTHORITY_UNPROVEN", "POLICY_PENDING"]));
  });

  it("blocks effects on invalid input and runs them only after validation succeeds", () => {
    const effects = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const invalidSnapshot = exactInventory();
    delete (invalidSnapshot.validationSummary as JsonObject).completenessLedger;

    expect(validateBeforeConsumerEffects(invalidSnapshot, effects)).toMatchObject({ ok: false });
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();

    expect(validateBeforeConsumerEffects(exactInventory(), effects)).toMatchObject({ ok: true });
    for (const effect of effects) expect(effect).toHaveBeenCalledTimes(1);
  });

  it("rejects secret-bearing callback and credential content sentinels", () => {
    const snapshot = exactInventory();
    const credential = workloadRecord("CRINA", 50);
    credential.recordId = "00000000-0000-4000-8000-000000000050";
    credential.recordType = "CREDENTIAL_REF";
    credential.credentialRef = {
      secretProvider: "GITHUB_ENVIRONMENT",
      vaultOrProjectId: "fleet-release-production",
      secretObjectId: "DATABASE_URL",
      versionSelectorPolicy: "CURRENT_BY_POLICY",
      consumerResourceRefs: ["worker"],
      purpose: "runtime-binding",
      ownerRef: "security-owner",
      rotationMetadataTimestamp: timestamp,
      valueObserved: true,
    };
    delete credential.workload;
    credential.recordDigest = sha256Hex(canonicalJson(withoutKey(credential, "recordDigest")));
    (snapshot.records as JsonObject[]).push(credential);
    snapshot.documentDigest = sha256Hex(canonicalJson(withoutKey(snapshot, "documentDigest")));

    const result = validateExactTargetInventory(snapshot);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SECRET_SENTINEL" })]));
  });
});
