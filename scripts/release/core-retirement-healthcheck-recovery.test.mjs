import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { CORE_BEFORE, CORE_SOURCE_SHA, CORE_RETIREMENT_TARGET, ROLES } from "./core-retirement.mjs";
import { HEALTHCHECK_CASE as incident, HEALTHCHECK_STEP, assertHealthcheckRecoveryStart,
  validateHealthcheckPredecessors, validateHealthcheckRecoveryApproval } from "./core-retirement-healthcheck-recovery.mjs";

const clone = value => structuredClone(value);
const now = Date.parse("2026-10-01T18:00:00Z");
function fixture() {
  const images = { worker: { digest: "sha256:" + "1".repeat(64) }, web: { digest: "sha256:" + "2".repeat(64) } };
  const stages = {}, services = [];
  for (const role of ROLES) {
    const original = { id: CORE_BEFORE[role], status: "SUCCESS" };
    const failed = { id: incident.failedWorkerDeploymentId, status: "FAILED" };
    stages[role] = { image: `ghcr.io/corgtexdotcom/corgtex/${role}@${images[role].digest}`,
      startCommand: role === "worker" ? incident.predecessorWorkerStartCommand : "npm run start --workspace=@corgtex/web",
      releaseSettings: { CORGTEX_RELEASE_GIT_SHA: CORE_SOURCE_SHA, CORGTEX_RELEASE_IMAGE_TAG: `sha-${CORE_SOURCE_SHA}`,
        CORGTEX_RELEASE_VERSION: `main-${CORE_SOURCE_SHA.slice(0, 12)}`, CORGTEX_STARTUP_MODE: "web" },
      latestDeployment: role === "worker" ? failed : original, activeDeployments: [original],
      history: [{ ...original, digest: images[role].digest }, ...(role === "worker" ? [{ ...failed, digest: null }] : [])] };
    const active = { ...original, deploymentStopped: false, instances: [{ idRef: role, status: "RUNNING" }] };
    services.push({ serviceId: CORE_RETIREMENT_TARGET[`${role}ServiceId`], autoDeployEnabled: false, autoUpdatesType: null,
      cronSchedule: null, configuredCronSchedule: null, nextCronRunAt: null, fileConfig: null,
      activeDeployments: [active], deployments: [active, ...(role === "worker" ? [{ ...failed, deploymentStopped: true,
        instances: [{ idRef: "failed", status: "REMOVED" }] }] : [])] });
  }
  return { state: { stages, fence: { staged: { empty: true, status: "STAGED" }, pendingWork: [], services },
    configIdentity: incident.privateConfigSha256 }, receipt: { evidence: { images } } };
}
// A small synthetic fixture gets its own test-only state pin. Production has no
// caller-supplied incident override; the committed case is restored synchronously.
function withFixture(test) {
  const f = fixture(), originalHash = incident.expectedProviderSha256;
  incident.expectedProviderSha256 = identityHash(f.state);
  try { test(f); } finally { incident.expectedProviderSha256 = originalHash; }
}
function envelope() {
  return { schemaVersion: 1, kind: "core-logical-retirement-healthcheck-recovery", reviewedAt: new Date(now).toISOString(),
    caseSha256: identityHash(incident), failedRunId: incident.runId, originalApprovalHash: incident.originalApprovalHash,
    reconciliationApprovalHash: incident.reconciliationApprovalHash, expectedProviderSha256: incident.expectedProviderSha256,
    expectedPrivateConfigSha256: incident.privateConfigSha256,
    retirementApproval: { ...secondIntent.approval, reviewedAt: new Date(now).toISOString(), providerBeforeSha256: incident.expectedProviderSha256 } };
}

describe("exact failed-healthcheck recovery case", () => {
  it("pins the immutable command and distinct failed-state/provider identities", () => {
    const committed = JSON.parse(readFileSync(new URL("../../.github/core-retirement-healthcheck-recovery.json", import.meta.url)));
    expect(HEALTHCHECK_STEP).toBe("Recover Core worker healthcheck retirement");
    expect(committed.expectedProviderSha256).toBe("ceedd800fccc3356ed3d2ddb7864f83d4e1d0e3d8bdaf04e9298b07793e652bf");
    expect(committed.providerBeforeSha256).not.toBe(committed.expectedProviderSha256);
    expect(sha256(committed.predecessorWorkerStartCommand)).toBe("7935b625f5fb8076383b7791465f42a2ab52edfd4b82039cfee54f94e01ff29c");
    expect(committed.workerHealthcheck).toEqual({ path: "/healthz", timeout: 100 });
  });
  it("accepts exact failed utility stopped with both original processes active", () => withFixture(({ state, receipt }) => {
    expect(() => assertHealthcheckRecoveryStart(state, receipt)).not.toThrow();
    expect(state.stages.worker.latestDeployment.status).toBe("FAILED");
    expect(state.stages.worker.history[1].digest).toBeNull();
  }));
  it.each(["latest-success", "failed-digest", "private-config", "worker-command", "web-command", "active-extra", "pending", "image", "variables-identity"])("rejects %s drift without normalizing it", kind => withFixture(({ state, receipt }) => {
    if (kind === "latest-success") state.stages.worker.latestDeployment = state.stages.worker.activeDeployments[0];
    if (kind === "failed-digest") state.stages.worker.history[1].digest = receipt.evidence.images.worker.digest;
    if (kind === "private-config") state.configIdentity = "0".repeat(64);
    if (kind === "worker-command") state.stages.worker.startCommand += " ";
    if (kind === "web-command") state.stages.web.startCommand = incident.predecessorWorkerStartCommand;
    if (kind === "active-extra") state.stages.worker.activeDeployments.push({ id: "other", status: "SUCCESS" });
    if (kind === "pending") state.fence.pendingWork.push({ idRef: "unknown" });
    if (kind === "image") state.stages.worker.image = "other-image";
    if (kind === "variables-identity") state.extra = "unknown configuration";
    expect(() => assertHealthcheckRecoveryStart(state, receipt)).toThrow("HEALTHCHECK_RECOVERY_STATE_CHANGED");
  }));
  it.each(["old-stopped", "old-not-running", "failed-not-stopped", "failed-running", "wrong-receipt"])("independently rejects unsafe %s even in a matching synthetic projection", kind => withFixture(({ state, receipt }) => {
    const worker = state.fence.services[0];
    if (kind === "old-stopped") worker.activeDeployments[0].deploymentStopped = true;
    if (kind === "old-not-running") worker.activeDeployments[0].instances[0].status = "STOPPED";
    if (kind === "failed-not-stopped") worker.deployments[1].deploymentStopped = false;
    if (kind === "failed-running") worker.deployments[1].instances[0].status = "RUNNING";
    if (kind === "wrong-receipt") receipt.evidence.images.worker.digest = "sha256:" + "f".repeat(64);
    incident.expectedProviderSha256 = identityHash(state);
    expect(() => assertHealthcheckRecoveryStart(state, receipt)).toThrow();
  }));
});

describe("two immutable predecessors", () => {
  it("authenticates the original CD approval and second reconciliation chain", () => {
    expect(validateHealthcheckPredecessors(firstIntent, secondIntent)).toEqual(secondIntent);
  });
  it.each(["first-approval", "second-approval", "case", "envelope", "nested", "provider-before", "evidence", "run", "source"])("rejects altered %s", kind => {
    const first = clone(firstIntent), second = clone(secondIntent);
    if (kind === "first-approval") first.approvalHash = "0".repeat(64);
    if (kind === "second-approval") second.approval.publicSelfserveEvidenceSha256 = "0".repeat(64);
    if (kind === "case") second.predecessor.artifactId++;
    if (kind === "envelope") second.reconciliation.originalApprovalHash = "0".repeat(64);
    if (kind === "nested") second.reconciliation.retirementApproval = clone(first.approval);
    if (kind === "provider-before") second.providerBeforeSha256 = incident.expectedProviderSha256;
    if (kind === "evidence") second.imageStartupProofSha256 = "0".repeat(64);
    if (kind === "run") second.runId = String(Number(second.runId) + 1);
    if (kind === "source") second.workflowSha = "0".repeat(40);
    expect(() => validateHealthcheckPredecessors(first, second)).toThrow();
  });
});

describe("fresh recovery envelope", () => {
  it("returns only the new normal approval bound to the exact failed provider state", () => {
    const a = envelope(); expect(validateHealthcheckRecoveryApproval(a, identityHash(a), secondIntent, now)).toEqual(a.retirementApproval);
  });
  it.each(["caseSha256", "failedRunId", "originalApprovalHash", "reconciliationApprovalHash", "expectedProviderSha256", "expectedPrivateConfigSha256"])("rejects altered %s despite rehashed caller input", key => {
    const a = envelope(); a[key] = null;
    expect(() => validateHealthcheckRecoveryApproval(a, identityHash(a), secondIntent, now)).toThrow("HEALTHCHECK_RECOVERY_APPROVAL_INVALID");
  });
  it.each(["outer-old", "outer-future", "nested-old", "nested-future", "old-provider", "ops-changed", "baseline-changed", "image-changed", "writes-enabled", "bad-hash", "top-level-predecessor-drift"])("rejects %s", kind => {
    const a = envelope(), second = clone(secondIntent);
    if (kind === "outer-old") a.reviewedAt = new Date(now - 3600001).toISOString();
    if (kind === "outer-future") a.reviewedAt = new Date(now + 1).toISOString();
    if (kind === "nested-old") a.retirementApproval.reviewedAt = new Date(now - 3600001).toISOString();
    if (kind === "nested-future") a.retirementApproval.reviewedAt = new Date(now + 1).toISOString();
    if (kind === "old-provider") a.retirementApproval.providerBeforeSha256 = incident.providerBeforeSha256;
    if (kind === "ops-changed") a.retirementApproval.opsSnapshotSha256 = "0".repeat(64);
    if (kind === "baseline-changed") a.retirementApproval.baselineReceiptSha256 = "0".repeat(64);
    if (kind === "image-changed") a.retirementApproval.imageStartupProofSha256 = "0".repeat(64);
    if (kind === "writes-enabled") a.retirementApproval.databaseChanges = true;
    if (kind === "top-level-predecessor-drift") { second.opsSnapshotSha256 = "0".repeat(64); a.retirementApproval.opsSnapshotSha256 = second.opsSnapshotSha256; }
    expect(() => validateHealthcheckRecoveryApproval(a, kind === "bad-hash" ? "0".repeat(64) : identityHash(a), second, now)).toThrow();
  });
});

// Nonsecret immutable incident manifests. They contain evidence hashes and exact
// target identities only; no provider credentials, customer data or command output.
const firstIntent = {
  "approvalHash": "cd40863de872a9e0acd633adfaa74044c972682ad08c375b57878feae94490f3",
  "kind": "core-logical-retirement-plan",
  "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
  "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
  "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
  "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
  "target": {
    "projectId": "0c843902-611a-4141-be91-b049a36d9617",
    "environmentId": "03856ec6-a881-47de-bd71-44207a266ac7",
    "webServiceId": "dafd9062-3f96-4a42-813a-c194ac867858",
    "workerServiceId": "42de000e-f64d-4700-9a07-05d0ca42873e"
  },
  "before": {
    "web": "66444bbd-cd25-41f6-9972-56eccd5cb08c",
    "worker": "c1145a3d-6476-4408-86fb-d220e1fece5e"
  },
  "databaseChanges": false,
  "physicalServices": "retain",
  "exclusion": "fleet-release-concurrency-and-fresh-ops-no-active-leases",
  "approval": {
    "schemaVersion": 1,
    "kind": "core-logical-retirement",
    "reviewedAt": "2026-10-01T15:17:55.596Z",
    "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
    "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
    "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
    "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
    "publicSelfserveEvidenceSha256": "57d3fabc09dbf372685c89612162a4c000654f60955f0437162ee70ef3a4b446",
    "providerDispositionSha256": "a1afa170e9480dacd86573bbec589b27e49566e9091d730ba68c80674158dd9d",
    "sourceDataDispositionSha256": "dad5a44a506483d3eb89095afe2d6f6419b1b2978dc179bac1f838cf82c3ab01",
    "sourceDataDisposition": "retain-unchanged",
    "customerTargets": "selfserve-only",
    "physicalServices": "retain",
    "databaseChanges": false
  },
  "workflowSha": "834ef55278e330fa8d173f909f4eefc335621125",
  "runId": "36883501899"
};
const secondIntent = {
  "approvalHash": "f5f108cba5f998e7b5b9e9cb795b0d7972237ce9c56d51f033da91cf337ac811",
  "kind": "core-logical-retirement-plan",
  "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
  "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
  "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
  "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
  "target": {
    "projectId": "0c843902-611a-4141-be91-b049a36d9617",
    "environmentId": "03856ec6-a881-47de-bd71-44207a266ac7",
    "webServiceId": "dafd9062-3f96-4a42-813a-c194ac867858",
    "workerServiceId": "42de000e-f64d-4700-9a07-05d0ca42873e"
  },
  "before": {
    "web": "66444bbd-cd25-41f6-9972-56eccd5cb08c",
    "worker": "c1145a3d-6476-4408-86fb-d220e1fece5e"
  },
  "databaseChanges": false,
  "physicalServices": "retain",
  "exclusion": "fleet-release-concurrency-and-fresh-ops-no-active-leases",
  "approval": {
    "schemaVersion": 1,
    "kind": "core-logical-retirement",
    "reviewedAt": "2026-10-01T16:26:10.760Z",
    "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
    "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
    "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
    "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
    "publicSelfserveEvidenceSha256": "97eb1eab6416ee00efb905aa4cc9cb853fc2c048732b637e6d8265f45758f341",
    "providerDispositionSha256": "44a8ef9fb9bb2f684502f98dbd614692a33593483539251efae1cce191334c88",
    "sourceDataDispositionSha256": "0d5cdebc6baf4f3dbe9c4a278127ab7f9ffecaeb3a7a3bf404d18e451b2747cb",
    "sourceDataDisposition": "retain-unchanged",
    "customerTargets": "selfserve-only",
    "physicalServices": "retain",
    "databaseChanges": false
  },
  "reconciliation": {
    "schemaVersion": 1,
    "kind": "core-logical-retirement-reconciliation",
    "reviewedAt": "2026-10-01T16:26:10.760Z",
    "caseSha256": "cbf8a068a2dacf105a8598ce2a169312f6ef5eb80b3d164fcc99734e927dd9ac",
    "failedRunId": 36883501899,
    "originalApprovalHash": "cd40863de872a9e0acd633adfaa74044c972682ad08c375b57878feae94490f3",
    "expectedProviderSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
    "expectedPrivateConfigSha256": "f18b77a205fd4bd144ad19bae99e6d3e84a96c0d54288dcb4dbba94bdf0c32b0",
    "retirementApproval": {
      "schemaVersion": 1,
      "kind": "core-logical-retirement",
      "reviewedAt": "2026-10-01T16:26:10.760Z",
      "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
      "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
      "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
      "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
      "publicSelfserveEvidenceSha256": "97eb1eab6416ee00efb905aa4cc9cb853fc2c048732b637e6d8265f45758f341",
      "providerDispositionSha256": "44a8ef9fb9bb2f684502f98dbd614692a33593483539251efae1cce191334c88",
      "sourceDataDispositionSha256": "0d5cdebc6baf4f3dbe9c4a278127ab7f9ffecaeb3a7a3bf404d18e451b2747cb",
      "sourceDataDisposition": "retain-unchanged",
      "customerTargets": "selfserve-only",
      "physicalServices": "retain",
      "databaseChanges": false
    }
  },
  "predecessor": {
    "schemaVersion": 1,
    "runId": 36883501899,
    "attempt": 1,
    "workflowId": 371671639,
    "workflowSha": "834ef55278e330fa8d173f909f4eefc335621125",
    "jobId": 110440896141,
    "artifactId": 11172747036,
    "artifactName": "core-retirement-36883501899-1",
    "artifactSha256": "b03bbffa384339e2cdd099bd7ea6e40aab0abca6f7abd656b963a557ebc18cab",
    "intentSha256": "f83b7de30d298ccf1af7b7c90d6e3fd66a4091c8001ff584506fa8c809d238aa",
    "failedSha256": "80aa441f9f7ad7e3d30250773a94d52afbe1c1f0d685d97e1e29df588f48bc7c",
    "originalApprovalHash": "cd40863de872a9e0acd633adfaa74044c972682ad08c375b57878feae94490f3",
    "providerBeforeSha256": "fceab3aae2ad42c8a89cae244c56aadc1a00a640925484abef6a6f488eaed08c",
    "privateConfigSha256": "f18b77a205fd4bd144ad19bae99e6d3e84a96c0d54288dcb4dbba94bdf0c32b0",
    "failureCode": "CORE_RETIREMENT_PRESERVED_CONFIG_CHANGED"
  },
  "workflowSha": "bfd35ad3413ac4e8f0c05b064caca80dda1dbfbe",
  "runId": "36892304659"
};
