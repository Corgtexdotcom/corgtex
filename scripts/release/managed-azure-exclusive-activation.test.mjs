import { describe, expect, it, vi } from "vitest";
import { createManagedAzureExclusiveActivation, snapshotManagedAzureExclusiveActivation } from "./managed-azure-exclusive-activation.mjs";
import { createManagedAzureContainerAppTransport, managedAzureConfigurationDigest } from "./managed-azure-container-app-transport.mjs";

const target = { subscriptionId: "123e4567-e89b-42d3-a456-426614174000", resourceGroup: "rg-test",
  acrName: "acrtest", acrServer: "acrtest.azurecr.io", webAppName: "web-app", workerAppName: "worker-app" };
const configuration = { activeRevisionsMode: "Single", ingress: { external: true, targetPort: 3000,
  traffic: [{ latestRevision: true, weight: 100 }] }, secrets: [{ name: "database-url", keyVaultUrl: "https://synthetic.vault.azure.net/secrets/database-url" }] };
const digest = managedAzureConfigurationDigest(configuration);
const ownership = { originalMode: "Single", temporaryMode: "Multiple", configurationDigests: { web: digest, worker: digest } };
const baseline = { web: "web-app--old", worker: "worker-app--old" };
const successor = { web: "web-app--next", worker: "worker-app--next" };

function fixture() {
  const events = [];
  const states = Object.fromEntries(["web", "worker"].map((role) => [role, { mode: "Single", configurationDigest: digest,
    provisioningState: "Succeeded", latestRevisionName: baseline[role], latestReadyRevisionName: baseline[role],
    revisions: [{ revisionName: baseline[role], active: true, replicaCount: 1 }] }]));
  const deps = {
    readExclusiveState: vi.fn(async ({ role }) => structuredClone(states[role])),
    setRevisionMode: vi.fn(async ({ role, mode }) => { events.push(`mode:${role}:${mode}`); states[role].mode = mode; }),
    setRevisionActive: vi.fn(async ({ role, revisionName, active }) => {
      events.push(`active:${role}:${active}`);
      Object.assign(states[role].revisions.find((revision) => revision.revisionName === revisionName), { active, replicaCount: active ? 1 : 0 });
      return { terminal: true, succeeded: true, replicaCount: active ? 1 : 0 };
    }),
    patchTemplate: vi.fn(async ({ role, template }) => {
      const state = states[role];
      // Captured production behavior: Single mode reactivated the deactivated
      // predecessor while the new revision started. It claimed the diagnostic.
      if (state.mode === "Single") for (const revision of state.revisions) Object.assign(revision, { active: true, replicaCount: 1 });
      const predecessorRunning = state.revisions.some((revision) => revision.replicaCount > 0);
      events.push({ startup: role, predecessorRunning, otherRoleRunning: states[role === "web" ? "worker" : "web"].revisions.some((revision) => revision.replicaCount > 0) });
      const revisionName = `${role}-app--${template.revisionSuffix}`;
      state.revisions.push({ revisionName, active: true, replicaCount: 1 });
      state.latestRevisionName = revisionName;
      state.latestReadyRevisionName = revisionName;
      return { terminal: true, succeeded: true };
    }),
    readApp: vi.fn(), readAppTemplate: vi.fn(), waitForState: vi.fn(),
  };
  const context = () => createManagedAzureExclusiveActivation(deps, { target, ownership,
    knownRevisions: { web: [baseline.web, successor.web], worker: [baseline.worker, successor.worker] }, onProgress: async () => events.push("heartbeat") });
  return { states, events, deps, context };
}

describe("owned exclusive Azure startup interval", () => {
  it("reproduces the observed Single-mode restart despite an earlier zero-replica drain", async () => {
    const { deps, events } = fixture();
    await deps.setRevisionActive({ role: "worker", revisionName: baseline.worker, active: false });
    await deps.patchTemplate({ role: "worker", template: { revisionSuffix: "next" } });
    expect(events.find((event) => event.startup === "worker").predecessorRunning).toBe(true);
  });
  it("keeps both predecessors stopped through web migration and worker startup, then restores Single", async () => {
    const { deps, states, events, context } = fixture();
    expect(await snapshotManagedAzureExclusiveActivation(deps, target, { web: { revisionName: baseline.web }, worker: { revisionName: baseline.worker } })).toEqual(ownership);
    const release = context();
    await release.enter();
    await release.deps.patchTemplate({ role: "web", template: { revisionSuffix: "next" } });
    await release.deps.patchTemplate({ role: "worker", template: { revisionSuffix: "next" } });
    expect(events.filter((event) => event.startup)).toEqual([
      { startup: "web", predecessorRunning: false, otherRoleRunning: false },
      { startup: "worker", predecessorRunning: false, otherRoleRunning: true },
    ]);
    expect(await release.finish(successor)).toMatchObject({ mode: "Single", predecessorsStopped: true });
    expect(states.web.configurationDigest).toBe(digest);
    expect(states.worker.mode).toBe("Single");
    expect(events.indexOf("mode:worker:Multiple")).toBeLessThan(events.indexOf("active:worker:false"));
  });
  it("does not accept an inactive predecessor with remaining replicas", async () => {
    const { states, deps, context } = fixture();
    deps.setRevisionActive.mockImplementation(async ({ role }) => {
      states[role].revisions[0].active = false;
      return { terminal: true, succeeded: true, replicaCount: 1 };
    });
    await expect(context().enter()).rejects.toThrow("AZURE_EXCLUSIVE_DRAIN_AMBIGUOUS");
    expect(deps.patchTemplate).not.toHaveBeenCalled();
  });
  it("retains uncertainty after a partial mode change and can reconcile the same owned interval", async () => {
    const { deps, states, context } = fixture();
    const change = deps.setRevisionMode.getMockImplementation();
    deps.setRevisionMode.mockImplementationOnce(change).mockRejectedValueOnce(new Error("lost reply"));
    await expect(context().enter()).rejects.toThrow("lost reply");
    expect(states.web.mode).toBe("Multiple");
    expect(deps.patchTemplate).not.toHaveBeenCalled();
    const resumed = context();
    await resumed.enter();
    await resumed.deps.patchTemplate({ role: "web", template: { revisionSuffix: "next" } });
    expect(states.worker.revisions[0].replicaCount).toBe(0);
  });
  it("rejects an unexpected active revision or configuration drift without a drain or patch", async () => {
    for (const drift of ["revision", "configuration"]) {
      const { states, deps, context } = fixture();
      if (drift === "revision") states.web.revisions.push({ revisionName: "web-app--unowned", active: true, replicaCount: 1 });
      else states.web.configurationDigest = `sha256:${"0".repeat(64)}`;
      await expect(context().enter()).rejects.toThrow(drift === "revision" ? "AZURE_EXCLUSIVE_REVISION_UNOWNED" : "AZURE_EXCLUSIVE_CONFIGURATION_DRIFT");
      expect(deps.setRevisionActive).not.toHaveBeenCalled();
      expect(deps.patchTemplate).not.toHaveBeenCalled();
    }
  });
  it("will not restore Single before the exact selected pair is ready and predecessors stopped", async () => {
    const { states, deps, context } = fixture(); const release = context();
    await release.enter();
    await release.deps.patchTemplate({ role: "web", template: { revisionSuffix: "next" } });
    await expect(release.finish(successor)).rejects.toThrow("AZURE_EXCLUSIVE_RESTORE_UNPROVEN");
    expect(deps.setRevisionMode.mock.calls.every(([request]) => request.mode === "Multiple")).toBe(true);
    states.worker.latestRevisionName = successor.worker;
    states.worker.latestReadyRevisionName = successor.worker;
    states.worker.revisions.push({ revisionName: successor.worker, active: true, replicaCount: 1 });
    states.web.revisions[0].replicaCount = 1;
    await expect(release.finish(successor)).rejects.toThrow("AZURE_EXCLUSIVE_RESTORE_UNPROVEN");
  });
});

describe("configuration-only revision mode transport", () => {
  it("reconciles a lost PATCH response through unchanged configuration and exact mode reads", async () => {
    let mode = "Single";
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === "PATCH") {
        expect(JSON.parse(init.body)).toEqual({ location: "West US 3", properties: { configuration: { activeRevisionsMode: "Multiple" } } });
        mode = "Multiple";
        throw new Error("response lost");
      }
      if (url.includes("/replicas?")) return Response.json({ value: [] });
      if (url.includes("/revisions?")) return Response.json({ value: [{ name: baseline.web, properties: { active: false } }] });
      return Response.json({ location: "West US 3", properties: { provisioningState: "Succeeded", configuration: { ...configuration, activeRevisionsMode: mode } } });
    });
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    const result = await transport.setRevisionMode({ target, role: "web", mode: "Multiple", exclusiveActivation: ownership });
    expect(result.mode).toBe("Multiple");
    expect(result.configurationDigest).toBe(digest);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
  });
});
