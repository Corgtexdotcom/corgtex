import { describe, expect, it, vi } from "vitest";
import {
  managedAzureTemplateDigest,
} from "./managed-azure-container-app-transport.mjs";
import {
  buildManagedAzureRecoveryIntent,
  managedAzureRecoveryIntents,
  readManagedAzureRecoveryIntentPlan,
  runManagedAzureRecoveryIntent,
} from "./managed-azure-recovery-intent.mjs";

const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const leaseId = "123e4567-e89b-42d3-a456-426614174002";
const capability = "private-capability";
const predecessorSha = "a".repeat(40);
const recoverySha = "b".repeat(40);
const imageDigest = `sha256:${"1".repeat(64)}`;
const workerImageDigest = `sha256:${"2".repeat(64)}`;
const target = Object.freeze({
  subscriptionId: "123e4567-e89b-42d3-a456-426614174000",
  resourceGroup: "rg.Safe_1",
  acrName: "acr12",
  acrServer: "acr12.azurecr.io",
  webAppName: "web-app",
  workerAppName: "worker-app",
});
const originatingLease = Object.freeze({ leaseId, fence: 7 });
const handle = Object.freeze({ deploymentId, leaseId, fence: 8, capability });
const release = Object.freeze({
  gitSha: recoverySha,
  imageTag: `sha-${recoverySha}`,
  version: "recovery-1",
});

function baselineTemplate(role = "web") {
  return {
    revisionSuffix: `${role}-base`,
    containers: [{
      name: `${role}-container`,
      image: `${target.acrServer}/corgtex/${role}@${role === "web" ? imageDigest : workerImageDigest}`,
      env: [
        { name: "CORGTEX_STARTUP_MODE", value: role },
        { name: "DATABASE_URL", secretRef: "database-url" },
        { name: "CORGTEX_RELEASE_GIT_SHA", value: predecessorSha },
        { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${predecessorSha}` },
        { name: "CORGTEX_RELEASE_VERSION", value: "release-base" },
      ],
      resources: { cpu: 1, memory: "2Gi" },
    }],
    scale: { minReplicas: 1, maxReplicas: 2 },
  };
}

function predecessor(role = "web") {
  const template = baselineTemplate(role);
  const appName = role === "web" ? target.webAppName : target.workerAppName;
  return {
    appName,
    location: "West US",
    role,
    revisionName: `${appName}--${template.revisionSuffix}`,
    revisionSuffix: template.revisionSuffix,
    containerName: `${role}-container`,
    image: template.containers[0].image,
    imageDigest: role === "web" ? imageDigest : workerImageDigest,
    template,
    templateDigest: managedAzureTemplateDigest(template),
  };
}

function planFor(role = "web") {
  const digest = role === "web" ? imageDigest : workerImageDigest;
  return buildManagedAzureRecoveryIntent({
    originatingLease,
    target,
    role,
    predecessor: predecessor(role),
    release,
    image: `${target.acrServer}/corgtex/${role}@${digest}`,
    imageDigest: digest,
  });
}

function convergedState(plan = planFor()) {
  return {
    ...predecessor(plan.intent.role),
    revisionName: `${plan.intent.appName}--${plan.intent.revisionSuffix}`,
    revisionSuffix: plan.intent.revisionSuffix,
    image: plan.template.containers[0].image,
    imageDigest: plan.intent.imageDigest,
    template: plan.template,
    templateDigest: plan.intent.templateDigest,
  };
}

function rig({ plan = planFor(), created = true, revisionKinds = ["READY"], appState = convergedState(plan), leaseImpl } = {}) {
  let now = 1_000;
  const calls = [];
  const deps = {
    lease: vi.fn(async (operation, args) => {
      calls.push(operation);
      if (leaseImpl) return leaseImpl(operation, args);
      if (operation === "record_recovery_intent") {
        return { deploymentId, leaseId, fence: 8, phase: "RECOVERY_REQUIRED", created, intent: plan.intent };
      }
      if (operation === "heartbeat_recovery") {
        return { deploymentId, leaseId, fence: 8, phase: "RECOVERY_REQUIRED" };
      }
      throw new Error(`unexpected lease operation: ${operation}`);
    }),
    patchTemplate: vi.fn(async () => ({ terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" })),
    readRevisionState: vi.fn(async () => ({ kind: revisionKinds.shift() ?? "READY" })),
    readApp: vi.fn(async () => appState),
    intentClock: vi.fn(() => now),
    intentSleep: vi.fn(async (ms) => { now += ms; }),
  };
  return { deps, calls, plan };
}

describe("managed Azure recovery intent", () => {
  it("builds a stable canonical intent vector and binds the worker root contract gitSha", () => {
    const { intent, template } = planFor("worker");

    expect(Object.keys(intent)).toStrictEqual([
      "protocolVersion",
      "purpose",
      "role",
      "originatingLeaseId",
      "originatingFence",
      "appName",
      "predecessorRevisionName",
      "predecessorTemplateDigest",
      "gitSha",
      "imageDigest",
      "templateBaseDigest",
      "revisionSuffix",
      "templateDigest",
      "intentDigest",
    ]);
    expect(intent).toMatchObject({
      protocolVersion: 1,
      purpose: "COMPATIBLE_RECOVERY_PATCH",
      role: "worker",
      originatingLeaseId: leaseId,
      originatingFence: 7,
      appName: target.workerAppName,
      gitSha: recoverySha,
      imageDigest: workerImageDigest,
    });
    expect(intent.revisionSuffix).toBe("ri-875c365fa30d94fa82daff737750c721");
    expect(intent.templateDigest).toBe("sha256:5e0d19c5d9a44d2b4d8021c70cc7ec4f8d9c9504627b6ba4b76ad4f49c33b2d9");
    expect(intent.intentDigest).toBe("sha256:12edcc9260d5d3aafea68bfa3604c7f66a130a1f0f70efe7b50f6c143ae9d73d");
    expect(template.revisionSuffix).toBe(intent.revisionSuffix);
    expect(managedAzureTemplateDigest(template)).toBe(intent.templateDigest);
    expect(template.containers[0].env.find((entry) => entry.name === "CORGTEX_RELEASE_GIT_SHA")?.value).toBe(recoverySha);
  });

  it("records the intent before PATCH, survives a pending ARM response, and waits for exact app convergence", async () => {
    const { deps, calls, plan } = rig({ revisionKinds: ["ABSENT", "PROVISIONING", "READY"] });
    deps.patchTemplate.mockImplementationOnce(async ({ onProgress }) => {
      expect(calls).toContain("record_recovery_intent");
      await onProgress();
      return {
        terminal: false,
        succeeded: false,
        code: "AZURE_OPERATION_LOCATION_INVALID",
        stage: "OPERATION_LOCATION",
        providerStatus: 202,
      };
    });

    await expect(runManagedAzureRecoveryIntent(deps, {
      handle,
      reason: "Recover compatible release.",
      target,
      release,
      intent: plan.intent,
      template: plan.template,
      location: "West US",
    })).resolves.toStrictEqual({ intent: plan.intent, state: convergedState(plan), patched: true });

    expect(calls[0]).toBe("record_recovery_intent");
    expect(deps.patchTemplate).toHaveBeenCalledTimes(1);
    expect(deps.patchTemplate.mock.calls[0][0]).toMatchObject({
      target,
      role: "web",
      location: "West US",
      template: plan.template,
    });
    expect(deps.readRevisionState.mock.calls.map(([args]) => args.revisionName)).toStrictEqual([
      `${target.webAppName}--${plan.intent.revisionSuffix}`,
      `${target.webAppName}--${plan.intent.revisionSuffix}`,
      `${target.webAppName}--${plan.intent.revisionSuffix}`,
    ]);
    expect(deps.readRevisionState.mock.calls.every(([args]) => args.expectedTemplate === plan.template)).toBe(true);
    expect(deps.readApp).toHaveBeenCalledWith(expect.objectContaining({
      target,
      role: "web",
      release,
      imageDigest,
      ambiguous: true,
    }));
    expect(deps.intentSleep).toHaveBeenCalledTimes(2);
  });

  it("treats a lost record response as uncertain and sends zero PATCHes", async () => {
    const { deps, plan } = rig({
      leaseImpl: async (operation) => {
        if (operation === "record_recovery_intent") throw new Error("control-plane timeout");
        return { deploymentId, leaseId, fence: 8, phase: "RECOVERY_REQUIRED" };
      },
    });

    await expect(runManagedAzureRecoveryIntent(deps, {
      handle,
      reason: "Recover compatible release.",
      target,
      release,
      intent: plan.intent,
      template: plan.template,
      location: "West US",
    })).rejects.toThrow("RECOVERY_INTENT_RECORDING_UNCERTAIN");
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.readRevisionState).not.toHaveBeenCalled();
  });

  it("skips PATCH for a created:false receipt or an existing READY intent", async () => {
    for (const mode of ["created-false", "existing"]) {
      const { deps, plan } = rig({ created: false });
      const result = await runManagedAzureRecoveryIntent(deps, {
        handle,
        reason: "Recover compatible release.",
        target,
        release,
        intent: plan.intent,
        template: plan.template,
        location: "West US",
        existing: mode === "existing",
      });

      expect(result).toStrictEqual({ intent: plan.intent, state: convergedState(plan), patched: false });
      expect(deps.patchTemplate).not.toHaveBeenCalled();
      expect(deps.readRevisionState).toHaveBeenCalledTimes(1);
      expect(deps.lease.mock.calls.some(([operation]) => operation === "record_recovery_intent")).toBe(mode === "created-false");
    }
  });

  it("blocks an existing intent whose revision is still absent", async () => {
    const { deps, plan } = rig({ revisionKinds: ["ABSENT"] });

    await expect(runManagedAzureRecoveryIntent(deps, {
      handle,
      reason: "Recover compatible release.",
      target,
      release,
      intent: plan.intent,
      template: plan.template,
      location: "West US",
      existing: true,
    })).rejects.toThrow("RECOVERY_INTENT_RECORDED_REVISION_ABSENT");
    expect(deps.patchTemplate).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "UNKNOWN"])("blocks a %s revision readback instead of continuing", async (kind) => {
    const { deps, plan } = rig({ revisionKinds: [kind] });

    await expect(runManagedAzureRecoveryIntent(deps, {
      handle,
      reason: "Recover compatible release.",
      target,
      release,
      intent: plan.intent,
      template: plan.template,
      location: "West US",
    })).rejects.toThrow("RECOVERY_INTENT_REVISION_NOT_READY");
    expect(deps.readApp).not.toHaveBeenCalled();
  });

  it("stops immediately when a heartbeat fails", async () => {
    const { deps, plan } = rig({
      leaseImpl: async (operation) => {
        if (operation === "record_recovery_intent") {
          return { deploymentId, leaseId, fence: 8, phase: "RECOVERY_REQUIRED", created: true, intent: planFor().intent };
        }
        throw new Error("heartbeat failed");
      },
    });

    await expect(runManagedAzureRecoveryIntent(deps, {
      handle,
      reason: "Recover compatible release.",
      target,
      release,
      intent: plan.intent,
      template: plan.template,
      location: "West US",
    })).rejects.toThrow("RECOVERY_INTENT_HEARTBEAT_FAILED");
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.readRevisionState).not.toHaveBeenCalled();
  });

  it("reconstructs plans only from the bound predecessor or exact candidate source", async () => {
    const plan = planFor();
    const sourceDeps = {
      readAppTemplate: vi.fn(async () => ({ state: predecessor() })),
    };
    await expect(readManagedAzureRecoveryIntentPlan(sourceDeps, {
      intent: plan.intent,
      originatingLease,
      target,
      release,
      image: `${target.acrServer}/corgtex/web@${imageDigest}`,
      releases: [{ release, imageDigest }],
    })).resolves.toStrictEqual(plan);

    const candidateState = convergedState(plan);
    const candidateDeps = {
      readAppTemplate: vi.fn(async () => ({ state: candidateState })),
    };
    await expect(readManagedAzureRecoveryIntentPlan(candidateDeps, {
      intent: plan.intent,
      originatingLease,
      target,
      release,
      image: `${target.acrServer}/corgtex/web@${imageDigest}`,
      releases: [{ release, imageDigest }],
    })).resolves.toStrictEqual({ intent: plan.intent, template: plan.template });

    await expect(readManagedAzureRecoveryIntentPlan(candidateDeps, {
      intent: { ...plan.intent, templateDigest: `sha256:${"9".repeat(64)}` },
      originatingLease,
      target,
      release,
      image: `${target.acrServer}/corgtex/web@${imageDigest}`,
      releases: [{ release, imageDigest }],
    })).rejects.toThrow("RECOVERY_INTENT_APP_DRIFT");
    await expect(readManagedAzureRecoveryIntentPlan(candidateDeps, {
      intent: plan.intent,
      originatingLease,
      target,
      release: { ...release, gitSha: predecessorSha, imageTag: `sha-${predecessorSha}` },
      image: `${target.acrServer}/corgtex/web@${imageDigest}`,
      releases: [{ release, imageDigest }],
    })).rejects.toThrow("RECOVERY_INTENT_BINDING_DRIFT");
  });

  it("accepts only a schema v2 one-per-role recovery intent journal", () => {
    const web = planFor("web").intent;
    const worker = planFor("worker").intent;

    expect(managedAzureRecoveryIntents({ recovery: { schemaVersion: 2, intents: [web, worker] } })).toStrictEqual([web, worker]);
    expect(managedAzureRecoveryIntents({ recovery: { schemaVersion: 2, intents: [] } })).toStrictEqual([]);
    expect(() => managedAzureRecoveryIntents({ recovery: { schemaVersion: 1, intents: [] } })).toThrow("RECOVERY_INTENT_JOURNAL_INVALID");
    expect(() => managedAzureRecoveryIntents({ recovery: { schemaVersion: 2, intents: [web, web] } })).toThrow("RECOVERY_INTENT_JOURNAL_INVALID");
    expect(() => managedAzureRecoveryIntents({ recovery: { schemaVersion: 2, intents: [web, worker, { ...web, role: "extra" }] } })).toThrow("RECOVERY_INTENT_JOURNAL_INVALID");
  });
});
