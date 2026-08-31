import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { managedAzureRevisionSuffix, managedAzureTemplateDigest } from "./managed-azure-container-app-transport.mjs";
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
      if (operation === "heartbeat") return { deploymentId, fence: 8, phase: "RECOVERY_REQUIRED" };
      if (operation === "mark_recovery") return { deploymentId, fence: 8, phase: "RECOVERY_REQUIRED" };
      if (operation === "finalize_success") return { deploymentId, fence: 8, status: "SUCCEEDED", releaseImageTag: `sha-${nextSha}`, releaseVersion: "release-2" };
      throw new Error("unexpected lease operation");
    }),
    readApp: vi.fn(async ({ role }) => state(role)),
    patchTemplate: vi.fn(async () => ({ terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" })),
    waitForState: vi.fn(async () => undefined),
    healthProbe: vi.fn(async () => ({ ok: true })),
    ...depOverrides,
  };
  return { deps, calls };
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
    expect(calls.map(([operation]) => operation)).toEqual(["get_recovery", "claim_recovery", "get_rollback", "heartbeat", "finalize_success"]);
    expect(deps.patchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.patchTemplate.mock.calls[0][0]).toMatchObject({ role: "worker", target, location: "West US" });
    expect(deps.patchTemplate.mock.calls[0][0].template.containers[0].image).toBe(`${target.acrServer}/corgtex/worker@${rollback.incoming.workerDigest}`);
    expect(deps.patchTemplate.mock.calls[0][0].template.revisionSuffix).toBe(workerSuffix);
    expect(deps.waitForState).toHaveBeenCalledWith(expect.objectContaining({ role: "worker", release: incoming, imageDigest: rollback.incoming.workerDigest }));
    expect(deps.healthProbe).toHaveBeenCalledWith({ origin: "https://selfserve.example", release: incoming });
    expect(managedAzureRecoveryCliResultAccepted(result)).toBe(true);
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

  it("keeps using the observed transaction suffix after a later recovery claim expires", async () => {
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
    expect(workflow).toContain("timeout-minutes: 30");
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
