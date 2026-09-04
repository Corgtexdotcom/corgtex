import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildManagedAzureReleaseTemplate, managedAzureRevisionSuffix, managedAzureTemplateDigest } from "./managed-azure-container-app-transport.mjs";
import {
  managedAzureRecoveryCliResultAccepted,
  runManagedAzureReleaseRecovery,
  writeManagedAzureRecoveryCliResult,
} from "./managed-azure-release-recovery.mjs";

const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const previousLeaseId = "123e4567-e89b-42d3-a456-426614174002";
const claimedLeaseId = "123e4567-e89b-42d3-a456-426614174003";
const laterRecoveryLeaseId = "123e4567-e89b-42d3-a456-426614174004";
const baseSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const target = Object.freeze({
  subscriptionId: "123e4567-e89b-42d3-a456-426614174000",
  resourceGroup: "rg.Safe_1",
  acrName: "acr12",
  acrServer: "acr12.azurecr.io",
  webAppName: "web-app",
  workerAppName: "worker-app",
});
const digests = {
  web: `sha256:${"1".repeat(64)}`,
  worker: `sha256:${"2".repeat(64)}`,
};

function template(role, digest, suffix, release = { gitSha: baseSha, imageTag: `sha-${baseSha}`, version: "release-1" }) {
  return {
    revisionSuffix: suffix,
    containers: [{
      name: `${role}--old`,
      image: `${target.acrServer}/corgtex/${role}@${digest}`,
      env: [
        { name: "CORGTEX_RELEASE_GIT_SHA", value: release.gitSha },
        { name: "CORGTEX_RELEASE_IMAGE_TAG", value: release.imageTag },
        { name: "CORGTEX_RELEASE_VERSION", value: release.version },
      ],
    }],
  };
}

const templates = {
  web: template("web", digests.web, "web-base"),
  worker: template("worker", digests.worker, "worker-base"),
};
const rollback = Object.freeze({
  schemaVersion: 1,
  target,
  previous: {
    releaseVersion: "release-1",
    web: {
      containerName: "web--old",
      image: templates.web.containers[0].image,
      readyRevision: `${target.webAppName}--web-base`,
      templateDigest: managedAzureTemplateDigest(templates.web),
    },
    worker: {
      containerName: "worker--old",
      image: templates.worker.containers[0].image,
      readyRevision: `${target.workerAppName}--worker-base`,
      templateDigest: managedAzureTemplateDigest(templates.worker),
    },
  },
  incoming: { webDigest: `sha256:${"3".repeat(64)}`, workerDigest: `sha256:${"4".repeat(64)}` },
});

function state(role, overrides = {}) {
  const expected = rollback.previous[role];
  return {
    appName: role === "web" ? target.webAppName : target.workerAppName,
    role,
    location: "West US",
    revisionName: expected.readyRevision,
    revisionSuffix: role === "web" ? "web-base" : "worker-base",
    containerName: expected.containerName,
    image: expected.image,
    imageDigest: role === "web" ? digests.web : digests.worker,
    template: templates[role],
    templateDigest: expected.templateDigest,
    ...overrides,
  };
}

function rig(overrides = {}) {
  const calls = [];
  const {
    recoveryStatus = {
      deploymentId,
      leaseId: previousLeaseId,
      fence: 7,
      phase: "RECOVERY_REQUIRED",
      release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1", target: { kind: "FORWARD", imageTag: `sha-${nextSha}`, version: "release-2" } },
      origin: "https://selfserve.example",
      target,
      originatingLease: { leaseId: previousLeaseId, fence: 7 },
      recovery: { stage: "IMPORT", code: "PROTOCOL_LOCATION_VIOLATION" },
    },
    rollbackPayload = rollback,
    ...depOverrides
  } = overrides;
  const deps = {
    owner: "github:recovery-test",
    lease: vi.fn(async (operation, args) => {
      calls.push([operation, args]);
      if (operation === "get_recovery") return recoveryStatus;
      if (operation === "claim_recovery") return { deploymentId, leaseId: claimedLeaseId, fence: 8, capability: "private-capability" };
      if (operation === "get_rollback") return rollbackPayload;
      if (operation === "finalize_rollback") return { deploymentId, fence: 8, status: "ROLLED_BACK", releaseImageTag: `sha-${baseSha}`, releaseVersion: "release-1" };
      if (operation === "heartbeat" || operation === "heartbeat_recovery") return { deploymentId, fence: 8, phase: "RECOVERY_REQUIRED" };
      if (operation === "mark_recovery") return { deploymentId, fence: 8, phase: "RECOVERY_REQUIRED" };
      if (operation === "finalize_success") return { deploymentId, fence: 8, status: "SUCCEEDED", releaseImageTag: `sha-${nextSha}`, releaseVersion: "release-2" };
      if (operation === "finalize_compatible_recovery") return { deploymentId, fence: 8, status: "RECOVERED_COMPATIBLE", releaseImageTag: `sha-${"c".repeat(40)}`, releaseVersion: "recovery-1" };
      throw new Error("unexpected lease operation");
    }),
    readApp: vi.fn(async ({ role }) => state(role)),
    patchTemplate: vi.fn(async () => ({ terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" })),
    waitForState: vi.fn(async () => undefined),
    healthProbe: vi.fn(async () => ({ ok: true })),
    authPreflight: vi.fn(async () => ({ ok: true })),
    acceptanceProbe: vi.fn(async ({ operationId, release }) => ({ accepted: true, webGitSha: release.gitSha,
      receipt: { workerGitSha: release.gitSha, operationId } })),
    observeNewRelease: vi.fn(async () => ({ verified: true })),
    setRevisionActive: vi.fn(async () => ({ terminal: true, succeeded: true })),
    ...depOverrides,
  };
  return { deps, calls };
}

function resumableSchemaV2State(rollbackPayload, initial = { web: "FORWARD", worker: "BASELINE" }) {
  const recovery = rollbackPayload.compatibleRecovery;
  const recoveryRelease = { gitSha: recovery.gitSha, imageTag: recovery.imageTag, version: recovery.releaseVersion };
  const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
  const live = { ...initial };
  const stateFor = (role, kind) => {
    if (kind === "BASELINE") return state(role);
    const release = kind === "FORWARD" ? incoming : recoveryRelease;
    const suffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role,
      phase: kind === "FORWARD" ? "forward" : "rollback" });
    const image = kind === "FORWARD"
      ? `${target.acrServer}/corgtex/${role}@${rollbackPayload.incoming[role === "web" ? "webDigest" : "workerDigest"]}`
      : recovery[role].image;
    const candidate = buildManagedAzureReleaseTemplate({ baseline: state(role), role, image, release, revisionSuffix: suffix });
    return state(role, { revisionName: `${target[role === "web" ? "webAppName" : "workerAppName"]}--${suffix}`,
      revisionSuffix: suffix, image, imageDigest: kind === "FORWARD"
        ? rollbackPayload.incoming[role === "web" ? "webDigest" : "workerDigest"] : recovery[role].digest,
      template: candidate, templateDigest: managedAzureTemplateDigest(candidate) });
  };
  const readApp = vi.fn(async ({ role, release }) => {
    const kind = live[role];
    const expectedSha = kind === "BASELINE" ? baseSha : kind === "FORWARD" ? nextSha : recovery.gitSha;
    if (release.gitSha !== expectedSha) throw new Error("state mismatch");
    return stateFor(role, kind);
  });
  const patchTemplate = vi.fn(async ({ role, template: candidate }) => {
    const gitSha = candidate.containers[0].env.find((entry) => entry.name === "CORGTEX_RELEASE_GIT_SHA")?.value;
    if (gitSha !== recovery.gitSha) throw new Error("unexpected recovery patch");
    live[role] = "COMPATIBLE";
    return { terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" };
  });
  return { live, readApp, patchTemplate };
}

describe("managed Azure release recovery", () => {
  it("claims expired recovery, verifies both baseline apps, and clears the lease without logging capability", async () => {
    const { deps, calls } = rig();
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Clear failed import recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({
      status: "RECOVERY_CLEARED",
      deploymentId,
      previousLeaseId,
      previousFence: 7,
      fence: 8,
      releaseImageTag: `sha-${baseSha}`,
      releaseVersion: "release-1",
    });
    expect(calls.map(([operation]) => operation)).toEqual(["get_recovery", "claim_recovery", "get_rollback", "finalize_rollback"]);
    expect(deps.readApp).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private-capability");
    expect(writeManagedAzureRecoveryCliResult(result, { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } })).toBe(0);
    expect(managedAzureRecoveryCliResultAccepted(result)).toBe(true);
  });

  it("preserves rollback recovery when the recorded target is rollback", async () => {
    const { deps, calls } = rig({
      recoveryStatus: {
        deploymentId,
        leaseId: previousLeaseId,
        fence: 7,
        phase: "RECOVERY_REQUIRED",
        release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1", target: { kind: "ROLLBACK", imageTag: `sha-${baseSha}`, version: "release-1" } },
        origin: "https://selfserve.example",
        target,
        originatingLease: { leaseId: previousLeaseId, fence: 7 },
        recovery: { stage: "ROLLBACK", code: "ROLLBACK_READBACK_AMBIGUOUS" },
      },
    });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Clear failed rollback recovery.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", releaseImageTag: `sha-${baseSha}`, releaseVersion: "release-1" });
    expect(calls.map(([operation]) => operation)).toEqual(["get_recovery", "claim_recovery", "get_rollback", "finalize_rollback"]);
  });

  it("stops before finalize when fresh Azure state does not match rollback baseline", async () => {
    const { deps } = rig({ readApp: vi.fn(async ({ role }) => state(role, role === "web" ? { revisionName: `${target.webAppName}--drift` } : {})) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Clear failed import recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_MIXED_STATE_UNSUPPORTED" });
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
    expect(writeManagedAzureRecoveryCliResult(result, { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } })).toBe(1);
  });

  it("uses the approved compatible pair after a partial forward migration and records the actual recovery release", async () => {
    const recoverySha = "c".repeat(40); const recoveryWeb = `sha256:${"5".repeat(64)}`; const recoveryWorker = `sha256:${"6".repeat(64)}`;
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: recoverySha, imageTag: `sha-${recoverySha}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@${recoveryWeb}`, digest: recoveryWeb }, worker: { image: `${target.acrServer}/corgtex/worker@${recoveryWorker}`, digest: recoveryWorker },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE",
    } };
    const live = resumableSchemaV2State(rollbackPayload);
    const { deps, calls } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover partial schema activation safely.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "COMPATIBLE_RECOVERY", releaseImageTag: `sha-${recoverySha}` });
    expect(deps.patchTemplate).toHaveBeenCalledTimes(2);
    expect(deps.patchTemplate.mock.calls.map(([arg]) => arg.template.containers[0].image)).toEqual([rollbackPayload.compatibleRecovery.web.image, rollbackPayload.compatibleRecovery.worker.image]);
    expect(deps.acceptanceProbe).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: recoverySha }) }));
    expect(calls.map(([operation]) => operation)).toContain("finalize_compatible_recovery");
    expect(calls.map(([operation]) => operation)).not.toContain("finalize_success");
  });

  it("resumes after the compatible web patch without rebuilding or duplicating it", async () => {
    const recoverySha = "c".repeat(40); const recoveryWeb = `sha256:${"5".repeat(64)}`; const recoveryWorker = `sha256:${"6".repeat(64)}`;
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: recoverySha, imageTag: `sha-${recoverySha}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@${recoveryWeb}`, digest: recoveryWeb }, worker: { image: `${target.acrServer}/corgtex/worker@${recoveryWorker}`, digest: recoveryWorker },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE",
    } };
    const live = resumableSchemaV2State(rollbackPayload, { web: "COMPATIBLE", worker: "BASELINE" });
    const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Resume compatible recovery exactly once.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "COMPATIBLE_RECOVERY" });
    expect(deps.patchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.patchTemplate).toHaveBeenCalledWith(expect.objectContaining({ role: "worker" }));
    expect(deps.acceptanceProbe).toHaveBeenCalledTimes(1);
  });

  it("uses exact exclusive baselines for containment and then converges to compatible recovery", async () => {
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: "c".repeat(40), imageTag: `sha-${"c".repeat(40)}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@sha256:${"5".repeat(64)}`, digest: `sha256:${"5".repeat(64)}` },
      worker: { image: `${target.acrServer}/corgtex/worker@sha256:${"6".repeat(64)}`, digest: `sha256:${"6".repeat(64)}` },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE",
    } };
    const live = resumableSchemaV2State(rollbackPayload, { web: "BASELINE", worker: "BASELINE" });
    const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate, recoveryStatus: {
      deploymentId, leaseId: previousLeaseId, fence: 7, phase: "RECOVERY_REQUIRED",
      release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1", target: { kind: "FORWARD", imageTag: `sha-${nextSha}`, version: "release-2" } },
      origin: "https://selfserve.example", target, originatingLease: { leaseId: previousLeaseId, fence: 7 },
      recovery: { stage: "FENCING", code: "TRANSACTION_AMBIGUOUS" },
    } });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Restore drained baseline revisions.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "COMPATIBLE_RECOVERY",
      releaseImageTag: rollbackPayload.compatibleRecovery.imageTag });
    expect(deps.setRevisionActive.mock.calls.map(([request]) => [request.role, request.revisionName, request.active]))
      .toEqual([["web", `${target.webAppName}--web-base`, true], ["worker", `${target.workerAppName}--worker-base`, true]]);
    expect(deps.healthProbe).toHaveBeenCalledWith({ origin: "https://selfserve.example", release: { gitSha: baseSha, imageTag: `sha-${baseSha}`, version: "release-1" } });
    expect(deps.patchTemplate.mock.calls.map(([request]) => request.role)).toEqual(["web", "worker"]);
    expect(deps.authPreflight).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }) }));
    expect(deps.acceptanceProbe).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }), operationId: expect.any(String) }));
    expect(deps.observeNewRelease).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }),
      imageDigests: { web: rollbackPayload.compatibleRecovery.web.digest, worker: rollbackPayload.compatibleRecovery.worker.digest }, durationMs: 15 * 60_000 }));
    expect(deps.lease).toHaveBeenCalledWith("finalize_compatible_recovery", expect.objectContaining({ evidence: expect.objectContaining({
      gitSha: rollbackPayload.compatibleRecovery.gitSha,
      acceptanceEvidenceDigest: expect.stringMatching(/^sha256:/),
    }) }));
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });

  it("routes a standard-policy V2 baseline through the approved compatible recovery", async () => {
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: "c".repeat(40), imageTag: `sha-${"c".repeat(40)}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@sha256:${"5".repeat(64)}`, digest: `sha256:${"5".repeat(64)}` },
      worker: { image: `${target.acrServer}/corgtex/worker@sha256:${"6".repeat(64)}`, digest: `sha256:${"6".repeat(64)}` },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "STANDARD",
    } };
    const live = resumableSchemaV2State(rollbackPayload, { web: "BASELINE", worker: "BASELINE" });
    const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover the approved compatible schema pair.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "COMPATIBLE_RECOVERY",
      releaseImageTag: rollbackPayload.compatibleRecovery.imageTag });
    expect(deps.setRevisionActive).not.toHaveBeenCalled();
    expect(deps.patchTemplate.mock.calls.map(([request]) => request.role)).toEqual(["web", "worker"]);
    expect(deps.authPreflight).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }) }));
    expect(deps.acceptanceProbe).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }) }));
    expect(deps.observeNewRelease).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: rollbackPayload.compatibleRecovery.gitSha }) }));
    expect(deps.lease).toHaveBeenCalledWith("finalize_compatible_recovery", expect.anything());
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });

  it.each(["EXCLUSIVE", "STANDARD"])("does not clear a %s recovery when compatible acceptance proof fails", async (activationPolicy) => {
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: "c".repeat(40), imageTag: `sha-${"c".repeat(40)}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@sha256:${"5".repeat(64)}`, digest: `sha256:${"5".repeat(64)}` },
      worker: { image: `${target.acrServer}/corgtex/worker@sha256:${"6".repeat(64)}`, digest: `sha256:${"6".repeat(64)}` },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy,
    } };
    for (const scenario of ["auth", "diagnostic", "observation"]) {
      const overrides = scenario === "diagnostic" ? { acceptanceProbe: vi.fn(async () => ({ accepted: false })) }
        : scenario === "observation" ? { observeNewRelease: vi.fn(async () => ({ verified: false })) }
          : { authPreflight: vi.fn(async () => { throw new Error("revoked"); }) };
      const live = resumableSchemaV2State(rollbackPayload, { web: "BASELINE", worker: "BASELINE" });
      const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate, ...overrides });
      const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Require exact rollback proof.", acrName: "acr12" }, deps);
      expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId,
        code: `MANAGED_RELEASE_RECOVERY_COMPATIBLE_${scenario === "auth" ? "AUTH" : scenario === "diagnostic" ? "DIAGNOSTIC" : "OBSERVATION"}_FAILED` });
      expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
      expect(deps.lease).toHaveBeenCalledWith("mark_recovery", expect.anything());
    }
  });

  it("retains compatible recovery when the worker cannot produce an exact receipt", async () => {
    const recoverySha = "c".repeat(40); const recoveryWeb = `sha256:${"5".repeat(64)}`; const recoveryWorker = `sha256:${"6".repeat(64)}`;
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: recoverySha, imageTag: `sha-${recoverySha}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@${recoveryWeb}`, digest: recoveryWeb }, worker: { image: `${target.acrServer}/corgtex/worker@${recoveryWorker}`, digest: recoveryWorker },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE",
    } };
    const live = resumableSchemaV2State(rollbackPayload);
    const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate,
      acceptanceProbe: vi.fn(async () => ({ accepted: false })) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover partial schema activation safely.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_COMPATIBLE_DIAGNOSTIC_FAILED" });
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_compatible_recovery", expect.anything());
  });

  it("reports failed recovery recording and never finalizes the claimed lease", async () => {
    const recoverySha = "c".repeat(40); const recoveryWeb = `sha256:${"5".repeat(64)}`; const recoveryWorker = `sha256:${"6".repeat(64)}`;
    const rollbackPayload = { ...structuredClone(rollback), schemaVersion: 2,
      incoming: { ...rollback.incoming, schemaApprovalDigest: `sha256:${"a".repeat(64)}` }, compatibleRecovery: {
      gitSha: recoverySha, imageTag: `sha-${recoverySha}`, releaseVersion: "recovery-1",
      web: { image: `${target.acrServer}/corgtex/web@${recoveryWeb}`, digest: recoveryWeb }, worker: { image: `${target.acrServer}/corgtex/worker@${recoveryWorker}`, digest: recoveryWorker },
      schemaCompatibilityApprovalDigest: `sha256:${"9".repeat(64)}`, acceptancePolicy: "AUTHENTICATED_WEB_AND_WORKER_IDENTITY_SCHEMA_V1", activationPolicy: "EXCLUSIVE",
    } };
    const live = resumableSchemaV2State(rollbackPayload);
    const { deps } = rig({ rollbackPayload, readApp: live.readApp, patchTemplate: live.patchTemplate,
      acceptanceProbe: vi.fn(async () => ({ accepted: false })) });
    const lease = deps.lease.getMockImplementation();
    deps.lease.mockImplementation(async (operation, args) => {
      if (operation === "mark_recovery") throw new Error("control plane unavailable");
      return lease(operation, args);
    });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Retain fenced recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_RECORDING_FAILED" });
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_compatible_recovery", expect.anything());
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("completes a recorded forward release when web is forward and worker is still baseline", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const workerSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "worker", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps, calls } = rig({ readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({
      status: "RECOVERY_CLEARED",
      deploymentId,
      previousLeaseId,
      previousFence: 7,
      fence: 8,
      releaseImageTag: `sha-${nextSha}`,
      releaseVersion: "release-2",
      resolution: "FORWARD_COMPLETED",
    });
    expect(calls.map(([operation]) => operation)).toEqual(["get_recovery", "claim_recovery", "get_rollback", "heartbeat", "heartbeat", "finalize_success"]);
    expect(deps.patchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.patchTemplate.mock.calls[0][0]).toMatchObject({ role: "worker", target, location: "West US" });
    expect(deps.patchTemplate.mock.calls[0][0].template.containers[0].image).toBe(`${target.acrServer}/corgtex/worker@${rollback.incoming.workerDigest}`);
    expect(deps.patchTemplate.mock.calls[0][0].template.revisionSuffix).toBe(workerSuffix);
    expect(deps.waitForState).toHaveBeenCalledWith(expect.objectContaining({ role: "worker", release: incoming, imageDigest: rollback.incoming.workerDigest }));
    expect(deps.healthProbe).toHaveBeenCalledWith({ origin: "https://selfserve.example", release: incoming });
    expect(managedAzureRecoveryCliResultAccepted(result)).toBe(true);
  });

  it("reconstructs forward recovery when the recorded baseline used an Azure-generated revision suffix", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const workerSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "worker", phase: "forward" });
    const webBaselineTemplate = template("web", digests.web, "");
    const rollbackPayload = structuredClone(rollback);
    rollbackPayload.previous.web = {
      ...rollbackPayload.previous.web,
      readyRevision: `${target.webAppName}--b8bc6lz`,
      templateDigest: managedAzureTemplateDigest(webBaselineTemplate),
    };
    const webTemplate = buildManagedAzureReleaseTemplate({
      baseline: state("web", {
        revisionName: `${target.webAppName}--b8bc6lz`,
        revisionSuffix: "",
        template: webBaselineTemplate,
        templateDigest: managedAzureTemplateDigest(webBaselineTemplate),
      }),
      role: "web",
      image: `${target.acrServer}/corgtex/web@${rollback.incoming.webDigest}`,
      release: incoming,
      revisionSuffix: webSuffix,
    });
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps } = rig({ rollbackPayload, readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "FORWARD_COMPLETED" });
    expect(deps.patchTemplate.mock.calls[0][0].template.revisionSuffix).toBe(workerSuffix);
  });

  it("completes forward recovery when the missing role is already transaction-rolled back", async () => {
    const baseline = { gitSha: baseSha, imageTag: `sha-${baseSha}`, version: "release-1" };
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const workerRollbackSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "worker", phase: "rollback" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const workerRollbackTemplate = buildManagedAzureReleaseTemplate({
      baseline: state("worker"),
      role: "worker",
      image: rollback.previous.worker.image,
      release: baseline,
      revisionSuffix: workerRollbackSuffix,
    });
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker", {
        revisionName: `${target.workerAppName}--${workerRollbackSuffix}`,
        revisionSuffix: workerRollbackSuffix,
        template: workerRollbackTemplate,
        templateDigest: managedAzureTemplateDigest(workerRollbackTemplate),
      });
      throw new Error("state mismatch");
    });
    const { deps } = rig({ readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "FORWARD_COMPLETED" });
    expect(deps.patchTemplate).toHaveBeenCalledWith(expect.objectContaining({ role: "worker" }));
    expect(deps.lease).toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("blocks a forward image that is not the transaction-owned revision", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webTemplate = template("web", rollback.incoming.webDigest, "manual-forward", incoming);
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--manual-forward`,
        revisionSuffix: "manual-forward",
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps } = rig({ readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_MIXED_STATE_UNSUPPORTED" });
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("blocks forward recovery when recovery status omits the originating transaction lease", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const recoveryStatus = {
      deploymentId,
      leaseId: previousLeaseId,
      fence: 7,
      phase: "RECOVERY_REQUIRED",
      release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1", target: { kind: "FORWARD", imageTag: `sha-${nextSha}`, version: "release-2" } },
      origin: "https://selfserve.example",
      target,
      recovery: { stage: "IMPORT", code: "PROTOCOL_LOCATION_VIOLATION" },
    };
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps } = rig({ recoveryStatus, readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_STATUS_INVALID" });
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("keeps using the originating transaction suffix after a later recovery claim expires", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const laterStatusSuffix = managedAzureRevisionSuffix({ leaseId: laterRecoveryLeaseId, fence: 11, role: "web", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps } = rig({
      recoveryStatus: {
        deploymentId,
        leaseId: laterRecoveryLeaseId,
        fence: 11,
        phase: "RECOVERY_REQUIRED",
        release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1", target: { kind: "FORWARD", imageTag: `sha-${nextSha}`, version: "release-2" } },
        origin: "https://selfserve.example",
        target,
        originatingLease: { leaseId: previousLeaseId, fence: 7 },
        recovery: { stage: "OBSERVATION", code: "HEALTH_RELEASE_MISMATCH" },
      },
      readApp,
    });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "FORWARD_COMPLETED" });
    expect(deps.patchTemplate.mock.calls[0][0].template.revisionSuffix).toBe(webSuffix);
    expect(deps.patchTemplate.mock.calls[0][0].template.revisionSuffix).not.toBe(laterStatusSuffix);
  });

  it("records worker readback failures after patching during forward completion", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps, calls } = rig({ readApp, waitForState: vi.fn(async () => { throw new Error("timeout"); }) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "WORKER_READBACK_AMBIGUOUS" });
    expect(calls.map(([operation]) => operation)).toContain("mark_recovery");
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("records worker patch exceptions during forward completion", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) return state("web", {
        revisionName: `${target.webAppName}--${webSuffix}`,
        revisionSuffix: webSuffix,
        image: webTemplate.containers[0].image,
        imageDigest: rollback.incoming.webDigest,
        template: webTemplate,
        templateDigest: managedAzureTemplateDigest(webTemplate),
      });
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps, calls } = rig({ readApp, patchTemplate: vi.fn(async () => { throw new Error("ambiguous patch"); }) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "WORKER_PATCH_AMBIGUOUS" });
    expect(calls.map(([operation]) => operation)).toContain("mark_recovery");
    expect(deps.waitForState).not.toHaveBeenCalled();
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("revalidates the exact web forward revision after worker readback", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const webTemplate = template("web", rollback.incoming.webDigest, webSuffix, incoming);
    const driftedTemplate = template("web", rollback.incoming.webDigest, "manual-forward", incoming);
    let forwardWebReads = 0;
    const readApp = vi.fn(async ({ role, release }) => {
      if (role === "web" && release.gitSha === nextSha) {
        forwardWebReads += 1;
        return forwardWebReads === 1
          ? state("web", {
            revisionName: `${target.webAppName}--${webSuffix}`,
            revisionSuffix: webSuffix,
            image: webTemplate.containers[0].image,
            imageDigest: rollback.incoming.webDigest,
            template: webTemplate,
            templateDigest: managedAzureTemplateDigest(webTemplate),
          })
          : state("web", {
            revisionName: `${target.webAppName}--manual-forward`,
            revisionSuffix: "manual-forward",
            image: driftedTemplate.containers[0].image,
            imageDigest: rollback.incoming.webDigest,
            template: driftedTemplate,
            templateDigest: managedAzureTemplateDigest(driftedTemplate),
          });
      }
      if (role === "worker" && release.gitSha === baseSha) return state("worker");
      throw new Error("state mismatch");
    });
    const { deps, calls } = rig({ readApp });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "WEB_READBACK_MISMATCH" });
    expect(forwardWebReads).toBe(2);
    expect(calls.map(([operation]) => operation)).toContain("mark_recovery");
    expect(deps.healthProbe).not.toHaveBeenCalled();
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("records observation failure when both roles are already forward", async () => {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const webSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "web", phase: "forward" });
    const workerSuffix = managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role: "worker", phase: "forward" });
    const forwardTemplates = {
      web: template("web", rollback.incoming.webDigest, webSuffix, incoming),
      worker: template("worker", rollback.incoming.workerDigest, workerSuffix, incoming),
    };
    const readApp = vi.fn(async ({ role, release }) => {
      if (release.gitSha !== nextSha) throw new Error("state mismatch");
      return state(role, {
        revisionName: `${role === "web" ? target.webAppName : target.workerAppName}--${role === "web" ? webSuffix : workerSuffix}`,
        revisionSuffix: role === "web" ? webSuffix : workerSuffix,
        image: forwardTemplates[role].containers[0].image,
        imageDigest: rollback.incoming[role === "web" ? "webDigest" : "workerDigest"],
        template: forwardTemplates[role],
        templateDigest: managedAzureTemplateDigest(forwardTemplates[role]),
      });
    });
    const { deps, calls } = rig({ readApp, healthProbe: vi.fn(async () => ({ ok: false, code: "HEALTH_RELEASE_MISMATCH" })) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Complete partial forward recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "HEALTH_RELEASE_MISMATCH" });
    expect(calls.map(([operation]) => operation)).toContain("mark_recovery");
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
  });

  it("keeps recovery script source free of secret output and image import", () => {
    const source = readFileSync(new URL("./managed-azure-release-recovery.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/startManagedAzureImport|GHCR_IMPORT_TOKEN|beginManagedReleaseMutation|console\./);
    expect(source).not.toContain("releaseLeaseTokenHash");
    expect(source).toContain("claim_recovery");
    expect(source).toContain("finalize_rollback");
    expect(source).toContain("finalize_success");
    expect(source).toContain("patchTemplate");
  });

  it("keeps the workflow manual, protected, and on the existing release concurrency key", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-release-recovery.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: managed-azure-release-production");
    expect(workflow).toContain("timeout-minutes: 150");
    expect(workflow).toContain("group: managed-azure-release-${{ inputs.deployment_id }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("scripts/release/managed-azure-release-recovery.mjs");
    expect(workflow).toContain("RECOVERY_DEPLOYMENT_ID: ${{ inputs.deployment_id }}");
    expect(workflow).toContain("RECOVERY_REASON: ${{ inputs.reason }}");
    expect(workflow).toContain('--deployment-id "$RECOVERY_DEPLOYMENT_ID"');
    expect(workflow).toContain('--reason "$RECOVERY_REASON"');
    expect(workflow).not.toContain('--deployment-id "${{ inputs.deployment_id }}"');
    expect(workflow).not.toContain('--reason "${{ inputs.reason }}"');
    expect(workflow).not.toContain("GHCR_IMPORT_TOKEN");
  });
});

describe("recovery after hosted selection removal", () => {
  function removedSelectionRig(bothForward, failure = null) {
    const incoming = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const current = {};
    for (const role of ["web", "worker"]) {
      const forward = role === "web" || bothForward;
      const selected = forward ? template(role, rollback.incoming[`${role}Digest`], managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role, phase: "forward" }), incoming) : templates[role];
      current[role] = { selected, sha: forward ? nextSha : baseSha };
    }
    const { deps, calls } = rig();
    const lease = deps.lease.getMockImplementation();
    deps.lease.mockImplementation(async (operation, args) => {
      if (operation === "heartbeat") throw Object.assign(new Error("forward denied"), { code: failure ?? "MANAGED_RELEASE_FORWARD_NOT_ALLOWED" });
      if (operation === "heartbeat_recovery") { calls.push([operation, args]); return { phase: "RECOVERY_REQUIRED" }; }
      return lease(operation, args);
    });
    deps.readApp.mockImplementation(async ({ role, release }) => {
      const { selected, sha } = current[role];
      if (sha !== release.gitSha) throw new Error("state mismatch");
      return state(role, { revisionName: `${role === "web" ? target.webAppName : target.workerAppName}--${selected.revisionSuffix}`, revisionSuffix: selected.revisionSuffix,
        image: selected.containers[0].image, imageDigest: selected.containers[0].image.split("@")[1], template: selected, templateDigest: managedAzureTemplateDigest(selected) });
    });
    deps.patchTemplate.mockImplementation(async ({ role, template: selected }) => {
      current[role] = { selected, sha: baseSha };
      return { terminal: true, succeeded: true };
    });
    return { deps, calls };
  }
  it.each([false, true])("rolls back only recognized owned revisions, worker before web (both=%s)", async (both) => {
    const { deps } = removedSelectionRig(both);
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover removed primary selection.", acrName: "acr12" }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_CLEARED", resolution: "ROLLED_BACK_SELECTION_REMOVED", releaseImageTag: `sha-${baseSha}` });
    expect(deps.patchTemplate.mock.calls.map(([args]) => args.role)).toEqual(both ? ["worker", "web"] : ["web"]);
    for (const [{ role, template: restored }] of deps.patchTemplate.mock.calls) {
      expect(restored.containers[0].image).toBe(rollback.previous[role].image);
      expect(restored.revisionSuffix).toBe(managedAzureRevisionSuffix({ leaseId: previousLeaseId, fence: 7, role, phase: "rollback" }));
    }
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_success", expect.anything());
    expect(deps.lease).toHaveBeenCalledWith("heartbeat_recovery", expect.anything());
    expect(deps.healthProbe).toHaveBeenCalledWith(expect.objectContaining({ release: expect.objectContaining({ gitSha: baseSha }) }));
  });
  it("does not treat auth revocation as selection removal or mutate the provider", async () => {
    const { deps } = removedSelectionRig(true, "FORBIDDEN");
    expect(await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover revoked authorization.", acrName: "acr12" }, deps)).toMatchObject({ status: "RECOVERY_BLOCKED" });
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });
  it("retains an ambiguous rollback instead of clearing or retrying the lease", async () => {
    const { deps } = removedSelectionRig(true);
    deps.patchTemplate.mockResolvedValue({ terminal: false, succeeded: false, code: "AZURE_OPERATION_TIMEOUT" });
    expect(await runManagedAzureReleaseRecovery({ deploymentId, reason: "Recover interrupted rollback.", acrName: "acr12" }, deps)).toMatchObject({ status: "RECOVERY_BLOCKED" });
    expect(deps.patchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.lease).toHaveBeenCalledWith("mark_recovery", expect.objectContaining({ stage: "ROLLBACK" }));
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });
});
