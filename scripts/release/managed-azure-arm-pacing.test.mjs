import { describe, expect, it } from "vitest";
import { createManagedAzurePacedContainerAppTransport } from "./managed-azure-arm-pacing.mjs";
const target = { subscriptionId: "123e4567-e89b-42d3-a456-426614174000", resourceGroup: "rg.Safe_1",
  acrName: "acr12", acrServer: "acr12.azurecr.io", webAppName: "web-app", workerAppName: "worker-app" };
const templates = { web: { revisionSuffix: "web-base", containers: [{ name: "web", image: "fixture", env: [] }] } };

describe("managed release ARM method-boundary pacing", () => {
  function pacedFixture({ count = 101, failFetch = false, onSleep } = {}) {
    let now = 0, failReads = failFetch, ownerLost = false;
    const calls = [], sleeps = [], heartbeats = [];
    const controller = new AbortController();
    const native = createManagedAzurePacedContainerAppTransport({ clock: () => now, getAccessToken: async () => "fixture",
      onProgress: async () => { heartbeats.push(now); if (ownerLost) throw Error("OWNER_LOST"); },
      sleep: async (ms, signal) => { if (signal?.aborted) throw Error("ABORTED"); sleeps.push(ms); now += ms; await onSleep?.(controller); },
      fetchImpl: async (url, init) => {
        calls.push({ url, at: now, method: init.method });
        if (failReads) throw Error("NETWORK");
        const u = new URL(url), appName = u.pathname.split("/containerApps/")[1].split("/")[0];
        if (u.pathname.endsWith("/replicas")) return Response.json({ value: [] });
        if (u.pathname.endsWith("/revisions")) {
          const offset = Number(u.searchParams.get("skipToken") ?? 0), next = new URL(u);
          next.searchParams.set("pageSize", "20"); next.searchParams.set("skipToken", String(offset + 20));
          return Response.json({ value: Array.from({ length: Math.min(20, count - offset) }, (_, i) =>
            ({ name: `${appName}--old${offset + i}`, properties: { active: false } })),
            ...(offset + 20 < count ? { nextLink: next.href } : {}) });
        }
        return Response.json({ location: "West US 3", properties: { provisioningState: "Succeeded",
          latestRevisionName: `${appName}--old0`, latestReadyRevisionName: `${appName}--old0`,
          configuration: { activeRevisionsMode: "Single", ingress: { traffic: [{ latestRevision: true, weight: 100 }] } } } });
      } });
    return { native, calls, sleeps, heartbeats, controller, input: { target, role: "web", signal: controller.signal },
      get now() { return now; }, resetFailure() { failReads = false; }, loseOwner() { ownerLost = true; } };
  }
  it.each([101, 256])("retains all %i revisions within the native census deadline and repays reads before the next fresh census", async count => {
    const f = pacedFixture({ count });
    const first = await f.native.readExclusiveState(f.input), returned = f.now, reads = f.calls.length;
    expect(first.revisions).toHaveLength(count);
    expect(returned).toBeLessThan(180_000);
    expect(returned).toBe(f.calls.at(-1).at); // no debt sleep after obtaining evidence
    const before = f.heartbeats.length;
    await f.native.readExclusiveState({ ...f.input, role: "worker" });
    expect(f.calls[reads].at).toBeGreaterThanOrEqual(reads * 1_250);
    expect(f.calls[reads].url).toContain("/worker-app?");
    expect(f.sleeps.every(ms => ms <= 15_000)).toBe(true);
    expect(f.heartbeats.length).toBeGreaterThan(before + 1);
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
  });
  it("serializes concurrent methods and counts failed native GET attempts without replaying methods", async () => {
    const f = pacedFixture({ count: 1, failFetch: true });
    await expect(f.native.readExclusiveState(f.input)).rejects.toThrow("AZURE_REQUEST_AMBIGUOUS");
    expect(f.calls).toHaveLength(3);
    f.resetFailure();
    const offset = f.calls.length;
    await Promise.all([f.native.readExclusiveState(f.input), f.native.readExclusiveState({ ...f.input, role: "worker" })]);
    expect(f.calls[offset].at).toBeGreaterThanOrEqual(3 * 1_250);
    expect(f.calls.slice(offset).map(call => call.url.includes("/worker-app") ? "worker" : "web"))
      .toEqual(["web", "web", "web", "worker", "worker", "worker"]);
  });
  it.each(["abort", "owner"])("blocks the next provider method after %s during debt repayment", async mode => {
    let f;
    f = pacedFixture({ count: 1, onSleep: controller => {
      if (f.calls.length === 3) { if (mode === "abort") controller.abort(); else f.loseOwner(); }
    } });
    await f.native.readExclusiveState(f.input);
    await expect(f.native.readExclusiveState({ ...f.input, role: "worker" })).rejects.toThrow(mode === "abort" ? "AZURE_ARM_PACING_ABORTED" : "OWNER_LOST");
    expect(f.calls).toHaveLength(3);
  });
  it("does not retry an uncertain mutation or charge it as an ARM GET", async () => {
    let now = 0; const methods = [], sleeps = [];
    const native = createManagedAzurePacedContainerAppTransport({ clock: () => now, getAccessToken: async () => "fixture",
      sleep: async ms => { sleeps.push(ms); now += ms; }, onProgress: async () => {},
      fetchImpl: async (_url, init) => { methods.push(init.method); throw Error("reply lost"); } });
    const result = await native.patchTemplate({ target, role: "web", location: "West US 3", template: templates.web });
    expect(result).toMatchObject({ terminal: false, succeeded: false, code: "AZURE_PATCH_AMBIGUOUS" });
    expect(methods).toEqual(["PATCH"]); expect(sleeps).toEqual([]);
    await expect(native.readExclusiveState({ target, role: "worker" })).rejects.toThrow("AZURE_REQUEST_AMBIGUOUS");
    expect(methods).toEqual(["PATCH", "GET", "GET", "GET"]);
    expect(now).toBe(1_000); // only native 500ms census spacing, no PATCH debt
  });
  it("retains a long native Retry-After across roles without an early provider retry", async () => {
    let now = 0; const calls = [];
    const native = createManagedAzurePacedContainerAppTransport({ clock: () => now, getAccessToken: async () => "fixture",
      sleep: async ms => { now += ms; }, onProgress: async () => {},
      fetchImpl: async (url, init) => { calls.push({ url, method: init.method, at: now });
        return Response.json({}, { status: 429, headers: { "Retry-After": "600" } }); } });
    await expect(native.readExclusiveState({ target, role: "web" })).rejects.toThrow("AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_600_SECONDS");
    await expect(native.readExclusiveState({ target, role: "worker" })).rejects.toThrow("AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_");
    expect(calls).toHaveLength(1); expect(now).toBe(1_250);
  });
  it("does not delegate an already aborted method", async () => {
    const f = pacedFixture(); f.controller.abort();
    await expect(f.native.readExclusiveState(f.input)).rejects.toThrow("AZURE_ARM_PACING_ABORTED");
    expect(f.calls).toHaveLength(0); expect(f.heartbeats).toHaveLength(0);
  });
});
