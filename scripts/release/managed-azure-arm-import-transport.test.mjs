import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { canonicalizeManagedAzureImportRequestValueV1 } from "./azure-release-managed-target.mjs";
import * as transportModule from "./managed-azure-arm-import-transport.mjs";

const SHA = "a".repeat(40); const DIGEST = `sha256:${"b".repeat(64)}`;
const DEPLOYMENT_ID = "aaaaaaaa-aaaa-faaa-0aaa-aaaaaaaa0101";
const SUBSCRIPTION_ID = "bbbbbbbb-bbbb-0bbb-fbbb-bbbbbbbb0102";
const SOURCE_CREDENTIALS = { username: "ghcr-user-canary", password: "ghcr-password-canary" };
function request() {
  return canonicalizeManagedAzureImportRequestValueV1({ schemaVersion: 1, deploymentId: DEPLOYMENT_ID,
    target: { subscriptionId: SUBSCRIPTION_ID, resourceGroup: "rg-managed", acrName: "acrmanaged",
      acrServer: "acrmanaged.azurecr.io", webAppName: "managed-web", workerAppName: "managed-worker" },
    binding: { role: "web", sourceTag: `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`, sourceDigest: DIGEST,
      sourceDigestRef: `ghcr.io/corgtexdotcom/corgtex/web@${DIGEST}`, destinationRepository: "corgtex/web",
      destinationTag: `corgtex/web:sha-${SHA}` }, mode: "NoForce" });
}
function pollUrl(change = (value) => value) {
  return change(`https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-managed/providers/Microsoft.ContainerRegistry/locations/eastus/operationResults/operationStatuses/registries-cccccccc-cccc-4ccc-8ccc-cccccccc0103?api-version=2025-11-01`);
}
function response(spec, requestedUrl) {
  return { status: spec.status, redirected: spec.redirected ?? false, url: spec.url ?? requestedUrl, headers: new Headers(spec.headers) };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function rig(items = [{ status: 200 }], overrides = {}) {
  const calls = []; const sleeps = []; let tokenCalls = 0; let sourceCalls = 0; let now = 0;
  const dependencies = {
    fetchImpl: async (url, options) => { calls.push({ url, options }); const item = items.shift();
      if (item instanceof Error) throw item; if (typeof item === "function") return item(url, options);
      return response(item ?? { status: 200 }, url); },
    getAzureAccessToken: async () => `azure-token-canary-${++tokenCalls}`,
    getSourceCredentials: async () => { sourceCalls += 1; return { ...SOURCE_CREDENTIALS }; },
    clock: () => now,
    sleep: async (milliseconds) => { sleeps.push(milliseconds);
      if (milliseconds === 15_000) return new Promise(() => {}); now += milliseconds; },
    ...overrides,
  };
  return { transport: transportModule.createManagedAzureArmImportTransport(dependencies), calls, sleeps,
    tokenCalls: () => tokenCalls, sourceCalls: () => sourceCalls, setNow: (value) => { now = value; } };
}
function expectInvalid(operation, canary = "private-provider-canary") {
  try { operation(); expect.unreachable(); } catch (error) {
    expect(error).toBeInstanceOf(Error); expect(error.message).toBe("MANAGED_AZURE_ARM_IMPORT_TRANSPORT_INPUT_INVALID");
    expect(error.message).not.toContain(canary);
  }
}
async function outcome(specs, overrides) {
  const fixture = rig(specs, overrides); return { result: await fixture.transport.startManagedAzureImport(structuredClone(request())).completion, fixture };
}

describe("managed Azure ARM import transport", () => {
  test("exports only the inert fixed factory and rejects unsafe dependency topology", () => {
    expect(Object.keys(transportModule)).toStrictEqual(["createManagedAzureArmImportTransport"]);
    const source = readFileSync(new URL("./managed-azure-arm-import-transport.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/node:fs|node:child_process|node:http|node:https|\bfetch\b|\bprocess\b|console\.|setTimeout|setInterval|Math\.random|Date\.|\beval\b|\bFunction\b|import\s*\(/);
    expect(source).not.toContain("canonicalizeManagedAzureImportRequestV1(");
    expect(source).toMatch(/REQUEST_TIMEOUT_MS = 15_000[\s\S]*DEADLINE_MS = 120_000[\s\S]*MAX_POLLS = 12[\s\S]*DEFAULT_DELAY_MS = 1_000[\s\S]*MAX_RETRY_AFTER_MS = 30_000/);
    const valid = { fetchImpl() {}, getAzureAccessToken() {}, getSourceCredentials() {}, clock() {}, sleep() {} };
    for (const value of [null, [], { ...valid, extra() {} }, { ...valid, sleep: true }, new Proxy(valid, {})]) expectInvalid(() => transportModule.createManagedAzureArmImportTransport(value));
    const accessor = { ...valid }; Object.defineProperty(accessor, "sleep", { enumerable: true, get() { throw new Error("private-provider-canary"); } });
    expectInvalid(() => transportModule.createManagedAzureArmImportTransport(accessor));
  });

  test("rejects malformed requests synchronously before time, credentials, or HTTP", () => {
    let reads = 0; const fixture = rig([], { clock: () => { reads += 1; return 0; },
      getAzureAccessToken: () => { reads += 1; return "token"; }, getSourceCredentials: () => { reads += 1; return SOURCE_CREDENTIALS } });
    const extra = structuredClone(request()); extra.extra = true;
    const missing = structuredClone(request()); delete missing.mode;
    const symbol = structuredClone(request()); symbol[Symbol("private-provider-canary")] = true;
    const hidden = structuredClone(request()); Object.defineProperty(hidden, "extra", { value: true });
    const inherited = Object.assign(Object.create({ extra: true }), structuredClone(request()));
    const cyclic = structuredClone(request()); cyclic.target = cyclic;
    const drift = structuredClone(request()); drift.binding.destinationTag = "corgtex/web:latest";
    const accessor = structuredClone(request()); Object.defineProperty(accessor.binding, "sourceDigest", { enumerable: true, get() { reads += 1; return DIGEST; } });
    for (const value of [extra, missing, symbol, hidden, inherited, cyclic, drift, accessor, new Proxy(request(), {}), { intent: request(), role: "web" }, []])
      expectInvalid(() => fixture.transport.startManagedAzureImport(value));
    expect(reads).toBe(0); expect(fixture.calls).toHaveLength(0);
  });

  test("sends the one exact credential-confined POST and returns a fresh frozen success", async () => {
    const canonical = request(); const fixture = rig([{ status: 200 }]); const operation = fixture.transport.startManagedAzureImport(structuredClone(canonical));
    expect(Object.keys(fixture.transport)).toStrictEqual(["startManagedAzureImport"]); expect(Object.isFrozen(fixture.transport)).toBe(true);
    expect(Object.keys(operation)).toStrictEqual(["completion", "abort"]); expect(Object.isFrozen(operation)).toBe(true);
    const result = await operation.completion; const call = fixture.calls[0]; const body = JSON.parse(call.options.body);
    expect(call.url).toBe(`https://management.azure.com/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/rg-managed/providers/Microsoft.ContainerRegistry/registries/acrmanaged/importImage?api-version=2025-11-01`);
    expect(call.options).toMatchObject({ method: "POST", redirect: "manual", headers: { Authorization: "Bearer azure-token-canary-1", "Content-Type": "application/json" } });
    expect(call.options.signal).toBeInstanceOf(AbortSignal); expect(body).toStrictEqual({ source: { registryUri: "ghcr.io",
      sourceImage: `corgtexdotcom/corgtex/web@${DIGEST}`, credentials: SOURCE_CREDENTIALS }, targetTags: [`corgtex/web:sha-${SHA}`], mode: "NoForce" });
    expect(Object.keys(result)).toStrictEqual(["schemaVersion", "request", "outcome", "reason", "completedAtMs"]);
    expect(result).toMatchObject({ schemaVersion: 1, outcome: "CONFIRMED_SUCCESS", reason: "ARM_COMPLETED", completedAtMs: 0 });
    expect(result.request).toStrictEqual(canonical); expect(result.request).not.toBe(canonical); expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.request.target)).toBe(true); expect(JSON.stringify(result)).not.toMatch(/azure-token|ghcr-user|ghcr-password/);
    expect(await operation.abort()).toBe(result); expect(await operation.abort()).toBe(result); expect(fixture.calls).toHaveLength(1);
  });

  test("maps every initial response class without reading or echoing response bodies", async () => {
    const cases = [[400, "CONFIRMED_POST_REJECTION", "POST_REJECTED"], [401, "CONFIRMED_POST_REJECTION", "POST_REJECTED"],
      [408, "UNVERIFIED", "POST_TRANSPORT_AMBIGUITY"], [429, "UNVERIFIED", "POST_TRANSPORT_AMBIGUITY"],
      [500, "UNVERIFIED", "POST_TRANSPORT_AMBIGUITY"], [201, "UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION"],
      [204, "UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION"], [302, "UNVERIFIED", "PROTOCOL_LOCATION_VIOLATION"]];
    for (const [status, expectedOutcome, reason] of cases) expect((await outcome([{ status }])).result).toMatchObject({ outcome: expectedOutcome, reason });
    expect((await outcome([new Error("private-provider-canary")])).result).toMatchObject({ outcome: "UNVERIFIED", reason: "POST_TRANSPORT_AMBIGUITY" });
    for (const spec of [{ status: 200, redirected: true }, { status: 200, url: "https://management.azure.com/drift" }])
      expect((await outcome([spec])).result.reason).toBe("PROTOCOL_LOCATION_VIOLATION");
  });

  test("accepts only the exact documented immutable Location boundary", async () => {
    const invalid = [null, "/relative", pollUrl((value) => value.replace("management.azure.com", "example.com")),
      pollUrl((value) => value.replace(SUBSCRIPTION_ID, DEPLOYMENT_ID)), pollUrl((value) => value.replace("rg-managed", "rg-other")),
      pollUrl((value) => value.replace("Microsoft.ContainerRegistry", "microsoft.containerregistry")), pollUrl((value) => `${value}&extra=true`),
      pollUrl((value) => value.replace("https://", "https://user@")), pollUrl((value) => value.replace("management.azure.com", "management.azure.com:444")),
      pollUrl((value) => `${value}#fragment`), pollUrl((value) => value.replace("/eastus/", "/../")), `${pollUrl()}, ${pollUrl()}`];
    for (const location of invalid) expect((await outcome([{ status: 202, headers: location === null ? {} : { Location: location } }])).result.reason).toBe("PROTOCOL_LOCATION_VIOLATION");
    expect((await outcome([{ status: 202, headers: { Location: pollUrl(), "Azure-AsyncOperation": pollUrl() } }])).result.reason).toBe("PROTOCOL_LOCATION_VIOLATION");
  });

  test("polls only the immutable URL with fresh tokens, bounded delay, and one 401 refresh", async () => {
    const location = pollUrl(); const fixture = rig([{ status: 202, headers: { Location: location, "Retry-After": "2" } },
      { status: 202, headers: { "Retry-After": "0" } }, { status: 401 }, { status: 200 }]);
    const result = await fixture.transport.startManagedAzureImport(request()).completion;
    expect(result).toMatchObject({ outcome: "CONFIRMED_SUCCESS", reason: "ARM_COMPLETED", completedAtMs: 2_000 });
    expect(fixture.calls).toHaveLength(4); expect(fixture.calls.slice(1).every((call) => call.url === location && call.options.method === "GET"
      && call.options.redirect === "manual" && !("body" in call.options))).toBe(true);
    expect(fixture.calls.slice(1).map((call) => call.options.headers.Authorization)).toStrictEqual([
      "Bearer azure-token-canary-2", "Bearer azure-token-canary-3", "Bearer azure-token-canary-4"]);
    expect(fixture.sourceCalls()).toBe(1); expect(fixture.tokenCalls()).toBe(4); expect(fixture.sleeps.filter((value) => value !== 15_000)).toStrictEqual([2_000, 0]);
  });

  test("maps poll rejection, ambiguity, and protocol drift without retrying the POST", async () => {
    const location = pollUrl(); const initial = { status: 202, headers: { Location: location, "Retry-After": "0" } };
    const cases = [[{ status: 400 }, "POLL_REJECTION"], [{ status: 401 }, "POLL_REJECTION"], [{ status: 408 }, "POLL_TRANSPORT_AMBIGUITY"],
      [{ status: 429 }, "POLL_TRANSPORT_AMBIGUITY"], [{ status: 500 }, "POLL_TRANSPORT_AMBIGUITY"],
      [new Error("private-provider-canary"), "POLL_TRANSPORT_AMBIGUITY"], [{ status: 201 }, "PROTOCOL_LOCATION_VIOLATION"],
      [{ status: 302 }, "PROTOCOL_LOCATION_VIOLATION"], [{ status: 202, headers: { Location: pollUrl() } }, "PROTOCOL_LOCATION_VIOLATION"]];
    for (const [spec, reason] of cases) { const { result, fixture } = await outcome([initial, spec, spec]);
      expect(result).toMatchObject({ outcome: "UNVERIFIED", reason }); expect(fixture.calls.filter((call) => call.options.method === "POST")).toHaveLength(1); }
  });

  test("fails closed on credentials, Retry-After, clock, timeout, exhaustion, and abort races", async () => {
    for (const overrides of [{ getAzureAccessToken: async () => "bad token" }, { getSourceCredentials: async () => ({ username: "x" }) },
      { getSourceCredentials: async () => { throw new Error("ghcr-password-canary"); } }]) {
      const { result, fixture } = await outcome([], overrides); expect(result.reason).toBe("POST_TRANSPORT_AMBIGUITY");
      expect(fixture.calls).toHaveLength(0); expect(JSON.stringify(result)).not.toMatch(/ghcr-password|bad token/);
    }
    for (const retryAfter of ["-1", "1.5", "31", "1, 2"]) expect((await outcome([{ status: 202, headers: { Location: pollUrl(), "Retry-After": retryAfter } }])).result.reason).toBe("PROTOCOL_LOCATION_VIOLATION");
    for (const clock of [() => -1, (() => { let value = 1; return () => value--; })()]) expect((await outcome([{ status: 200 }], { clock })).result.reason).toBe("POST_TRANSPORT_AMBIGUITY");
    const repeated = Array.from({ length: 13 }, (_, index) => index === 0 ? { status: 202, headers: { Location: pollUrl(), "Retry-After": "0" } } : { status: 202, headers: { "Retry-After": "0" } });
    const exhausted = await outcome(repeated); expect(exhausted.result.reason).toBe("POLL_EXHAUSTION"); expect(exhausted.fixture.calls).toHaveLength(13);
    const deadline = await outcome(Array.from({ length: 5 }, (_, index) => ({ status: 202, headers: { ...(index === 0 ? { Location: pollUrl() } : {}), "Retry-After": "30" } })));
    expect(deadline.result).toMatchObject({ reason: "POLL_EXHAUSTION", completedAtMs: 120_000 }); expect(deadline.fixture.calls).toHaveLength(4);
    const hanging = deferred(); let timeoutSignal; const timed = await outcome([(url, options) => { timeoutSignal = options.signal; return hanging.promise; }],
      { sleep: async (milliseconds) => { if (milliseconds === 15_000) return; return new Promise(() => {}); } });
    expect(timed.result.reason).toBe("POST_TRANSPORT_AMBIGUITY"); expect(timeoutSignal.aborted).toBe(true);
    const late = deferred(); const abortFixture = rig([(url, options) => late.promise]); const operation = abortFixture.transport.startManagedAzureImport(request());
    for (let turn = 0; turn < 64 && abortFixture.calls.length === 0; turn += 1) await Promise.resolve();
    const firstAbort = operation.abort(); const secondAbort = operation.abort(); const aborted = await firstAbort;
    expect(aborted.reason).toBe("LOCAL_ABORT"); expect(await secondAbort).toBe(aborted); expect(abortFixture.calls[0].options.signal.aborted).toBe(true);
    late.resolve(response({ status: 200 }, abortFixture.calls[0].url)); await Promise.resolve(); expect(await operation.completion).toBe(aborted); expect(abortFixture.calls).toHaveLength(1);
  });
});
