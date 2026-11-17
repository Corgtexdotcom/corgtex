import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeManagedReleaseRecoveryIntent,
  canonicalizeInvalidRecoveryIntentSupersession,
  canonicalManagedReleaseRecoveryIntentJson,
  managedReleaseRecoveryIntentDigest,
  managedReleaseRecoveryIntentRevisionSuffix,
  type ManagedReleaseRecoveryIntentBase,
  type ManagedReleaseRecoveryIntentRole,
} from "./managed-azure-recovery-intent";

const LEASE_ID = "123e4567-e89b-42d3-a456-426614174000";
const DIGESTS = ["1", "2", "3", "4", "5", "6"].map((value) => `sha256:${value.repeat(64)}`);
const GIT_SHA = "c".repeat(40);
const authority = {
  leaseId: LEASE_ID,
  fence: 17,
  payload: {
    schemaVersion: 2 as const,
    target: {
      subscriptionId: "123e4567-e89b-12d3-a456-426614174111",
      resourceGroup: "rg.Safe_1",
      acrName: "acr12",
      acrServer: "acr12.azurecr.io",
      webAppName: "web-app",
      workerAppName: "worker-app",
    },
    previous: {
      releaseVersion: "release-1",
      web: {
        containerName: "web--old",
        image: `acr12.azurecr.io/corgtex/web@${DIGESTS[0]}`,
        readyRevision: "web-app--rev-1",
        templateDigest: DIGESTS[2],
      },
      worker: {
        containerName: "worker--old",
        image: `acr12.azurecr.io/corgtex/worker@${DIGESTS[1]}`,
        readyRevision: "worker-app--rev-2",
        templateDigest: DIGESTS[3],
      },
    },
    incoming: {
      webDigest: DIGESTS[2],
      workerDigest: DIGESTS[3],
      schemaApprovalDigest: DIGESTS[4],
    },
    compatibleRecovery: {
      gitSha: GIT_SHA,
      imageTag: `sha-${GIT_SHA}`,
      releaseVersion: "recovery-1",
      web: { image: `acr12.azurecr.io/corgtex/web@${DIGESTS[0]}`, digest: DIGESTS[0] },
      worker: { image: `acr12.azurecr.io/corgtex/worker@${DIGESTS[1]}`, digest: DIGESTS[1] },
      schemaCompatibilityApprovalDigest: DIGESTS[5],
      acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1" as const,
      activationPolicy: "EXCLUSIVE" as const,
    },
  },
};

function base(role: ManagedReleaseRecoveryIntentRole, overrides: Partial<ManagedReleaseRecoveryIntentBase> = {}): ManagedReleaseRecoveryIntentBase {
  return {
    protocolVersion: 1,
    purpose: "COMPATIBLE_RECOVERY_PATCH",
    role,
    originatingLeaseId: LEASE_ID,
    originatingFence: 17,
    appName: role === "web" ? "web-app" : "worker-app",
    predecessorRevisionName: role === "web" ? "web-app--rev-1" : "worker-app--rev-2",
    predecessorTemplateDigest: role === "web" ? DIGESTS[2]! : DIGESTS[3]!,
    gitSha: GIT_SHA,
    imageDigest: role === "web" ? DIGESTS[0]! : DIGESTS[1]!,
    templateBaseDigest: DIGESTS[4]!,
    ...overrides,
  };
}

function intent(role: ManagedReleaseRecoveryIntentRole, overrides: Partial<ManagedReleaseRecoveryIntentBase> = {}) {
  const canonicalBase = base(role, overrides);
  const revisionSuffix = managedReleaseRecoveryIntentRevisionSuffix(canonicalBase);
  const withoutDigest = { ...canonicalBase, revisionSuffix, templateDigest: DIGESTS[5]! };
  return { ...withoutDigest, intentDigest: managedReleaseRecoveryIntentDigest(withoutDigest) };
}

function reverseKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
}

describe("managed Azure recovery intent canonicalization", () => {
  it("recomputes stable suffix and intent digests from sorted-key canonical JSON", () => {
    const web = intent("web");
    expect(canonicalManagedReleaseRecoveryIntentJson({ b: 1, a: { z: "last", c: "first" } })).toBe("{\"a\":{\"c\":\"first\",\"z\":\"last\"},\"b\":1}");
    expect(managedReleaseRecoveryIntentRevisionSuffix(reverseKeys(base("web")) as ManagedReleaseRecoveryIntentBase)).toBe(web.revisionSuffix);
    expect(canonicalizeManagedReleaseRecoveryIntent(reverseKeys(web), authority)).toEqual(web);
  });

  it("rejects unexpected secret-bearing fields", () => {
    expect(() => canonicalizeManagedReleaseRecoveryIntent({ ...intent("web"), secretName: "container-secret" }, authority)).toThrow("MANAGED_RELEASE_INVALID_RECOVERY_INTENT");
  });

  it("rejects authority mismatches for lease, app, revision, image, and predecessor template", () => {
    for (const forged of [
      { ...intent("web"), originatingLeaseId: "123e4567-e89b-42d3-a456-426614174999" },
      { ...intent("web"), appName: "web-alt", predecessorRevisionName: "web-alt--rev-1" },
      { ...intent("web"), imageDigest: DIGESTS[1] },
      { ...intent("web"), predecessorTemplateDigest: DIGESTS[3] },
    ]) {
      expect(() => canonicalizeManagedReleaseRecoveryIntent(forged, authority)).toThrow("MANAGED_RELEASE_RECOVERY_INTENT_CONFLICT");
    }
  });

  it("accepts a valid observed predecessor that is not the rollback baseline", () => {
    const observed = intent("web", {
      predecessorRevisionName: "web-app--forward-2",
      predecessorTemplateDigest: DIGESTS[3]!,
      templateBaseDigest: DIGESTS[2]!,
    });
    expect(canonicalizeManagedReleaseRecoveryIntent(observed, authority)).toEqual(observed);
  });

  it("rejects syntactically bad digests and recomputed digest conflicts", () => {
    expect(() => canonicalizeManagedReleaseRecoveryIntent({ ...intent("web"), templateDigest: "sha256:not-a-digest" }, authority)).toThrow("MANAGED_RELEASE_INVALID_RECOVERY_INTENT");
    expect(() => canonicalizeManagedReleaseRecoveryIntent({ ...intent("web"), revisionSuffix: "ri-00000000000000000000000000000000" }, authority)).toThrow("MANAGED_RELEASE_RECOVERY_INTENT_CONFLICT");
    expect(() => canonicalizeManagedReleaseRecoveryIntent({ ...intent("web"), intentDigest: DIGESTS[0] }, authority)).toThrow("MANAGED_RELEASE_RECOVERY_INTENT_CONFLICT");
  });

  it.each([2, 3] as const)("parses the real script intent format under rollback schema %i", async (schemaVersion) => {
    const [{ buildManagedAzureRecoveryIntent }, { managedAzureTemplateDigest }] = await Promise.all([
      import(new URL("../../../scripts/release/managed-azure-recovery-intent.mjs", import.meta.url).href),
      import(new URL("../../../scripts/release/managed-azure-container-app-transport.mjs", import.meta.url).href),
    ]);
    const template = {
      revisionSuffix: "worker-base",
      containers: [{
        name: "worker-container",
        image: "acr12.azurecr.io/corgtex/worker@sha256:2222222222222222222222222222222222222222222222222222222222222222",
        env: [
          { name: "CORGTEX_STARTUP_MODE", value: "worker" },
          { name: "DATABASE_URL", secretRef: "database-url" },
          { name: "CORGTEX_RELEASE_GIT_SHA", value: "a".repeat(40) },
          { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${"a".repeat(40)}` },
          { name: "CORGTEX_RELEASE_VERSION", value: "release-base" },
        ],
        resources: { cpu: 1, memory: "2Gi" },
      }],
      scale: { minReplicas: 1, maxReplicas: 2 },
    };
    const predecessor = {
      appName: authority.payload.target.workerAppName,
      location: "West US",
      role: "worker",
      revisionName: `${authority.payload.target.workerAppName}--worker-base`,
      revisionSuffix: "worker-base",
      containerName: "worker-container",
      image: template.containers[0]!.image,
      imageDigest: authority.payload.compatibleRecovery.worker.digest,
      template,
      templateDigest: managedAzureTemplateDigest(template),
    };
    const { intent: built } = buildManagedAzureRecoveryIntent({
      originatingLease: { leaseId: authority.leaseId, fence: authority.fence },
      target: authority.payload.target,
      role: "worker",
      predecessor,
      release: { gitSha: authority.payload.compatibleRecovery.gitSha, imageTag: authority.payload.compatibleRecovery.imageTag, version: authority.payload.compatibleRecovery.releaseVersion },
      image: authority.payload.compatibleRecovery.worker.image,
      imageDigest: authority.payload.compatibleRecovery.worker.digest,
    });
    const currentAuthority = schemaVersion === 2 ? authority : {
      ...authority,
      payload: { ...authority.payload, schemaVersion, exclusiveActivation: {
        originalMode: "Single" as const, temporaryMode: "Multiple" as const,
        configurationDigests: { web: DIGESTS[0]!, worker: DIGESTS[1]! },
      } },
    };
    expect(canonicalizeManagedReleaseRecoveryIntent(built, currentAuthority)).toEqual(built);
    expect(built.protocolVersion).toBe(2);
  });
});


describe("bounded recovery intent names and unapplied supersession", () => {
  it.each(Array.from({ length: 31 }, (_, i) => i + 2))("preserves supported %i-character app names and exact v1 reconstruction", async length => {
    const appName = "a".repeat(length);
    const current = { ...authority, payload: { ...authority.payload, target: { ...authority.payload.target, webAppName: appName } } };
    const old = intent("web", { appName, predecessorRevisionName: `${appName}--old` });
    const next = intent("web", { protocolVersion: 2, appName, predecessorRevisionName: `${appName}--old` });
    expect(canonicalizeManagedReleaseRecoveryIntent(old, current)).toEqual(old);
    expect(canonicalizeManagedReleaseRecoveryIntent(next, current)).toEqual(next);
    expect(next.revisionSuffix.length).toBe(3 + Math.min(32, 49 - length));
    expect(`${appName}--${next.revisionSuffix}`.length).toBeLessThanOrEqual(54);
    const { recoveryIntentRevisionSuffix } = await import(new URL("../../../scripts/release/managed-azure-recovery-intent.mjs", import.meta.url).href);
    expect(recoveryIntentRevisionSuffix(base("web", { protocolVersion: 2, appName, predecessorRevisionName: `${appName}--old` }))).toBe(next.revisionSuffix);
  });
  function proof() {
    const appName = "ca-corgtex-ss-prod-web";
    const old = intent("web", { appName, predecessorRevisionName: `${appName}--0000130` });
    const next = intent("web", { protocolVersion: 2, appName, predecessorRevisionName: old.predecessorRevisionName });
    const current = { ...authority, currentLeaseId: LEASE_ID, currentFence: 18, now: 1_000_000,
      payload: { ...authority.payload, schemaVersion: 3 as const,
        exclusiveActivation: { originalMode: "Single" as const, temporaryMode: "Multiple" as const, configurationDigests: { web: DIGESTS[2]!, worker: DIGESTS[3]! } },
        target: { ...authority.payload.target, webAppName: appName } } };
    const evidence = { schemaVersion: 1, startedAt: 900_000, observedAt: 999_000, leaseId: LEASE_ID, fence: 18,
      targetDigest: `sha256:${createHash("sha256").update(canonicalManagedReleaseRecoveryIntentJson(current.payload.target)).digest("hex")}`,
      oldIntentDigest: old.intentDigest, role: "web", appName, latestRevisionName: old.predecessorRevisionName,
      latestReadyRevisionName: old.predecessorRevisionName, templateDigest: old.predecessorTemplateDigest,
      configurationDigest: DIGESTS[2], provisioningState: "Succeeded",
      revisions: [{ revisionName: old.predecessorRevisionName, active: true, replicaCount: 1 }] };
    return { old, next, current, evidence };
  }
  it("admits the real 59-character invalid web intent with intact predecessor, including a drained predecessor", () => {
    const { old, next, current, evidence } = proof();
    expect(`${old.appName}--${old.revisionSuffix}`).toHaveLength(59);
    expect(`${next.appName}--${next.revisionSuffix}`).toHaveLength(54);
    expect(canonicalizeInvalidRecoveryIntentSupersession(old, next, evidence, current)).toEqual(evidence);
    evidence.revisions[0]!.active = false; evidence.revisions[0]!.replicaCount = 0;
    expect(canonicalizeInvalidRecoveryIntentSupersession(old, next, evidence, current)).toEqual(evidence);
    const worker = intent("worker", { appName: "ca-corgtex-ss-prod-worker", predecessorRevisionName: "ca-corgtex-ss-prod-worker--old" });
    expect(`${worker.appName}--${worker.revisionSuffix}`).toHaveLength(62);
  });
  it.each(["stale", "future", "duration", "owner", "target", "template", "config", "ready", "missing", "duplicate", "old-present", "new-present", "foreign-active", "foreign-replica", "foreign-app", "image", "valid-v1", "role"])("rejects %s supersession evidence", mode => {
    const { old, next, current, evidence } = proof();
    if (mode === "stale") evidence.observedAt = 930_000;
    if (mode === "future") evidence.observedAt = 1_006_000;
    if (mode === "duration") evidence.startedAt = 1;
    if (mode === "owner") evidence.fence++;
    if (mode === "target") evidence.targetDigest = DIGESTS[0]!;
    if (mode === "template") evidence.templateDigest = DIGESTS[0]!;
    if (mode === "config") evidence.configurationDigest = DIGESTS[0];
    if (mode === "ready") evidence.latestReadyRevisionName += "-other";
    if (mode === "missing") evidence.revisions = [];
    if (mode === "duplicate") evidence.revisions.push({ ...evidence.revisions[0]! });
    if (mode === "old-present" || mode === "new-present") evidence.revisions.push({ revisionName: `${old.appName}--${mode === "old-present" ? old.revisionSuffix : next.revisionSuffix}`, active: false, replicaCount: 0 });
    if (mode.startsWith("foreign-")) evidence.revisions.push({ revisionName: `${mode === "foreign-app" ? "another-app" : old.appName}--foreign`, active: mode === "foreign-active", replicaCount: mode === "foreign-replica" ? 1 : 0 });
    if (mode === "image") next.imageDigest = DIGESTS[4]!;
    if (mode === "valid-v1") old.appName = "short";
    if (mode === "role") next.role = "worker";
    expect(() => canonicalizeInvalidRecoveryIntentSupersession(old, next, evidence, current)).toThrow();
  });
});
