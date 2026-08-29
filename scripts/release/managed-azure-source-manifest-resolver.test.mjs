import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { canonicalizeManagedAzureReleaseIntentV1 } from "./azure-release-managed-target.mjs";
import * as resolverModule from "./managed-azure-source-manifest-resolver.mjs";

const { createManagedAzureSourceManifestResolver } = resolverModule;
const FAILURE = "MANAGED_AZURE_SOURCE_MANIFEST_RESOLUTION_FAILED";
const SHA = "1234567890abcdef1234567890abcdef12345678";
const DIGESTS = { web: `sha256:${"a".repeat(64)}`, worker: `sha256:${"b".repeat(64)}` };
const OPTIONS = { stdio: ["ignore", "pipe", "pipe"], shell: false, detached: false, timeoutMs: 10_000,
  maxStdoutBytes: 16_384, maxStderrBytes: 4_096 };
function processResult(stdout, values = {}) {
  return { code: 0, signal: null, timedOut: false, stdout, stderr: "", stdoutOverflow: false, stderrOverflow: false, ...values };
}
function operation(value, abort = vi.fn(async () => undefined)) {
  return { completion: value instanceof Promise ? value : Promise.resolve(value), abort };
}
function harness(values) {
  const queue = values.map((value) => value?.completion ? value : operation(value));
  const spawn = vi.fn(() => { const next = queue.shift(); if (!next) throw new Error("unexpected spawn"); return next; });
  return { spawn, resolver: createManagedAzureSourceManifestResolver({ spawn }) };
}
function manifest(role, values = {}, space) { return JSON.stringify({ schemaVersion: 2, digest: DIGESTS[role], ...values }, null, space); }
async function rejects(promise) { await expect(promise).rejects.toEqual(new Error(FAILURE)); }

describe("managed Azure source manifest resolver", () => {
  it("exports only the closed factory and rejects unsafe dependencies without getter invocation", () => {
    expect(Object.keys(resolverModule)).toEqual(["createManagedAzureSourceManifestResolver"]);
    const getter = vi.fn(); const accessor = {};
    Object.defineProperty(accessor, "spawn", { enumerable: true, get: getter });
    for (const value of [{}, { spawn() {}, extra: true }, { spawn: 1 }, [], new Proxy({ spawn() {} }, {})])
      expect(() => createManagedAzureSourceManifestResolver(value)).toThrow(FAILURE);
    expect(() => createManagedAzureSourceManifestResolver(accessor)).toThrow(FAILURE); expect(getter).not.toHaveBeenCalled();
    const resolver = createManagedAzureSourceManifestResolver({ spawn() {} });
    expect(Object.keys(resolver)).toEqual(["resolveManagedAzureSourceManifests"]); expect(Object.isFrozen(resolver)).toBe(true);
  });

  it("resolves exact web then worker source tags into fresh frozen raw observations", async () => {
    const prettyWeb = manifest("web", {}, 2);
    const { spawn, resolver } = harness([processResult(`${prettyWeb}\n`), processResult(manifest("worker"))]);
    const input = { gitSha: SHA }; const output = await resolver.resolveManagedAzureSourceManifests(input);
    expect(output).toEqual({ schemaVersion: 1, gitSha: SHA, manifests: {
      web: { sourceTag: `ghcr.io/corgtexdotcom/corgtex/web:sha-${SHA}`, raw: prettyWeb },
      worker: { sourceTag: `ghcr.io/corgtexdotcom/corgtex/worker:sha-${SHA}`, raw: manifest("worker") },
    } });
    expect(Object.keys(output)).toEqual(["schemaVersion", "gitSha", "manifests"]);
    expect(Object.keys(output.manifests)).toEqual(["web", "worker"]); expect(Object.isFrozen(output.manifests.web)).toBe(true);
    input.gitSha = "f".repeat(40); expect(output.gitSha).toBe(SHA);
    for (const [index, role] of ["web", "worker"].entries()) {
      const tag = `ghcr.io/corgtexdotcom/corgtex/${role}:sha-${SHA}`;
      expect(spawn.mock.calls[index]).toEqual(["docker", ["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", tag], OPTIONS]);
      expect(spawn.mock.calls[index][2]).not.toHaveProperty("env");
    }
  });

  it("rejects every SHA or input-topology near miss before spawn", async () => {
    const invalid = ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), `sha-${"a".repeat(40)}`, "g".repeat(40), null];
    for (const gitSha of invalid) { const spawn = vi.fn(); await rejects(createManagedAzureSourceManifestResolver({ spawn }).resolveManagedAzureSourceManifests({ gitSha })); expect(spawn).not.toHaveBeenCalled(); }
    const values = [{}, { gitSha: SHA, tag: "latest" }, [], new Proxy({ gitSha: SHA }, {})];
    const hidden = { gitSha: SHA }; Object.defineProperty(hidden, "credential", { value: "credential-canary" }); values.push(hidden);
    const symbol = { gitSha: SHA }; symbol[Symbol("credential-canary")] = true; values.push(symbol);
    let reads = 0; const accessor = {}; Object.defineProperty(accessor, "gitSha", { enumerable: true, get() { reads += 1; return SHA; } }); values.push(accessor);
    for (const value of values) { const spawn = vi.fn(); await rejects(createManagedAzureSourceManifestResolver({ spawn }).resolveManagedAzureSourceManifests(value)); expect(spawn).not.toHaveBeenCalled(); }
    expect(reads).toBe(0);
  });

  it("fails closed on malformed, ambiguous, duplicate, controlled, or oversized manifest text", async () => {
    const malformed = ["", "null", "[]", "1", "{}", JSON.stringify({ nested: { digest: DIGESTS.web } }),
      JSON.stringify({ digest: DIGESTS.web.toUpperCase() }), `{"digest":"${DIGESTS.web}","digest":"${DIGESTS.web}"}`,
      `{"di\\u0067est":"${DIGESTS.web}","digest":"${DIGESTS.web}"}`, `${manifest("web")} trailing`, ` ${manifest("web")}`,
      `${manifest("web")}\n\n`, `${manifest("web")}\r\n`, `{"digest":"${DIGESTS.web}","x":"\\u000a"}`,
      `{"digest":"${DIGESTS.web}","x\\u000a":"value"}`, `{"digest":"${DIGESTS.web}","x\\ud800":"value"}`,
      JSON.stringify({ digest: DIGESTS.web, ["x\u0085"]: "value" }),
      JSON.stringify({ digest: DIGESTS.web, x: "\u0085" }), `{"digest":"${DIGESTS.web}","x":"\ud800"}`,
      JSON.stringify({ digest: DIGESTS.web, padding: "é".repeat(8_200) })];
    for (const stdout of malformed) { const { resolver } = harness([processResult(stdout)]); await rejects(resolver.resolveManagedAzureSourceManifests({ gitSha: SHA })); }
    Object.defineProperty(Object.prototype, "polluted", { enumerable: true, configurable: true, writable: true, value: "credential-canary" });
    try { expect(() => harness([processResult(manifest("web"))])).toThrow(FAILURE); } finally { delete Object.prototype.polluted; }
  });

  it("sanitizes all process failures, starts no worker after web ambiguity, and aborts the exact timeout", async () => {
    const canary = "credential-canary";
    const failures = [operation(Promise.reject(new Error(canary))), operation(processResult("x", { code: 2 })),
      operation(processResult("x", { signal: "SIGTERM" })), operation(processResult("x", { stdoutOverflow: true })),
      operation(processResult("x", { stderr: canary })), { completion: Promise.resolve(processResult("x")) },
      { completion: "not-a-promise", abort: async () => undefined }, operation(processResult("x"), new Proxy(async () => undefined, {}))];
    for (const handle of failures) { const spawn = vi.fn(() => handle); await rejects(createManagedAzureSourceManifestResolver({ spawn }).resolveManagedAzureSourceManifests({ gitSha: SHA })); expect(spawn).toHaveBeenCalledTimes(1); }
    const abort = vi.fn(async () => undefined); const timedOut = operation(processResult("", { code: null, timedOut: true }), abort);
    await rejects(createManagedAzureSourceManifestResolver({ spawn: () => timedOut }).resolveManagedAzureSourceManifests({ gitSha: SHA })); expect(abort).toHaveBeenCalledTimes(1);
    for (const badAbort of [() => undefined, () => Promise.reject(new Error(canary))]) {
      await rejects(createManagedAzureSourceManifestResolver({ spawn: () => operation(processResult("", { timedOut: true }), vi.fn(badAbort)) }).resolveManagedAzureSourceManifests({ gitSha: SHA }));
    }
    await rejects(createManagedAzureSourceManifestResolver({ spawn() { throw new Error(canary); } }).resolveManagedAzureSourceManifests({ gitSha: SHA }));
  });

  it("returns no partial result when the worker read fails", async () => {
    const { resolver, spawn } = harness([processResult(manifest("web")), processResult("bad")]);
    await rejects(resolver.resolveManagedAzureSourceManifests({ gitSha: SHA })); expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("feeds the exact untrusted pair through protected #902 while remaining inert and unintegrated", async () => {
    const { resolver } = harness([processResult(manifest("web")), processResult(manifest("worker"))]);
    const observed = await resolver.resolveManagedAzureSourceManifests({ gitSha: SHA });
    const deploymentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const intent = canonicalizeManagedAzureReleaseIntentV1({ deploymentId, gitSha: SHA, manifests: observed.manifests, deployments: [{
      deploymentId, deploymentKind: "REMOTE_MANAGED", cloudProvider: "AZURE", environment: "production", deploymentStatus: "ACTIVE",
      provisioningStatus: "active", releaseEligible: true, provider: "azure", group: "managed-customers", workload: "managed-customers",
      azure: { subscriptionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", resourceGroup: "managed-prod", acrResourceGroup: "managed-acr", acrName: "managedacr",
        acrServer: "managedacr.azurecr.io", webAppName: "managed-web", workerAppName: "managed-worker" },
    }] });
    expect(intent.roles.web.sourceDigest).toBe(DIGESTS.web); expect(intent.roles.worker.sourceDigest).toBe(DIGESTS.worker);
    const source = readFileSync(new URL("./managed-azure-source-manifest-resolver.mjs", import.meta.url), "utf8");
    expect(source.match(/\bexport\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/azure-release-managed-target|node:child_process|\bprocess\b|\bfetch\s*\(|node:fs|setTimeout|setInterval|console\.|Math\.random|docker (?:login|pull|push)|acr import|containerapp|rollback|lease|workflow/);
  });
});
