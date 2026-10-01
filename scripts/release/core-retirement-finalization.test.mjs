import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Native loading preserves Function.toString() bytes used by the retained utility
// command. Vitest's source transform must not rewrite this production invariant.
import { compileFunction, constants } from "node:vm";
const nativeImport = compileFunction("return import(specifier)", ["specifier"], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const { identityHash, sha256 } = await nativeImport(new URL("../accepted-core-baseline.mjs", import.meta.url).href);
const { CORE_RETIREMENT_TARGET: target, CORE_SOURCE_SHA: sourceSha, CORE_BEFORE, ROLES, retirementCommand } =
  await nativeImport(new URL("./core-retirement.mjs", import.meta.url).href);
const { HEALTHCHECK_CASE: prior } = await nativeImport(new URL("./core-retirement-healthcheck-recovery.mjs", import.meta.url).href);
const { WEB_COMPLETION_CASE: webCase } =
  await nativeImport(new URL("./core-retirement-web-completion.mjs", import.meta.url).href);
const { FINALIZATION_CASE: incident, validateFinalizationPredecessors, verifyReadOnlyFinalization: finalize } =
  await nativeImport(new URL("./core-retirement-finalization.mjs", import.meta.url).href);
const { validateReconciliationEvidence, downloadReconciliationMembers } =
  await nativeImport(new URL("./core-retirement-reconciliation.mjs", import.meta.url).href);
const clone = value => structuredClone(value);
const H = "a".repeat(64), now = Date.parse("2026-10-01T21:30:00Z");
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
// Immutable nonsecret approvals are inline; tests never read ignored operational artifacts.
const firstApproval = {
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
};
const secondApproval = {
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
};
const thirdApproval = {
  "schemaVersion": 1,
  "kind": "core-logical-retirement",
  "reviewedAt": "2026-10-01T18:50:10.223Z",
  "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
  "providerBeforeSha256": "ceedd800fccc3356ed3d2ddb7864f83d4e1d0e3d8bdaf04e9298b07793e652bf",
  "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
  "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
  "publicSelfserveEvidenceSha256": "d96f8021d45605c504bb3095dc7d8a57572d520b82abcc0ceadbc99ea541935b",
  "providerDispositionSha256": "a5bea957d27e9addabeb9d9276a5015effeac581ca22b00f435f6ef955a02a78",
  "sourceDataDispositionSha256": "5bbef67ef87d9a03608bd8587877bd70bf99af9e0d0eb66d653f126a0d5a23fc",
  "sourceDataDisposition": "retain-unchanged",
  "customerTargets": "selfserve-only",
  "physicalServices": "retain",
  "databaseChanges": false
};
function chain() {
  const evidence = Object.fromEntries(["baselineReceiptSha256", "opsSnapshotSha256", "imageStartupProofSha256"].map(key => [key, firstApproval[key]]));
  const base = { ...evidence, target: clone(target), before: clone(CORE_BEFORE) };
  const first = { ...clone(base), runId: String(prior.predecessor.runId), workflowSha: prior.predecessor.workflowSha,
    approvalHash: prior.originalApprovalHash, providerBeforeSha256: prior.providerBeforeSha256, approval: clone(firstApproval) };
  const second = { ...clone(base), runId: String(prior.runId), workflowSha: prior.workflowSha, approvalHash: prior.retirementApprovalHash,
    providerBeforeSha256: prior.providerBeforeSha256, approval: clone(secondApproval), predecessor: clone(prior.predecessor),
    reconciliation: { schemaVersion: 1, kind: "core-logical-retirement-reconciliation", reviewedAt: secondApproval.reviewedAt,
      caseSha256: identityHash(prior.predecessor), failedRunId: prior.predecessor.runId, originalApprovalHash: prior.originalApprovalHash,
      expectedProviderSha256: prior.providerBeforeSha256, expectedPrivateConfigSha256: prior.privateConfigSha256,
      retirementApproval: clone(secondApproval) } };
  const third = { ...clone(base), runId: String(webCase.runId), workflowSha: webCase.workflowSha, approvalHash: webCase.workerProofSha256,
    providerBeforeSha256: prior.expectedProviderSha256, approval: clone(thirdApproval), predecessor: clone(prior),
    healthcheckApproval: { schemaVersion: 1, kind: "core-logical-retirement-healthcheck-recovery", reviewedAt: thirdApproval.reviewedAt,
      caseSha256: identityHash(prior), failedRunId: prior.runId, originalApprovalHash: prior.originalApprovalHash,
      reconciliationApprovalHash: prior.reconciliationApprovalHash, expectedProviderSha256: prior.expectedProviderSha256,
      expectedPrivateConfigSha256: prior.privateConfigSha256, retirementApproval: clone(thirdApproval) } };
  return { first, second, third };
}
const fourthApproval = {
  "schemaVersion": 1,
  "kind": "core-logical-retirement",
  "reviewedAt": "2026-10-01T20:08:39.587Z",
  "baselineReceiptSha256": "f5affcd52df4953d2e7406aeed1852e43ffed4bf063d0bac2f39172940e3ee71",
  "providerBeforeSha256": "54efe845d1ecefa5e1c482b22c80df746077b44cc92eec7438beb3b1c05a71f1",
  "opsSnapshotSha256": "4775fb61da81a0b38d2264a6c5a1bfda4b8dd2bd4fdfb8560814ed36834177cf",
  "imageStartupProofSha256": "8add6f20eaf20871e7ee15ceb406f4016761ff30472fcc404f50a91ea4d24b9e",
  "publicSelfserveEvidenceSha256": "4c0bf1bd896a565a33e2624d821f152ab75133f0a320b3da89169efb55e1ac7b",
  "providerDispositionSha256": "a6f68f9e3c5a2b699299a08190515b1947285d0ee007300262950213e9af53b0",
  "sourceDataDispositionSha256": "f047133123a9a46cefd86b22da117be8238112b0469f7323aa398a83cebed111",
  "sourceDataDisposition": "retain-unchanged",
  "customerTargets": "selfserve-only",
  "physicalServices": "retain",
  "databaseChanges": false
};
function fourChain() {
  const { first, second, third } = chain();
  const fourth = { ...clone(third), runId: String(incident.runId), workflowSha: incident.workflowSha,
    approvalHash: incident.retirementApprovalHash, providerBeforeSha256: incident.providerBeforeSha256,
    predecessor: clone(webCase), approval: clone(fourthApproval),
    webCompletionApproval: { schemaVersion: 1, kind: "core-logical-retirement-web-completion", reviewedAt: fourthApproval.reviewedAt,
      caseSha256: identityHash(webCase), failedRunId: webCase.runId, healthcheckApprovalHash: webCase.healthcheckApprovalHash,
      expectedProviderSha256: webCase.expectedProviderSha256, expectedPrivateConfigSha256: webCase.privateConfigSha256,
      retainedWorkerDeploymentId: webCase.workerDeploymentId, retainedWorkerProofSha256: webCase.workerProofSha256,
      retirementApproval: clone(fourthApproval) } };
  delete fourth.healthcheckApproval;
  return { first, second, third, fourth };
}
function fixture() {
  const baselineTarget = { ...target, id: "backup-app", origin: "https://app.corgtex.com", provider: "railway", databaseIdentitySha256: H };
  const images = Object.fromEntries(ROLES.map(role => [role, { deploymentId: CORE_BEFORE[role], digest: incident.roleProofs[role].imageDigest }]));
  const verifier = "b".repeat(40), observedAt = new Date(now).toISOString();
  const evidence = { target: baselineTarget, sourceSha, images,
    buildProof: { kind: "direct-container-build-readback", evidenceSha256: H, observedAt,
      roles: Object.fromEntries(ROLES.map(role => [role, { deploymentId: CORE_BEFORE[role], sourceSha }])) },
    authProof: { kind: "protected-review-retained-core-auth", runId: 1, runAttempt: 1, jobId: 2, stepNumber: 3,
      workflowSha: verifier, evidenceSha256: H, observedAt, origin: baselineTarget.origin,
      checks: { health: true, releaseMetadata: true, loginPage: true, login: true, session: true, rootFlow: true } } };
  const receipt = { schemaVersion: 1, kind: "accepted-core-baseline", accepted: true, evidence,
    schema: { manifestSha256: H, datamodelSha256: H, exactLedgerMatch: true, supportedSchemaMatch: true },
    acceptance: { repository: "Corgtexdotcom/corgtex", workflowPath: ".github/workflows/accepted-core-baseline.yml", workflowSha: verifier,
      runId: 4, runAttempt: 1, acceptedAt: observedAt, evidenceSha256: identityHash(evidence) } };
  const receiptBytes = JSON.stringify(receipt);
  const pin = { schemaVersion: 1, target: "backup-app", targetSha256: identityHash(baselineTarget), sourceSha, verifierSha: verifier,
    receiptSha256: sha256(receiptBytes), run: { id: 4, attempt: 1, workflowId: 5, workflowSha: verifier },
    artifact: { id: 6, name: "accepted-core-baseline-4-1", sha256: H } };
  const stages = {}, services = [];
  for (const role of ROLES) {
    const proof = incident.roleProofs[role];
    const binding = { projectId: target.projectId, environmentId: target.environmentId, serviceId: target[`${role}ServiceId`] };
    const live = { ...binding, id: proof.deploymentId, status: "SUCCESS", deploymentStopped: false, instances: [{ idRef: role, status: "RUNNING" }] };
    const old = { ...binding, id: CORE_BEFORE[role], status: "REMOVED", deploymentStopped: true, instances: [{ idRef: `old-${role}`, status: "REMOVED" }] };
    const displaced = role === "worker" ? webCase.displacedWorkerHistory : incident.displacedWebHistory;
    const historic = { ...binding, id: displaced.id, status: displaced.status, deploymentStopped: true, instances: [{ idRef: `historic-${role}`, status: "REMOVED" }] };
    stages[role] = { image: `ghcr.io/corgtexdotcom/corgtex/${role}@${proof.imageDigest}`, startCommand: retirementCommand(role, proof.proofSha256),
      latestDeployment: { id: proof.deploymentId, status: "SUCCESS" }, activeDeployments: [{ id: proof.deploymentId, status: "SUCCESS" }],
      history: [{ id: proof.deploymentId, status: "SUCCESS", digest: proof.imageDigest }], hasMoreHistory: true };
    services.push({ ...binding, autoDeployEnabled: false, autoUpdatesType: null, cronSchedule: null, configuredCronSchedule: null,
      nextCronRunAt: null, fileConfig: null, activeDeployments: [clone(live)], deployments: [live, old, historic,
        ...(role === "worker" ? [{ ...binding, id: prior.failedWorkerDeploymentId, status: "FAILED", deploymentStopped: true, instances: [{ idRef: "failed", status: "REMOVED" }] }] : [])] });
  }
  const state = { stages, configIdentity: incident.privateConfigSha256,
    fence: { binding: { projectId: target.projectId, environmentId: target.environmentId, serviceIds: [target.webServiceId, target.workerServiceId] },
      staged: { empty: true, status: "STAGED" }, pendingWork: [], services } };
  const deps = { now: () => now, assertContext: vi.fn(async () => incident.opsSnapshotSha256), verifyImages: vi.fn(async () => incident.imageStartupProofSha256),
    readState: vi.fn(async () => clone(state)), verifyPublic: vi.fn(async () => {}), query: vi.fn(async (_text, { id }) => {
      const row = state.fence.services.flatMap(s => s.deployments).find(d => d.id === id);
      const role = row.serviceId === target.workerServiceId ? "worker" : "web";
      const displaced = role === "worker" ? webCase.displacedWorkerHistory : incident.displacedWebHistory;
      return { deployment: { ...clone(row), meta: { imageDigest: id === displaced.id ? displaced.digest : incident.roleProofs[role].imageDigest } } };
    }) };
  return { state, input: { pin, receipt, receiptBytes }, deps };
}
async function withFixture(test) {
  const f = fixture();
  const saved = { provider: incident.expectedProviderSha256, baseline: incident.baselineReceiptSha256,
    workerRow: webCase.displacedWorkerHistory.fullFenceRowSha256, webRow: incident.displacedWebHistory.fullFenceRowSha256 };
  incident.expectedProviderSha256 = identityHash(f.state); incident.baselineReceiptSha256 = f.input.pin.receiptSha256;
  webCase.displacedWorkerHistory.fullFenceRowSha256 = identityHash(f.state.fence.services[0].deployments[2]);
  incident.displacedWebHistory.fullFenceRowSha256 = identityHash(f.state.fence.services[1].deployments[2]);
  try { await test(f); } finally {
    incident.expectedProviderSha256 = saved.provider; incident.baselineReceiptSha256 = saved.baseline;
    webCase.displacedWorkerHistory.fullFenceRowSha256 = saved.workerRow; incident.displacedWebHistory.fullFenceRowSha256 = saved.webRow;
  }
}

describe("four consumed retirement mutation opportunities", () => {
  it("authenticates the exact historical approvals without treating them as fresh write authority", () => {
    const f = fourChain(); expect(validateFinalizationPredecessors(f.first, f.second, f.third, f.fourth)).toEqual(f.fourth);
    expect(Date.parse(f.fourth.approval.reviewedAt)).toBeLessThan(now - 3600000);
  });
  it.each(["first", "second", "third", "fourth", "run", "source", "target", "before", "provider", "case", "outer", "nested", "ops", "image", "baseline"])("rejects changed %s chain", kind => {
    const f = fourChain(), fourth = f.fourth;
    if (kind === "first") f.first.approvalHash = H;
    if (kind === "second") f.second.approval.databaseChanges = true;
    if (kind === "third") f.third.approvalHash = H;
    if (kind === "fourth") fourth.approvalHash = H;
    if (kind === "run") fourth.runId = "1";
    if (kind === "source") fourth.workflowSha = "a".repeat(40);
    if (kind === "target") fourth.target.projectId = id(1);
    if (kind === "before") fourth.before.web = id(1);
    if (kind === "provider") fourth.providerBeforeSha256 = H;
    if (kind === "case") fourth.predecessor.artifactId++;
    if (kind === "outer") fourth.webCompletionApproval.retainedWorkerProofSha256 = H;
    if (kind === "nested") fourth.webCompletionApproval.retirementApproval.databaseChanges = true;
    if (kind === "ops") fourth.opsSnapshotSha256 = H;
    if (kind === "image") fourth.imageStartupProofSha256 = H;
    if (kind === "baseline") fourth.baselineReceiptSha256 = H;
    expect(() => validateFinalizationPredecessors(f.first, f.second, f.third, fourth)).toThrow();
  });
});

describe("read-only retirement finalization", () => {
  it("proves both utilities, four direct continuities, zero writes and two unchanged provider reads", () => withFixture(async f => {
    const before = identityHash(f.state);
    for (const name of ["setCommand", "deploy", "reserveIntent", "write", "mutate"]) {
      Object.defineProperty(f.deps, name, { get() { throw new Error("MUTATION_DEPENDENCY_ACCESSED"); } });
    }
    const result = await finalize(f.input, f.deps);
    expect(result).toMatchObject({ kind: "core-logical-retirement-readonly-finalized", mutations: 0, providerWrites: 0, customerWrites: 0,
      physicalServices: "retain", databaseChanges: false, applicationWrites: false, businessWorker: false, before: CORE_BEFORE,
      roleProofs: incident.roleProofs, providerAfterSha256: before, failureCause: "unestablished" });
    expect(result.consumedFailedRunIds).toEqual([36883501899, 36892304659, 36909978237, 36919896238]);
    expect(result.continuity).toHaveLength(4);
    expect(f.deps.query.mock.calls.map(([, vars]) => vars.id)).toEqual([webCase.displacedWorkerHistory.id, incident.roleProofs.worker.deploymentId,
      incident.displacedWebHistory.id, incident.roleProofs.web.deploymentId]);
    expect(f.deps.query.mock.calls.every(([query]) => query.startsWith("query ") && !query.includes("mutation"))).toBe(true);
    expect(f.deps.verifyPublic).toHaveBeenCalledWith(incident.roleProofs.web.proofSha256);
    expect(f.deps.readState).toHaveBeenCalledTimes(2); expect(f.deps.assertContext).toHaveBeenCalledTimes(2);
    expect(identityHash(f.state)).toBe(before);
  }));
  it.each(["private", "workerCommand", "webCommand", "history", "target", "image", "extraDeployment"])("rejects exact projection %s drift", kind => withFixture(async f => {
    if (kind === "private") f.state.configIdentity = H;
    if (kind === "workerCommand") f.state.stages.worker.startCommand += " ";
    if (kind === "webCommand") f.state.stages.web.startCommand = retirementCommand("web", H);
    if (kind === "history") f.state.stages.web.history[0].digest = null;
    if (kind === "target") f.state.fence.binding.environmentId = id(1);
    if (kind === "image") f.state.stages.worker.image = "other";
    if (kind === "extraDeployment") f.state.fence.services[0].deployments.push({ id: id(1) });
    await expect(finalize(f.input, f.deps)).rejects.toThrow("FINALIZATION_STATE_CHANGED");
    expect(f.deps.query).not.toHaveBeenCalled(); expect(f.deps.verifyPublic).not.toHaveBeenCalled();
  }));
  it.each(["wrongBinding", "oldWebRunning", "oldWorkerRunning", "oldEmptyInstances", "failedRunning", "failedStatus", "activeStopped", "activeEmpty", "activeWrongTarget", "digest", "command", "trigger", "pending"])("independently rejects unsafe %s under a synthetic state pin", kind => withFixture(async f => {
    const worker = f.state.fence.services[0], web = f.state.fence.services[1];
    if (kind === "wrongBinding") f.state.fence.binding.projectId = id(1);
    if (kind === "oldWebRunning") web.deployments[1].instances[0].status = "RUNNING";
    if (kind === "oldWorkerRunning") worker.deployments[1].deploymentStopped = false;
    if (kind === "oldEmptyInstances") web.deployments[1].instances = [];
    if (kind === "failedRunning") worker.deployments[3].instances[0].status = "RUNNING";
    if (kind === "failedStatus") worker.deployments[3].status = "SUCCESS";
    if (kind === "activeStopped") worker.activeDeployments[0].deploymentStopped = true;
    if (kind === "activeEmpty") web.activeDeployments[0].instances = [];
    if (kind === "activeWrongTarget") web.activeDeployments[0].projectId = id(1);
    if (kind === "digest") f.state.stages.worker.history[0].digest = null;
    if (kind === "command") f.state.stages.web.startCommand = retirementCommand("web", H);
    if (kind === "trigger") worker.autoDeployEnabled = true;
    if (kind === "pending") f.state.fence.pendingWork.push({});
    incident.expectedProviderSha256 = identityHash(f.state);
    await expect(finalize(f.input, f.deps)).rejects.toThrow();
  }));
  it.each(["workerProject", "workerDigest", "webProject", "webEnvironment", "webService", "webId", "webDigest", "webStatus", "webMissing", "webNotStopped", "liveStopped", "liveInactive", "liveDigest", "displacedFence"])("rejects %s continuity", kind => withFixture(async f => {
    if (kind === "displacedFence") { f.state.fence.services[1].deployments[2].instances[0].status = "EXITED"; incident.expectedProviderSha256 = identityHash(f.state); }
    const read = f.deps.query.getMockImplementation();
    f.deps.query.mockImplementation(async (...args) => {
      const result = await read(...args), row = result.deployment;
      if (row.id === webCase.displacedWorkerHistory.id) {
        if (kind === "workerProject") row.projectId = id(1);
        if (kind === "workerDigest") row.meta.imageDigest = null;
      }
      if (row.id === incident.displacedWebHistory.id) {
        if (kind === "webProject") row.projectId = id(1);
        if (kind === "webEnvironment") row.environmentId = id(1);
        if (kind === "webService") row.serviceId = target.workerServiceId;
        if (kind === "webId") row.id = id(1);
        if (kind === "webDigest") row.meta.imageDigest = incident.roleProofs.web.imageDigest;
        if (kind === "webStatus") row.status = "SUCCESS";
        if (kind === "webMissing") return { deployment: null };
        if (kind === "webNotStopped") row.deploymentStopped = false;
      }
      if (row.id === incident.roleProofs.web.deploymentId) {
        if (kind === "liveStopped") row.deploymentStopped = true;
        if (kind === "liveInactive") row.instances[0].status = "REMOVED";
        if (kind === "liveDigest") row.meta.imageDigest = null;
      }
      return result;
    });
    await expect(finalize(f.input, f.deps)).rejects.toThrow(); expect(f.deps.verifyPublic).not.toHaveBeenCalled();
  }));
  it.each(["ops", "images", "lease", "lateLease", "lateOps", "lateDrift", "expired", "expiresDuringRead", "public", "queryFailure", "baselinePin"])("does not finalize after %s failure", kind => withFixture(async f => {
    if (kind === "ops") f.deps.assertContext.mockResolvedValue(H);
    if (kind === "images") f.deps.verifyImages.mockResolvedValue(H);
    if (kind === "lease") f.deps.assertContext.mockRejectedValue(new Error("ACTIVE_LEASE"));
    if (kind === "lateLease") f.deps.assertContext.mockResolvedValueOnce(incident.opsSnapshotSha256).mockRejectedValueOnce(new Error("ACTIVE_LEASE"));
    if (kind === "lateOps") f.deps.assertContext.mockResolvedValueOnce(incident.opsSnapshotSha256).mockResolvedValueOnce(H);
    if (kind === "lateDrift") f.deps.readState.mockResolvedValueOnce(clone(f.state)).mockResolvedValueOnce({ ...clone(f.state), changed: true });
    if (kind === "expired") f.deps.now = () => now + 86400001;
    if (kind === "expiresDuringRead") { let calls = 0; f.deps.now = () => ++calls === 1 ? now : now + 86400001; }
    if (kind === "public") f.deps.verifyPublic.mockRejectedValue(new Error("PUBLIC_PROOF_MISMATCH"));
    if (kind === "queryFailure") f.deps.query.mockRejectedValue(new Error("READ_FAILED"));
    if (kind === "baselinePin") f.input.receiptBytes += " ";
    await expect(finalize(f.input, f.deps)).rejects.toThrow();
    if (kind === "queryFailure") expect(f.deps.query).toHaveBeenCalledTimes(1);
  }));
});


function fourthArchive() {
  const intent = fourChain().fourth;
  const members = Object.fromEntries(incident.artifactMembers.map(name => [name, Buffer.from("{}") ]));
  members["intent.json"] = Buffer.from(JSON.stringify(intent));
  members["failed.json"] = Buffer.from(JSON.stringify({ status: "unverified", code: incident.failureCode,
    providerWrites: "unknown; reconcile before another execution" }));
  // Only generated member byte hashes vary. In particular, do not synthesize or
  // override the committed attempt key: that integration contract caused failure.
  const testCase = { ...clone(incident), intentSha256: sha256(members["intent.json"]), failedSha256: sha256(members["failed.json"]) };
  const run = { id: incident.runId, run_attempt: 1, workflow_id: incident.workflowId, head_sha: incident.workflowSha,
    path: ".github/workflows/core-retirement.yml", head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "failure",
    repository: { id: 1, full_name: "Corgtexdotcom/corgtex" }, head_repository: { id: 1, full_name: "Corgtexdotcom/corgtex" } };
  const artifact = { id: incident.artifactId, name: incident.artifactName, expired: false, digest: `sha256:${incident.artifactSha256}`,
    expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: run.id, head_sha: run.head_sha, repository_id: 1, head_repository_id: 1, head_branch: "main" } };
  const jobs = { total_count: 1, jobs: [{ id: incident.jobId, run_id: run.id, run_attempt: 1, name: "Retire existing Core", status: "completed", conclusion: "failure",
    steps: [{ name: "Complete remaining Core web retirement", status: "completed", conclusion: "failure", started_at: "2026-10-01T20:11:00Z" },
      { name: "Retain retirement and uncertain-outcome evidence", conclusion: "success" }] }] };
  return { intent, testCase, members, run, artifact, artifacts: { total_count: 1, artifacts: [artifact] }, jobs };
}

describe("committed finalization case archive integration", () => {
  it("authenticates the fourth attempt with the actual shared validator and committed case keys", () => {
    const f = fourthArchive();
    expect(validateReconciliationEvidence(f, f.testCase)).toEqual(f.intent);
    expect(incident.attempt).toBe(1); expect(Object.hasOwn(incident, "runAttempt")).toBe(false);
    expect(incident.artifactMembers).toEqual(["failed.json", "history-continuity.json", "image-startup.json", "intent.json", "utility-command-exercise.json"]);
    const brokenCase = { ...f.testCase, runAttempt: f.testCase.attempt }; delete brokenCase.attempt;
    expect(() => validateReconciliationEvidence(f, brokenCase)).toThrow("RECONCILIATION_RUN_INVALID");
  });
  it.each(["attempt", "workflow", "job", "step", "artifact", "member"])("rejects changed fourth archive %s", kind => {
    const f = fourthArchive();
    if (kind === "attempt") f.run.run_attempt = 2;
    if (kind === "workflow") f.run.workflow_id++;
    if (kind === "job") f.jobs.jobs[0].id++;
    if (kind === "step") f.jobs.jobs[0].steps[0].name = "Recover Core worker healthcheck retirement";
    if (kind === "artifact") f.artifact.digest = `sha256:${H}`;
    if (kind === "member") f.members["intent.json"] = Buffer.from("{}");
    expect(() => validateReconciliationEvidence(f, f.testCase)).toThrow();
  });
  it.each([false, true])("enforces the actual five-member download contract (missing continuity: %s)", async omitContinuity => {
    const f = fourthArchive(), directory = await mkdtemp(join(tmpdir(), "finalization-archive-test-"));
    try {
      const names = incident.artifactMembers.filter(name => !omitContinuity || name !== "history-continuity.json");
      for (const name of names) await writeFile(join(directory, name), f.members[name]);
      execFileSync("zip", ["-q", "fixture.zip", ...names], { cwd: directory });
      const bytes = await readFile(join(directory, "fixture.zip"));
      const testCase = { ...f.testCase, artifactSha256: sha256(bytes) };
      f.artifact.digest = `sha256:${testCase.artifactSha256}`;
      const requests = [];
      const fetcher = async (url, options) => {
        requests.push({ url: String(url), options });
        return requests.length === 1 ? { status: 302, headers: new Headers({ location: "https://artifact.example/fourth.zip" }) }
          : { ok: true, body: [bytes] };
      };
      const result = downloadReconciliationMembers({ GITHUB_TOKEN: "fixture-only" }, fetcher, testCase);
      if (omitContinuity) await expect(result).rejects.toThrow("RECONCILIATION_ARCHIVE_CONTENTS");
      else {
        const downloaded = await result;
        expect(validateReconciliationEvidence({ ...f, members: downloaded }, testCase)).toEqual(f.intent);
      }
      expect(requests).toHaveLength(2); expect(requests[1].options.headers).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
