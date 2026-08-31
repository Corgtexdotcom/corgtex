import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ManagedAzureContainerAppError,
  assertManagedAzureTemplateDelta,
  buildManagedAzureReleaseTemplate,
  canonicalizeManagedAzureContainerAppState,
  createManagedAzureContainerAppTransport,
  managedAzureRevisionSuffix,
  managedAzureTemplateDigest,
} from "./managed-azure-container-app-transport.mjs";
import { managedAzureCliResultAccepted, managedAzureHealthReady, runManagedAzureReleaseTransaction, writeManagedAzureCliResult } from "./managed-azure-release-transaction.mjs";

const deploymentId = "123e4567-e89b-42d3-a456-426614174001";
const inventoryRef = "123e4567-e89b-42d3-a456-426614174002";
const leaseId = "123e4567-e89b-42d3-a456-426614174003";
const baseSha = "a".repeat(40); const nextSha = "b".repeat(40);
const inventoryBytesBase64 = "e30=";
const inventorySha256 = createHash("sha256").update(Buffer.from(inventoryBytesBase64, "base64")).digest("hex");
const input = Object.freeze({ inventoryRef, inventorySha256, deploymentId, releaseSha: nextSha, releaseVersion: "release-2", reason: "Approved exact target release.", execute: false, acrName: "acr12", acrResourceGroup: "rg-acr" });
const target = Object.freeze({ subscriptionId: "123e4567-e89b-42d3-a456-426614174000", resourceGroup: "rg.Safe_1", acrName: "acr12", acrServer: "acr12.azurecr.io", webAppName: "web-app", workerAppName: "worker-app" });
const digests = { web: `sha256:${"1".repeat(64)}`, worker: `sha256:${"2".repeat(64)}`, nextWeb: `sha256:${"3".repeat(64)}`, nextWorker: `sha256:${"4".repeat(64)}` };
const transportBaseRelease = Object.freeze({ gitSha: baseSha, imageTag: `sha-${baseSha}`, version: "release-1" });
const transportNextRelease = Object.freeze({ gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" });

function template(role, releaseSha, version, imageDigest, suffix) {
  return {
    revisionSuffix: suffix,
    containers: [{
      name: role,
      image: `${target.acrServer}/corgtex/${role}@${imageDigest}`,
      env: [
        { name: "PRIVATE_CONFIG", secretRef: "private-config" },
        { name: "CORGTEX_RELEASE_GIT_SHA", value: releaseSha },
        { name: "CORGTEX_RELEASE_IMAGE_TAG", value: `sha-${releaseSha}` },
        { name: "CORGTEX_RELEASE_VERSION", value: version },
      ],
      resources: { cpu: 1, memory: "2Gi" },
    }],
    scale: { minReplicas: 1, maxReplicas: 2 },
  };
}

function state(role, kind, expectedTemplate = null) {
  const baseDigest = role === "web" ? digests.web : digests.worker;
  const nextDigest = role === "web" ? digests.nextWeb : digests.nextWorker;
  const selected = expectedTemplate ?? (kind === "BASELINE"
    ? template(role, baseSha, "release-1", baseDigest, `base-${role}`)
    : template(role, nextSha, "release-2", nextDigest, `next-${role}`));
  const appName = role === "web" ? target.webAppName : target.workerAppName;
  return {
    appName,
    location: "West US",
    role,
    revisionName: `${appName}--${selected.revisionSuffix}`,
    revisionSuffix: selected.revisionSuffix,
    containerName: role,
    image: selected.containers[0].image,
    imageDigest: kind === "BASELINE" ? baseDigest : nextDigest,
    template: selected,
    templateDigest: managedAzureTemplateDigest(selected),
  };
}

function rawApp(role = "web", release = transportBaseRelease, digest = digests.web, suffix = "base") {
  const appName = role === "web" ? target.webAppName : target.workerAppName;
  return {
    id: `/subscriptions/private/resourceGroups/${target.resourceGroup}/providers/Microsoft.App/containerApps/${appName}`,
    location: "West US",
    properties: {
      provisioningState: "Succeeded",
      runningStatus: "Running",
      latestRevisionName: `${appName}--${suffix}`,
      latestReadyRevisionName: `${appName}--${suffix}`,
      configuration: { activeRevisionsMode: "Single", ingress: { external: false } },
      template: {
        revisionSuffix: suffix,
        terminationGracePeriodSeconds: 45,
        containers: [{
          name: role,
          image: `${target.acrServer}/corgtex/${role}@${digest}`,
          command: ["node"],
          args: [role === "web" ? "server.js" : "worker.js"],
          env: [
            { name: "DATABASE_URL", secretRef: "database-url" },
            { name: "CORGTEX_RELEASE_GIT_SHA", value: release.gitSha },
            { name: "CORGTEX_RELEASE_IMAGE_TAG", value: release.imageTag },
            { name: "CORGTEX_RELEASE_VERSION", value: release.version },
          ],
          resources: { cpu: 1, memory: "2Gi" },
          probes: [{ type: "Liveness", httpGet: { path: "/api/health", port: 3000 } }],
        }],
        scale: { minReplicas: 1, maxReplicas: 3, rules: [] },
        volumes: [{ name: "tmp", storageType: "EmptyDir" }],
      },
    },
  };
}

function transportResponse(status, body, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function dependencies(options = {}) {
  const events = [];
  const current = { web: "BASELINE", worker: "BASELINE" };
  const currentTemplates = { web: null, worker: null };
  let patchCount = 0;
  const deps = {
    owner: "github:42:1",
    templateDigest: managedAzureTemplateDigest,
    loadInventory: vi.fn(async () => ({ inventoryRef, sha256: input.inventorySha256, bytesBase64: inventoryBytesBase64, evaluation: { canonicalDigest: `sha256:${"d".repeat(64)}` } })),
    lease: vi.fn(async (operation, args) => {
      events.push(`lease:${operation}`);
      if (operation === "preflight") return { deploymentId, origin: "https://customer.example", release: { baselineImageTag: `sha-${baseSha}`, baselineVersion: "release-1" }, target };
      if (operation === "acquire") return { deploymentId, leaseId, capability: "private-capability", fence: 7 };
      if (operation === "get_target") return { deploymentId, target: options.leasedTarget ?? target, release: { baselineImageTag: `sha-${baseSha}` } };
      return { deploymentId, operation, args };
    }),
    resolveRelease: vi.fn(async () => ({ roles: {
      web: { role: "web", digest: digests.nextWeb, image: `${target.acrServer}/corgtex/web@${digests.nextWeb}`, destinationState: options.webDestination ?? "MATCH" },
      worker: { role: "worker", digest: digests.nextWorker, image: `${target.acrServer}/corgtex/worker@${digests.nextWorker}`, destinationState: options.workerDestination ?? "MATCH" },
    } })),
    importRole: vi.fn(async (role) => { events.push(`import:${role.role}`); return options.importResult ?? { terminal: true, succeeded: true, ambiguous: false, code: "IMPORT_VERIFIED" }; }),
    readApp: vi.fn(async ({ role, release }) => {
      events.push(`read:${role}:${release.imageTag === `sha-${baseSha}` ? "base" : "next"}`);
      if (current[role] === "UNKNOWN") throw new Error("private-provider-state");
      const wanted = release.imageTag === `sha-${baseSha}` ? "BASELINE" : "FORWARD";
      if (current[role] !== wanted) throw new Error("state-mismatch");
      return state(role, wanted, currentTemplates[role]);
    }),
    patchTemplate: vi.fn(async ({ role, template: candidate }) => {
      patchCount += 1;
      const releaseEntry = candidate.containers[0].env.find((entry) => entry.name === "CORGTEX_RELEASE_GIT_SHA");
      const phase = releaseEntry.value === nextSha ? "forward" : "rollback";
      events.push(`patch:${role}:${phase}`);
      const configured = options.patchResults?.[patchCount - 1];
      if (configured) {
        if (configured.state) current[role] = configured.state;
        return configured.result;
      }
      current[role] = phase === "forward" ? "FORWARD" : "BASELINE";
      currentTemplates[role] = candidate;
      return { terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" };
    }),
    waitForState: vi.fn(async ({ role, release, expectedTemplate }) => {
      events.push(`wait:${role}:${release.imageTag === `sha-${baseSha}` ? "base" : "next"}`);
      if (options.rollbackReadbackFails && release.imageTag === `sha-${baseSha}`) throw new Error("rollback readback failed");
      current[role] = release.imageTag === `sha-${baseSha}` ? "BASELINE" : "FORWARD";
      currentTemplates[role] = expectedTemplate;
      return state(role, current[role], expectedTemplate);
    }),
    healthProbe: vi.fn(async () => options.health ?? { ok: true }),
  };
  return { deps, events, current };
}

describe("managed Azure single-target transaction", () => {
  it("keeps dry-run read-only while proving inventory, target, images, and both baselines", async () => {
    const { deps, events } = dependencies({ webDestination: "ABSENT" });
    const result = await runManagedAzureReleaseTransaction(input, deps);
    expect(result).toMatchObject({ status: "DRY_RUN_READY", deploymentId, effects: 0, importsRequired: ["web"] });
    expect(events.filter((event) => event.startsWith("lease:"))).toEqual(["lease:preflight"]);
    expect(deps.importRole).not.toHaveBeenCalled(); expect(deps.patchTemplate).not.toHaveBeenCalled();
    expect(deps.healthProbe).toHaveBeenCalledTimes(1);
    expect(deps.resolveRelease).toHaveBeenCalledWith({ deploymentId, target: { ...target, acrResourceGroup: input.acrResourceGroup }, gitSha: input.releaseSha });
    expect(deps.readApp).toHaveBeenCalledWith(expect.objectContaining({ target }));
    expect(JSON.stringify(result)).not.toContain("private-capability"); expect(JSON.stringify(result)).not.toContain(target.resourceGroup);
  });

  it("imports before mutation, updates web then worker, proves readback, and finalizes success", async () => {
    const { deps, events } = dependencies({ webDestination: "ABSENT", workerDestination: "ABSENT" });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "SUCCEEDED", phase: "COMPLETE" });
    expect(events.indexOf("lease:acquire")).toBeLessThan(events.indexOf("import:web"));
    expect(events.indexOf("import:worker")).toBeLessThan(events.indexOf("lease:begin"));
    expect(events.indexOf("patch:web:forward")).toBeLessThan(events.indexOf("patch:worker:forward"));
    expect(events.filter((event) => event === "lease:heartbeat")).toHaveLength(9);
    expect(events.at(-1)).toBe("lease:finalize_success");
    const recorded = deps.lease.mock.calls.find(([operation]) => operation === "record_rollback")[1].rollback;
    expect(recorded.previous.web).toMatchObject({ image: `${target.acrServer}/corgtex/web@${digests.web}`, templateDigest: expect.stringMatching(/^sha256:/) });
    expect(JSON.stringify(recorded)).not.toContain("private-capability");
  });

  it("uses a fresh compensating revision after a classified worker failure", async () => {
    const { deps, events } = dependencies({
      patchResults: [
        null,
        { state: "BASELINE", result: { terminal: true, succeeded: false, code: "AZURE_PATCH_REJECTED", providerCode: "InvalidParameterValueInContainerTemplate" } },
      ],
    });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "ROLLED_BACK", phase: "WORKER", code: "AZURE_PATCH_REJECTED", providerCode: "InvalidParameterValueInContainerTemplate" });
    expect(events.filter((event) => event.startsWith("patch:"))).toEqual(["patch:web:forward", "patch:worker:forward", "patch:web:rollback"]);
    expect(events.at(-1)).toBe("lease:finalize_rollback");
  });

  it("retains recovery instead of compensating unknown provider state", async () => {
    const { deps } = dependencies({
      patchResults: [{ state: "UNKNOWN", result: { terminal: false, succeeded: false, code: "AZURE_OPERATION_TIMEOUT", providerCode: "OperationTimedOut" } }],
    });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_REQUIRED", phase: "WEB", code: "AZURE_OPERATION_TIMEOUT", providerCode: "OperationTimedOut" });
    expect(deps.lease).toHaveBeenCalledWith("mark_recovery", expect.objectContaining({ stage: "WEB", code: "AZURE_OPERATION_TIMEOUT" }));
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });

  it("retains recovery for a non-terminal patch even when the last read still shows baseline", async () => {
    const { deps } = dependencies({
      patchResults: [{ state: "BASELINE", result: { terminal: false, succeeded: false, code: "AZURE_OPERATION_TIMEOUT", providerCode: "OperationTimedOut" } }],
    });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_REQUIRED", phase: "WEB", code: "AZURE_OPERATION_TIMEOUT", providerCode: "OperationTimedOut" });
    expect(deps.lease).not.toHaveBeenCalledWith("finalize_rollback", expect.anything());
  });

  it("retains the forward provider diagnostic when rollback readback is ambiguous", async () => {
    const { deps } = dependencies({
      rollbackReadbackFails: true,
      patchResults: [null, { state: "BASELINE", result: { terminal: true, succeeded: false, code: "AZURE_PATCH_REJECTED", providerCode: "InvalidParameterValueInContainerTemplate" } }],
    });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "RECOVERY_REQUIRED", phase: "ROLLBACK", code: "ROLLBACK_READBACK_AMBIGUOUS", providerCode: "InvalidParameterValueInContainerTemplate" });
  });

  it("aborts a pre-mutation reservation when the leased target differs from preflight", async () => {
    const { deps } = dependencies({ leasedTarget: { ...target, workerAppName: "other-worker" } });
    await expect(runManagedAzureReleaseTransaction({ ...input, execute: true }, deps)).rejects.toThrow("MANAGED_RELEASE_LEASE_TARGET_DRIFT");
    expect(deps.lease).toHaveBeenCalledWith("abort", expect.anything());
    expect(deps.lease).not.toHaveBeenCalledWith("record_rollback", expect.anything());
  });

  it("aborts an unmutated lease on confirmed import rejection", async () => {
    const { deps } = dependencies({ webDestination: "ABSENT",
      importResult: { terminal: true, succeeded: false, ambiguous: false, code: "POST_REJECTED", providerStatus: 400, providerCode: "InvalidSourceRegistryCredentials" } });
    const result = await runManagedAzureReleaseTransaction({ ...input, execute: true }, deps);
    expect(result).toMatchObject({ status: "REJECTED", phase: "IMPORT", role: "web", code: "POST_REJECTED", providerStatus: 400, providerCode: "InvalidSourceRegistryCredentials" });
    expect(deps.lease).toHaveBeenCalledWith("abort", expect.anything());
    expect(deps.lease).not.toHaveBeenCalledWith("begin", expect.anything());
    expect(deps.patchTemplate).not.toHaveBeenCalled();
  });

  it("blocks malformed admission before dependency effects", async () => {
    const { deps } = dependencies();
    await expect(runManagedAzureReleaseTransaction({ ...input, inventorySha256: "latest" }, deps)).rejects.toThrow("MANAGED_RELEASE_INPUT_INVALID");
    expect(deps.loadInventory).not.toHaveBeenCalled(); expect(deps.lease).not.toHaveBeenCalled();
  });

  it("hashes the returned inventory bytes before any target read", async () => {
    const { deps } = dependencies();
    deps.loadInventory.mockResolvedValueOnce({ inventoryRef, sha256: input.inventorySha256, bytesBase64: "W10=", evaluation: { canonicalDigest: `sha256:${"d".repeat(64)}` } });
    await expect(runManagedAzureReleaseTransaction(input, deps)).rejects.toThrow("MANAGED_RELEASE_INVENTORY_INVALID");
    expect(deps.lease).not.toHaveBeenCalled();
  });

  it("requires a healthy baseline before dry-run readiness or lease acquisition", async () => {
    const { deps } = dependencies({ health: { ok: false, code: "HEALTH_SCHEMA_STALE" } });
    await expect(runManagedAzureReleaseTransaction(input, deps)).rejects.toThrow("MANAGED_RELEASE_BASELINE_HEALTH_FAILED");
    expect(deps.lease).toHaveBeenCalledTimes(1); expect(deps.lease).toHaveBeenCalledWith("preflight", expect.anything());
  });

  it("surfaces safe release-resolution stage failures before baseline reads", async () => {
    for (const [error, code] of [
      ["MANAGED_AZURE_SOURCE_MANIFEST_RESOLUTION_FAILED", "MANAGED_RELEASE_SOURCE_MANIFEST_FAILED"],
      ["MANAGED_AZURE_PROVIDER_OBSERVATION_FAILED", "MANAGED_RELEASE_PROVIDER_OBSERVATION_FAILED"],
      ["private dependency failure", "MANAGED_RELEASE_IMAGE_PREFLIGHT_FAILED"],
    ]) {
      const { deps } = dependencies();
      deps.resolveRelease.mockRejectedValueOnce(new Error(error));
      await expect(runManagedAzureReleaseTransaction(input, deps)).rejects.toThrow(code);
      expect(deps.readApp).not.toHaveBeenCalled();
      expect(deps.importRole).not.toHaveBeenCalled();
      expect(deps.patchTemplate).not.toHaveBeenCalled();
    }
  });

  it("surfaces safe baseline app read failures before dry-run readiness", async () => {
    const { deps } = dependencies();
    deps.readApp.mockRejectedValueOnce(new ManagedAzureContainerAppError("AZURE_READ_FAILED"));
    await expect(runManagedAzureReleaseTransaction(input, deps)).rejects.toThrow("MANAGED_RELEASE_BASELINE_WEB_AZURE_READ_FAILED");
    expect(deps.importRole).not.toHaveBeenCalled();
    expect(deps.patchTemplate).not.toHaveBeenCalled();
  });

  it("accepts health only with exact release, database, and schema proof", () => {
    const release = { gitSha: nextSha, imageTag: `sha-${nextSha}`, version: "release-2" };
    const healthy = { status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", release };
    expect(managedAzureHealthReady(healthy, release)).toBe(true);
    for (const changed of [{ database: "down" }, { schema: "stale" }, { release: { ...release, gitSha: baseSha } }]) {
      expect(managedAzureHealthReady({ ...healthy, ...changed }, release)).toBe(false);
    }
  });

  it("accepts only the expected terminal result for each CLI mode", () => {
    expect(managedAzureCliResultAccepted({ status: "DRY_RUN_READY" }, false)).toBe(true);
    expect(managedAzureCliResultAccepted({ status: "SUCCEEDED" }, true)).toBe(true);
    for (const result of [{ status: "ROLLED_BACK" }, { status: "RECOVERY_REQUIRED" }, { status: "DRY_RUN_READY" }]) {
      expect(managedAzureCliResultAccepted(result, true)).toBe(false);
    }
    expect(managedAzureCliResultAccepted({ status: "SUCCEEDED" }, false)).toBe(false);
  });

  it("writes the result and returns a failing exit code for rejected execute outcomes", () => {
    const output = { stdout: "", stderr: "", writers: { stdout: { write: (value) => { output.stdout += value; } }, stderr: { write: (value) => { output.stderr += value; } } } };
    expect(writeManagedAzureCliResult({ status: "ROLLED_BACK", code: "AZURE_PATCH_REJECTED" }, true, output.writers)).toBe(1);
    expect(output.stdout).toContain('"status":"ROLLED_BACK"'); expect(output.stderr).toBe("ROLLED_BACK:AZURE_PATCH_REJECTED\n");
    output.stdout = ""; output.stderr = "";
    expect(writeManagedAzureCliResult({ status: "REJECTED", code: "POST_REJECTED", providerCode: "InvalidSourceRegistryCredentials" }, true, output.writers)).toBe(1);
    expect(output.stdout).toContain('"providerCode":"InvalidSourceRegistryCredentials"'); expect(output.stderr).toBe("REJECTED:POST_REJECTED\n");
    expect(writeManagedAzureCliResult({ status: "DRY_RUN_READY" }, false, output.writers)).toBe(0);
  });

  it("keeps the workflow manual, exact-targeted, and false by default", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("--inventory-ref");
    expect(workflow).toContain("--deployment-id");
    expect(workflow).not.toContain("repository_dispatch:");
    expect(workflow).not.toMatch(/schedule:|targets:|matrix:/);
  });
});

describe("managed Azure Container Apps transport", () => {
  it("captures a complete Single-mode baseline and rejects stale or non-ready state", () => {
    const raw = rawApp();
    const baseline = canonicalizeManagedAzureContainerAppState(raw, { target, role: "web", imageDigest: digests.web, release: transportBaseRelease });
    expect(baseline).toMatchObject({ appName: "web-app", revisionName: "web-app--base", containerName: "web", image: `${target.acrServer}/corgtex/web@${digests.web}` });
    expect(baseline.templateDigest).toBe(managedAzureTemplateDigest(raw.properties.template));

    const multiple = rawApp(); multiple.properties.configuration.activeRevisionsMode = "Multiple";
    expect(() => canonicalizeManagedAzureContainerAppState(multiple, { target, role: "web", imageDigest: digests.web, release: transportBaseRelease })).toThrow("AZURE_BASELINE_NOT_READY");
    const pending = rawApp(); pending.properties.latestReadyRevisionName = "web-app--older";
    expect(() => canonicalizeManagedAzureContainerAppState(pending, { target, role: "web", imageDigest: digests.web, release: transportBaseRelease })).toThrow("AZURE_BASELINE_NOT_READY");
    expect(() => canonicalizeManagedAzureContainerAppState(raw, { target, role: "web", imageDigest: digests.worker, release: transportBaseRelease })).toThrow("AZURE_IMAGE_MISMATCH");
    expect(() => canonicalizeManagedAzureContainerAppState(raw, { target, role: "web", imageDigest: digests.web, release: transportNextRelease })).toThrow("AZURE_RELEASE_IDENTITY_MISMATCH");
  });

  it("changes only the revision suffix, target image, and release identity", () => {
    const baseline = canonicalizeManagedAzureContainerAppState(rawApp(), { target, role: "web", imageDigest: digests.web, release: transportBaseRelease });
    const revisionSuffix = managedAzureRevisionSuffix({ leaseId, fence: 7, role: "web", phase: "forward" });
    const image = `${target.acrServer}/corgtex/web@${digests.nextWeb}`;
    const candidate = buildManagedAzureReleaseTemplate({ baseline, role: "web", image, release: transportNextRelease, revisionSuffix });
    expect(candidate).not.toBe(baseline.template);
    expect(candidate.containers[0]).toMatchObject({ image, command: ["node"], args: ["server.js"], resources: { cpu: 1, memory: "2Gi" } });
    expect(candidate.scale).toEqual(baseline.template.scale); expect(candidate.volumes).toEqual(baseline.template.volumes);
    expect(assertManagedAzureTemplateDelta(baseline, candidate, { role: "web", image, release: transportNextRelease, revisionSuffix })).toBe(true);
    const drifted = structuredClone(candidate); drifted.scale.maxReplicas = 4;
    expect(() => assertManagedAzureTemplateDelta(baseline, drifted, { role: "web", image, release: transportNextRelease, revisionSuffix })).toThrow("AZURE_TEMPLATE_DRIFT");
    expect(baseline.template.revisionSuffix).toBe("base"); expect(baseline.template.containers[0].image).toContain(digests.web);
  });

  it("derives distinct deterministic forward and compensation revisions", () => {
    const suffixInput = { leaseId, fence: 9, role: "worker" };
    const forward = managedAzureRevisionSuffix({ ...suffixInput, phase: "forward" });
    const rollback = managedAzureRevisionSuffix({ ...suffixInput, phase: "rollback" });
    expect(forward).not.toBe(rollback); expect(forward).toMatch(/^[a-z0-9-]+$/); expect(rollback).toHaveLength(forward.length);
  });

  it("sends one exact JSON PATCH and waits for an asynchronous terminal Location operation", async () => {
    let now = 1_000;
    const baseline = canonicalizeManagedAzureContainerAppState(rawApp(), { target, role: "web", imageDigest: digests.web, release: transportBaseRelease });
    const revisionSuffix = managedAzureRevisionSuffix({ leaseId, fence: 1, role: "web", phase: "forward" });
    const image = `${target.acrServer}/corgtex/web@${digests.nextWeb}`;
    const candidate = buildManagedAzureReleaseTemplate({ baseline, role: "web", image, release: transportNextRelease, revisionSuffix });
    const location = `https://management.azure.com/subscriptions/${target.subscriptionId}/providers/Microsoft.App/locations/westus/operationStatuses/op-1?monitor=true&api-version=2025-01-01`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(transportResponse(202, null, { location, "retry-after": "0" }))
      .mockResolvedValueOnce(transportResponse(202, { status: "InProgress" }, { "retry-after": "2" }))
      .mockResolvedValueOnce(transportResponse(200, { status: "Succeeded" }));
    const sleep = vi.fn(async () => { now += 1_000; });
    const onProgress = vi.fn(async () => undefined);
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: vi.fn().mockResolvedValue("token-value-with-enough-length"), sleep, clock: () => now });
    await expect(transport.patchTemplate({ target, role: "web", location: "West US", template: candidate, onProgress })).resolves.toEqual({ terminal: true, succeeded: true, code: "AZURE_PATCH_SUCCEEDED" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/rg.Safe_1/providers/Microsoft.App/containerApps/web-app?api-version=2025-01-01`);
    expect(init).toMatchObject({ method: "PATCH", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer token-value-with-enough-length", "content-type": "application/json" }) });
    expect(JSON.parse(init.body)).toEqual({ location: "West US", properties: { template: candidate } });
    expect(fetchImpl.mock.calls.slice(1).every(([pollUrl, pollInit]) => pollUrl === location && pollInit.method === "GET")).toBe(true);
    expect(sleep).toHaveBeenNthCalledWith(1, 0); expect(sleep).toHaveBeenNthCalledWith(2, 2_000); expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe asynchronous operation locations before polling", async () => {
    const candidate = rawApp().properties.template;
    const operationPath = `/subscriptions/${target.subscriptionId}/providers/Microsoft.App/locations/westus/operationStatuses/op-1`;
    const unsafeLocations = [
      `https://example.com${operationPath}?api-version=2025-01-01`,
      `https://user@management.azure.com${operationPath}?api-version=2025-01-01`,
      `https://management.azure.com${operationPath}?api-version=2025-01-01#fragment`,
      `https://management.azure.com/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.App/locations/westus/operationStatuses/op-1?api-version=2025-01-01`,
      `https://management.azure.com/subscriptions/${target.subscriptionId}/providers/Microsoft.App/locations/westus/private/op-1?api-version=2025-01-01`,
      `https://management.azure.com${operationPath}?api-version=2025-01-01&monitor=false`,
      `https://management.azure.com${operationPath}?api-version=2025-01-01&api-version=2025-01-01`,
      `https://management.azure.com/subscriptions/${target.subscriptionId}/resourceGroups/other-rg/providers/Microsoft.App/locations/westus/operationStatuses/op-1?api-version=2025-01-01`,
    ];
    for (const location of unsafeLocations) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(transportResponse(202, null, { location, "retry-after": "0" }));
      const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: vi.fn().mockResolvedValue("token-value-with-enough-length") });
      await expect(transport.patchTemplate({ target, role: "web", location: "West US", template: candidate })).resolves.toEqual({ terminal: false, succeeded: false, code: "AZURE_OPERATION_LOCATION_INVALID" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("classifies confirmed rejection separately from operation ambiguity", async () => {
    const candidate = rawApp().properties.template;
    const rejected = createManagedAzureContainerAppTransport({ fetchImpl: vi.fn().mockResolvedValue(transportResponse(412, { error: { code: "BadRequest", details: [{ code: "InvalidParameterValueInContainerTemplate", message: "private-provider-message" }] } })), getAccessToken: async () => "token-value-with-enough-length" });
    await expect(rejected.patchTemplate({ target, role: "web", location: "West US", template: candidate })).resolves.toEqual({ terminal: true, succeeded: false, code: "AZURE_PATCH_REJECTED", providerCode: "InvalidParameterValueInContainerTemplate" });
    const rejectedResult = await rejected.patchTemplate({ target, role: "web", location: "West US", template: candidate });
    expect(JSON.stringify(rejectedResult)).not.toContain("private-provider-message");
    const ambiguous = createManagedAzureContainerAppTransport({ fetchImpl: vi.fn().mockRejectedValue(new Error("private-provider-error")), getAccessToken: async () => "token-value-with-enough-length" });
    await expect(ambiguous.patchTemplate({ target, role: "web", location: "West US", template: candidate })).resolves.toEqual({ terminal: false, succeeded: false, code: "AZURE_PATCH_AMBIGUOUS" });
  });

  it("reads back only the expected ready revision and complete template", async () => {
    let now = 1_000;
    const raw = rawApp("web", transportNextRelease, digests.nextWeb, "next");
    const fetchImpl = vi.fn().mockResolvedValue(transportResponse(200, raw));
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "token-value-with-enough-length", sleep: async () => { now += 1_000; }, clock: () => now });
    const readback = await transport.waitForState({ target, role: "web", imageDigest: digests.nextWeb, release: transportNextRelease, expectedTemplate: raw.properties.template });
    expect(readback.revisionName).toBe("web-app--next"); expect(readback.templateDigest).toBe(managedAzureTemplateDigest(raw.properties.template));
  });

  it("uses bounded non-disclosing errors", () => {
    const polluted = rawApp(); polluted.properties.template.constructor = { secret: "private-value" };
    let error;
    try { canonicalizeManagedAzureContainerAppState(polluted, { target, role: "web", imageDigest: digests.web, release: transportBaseRelease }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ManagedAzureContainerAppError); expect(JSON.stringify(error)).not.toContain("private-value");
  });
});
