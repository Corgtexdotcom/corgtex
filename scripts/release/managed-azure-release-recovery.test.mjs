import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { managedAzureTemplateDigest } from "./managed-azure-container-app-transport.mjs";
import {
  managedAzureRecoveryCliResultAccepted,
  runManagedAzureReleaseRecovery,
  writeManagedAzureRecoveryCliResult,
} from "./managed-azure-release-recovery.mjs";

const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const previousLeaseId = "123e4567-e89b-42d3-a456-426614174002";
const claimedLeaseId = "123e4567-e89b-42d3-a456-426614174003";
const baseSha = "a".repeat(40);
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

function template(role, digest, suffix) {
  return {
    revisionSuffix: suffix,
    containers: [{
      name: `${role}--old`,
      image: `${target.acrServer}/corgtex/${role}@${digest}`,
      env: [
        { name: "CORGTEX_RELEASE_GIT_SHA", value: baseSha },
        { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${baseSha}` },
        { name: "CORGTEX_RELEASE_VERSION", value: "release-1" },
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
  const deps = {
    owner: "github:recovery-test",
    lease: vi.fn(async (operation, args) => {
      calls.push([operation, args]);
      if (operation === "get_recovery") return {
        deploymentId,
        leaseId: previousLeaseId,
        fence: 7,
        phase: "RECOVERY_REQUIRED",
        release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1" },
        target,
        recovery: { stage: "IMPORT", code: "PROTOCOL_LOCATION_VIOLATION" },
      };
      if (operation === "claim_recovery") return { deploymentId, leaseId: claimedLeaseId, fence: 8, capability: "private-capability" };
      if (operation === "get_rollback") return rollback;
      if (operation === "finalize_rollback") return { deploymentId, fence: 8, status: "ROLLED_BACK", releaseImageTag: `sha-${baseSha}`, releaseVersion: "release-1" };
      throw new Error("unexpected lease operation");
    }),
    readApp: vi.fn(async ({ role }) => state(role)),
    ...overrides,
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

  it("stops before finalize when fresh Azure state does not match rollback baseline", async () => {
    const { deps } = rig({ readApp: vi.fn(async ({ role }) => state(role, role === "web" ? { revisionName: `${target.webAppName}--drift` } : {})) });
    const result = await runManagedAzureReleaseRecovery({ deploymentId, reason: "Clear failed import recovery.", acrName: "acr12" }, deps);
    expect(result).toEqual({ status: "RECOVERY_BLOCKED", deploymentId, code: "MANAGED_RELEASE_RECOVERY_WEB_DRIFT" });
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
    expect(writeManagedAzureRecoveryCliResult(result, { stdout: { write: vi.fn() }, stderr: { write: vi.fn() } })).toBe(1);
  });

  it("keeps recovery script source free of secret output and Container App patching", () => {
    const source = readFileSync(new URL("./managed-azure-release-recovery.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/patchTemplate|PATCH|beginManagedReleaseMutation|finalize_success|console\./);
    expect(source).not.toContain("releaseLeaseTokenHash");
    expect(source).toContain("claim_recovery");
    expect(source).toContain("finalize_rollback");
  });

  it("keeps the workflow manual, protected, and on the existing release concurrency key", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-release-recovery.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: managed-azure-release-production");
    expect(workflow).toContain("group: managed-azure-release-${{ inputs.deployment_id }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("scripts/release/managed-azure-release-recovery.mjs");
    expect(workflow).not.toContain("GHCR_IMPORT_TOKEN");
  });
});
