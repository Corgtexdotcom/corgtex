import { describe, expect, it, vi } from "vitest";
import { createManagedAzureExclusiveActivation, snapshotManagedAzureExclusiveActivation } from "./managed-azure-exclusive-activation.mjs";
import { createManagedAzureContainerAppTransport, managedAzureConfigurationDigest } from "./managed-azure-container-app-transport.mjs";
import { managedAzureFailureDetail } from "./managed-azure-release-transaction.mjs";

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
  it.each([
    ["revision-http", "AZURE_EXCLUSIVE_REVISION_LIST_HTTP_429"],
    ["replica-http", "AZURE_EXCLUSIVE_REPLICA_LIST_HTTP_503"],
    ["revision-shape", "AZURE_EXCLUSIVE_REVISION_LIST_INVALID"],
    ["replica-shape", "AZURE_EXCLUSIVE_REPLICA_LIST_INVALID"],
    ["active-missing", "AZURE_EXCLUSIVE_REVISION_METADATA_INVALID"],
  ])("retains the precise %s failure without exposing response content or treating it as an empty inventory", async (failure, code) => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/replicas?")) {
        if (failure === "replica-http") return Response.json({ message: "private provider content" }, { status: 503 });
        return Response.json({ value: failure === "replica-shape" ? null : [] });
      }
      if (url.includes("/revisions?")) {
        if (failure === "revision-http") return Response.json({ message: "private provider content" }, { status: 429 });
        return Response.json({ value: failure === "revision-shape" ? null : [{ name: baseline.web,
          properties: failure === "active-missing" ? {} : { active: false } }] });
      }
      return Response.json({ location: "West US 3", properties: { configuration } });
    });
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    const error = await transport.readExclusiveState({ target, role: "web" }).catch((caught) => caught);
    expect(error).toMatchObject({ code, ambiguous: true });
    expect(managedAzureFailureDetail(error)).toEqual({ failureClass: "AZURE_TRANSPORT", failureCode: code });
    expect(JSON.stringify(managedAzureFailureDetail(error))).not.toContain("private");
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
  it.each(["revision", "replicas", "replica-shape"])("distinguishes %s failure during exact candidate readback", async (failure) => {
    const expectedTemplate = { revisionSuffix: "old", containers: [{ name: "web", image: "synthetic" }] };
    const fetchImpl = vi.fn(async (url) => {
      if (failure === "revision" || (url.includes("/replicas?") && failure === "replicas")) {
        return Response.json({ message: "private provider content" }, { status: 503 });
      }
      if (url.includes("/replicas?")) return Response.json({ value: null });
      return Response.json({ name: baseline.web, properties: { template: expectedTemplate } });
    });
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    const code = failure === "revision" ? "AZURE_REVISION_HTTP_503"
      : failure === "replicas" ? "AZURE_REVISION_REPLICAS_HTTP_503" : "AZURE_REVISION_REPLICA_INVENTORY_INVALID";
    await expect(transport.readRevisionState({ target, role: "web", revisionName: baseline.web, expectedTemplate })).rejects.toMatchObject({ code, ambiguous: true });
    expect(fetchImpl.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  });
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

describe("bounded GET transport recovery", () => {
  const input = { target, role: "web", revisionName: baseline.web };
  it("retries a rejected GET with one token and reconciles its actual HTTP response", async () => {
    const token = vi.fn(async () => "synthetic");
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const sleep = vi.fn(async () => {});
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: token, sleep });
    await expect(transport.readRevisionState(input)).resolves.toEqual({ kind: "ABSENT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(token).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });
  it("stops after three transport failures and emits only safe attempt diagnostics", async () => {
    const token = vi.fn(async () => "synthetic");
    const fetchImpl = vi.fn(async () => { throw new Error("private credential URL"); });
    const sleep = vi.fn(async () => {});
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: token, sleep });
    const error = await transport.readRevisionState(input).catch((caught) => caught);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(token).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 750]);
    expect(managedAzureFailureDetail(error)).toEqual({ failureClass: "AZURE_TRANSPORT", failureCode: "AZURE_REQUEST_AMBIGUOUS",
      requestStage: "FETCH", requestAttempts: 3, requestDeadlineExceeded: false });
  });
  it("shares one twenty-second deadline across token acquisition and every GET attempt", async () => {
    vi.useFakeTimers();
    try {
      const token = vi.fn(() => new Promise((resolve) => setTimeout(() => resolve("synthetic"), 5000)));
      const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
        if (fetchImpl.mock.calls.length === 1) setTimeout(() => reject(new Error("transient")), 10000);
        signal.addEventListener("abort", () => reject(new Error("private timeout detail")), { once: true });
      }));
      const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: token });
      const pending = transport.readRevisionState(input).catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(20000);
      const error = await pending;
      expect(error).toMatchObject({ requestStage: "FETCH", requestAttempts: 2, requestDeadlineExceeded: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(token).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("does not retry token acquisition or issue a request after it fails", async () => {
    const token = vi.fn(async () => { throw new Error("private token detail"); });
    const fetchImpl = vi.fn();
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: token });
    await expect(transport.readRevisionState(input)).rejects.toMatchObject({ code: "AZURE_ACCESS_TOKEN_UNAVAILABLE",
      requestStage: "ACCESS_TOKEN", requestAttempts: 0, requestDeadlineExceeded: false });
    expect(token).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500])("does not retry an HTTP %i response", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "private response" }, { status }));
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    await expect(transport.readRevisionState(input)).rejects.toMatchObject({ code: `AZURE_REVISION_HTTP_${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["malformed", "identity"])("does not retry %s response validation", async (condition) => {
    const fetchImpl = vi.fn(async () => condition === "malformed" ? new Response("{") : Response.json({ name: "wrong-app--old" }));
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    await expect(transport.readRevisionState(input)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never retries a rejected PATCH", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("lost response"); });
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    await expect(transport.patchTemplate({ target, role: "web", location: "West US 3", template: {} })).resolves.toMatchObject({ terminal: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("reconciles a rejected activation POST without repeating it", async () => {
    let posted = false;
    const fetchImpl = vi.fn(async (url, init) => {
      if (init.method === "POST") { posted = true; throw new Error("lost response"); }
      return url.includes("/replicas?") ? Response.json({ value: [] }) : Response.json({ properties: { active: posted } });
    });
    const transport = createManagedAzureContainerAppTransport({ fetchImpl, getAccessToken: async () => "synthetic" });
    await expect(transport.setRevisionActive({ ...input, active: true })).resolves.toMatchObject({ terminal: true, succeeded: true });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  });
});
