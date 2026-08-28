import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import * as providerModule from "./managed-azure-provider-runtime.mjs";

const { createManagedAzureProviderObservation } = providerModule;
const FAILURE = "MANAGED_AZURE_PROVIDER_OBSERVATION_FAILED";
const SHA = "1234567890abcdef1234567890abcdef12345678";
const OTHER_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const DIGEST = `sha256:${"a".repeat(64)}`;
const UUID = "12345678-1234-1234-1234-123456789abc";
const TARGET = Object.freeze({ subscriptionId: UUID, resourceGroup: "managed-prod", acrName: "managedacr", acrServer: "managedacr.azurecr.io", webAppName: "managed-web", workerAppName: "managed-worker" });
const TAG = `sha-${SHA}`;
const USER_IDENTITY = `/subscriptions/${UUID}/resourceGroups/identity-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/release-pull`;
const LOWERCASE_GROUP_IDENTITY = `/subscriptions/${UUID}/resourcegroups/identity-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/release-pull`;

function request(role, values = {}) {
  const gitSha = values.gitSha ?? SHA; const target = { ...TARGET, ...(values.target ?? {}) };
  const sourceDigest = values.sourceDigest ?? DIGEST;
  return { schemaVersion: 1, deploymentId: values.deploymentId ?? UUID, target, binding: { role,
    sourceTag: `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${gitSha}`, sourceDigest,
    sourceDigestRef: `ghcr.io/corgtexdotcom/corgtex/${role}@${sourceDigest}`, destinationRepository: `corgtex/${role}`,
    destinationTag: `corgtex/${role}:sha-${gitSha}` }, mode: "NoForce" };
}
function result(stdout, values = {}) {
  return { code: 0, signal: null, timedOut: false, stdout, stderr: "", stdoutOverflow: false, stderrOverflow: false, ...values };
}
function operation(value) { const abort = vi.fn(async () => undefined); return { completion: value instanceof Promise ? value : Promise.resolve(value), abort }; }
function harness(values, times = [1_000, 1_001]) {
  const operations = values.map((value) => value?.completion ? value : operation(value));
  const spawn = vi.fn(() => { const next = operations.shift(); if (!next) throw new Error("unexpected spawn"); return next; });
  const clock = vi.fn(() => times.shift());
  return { spawn, clock, observer: createManagedAzureProviderObservation({ spawn, clock }) };
}
function acrRows(rows) { return `${JSON.stringify(rows)}\n`; }
function registryRow(server = TARGET.acrServer, identity = "system", values = {}) {
  return { server, identity, username: null, passwordSecretRef: null, ...values };
}
async function rejects(promise) { await expect(promise).rejects.toThrow(FAILURE); }
function subscriptionCount(args) { return args.filter((value) => value === "--subscription").length; }

describe("managed Azure provider observation", () => {
  it("exposes only the closed factory and rejects unsafe dependencies without invoking getters", () => {
    expect(Object.keys(providerModule)).toEqual(["createManagedAzureProviderObservation"]);
    const getter = vi.fn(); const accessor = {};
    Object.defineProperty(accessor, "spawn", { enumerable: true, get: getter });
    Object.defineProperty(accessor, "clock", { enumerable: true, value: () => 1 });
    for (const value of [{ spawn: () => undefined }, { spawn: () => undefined, clock: () => 1, extra: true }, { spawn: 1, clock: () => 1 }, [], new Proxy({ spawn() {}, clock() {} }, {})]) expect(() => createManagedAzureProviderObservation(value)).toThrow(FAILURE);
    expect(() => createManagedAzureProviderObservation(accessor)).toThrow(FAILURE); expect(getter).not.toHaveBeenCalled();
    const observer = createManagedAzureProviderObservation({ spawn() {}, clock() { return 1; } });
    expect(Object.keys(observer)).toEqual(["observeDestination", "observeRegistryPreflight"]); expect(Object.isFrozen(observer)).toBe(true);
    Object.defineProperty(Object.prototype, "polluted", { enumerable: true, configurable: true, writable: true, value: "canary" });
    try { expect(() => createManagedAzureProviderObservation({ spawn() {}, clock() { return 1; } })).toThrow(FAILURE); } finally { delete Object.prototype.polluted; }
  });

  it("returns exact frozen ABSENT and PRESENT destination observations with bounded explicit-subscription reads", async () => {
    const input = request("web"); const present = { digest: DIGEST, tags: [TAG] };
    const { observer, spawn } = harness([result(acrRows([])), result(acrRows([present]))], [100, 101, 102, 103]);
    const absent = await observer.observeDestination(input); const observed = await observer.observeDestination(input);
    expect(absent).toEqual({ schemaVersion: 1, request: input, observedAtMs: 101, state: "ABSENT", digest: null });
    expect(observed).toEqual({ schemaVersion: 1, request: input, observedAtMs: 103, state: "PRESENT", digest: DIGEST });
    expect(observed.request).not.toBe(input); expect(Object.isFrozen(observed)).toBe(true); expect(Object.isFrozen(observed.request.target)).toBe(true);
    input.target.acrName = "caller-mutated"; expect(observed.request.target.acrName).toBe(TARGET.acrName);
    expect(Object.keys(observed)).toEqual(["schemaVersion", "request", "observedAtMs", "state", "digest"]);
    const [executable, args, options] = spawn.mock.calls[1];
    expect(executable).toBe("az"); expect(args).toEqual(["acr", "manifest", "list-metadata", "--registry", TARGET.acrName, "--name", "corgtex/web", "--query", `[?tags!=null && contains(tags, '${TAG}')].{digest:digest,tags:tags}`, "--subscription", UUID, "--output", "json", "--only-show-errors"]);
    expect(subscriptionCount(args)).toBe(1); expect(options).toEqual({ stdio: ["ignore", "pipe", "pipe"], shell: false, detached: false, timeoutMs: 10_000, maxStdoutBytes: 16_384, maxStderrBytes: 4_096 }); expect(options).not.toHaveProperty("env");
    expect(JSON.stringify(observed)).not.toMatch(/MATCH|CONFLICT|credential|username|password/i);
  });

  it("returns one atomic exact two-role registry preflight with both pull identity kinds", async () => {
    const web = registryRow(TARGET.acrServer, "system", { username: "", passwordSecretRef: "" });
    const worker = registryRow(TARGET.acrServer, LOWERCASE_GROUP_IDENTITY, { username: "", passwordSecretRef: "" });
    const webRequest = request("web"); const workerRequest = request("worker");
    const { observer, spawn } = harness([result(acrRows([web])), result(acrRows([worker]))], [200, 201]);
    const output = await observer.observeRegistryPreflight({ webRequest, workerRequest });
    expect(Object.keys(output)).toEqual(["schemaVersion", "deploymentId", "target", "observedAtMs", "web", "worker"]);
    expect(output).toMatchObject({ schemaVersion: 1, deploymentId: UUID, observedAtMs: 201,
      web: { appName: TARGET.webAppName, registryServer: TARGET.acrServer, pullIdentity: { kind: "SYSTEM_ASSIGNED", resourceId: null } },
      worker: { appName: TARGET.workerAppName, registryServer: TARGET.acrServer, pullIdentity: { kind: "USER_ASSIGNED", resourceId: LOWERCASE_GROUP_IDENTITY } } });
    expect(Object.isFrozen(output)).toBe(true); expect(Object.isFrozen(output.worker.pullIdentity)).toBe(true);
    expect(output.web.binding).not.toBe(webRequest.binding); expect(output.worker.binding).not.toBe(workerRequest.binding);
    expect(spawn).toHaveBeenCalledTimes(2);
    for (const [index, app] of [TARGET.webAppName, TARGET.workerAppName].entries()) {
      const [command, args, options] = spawn.mock.calls[index]; expect(command).toBe("az"); expect(subscriptionCount(args)).toBe(1); expect(args).toEqual(["containerapp", "registry", "list", "--subscription", UUID, "--resource-group", TARGET.resourceGroup, "--name", app, "--query", "[].{server:server,identity:identity,username:username,passwordSecretRef:passwordSecretRef}", "--output", "json", "--only-show-errors"]); expect(options).not.toHaveProperty("env");
    }
    expect(JSON.stringify(output)).not.toMatch(/username|password|secret|token/i);
  });

  it("rejects pair substitution and topology attacks before any spawn", async () => {
    const cases = [
      { webRequest: request("worker"), workerRequest: request("worker") },
      { webRequest: request("web"), workerRequest: request("worker", { deploymentId: "abcdef12-1234-1234-1234-123456789abc" }) },
      { webRequest: request("web"), workerRequest: request("worker", { target: { resourceGroup: "other-rg" } }) },
      { webRequest: request("web"), workerRequest: request("worker", { gitSha: OTHER_SHA }) },
      { webRequest: request("web"), workerRequest: request("worker"), extra: true },
      new Proxy({ webRequest: request("web"), workerRequest: request("worker") }, {}),
    ];
    for (const input of cases) { const spawn = vi.fn(); const observer = createManagedAzureProviderObservation({ spawn, clock: () => 1 }); await rejects(observer.observeRegistryPreflight(input)); expect(spawn).not.toHaveBeenCalled(); }
    const getter = vi.fn(); const input = { workerRequest: request("worker") }; Object.defineProperty(input, "webRequest", { enumerable: true, get: getter });
    const spawn = vi.fn(); await rejects(createManagedAzureProviderObservation({ spawn, clock: () => 1 }).observeRegistryPreflight(input)); expect(getter).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous, foreign, malformed, or polluted destination output", async () => {
    const valid = { digest: DIGEST, tags: [TAG] };
    const outputs = [
      acrRows([valid, valid]), acrRows([{ ...valid, tags: [`sha-${OTHER_SHA}`] }]), acrRows([{ ...valid, digest: DIGEST.toUpperCase() }]),
      acrRows([{ ...valid, extra: true }]), acrRows([{ ...valid, tags: [TAG, TAG] }]), acrRows([{ ...valid, tags: [TAG.toUpperCase()] }]), `${JSON.stringify([valid])} trailing`, "[]\n\n",
    ];
    for (const stdout of outputs) { const { observer } = harness([result(stdout)]); await rejects(observer.observeDestination(request("web"))); }
    Object.defineProperty(Array.prototype, "polluted", { enumerable: true, configurable: true, value: "canary" });
    try { const { observer } = harness([result(acrRows([valid]))]); await rejects(observer.observeDestination(request("web"))); } finally { delete Array.prototype.polluted; }
  });

  it("fails the entire preflight on registry credentials, aliases, duplicates, unknown fields, or identities", async () => {
    const bad = [
      [registryRow("alternate.azurecr.io")], [registryRow(TARGET.acrServer, "system", { username: "canary" })],
      [registryRow(TARGET.acrServer, "system", { passwordSecretRef: "canary" })], [registryRow(TARGET.acrServer, "*")],
      [registryRow(TARGET.acrServer, null)], [registryRow(TARGET.acrServer, "secretref:canary")], [registryRow(TARGET.acrServer, `${USER_IDENTITY},${USER_IDENTITY}`)], [registryRow(TARGET.acrServer, "system", { password: "canary" })],
      [registryRow(), registryRow()], [],
    ];
    for (const rows of bad) { const { observer } = harness([result(acrRows([registryRow()])), result(acrRows(rows))]); await rejects(observer.observeRegistryPreflight({ webRequest: request("web"), workerRequest: request("worker") })); }
  });

  it("sanitizes every process lifecycle failure and aborts the exact timed-out operation", async () => {
    const canary = "credential-canary";
    const failures = [
      operation(Promise.reject(new Error(canary))), operation(result("[]", { code: 2 })), operation(result("[]", { signal: "SIGTERM" })),
      operation(result("[]", { stdoutOverflow: true })), operation(result("[]", { stderr: canary })), operation(result("x".repeat(16_385))),
      { completion: Promise.resolve(result("[]")) }, { completion: "not-a-promise", abort: async () => undefined },
    ];
    for (const handle of failures) { const spawn = vi.fn(() => handle); const observer = createManagedAzureProviderObservation({ spawn, clock: () => 1 }); await expect(observer.observeDestination(request("web"))).rejects.toEqual(new Error(FAILURE)); }
    const timedOut = operation(result("", { code: null, timedOut: true })); const observer = createManagedAzureProviderObservation({ spawn: () => timedOut, clock: () => 1 });
    await rejects(observer.observeDestination(request("web"))); expect(timedOut.abort).toHaveBeenCalledTimes(1);
    const throwing = createManagedAzureProviderObservation({ spawn: () => { throw new Error(canary); }, clock: () => 1 }); await expect(throwing.observeDestination(request("web"))).rejects.toEqual(new Error(FAILURE));
  });

  it("requires bounded nondecreasing clock values", async () => {
    for (const times of [[2, 1], [-1], [Number.MAX_SAFE_INTEGER]]) { const { observer } = harness([result(acrRows([]))], times); await rejects(observer.observeDestination(request("web"))); }
  });

  it("contains only the bounded read boundary and leaves digest policy and mutation absent", () => {
    const source = readFileSync(new URL("./managed-azure-provider-runtime.mjs", import.meta.url), "utf8");
    expect(source.match(/\bexport\b/g)).toHaveLength(1); expect(source).toContain("canonicalizeManagedAzureImportRequestValueV1");
    expect(source).not.toMatch(/node:child_process|\bprocess\b|\bfetch\s*\(|node:fs|setTimeout|setInterval|console\.|Math\.random|dynamic import|az login|acr import|containerapp update|MATCH|CONFLICT/);
    expect(source.match(/"--subscription"/g)?.length).toBe(2); expect(source.match(/spawn\("az"/g)).toHaveLength(1);
  });
});
