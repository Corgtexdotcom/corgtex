import { describe, expect, it, vi } from "vitest";
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
const { WEB_COMPLETION_CASE: incident, assertWebCompletionStart, validateWebCompletionPredecessors,
  validateWebCompletionApproval, verifyWebCompletionContinuity, completeCoreWebRetirement: complete } =
  await nativeImport(new URL("./core-retirement-web-completion.mjs", import.meta.url).href);
const clone = value => structuredClone(value);
const H = "a".repeat(64), now = Date.parse("2026-10-01T19:30:00Z");
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
  const third = { ...clone(base), runId: String(incident.runId), workflowSha: incident.workflowSha, approvalHash: incident.workerProofSha256,
    providerBeforeSha256: prior.expectedProviderSha256, approval: clone(thirdApproval), predecessor: clone(prior),
    healthcheckApproval: { schemaVersion: 1, kind: "core-logical-retirement-healthcheck-recovery", reviewedAt: thirdApproval.reviewedAt,
      caseSha256: identityHash(prior), failedRunId: prior.runId, originalApprovalHash: prior.originalApprovalHash,
      reconciliationApprovalHash: prior.reconciliationApprovalHash, expectedProviderSha256: prior.expectedProviderSha256,
      expectedPrivateConfigSha256: prior.privateConfigSha256, retirementApproval: clone(thirdApproval) } };
  return { first, second, third };
}
function envelope() {
  return { schemaVersion: 1, kind: "core-logical-retirement-web-completion", reviewedAt: new Date(now).toISOString(),
    caseSha256: identityHash(incident), failedRunId: incident.runId, healthcheckApprovalHash: incident.healthcheckApprovalHash,
    expectedProviderSha256: incident.expectedProviderSha256, expectedPrivateConfigSha256: incident.privateConfigSha256,
    retainedWorkerDeploymentId: incident.workerDeploymentId, retainedWorkerProofSha256: incident.workerProofSha256,
    retirementApproval: { ...clone(thirdApproval), reviewedAt: new Date(now).toISOString(), providerBeforeSha256: incident.expectedProviderSha256 } };
}
function fixture() {
  const baselineTarget = { ...target, id: "backup-app", origin: "https://app.corgtex.com", provider: "railway", databaseIdentitySha256: H };
  const images = Object.fromEntries(ROLES.map(role => [role, { deploymentId: CORE_BEFORE[role], digest: `sha256:${H}` }]));
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
  const stages = Object.fromEntries(ROLES.map(role => [role, {
    image: `ghcr.io/corgtexdotcom/corgtex/${role}@sha256:${H}`, startCommand: `npm run start --workspace=@corgtex/${role}`,
    latestDeployment: { id: CORE_BEFORE[role], status: "SUCCESS" }, activeDeployments: [{ id: CORE_BEFORE[role], status: "SUCCESS" }],
    history: [{ id: CORE_BEFORE[role], status: "SUCCESS", digest: `sha256:${H}` }],
    releaseSettings: { CORGTEX_RELEASE_GIT_SHA: sourceSha, CORGTEX_RELEASE_IMAGE_TAG: `sha-${sourceSha}`,
      CORGTEX_RELEASE_VERSION: `main-${sourceSha.slice(0, 12)}`, CORGTEX_STARTUP_MODE: "web" },
  }]));
  const state = { stages, fence: { staged: { empty: true, status: "STAGED" }, pendingWork: [], services: ROLES.map(role => ({
    serviceId: target[`${role}ServiceId`], autoDeployEnabled: false, autoUpdatesType: null,
    cronSchedule: null, configuredCronSchedule: null, nextCronRunAt: null, fileConfig: null, deployments: [{ status: "SUCCESS" }],
  })) } };
  state.configIdentity = incident.privateConfigSha256;
  for (const role of ROLES) {
    const currentId = role === "worker" ? incident.workerDeploymentId : CORE_BEFORE.web;
    const bound = { projectId: target.projectId, environmentId: target.environmentId, serviceId: target[`${role}ServiceId`] };
    const active = { ...bound, id: currentId, status: "SUCCESS", deploymentStopped: false, instances: [{ idRef: role, status: "RUNNING" }] };
    const svc = state.fence.services.find(row => row.serviceId === bound.serviceId);
    svc.activeDeployments = [clone(active)]; svc.deployments = [clone(active)];
    state.stages[role].latestDeployment = { id: currentId, status: "SUCCESS" };
    state.stages[role].activeDeployments = [{ id: currentId, status: "SUCCESS" }];
    state.stages[role].history = [{ id: currentId, status: "SUCCESS", digest: images[role].digest }];
    if (role === "worker") {
      state.stages.worker.startCommand = incident.workerStartCommand;
      svc.deployments.push({ ...bound, id: CORE_BEFORE.worker, status: "REMOVED", deploymentStopped: true, instances: [{ idRef: "old", status: "REMOVED" }] },
        { ...bound, id: prior.failedWorkerDeploymentId, status: "FAILED", deploymentStopped: true, instances: [{ idRef: "failed", status: "REMOVED" }] },
        { ...bound, id: incident.displacedWorkerHistory.id, status: "REMOVED", deploymentStopped: true, instances: [{ idRef: "displaced", status: "REMOVED" }] });
    }
  }
  const writes = [], order = [];
  const deps = { now: () => now, assertContext: vi.fn(async () => H), verifyImages: vi.fn(async () => H), verifyCommands: vi.fn(async () => ({ verified: true })),
    readState: vi.fn(async () => clone(state)), reserveIntent: vi.fn(async () => { order.push("reserve"); return true; }),
    verifyContinuity: vi.fn(async current => verifyWebCompletionContinuity(current, async (_query, { id: deploymentId }) => {
      const worker = current.fence.services[0], row = worker.deployments.find(d => d.id === deploymentId);
      return { deployment: { ...clone(row), meta: { imageDigest: deploymentId === incident.displacedWorkerHistory.id
        ? incident.displacedWorkerHistory.digest : images.worker.digest } } };
    })),
    setCommand: vi.fn(async (role, command) => { order.push(`command:${role}`); writes.push(`command:${role}`); state.stages[role].startCommand = command; }),
    deploy: vi.fn(async role => { order.push(`deploy:${role}`); writes.push(`deploy:${role}`); return id(11); }),
    verifyRuntime: vi.fn(async (role, deploymentId) => {
      const stage = state.stages[role]; stage.latestDeployment = { id: deploymentId, status: "SUCCESS" }; stage.activeDeployments = [clone(stage.latestDeployment)];
      stage.history.push({ ...stage.latestDeployment, digest: images[role].digest });
      const svc = state.fence.services.find(row => row.serviceId === target[`${role}ServiceId`]);
      const old = svc.deployments[0]; old.status = "REMOVED"; old.deploymentStopped = true; old.instances[0].status = "REMOVED";
      const active = { ...clone(old), id: deploymentId, status: "SUCCESS", deploymentStopped: false, instances: [{ idRef: "new", status: "RUNNING" }] };
      svc.deployments.push(active); svc.activeDeployments = [clone(active)]; return clone(state);
    }), verifyPublic: vi.fn(async () => {}) };
  const input = { pin, receipt, receiptBytes };
  const approve = async () => {
    const plan = await complete(input, deps);
    const approval = { schemaVersion: 1, kind: "core-logical-retirement", reviewedAt: observedAt,
      baselineReceiptSha256: pin.receiptSha256, providerBeforeSha256: plan.providerBeforeSha256, opsSnapshotSha256: H,
      imageStartupProofSha256: H, publicSelfserveEvidenceSha256: H, providerDispositionSha256: H, sourceDataDispositionSha256: H,
      sourceDataDisposition: "retain-unchanged", customerTargets: "selfserve-only", physicalServices: "retain", databaseChanges: false };
    return { ...input, approval, approvalHash: identityHash(approval), dryRun: false };
  };
  return { input, deps, state, writes, order, approve };
}
async function withFixture(test) {
  const f = fixture(), original = incident.expectedProviderSha256, rowHash = incident.displacedWorkerHistory.fullFenceRowSha256;
  incident.expectedProviderSha256 = identityHash(f.state);
  incident.displacedWorkerHistory.fullFenceRowSha256 = identityHash(f.state.fence.services[0].deployments.at(-1));
  try { await test(f); } finally { incident.expectedProviderSha256 = original; incident.displacedWorkerHistory.fullFenceRowSha256 = rowHash; }
}

describe("settled worker and original web admission", () => {
  it("accepts the settled worker and keeps its health and proof pins", () => withFixture(f => {
    expect(() => assertWebCompletionStart(f.state, f.input.receipt)).not.toThrow();
    expect(incident.workerHealthEvidence).toMatchObject({ path: "/healthz", httpStatus: 200, status: "ok", mode: "source-freeze-utility",
      role: "worker", proofSha256: incident.workerProofSha256, applicationWrites: false, businessWorker: false });
    expect(incident.workerStartCommand).toBe(retirementCommand("worker", incident.workerProofSha256));
  }));
  it.each(["config", "state", "proof", "workerId", "image", "healthCommand"])("rejects exact-state %s drift", kind => withFixture(f => {
    if (kind === "config") f.state.configIdentity = H;
    if (kind === "state") f.state.fence.pendingWork.push({});
    if (kind === "proof") f.state.stages.worker.startCommand = retirementCommand("worker", H);
    if (kind === "workerId") f.state.stages.worker.latestDeployment.id = id(50);
    if (kind === "image") f.state.stages.worker.image = "different-image";
    if (kind === "healthCommand") f.state.stages.worker.startCommand = prior.predecessorWorkerStartCommand;
    expect(() => assertWebCompletionStart(f.state, f.input.receipt)).toThrow("WEB_COMPLETION_STATE_CHANGED");
  }));
  it.each(["oldRunning", "failedRunning", "workerStopped", "webStopped", "wrongImageReceipt", "workerId", "workerProof"])("independently rejects %s under a synthetic state pin", kind => withFixture(f => {
    const worker = f.state.fence.services[0];
    if (kind === "oldRunning") worker.deployments[1].instances[0].status = "RUNNING";
    if (kind === "failedRunning") worker.deployments[2].deploymentStopped = false;
    if (kind === "workerStopped") worker.activeDeployments[0].deploymentStopped = true;
    if (kind === "webStopped") f.state.fence.services[1].activeDeployments[0].instances[0].status = "STOPPED";
    if (kind === "wrongImageReceipt") f.input.receipt.evidence.images.worker.digest = `sha256:${"f".repeat(64)}`;
    if (kind === "workerId") f.state.stages.worker.latestDeployment.id = id(50);
    if (kind === "workerProof") f.state.stages.worker.startCommand = retirementCommand("worker", H);
    incident.expectedProviderSha256 = identityHash(f.state);
    expect(() => assertWebCompletionStart(f.state, f.input.receipt)).toThrow();
  }));
});

describe("three immutable predecessor manifests", () => {
  it("authenticates all three accepted approvals and their nested recovery envelopes", () => {
    const { first, second, third } = chain(); expect(validateWebCompletionPredecessors(first, second, third)).toEqual(third);
    expect(identityHash(third.healthcheckApproval)).toBe(incident.healthcheckApprovalHash);
  });
  it.each(["first", "second", "third", "run", "workflow", "prior", "target", "before", "provider", "envelope", "nested", "evidence"])("rejects tampered %s", kind => {
    const { first, second, third } = chain();
    if (kind === "first") first.approvalHash = H;
    if (kind === "second") second.reconciliation.originalApprovalHash = H;
    if (kind === "third") third.approvalHash = H;
    if (kind === "run") third.runId = "1";
    if (kind === "workflow") third.workflowSha = "a".repeat(40);
    if (kind === "prior") third.predecessor.artifactId++;
    if (kind === "target") third.target.workerServiceId = id(99);
    if (kind === "before") third.before.worker = id(99);
    if (kind === "provider") third.providerBeforeSha256 = H;
    if (kind === "envelope") third.healthcheckApproval.expectedPrivateConfigSha256 = H;
    if (kind === "nested") third.healthcheckApproval.retirementApproval.databaseChanges = true;
    if (kind === "evidence") third.opsSnapshotSha256 = H;
    expect(() => validateWebCompletionPredecessors(first, second, third)).toThrow();
  });
});

describe("fresh web-only completion approval", () => {
  it("accepts a new normal approval with unchanged worker evidence", () => {
    const a = envelope(); expect(validateWebCompletionApproval(a, identityHash(a), chain().third, now)).toEqual(a.retirementApproval);
  });
  it.each(["outerOld", "outerFuture", "nestedOld", "private", "oldProvider", "workerProof", "workerId", "case", "evidence", "scope", "hash", "thirdEnvelope"])("rejects %s despite caller rehashing", kind => {
    const a = envelope(), { third } = chain();
    if (kind === "outerOld") a.reviewedAt = new Date(now - 3600001).toISOString();
    if (kind === "outerFuture") a.reviewedAt = new Date(now + 1).toISOString();
    if (kind === "nestedOld") a.retirementApproval.reviewedAt = new Date(now - 3600001).toISOString();
    if (kind === "private") a.expectedPrivateConfigSha256 = H;
    if (kind === "oldProvider") a.retirementApproval.providerBeforeSha256 = prior.expectedProviderSha256;
    if (kind === "workerProof") a.retainedWorkerProofSha256 = H;
    if (kind === "workerId") a.retainedWorkerDeploymentId = id(99);
    if (kind === "case") a.caseSha256 = H;
    if (kind === "evidence") a.retirementApproval.imageStartupProofSha256 = H;
    if (kind === "scope") a.retirementApproval.databaseChanges = true;
    if (kind === "thirdEnvelope") third.healthcheckApproval.reviewedAt = new Date(now).toISOString();
    expect(() => validateWebCompletionApproval(a, kind === "hash" ? H : identityHash(a), third, now)).toThrow();
  });
});

describe("direct displaced and utility deployment continuity", () => {
  it("reads only the displaced history and retained worker IDs", () => withFixture(async f => {
    const queries = [];
    const query = async (text, { id: deploymentId }) => {
      queries.push({ text, deploymentId }); const row = f.state.fence.services[0].deployments.find(d => d.id === deploymentId);
      return { deployment: { ...clone(row), meta: { imageDigest: deploymentId === incident.workerDeploymentId
        ? f.input.receipt.evidence.images.worker.digest : incident.displacedWorkerHistory.digest } } };
    };
    expect(await verifyWebCompletionContinuity(f.state, query)).toHaveLength(2);
    expect(queries.map(row => row.deploymentId)).toEqual([incident.displacedWorkerHistory.id, incident.workerDeploymentId]);
    expect(queries.every(row => row.text.startsWith("query "))).toBe(true);
  }));
  it.each(["project", "environment", "service", "id", "digest", "status", "missing", "notStopped", "activeOld", "utilityStopped", "utilityInactive", "utilityDigest", "fenceMissing", "fenceChanged"])("rejects %s evidence", kind => withFixture(async f => {
    if (kind === "fenceMissing") f.state.fence.services[0].deployments.pop();
    if (kind === "fenceChanged") f.state.fence.services[0].deployments.at(-1).instances[0].status = "RUNNING";
    const query = async (_text, { id: deploymentId }) => {
      const row = clone(f.state.fence.services[0].deployments.find(d => d.id === deploymentId));
      row.meta = { imageDigest: deploymentId === incident.workerDeploymentId ? f.input.receipt.evidence.images.worker.digest : incident.displacedWorkerHistory.digest };
      if (deploymentId === incident.displacedWorkerHistory.id) {
        if (kind === "project") row.projectId = id(99);
        if (kind === "environment") row.environmentId = id(99);
        if (kind === "service") row.serviceId = target.webServiceId;
        if (kind === "id") row.id = id(99);
        if (kind === "digest") row.meta.imageDigest = `sha256:${H}`;
        if (kind === "status") row.status = "SUCCESS";
        if (kind === "missing") return { deployment: null };
        if (kind === "notStopped") row.deploymentStopped = false;
        if (kind === "activeOld") row.instances[0].status = "RUNNING";
      } else {
        if (kind === "utilityStopped") row.deploymentStopped = true;
        if (kind === "utilityInactive") row.instances[0].status = "REMOVED";
        if (kind === "utilityDigest") row.meta.imageDigest = null;
      }
      return { deployment: row };
    };
    await expect(verifyWebCompletionContinuity(f.state, query)).rejects.toThrow();
  }));
});

describe("bounded remaining web retirement engine", () => {
  it("defaults to a read-only plan with no intent or writes", () => withFixture(async f => {
    expect(await complete(f.input, f.deps)).toMatchObject({ dryRun: true, mutations: 0, permittedWrites: ["command:web", "deploy:web"] });
    expect(f.writes).toEqual([]); expect(f.deps.reserveIntent).not.toHaveBeenCalled();
  }));
  it("reserves before exactly two web writes and retains mixed role proofs", () => withFixture(async f => {
    const input = await f.approve(), worker = clone(f.state.stages.worker), workerFence = clone(f.state.fence.services[0]);
    const result = await complete(input, f.deps);
    expect(f.order).toEqual(["reserve", "command:web", "deploy:web"]); expect(f.writes).toEqual(result.writes);
    expect(result.roleProofs.worker.proofSha256).toBe(incident.workerProofSha256);
    expect(result.roleProofs.web.proofSha256).toBe(input.approvalHash);
    expect(result.roleProofs.web.proofSha256).not.toBe(result.roleProofs.worker.proofSha256);
    expect(f.state.stages.worker).toEqual(worker); expect(f.state.fence.services[0]).toEqual(workerFence);
    expect(f.deps.verifyPublic).toHaveBeenCalledWith(input.approvalHash);
    expect(result).toMatchObject({ applicationWrites: false, businessWorker: false, databaseChanges: false });
  }));
  it.each(["reservation", "admissionState", "admissionLease", "oldBaseline", "expiredDuringAdmission", "commandExercise"])("rejects %s before any write", kind => withFixture(async f => {
    const input = await f.approve();
    if (kind === "reservation") f.deps.reserveIntent.mockResolvedValue(false);
    if (kind === "admissionState") f.deps.readState.mockResolvedValueOnce(clone(f.state)).mockResolvedValueOnce({ ...clone(f.state), changed: true });
    if (kind === "admissionLease") f.deps.assertContext.mockResolvedValueOnce(H).mockRejectedValueOnce(new Error("ACTIVE_RELEASE_LEASE"));
    if (kind === "oldBaseline") f.deps.now = () => now + 86400001;
    if (kind === "expiredDuringAdmission") {
      let calls = 0; f.deps.now = () => ++calls < 3 ? now : now + 86400001;
    }
    if (kind === "commandExercise") f.deps.verifyCommands.mockRejectedValue(new Error("UNVERIFIED_COMMAND"));
    await expect(complete(input, f.deps)).rejects.toThrow(); expect(f.writes).toEqual([]);
  }));
  it.each(["commandUncertain", "deployUncertain", "badDeployId", "leaseBeforeDeploy", "commandReadback", "retainedWorker", "finalDrift"])("stops without replay on %s", kind => withFixture(async f => {
    const input = await f.approve();
    if (kind === "commandUncertain") f.deps.setCommand.mockImplementation(async () => { f.writes.push("command:web"); throw new Error("UNCERTAIN"); });
    if (kind === "deployUncertain") f.deps.deploy.mockImplementation(async () => { f.writes.push("deploy:web"); throw new Error("UNCERTAIN"); });
    if (kind === "badDeployId") f.deps.deploy.mockResolvedValue("unknown");
    if (kind === "leaseBeforeDeploy") f.deps.assertContext.mockResolvedValueOnce(H).mockResolvedValueOnce(H).mockRejectedValueOnce(new Error("ACTIVE_LEASE"));
    if (kind === "commandReadback") f.deps.setCommand.mockImplementation(async () => { f.writes.push("command:web"); });
    if (kind === "retainedWorker") { const verify = f.deps.verifyRuntime.getMockImplementation(); f.deps.verifyRuntime.mockImplementation(async (...args) => { const final = await verify(...args); final.stages.worker.startCommand = "changed"; return final; }); }
    if (kind === "finalDrift") f.deps.verifyPublic.mockImplementation(async () => { f.state.configIdentity = H; });
    await expect(complete(input, f.deps)).rejects.toThrow();
    expect(f.deps.setCommand).toHaveBeenCalledTimes(1); expect(f.deps.deploy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(f.deps.setCommand.mock.calls.every(([role]) => role === "web")).toBe(true);
    expect(f.deps.deploy.mock.calls.every(([role]) => role === "web")).toBe(true);
  }));
});
