import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as observationModule from "./managed-azure-observation.mjs";
import { createManagedAzureObservationVerifier } from "./managed-azure-observation.mjs";

const FAILURE = "Managed Azure observation proof is invalid.";
const DEPLOYMENT = "123e4567-e89b-12d3-a456-426614174000";
const SUBSCRIPTION = "223e4567-e89b-12d3-a456-426614174000";
const SIBLING_SUBSCRIPTION = "323e4567-e89b-12d3-a456-426614174000";
const SHA = "a".repeat(40); const START = 1_700_000_000_000; const END = START + 300_000;
const TARGET = { subscriptionId: SUBSCRIPTION, resourceGroup: "rg-managed", webAppName: "managed-web", workerAppName: "managed-worker" };
const makeRequest = (changes = {}) => { const { target, ...root } = changes; return { deploymentId: DEPLOYMENT, targetClass: "azure-managed", expectedSha: SHA, expectedImageTag: `sha-${SHA}`, target: { ...TARGET, ...target }, windowStartUnixMs: START, windowEndUnixMs: END, ...root }; };
const selected = (query, changes = {}) => ({ deploymentId: query.deploymentId, targetClass: query.targetClass, role: query.role, subscriptionId: query.subscriptionId, resourceGroup: query.resourceGroup, appName: query.appName, gitSha: query.expectedSha, imageTag: query.expectedImageTag, status: "READY", observedAtUnixMs: END, ...changes });
const sibling = (query, id, changes = {}) => ({ deploymentId: id, targetClass: "azure-selfserve", role: query.role, subscriptionId: SIBLING_SUBSCRIPTION, resourceGroup: "rg-sibling", appName: query.role === "WEB" ? "sibling-web" : "sibling-worker", gitSha: "b".repeat(40), imageTag: `sha-${"b".repeat(40)}`, status: "FAILED", observedAtUnixMs: 1, ...changes });
const page = (query, rows = [selected(query)], changes = {}) => ({ complete: true, truncated: false, pageCount: 1, continuationToken: null, rows, ...changes });
const uuidAt = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const verifierFor = (queryResourceObservations = (query) => page(query), clock = () => END) => createManagedAzureObservationVerifier({ queryResourceObservations, clock });
const verifyWith = (queryResourceObservations, request = makeRequest(), clock = () => END) => verifierFor(queryResourceObservations, clock).verifyManagedAzureObservation(request);

describe("managed Azure observation verifier", () => {
  it("exposes only the exact frozen factory surface and rejects unsafe dependencies", () => {
    expect(Object.keys(observationModule)).toEqual(["createManagedAzureObservationVerifier"]);
    const verifier = verifierFor(); expect(Object.keys(verifier)).toEqual(["verifyManagedAzureObservation"]); expect(Object.isFrozen(verifier)).toBe(true);
    let getterCalled = false; let proxyTrapped = false;
    const accessor = Object.defineProperty({ clock: () => END }, "queryResourceObservations", { enumerable: true, get: () => { getterCalled = true; return () => undefined; } });
    const proxy = new Proxy({ queryResourceObservations: () => undefined, clock: () => END }, { ownKeys: () => { proxyTrapped = true; throw new Error("private"); } });
    for (const value of [{ clock: () => END }, { queryResourceObservations: () => undefined, clock: () => END, extra: true }, { queryResourceObservations: 1, clock: () => END }, accessor, proxy]) expect(() => createManagedAzureObservationVerifier(value)).toThrow(FAILURE);
    expect(getterCalled).toBe(false); expect(proxyTrapped).toBe(false);
  });

  it("queries both exact roles once and returns fresh exact deeply frozen zero-sibling summaries", async () => {
    const queries = []; const query = vi.fn((value) => { queries.push(value); return page(value, [selected(value, { observedAtUnixMs: value.role === "WEB" ? START : END })]); }); const clock = vi.fn(() => END); const input = makeRequest();
    const verifier = verifierFor(query, clock); const first = await verifier.verifyManagedAzureObservation(input); const second = await verifier.verifyManagedAzureObservation(Object.assign(Object.create(null), { ...makeRequest(), target: Object.assign(Object.create(null), TARGET) }));
    expect(query).toHaveBeenCalledTimes(4); expect(clock).toHaveBeenCalledTimes(2); expect(queries.map((value) => value.role)).toEqual(["WEB", "WORKER", "WEB", "WORKER"]);
    expect(Object.keys(queries[0])).toEqual(["deploymentId", "targetClass", "role", "subscriptionId", "resourceGroup", "appName", "expectedSha", "expectedImageTag", "windowStartUnixMs", "windowEndUnixMs"]); expect(queries.every(Object.isFrozen)).toBe(true); expect(queries[0]).not.toBe(queries[2]);
    expect(first).toEqual({ status: "VERIFIED", targetClass: "azure-managed", deploymentId: DEPLOYMENT, expectedSha: SHA, expectedImageTag: `sha-${SHA}`, windowStartUnixMs: START, windowEndUnixMs: END, web: { ready: true, observedAtUnixMs: START }, worker: { ready: true, observedAtUnixMs: END }, ignoredSiblingCount: 0 });
    expect(Object.keys(first)).toEqual(["status", "targetClass", "deploymentId", "expectedSha", "expectedImageTag", "windowStartUnixMs", "windowEndUnixMs", "web", "worker", "ignoredSiblingCount"]); expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.web)).toBe(true); expect(Object.isFrozen(first.worker)).toBe(true); expect(second).not.toBe(first); expect(second.web).not.toBe(first.web); expect(Object.isFrozen(input)).toBe(false); for (const key of ["target", "subscriptionId", "rows", "pageCount", "window", "timestamp", "url", "message", "siblings"]) expect(first).not.toHaveProperty(key);
  });

  it("deduplicates disjoint siblings across roles and accepts only the exact 0-through-126 bound", async () => {
    const sharedId = uuidAt(500); const one = await verifyWith((query) => page(query, [selected(query), sibling(query, sharedId)])); expect(one.ignoredSiblingCount).toBe(1);
    const maximum = await verifyWith((query) => { const offset = query.role === "WEB" ? 1 : 64; return page(query, [selected(query), ...Array.from({ length: 63 }, (_, index) => sibling(query, uuidAt(offset + index)))]); });
    expect(maximum.ignoredSiblingCount).toBe(126); expect(Object.isFrozen(maximum)).toBe(true);
  });

  it("descriptor-validates request topology before clock or query without invoking traps", async () => {
    let getterCalled = false; let proxyTrapped = false; const accessor = makeRequest(); Object.defineProperty(accessor, "deploymentId", { enumerable: true, get: () => { getterCalled = true; return DEPLOYMENT; } });
    const hidden = makeRequest(); Object.defineProperty(hidden, "extra", { value: true }); const inherited = Object.assign(Object.create({ private: true }), makeRequest()); const symbol = { ...makeRequest(), [Symbol("private")]: true };
    const proxy = new Proxy(makeRequest(), { ownKeys: () => { proxyTrapped = true; throw new Error("private"); } }); const cycle = makeRequest(); cycle.target = cycle;
    const alternateWindow = makeRequest(); delete alternateWindow.windowStartUnixMs; delete alternateWindow.windowEndUnixMs; alternateWindow.window = { start: new Date(START).toISOString(), end: new Date(END).toISOString() };
    for (const input of [accessor, hidden, inherited, symbol, proxy, cycle, [], alternateWindow, { ...makeRequest(), extra: true }, { ...makeRequest(), target: { ...TARGET, tenantId: "private" } }]) {
      const query = vi.fn(); const clock = vi.fn(() => END); await expect(verifierFor(query, clock).verifyManagedAzureObservation(input)).rejects.toThrow(FAILURE); expect(query).not.toHaveBeenCalled(); expect(clock).not.toHaveBeenCalled();
    }
    expect(getterCalled).toBe(false); expect(proxyTrapped).toBe(false);
  });

  it("rejects every identifier, relationship, and pre-clock time near miss", async () => {
    const cases = [makeRequest({ deploymentId: DEPLOYMENT.toUpperCase() }), makeRequest({ targetClass: "azure-selfserve" }), makeRequest({ expectedSha: SHA.toUpperCase() }), makeRequest({ expectedImageTag: `sha-${"b".repeat(40)}` }), makeRequest({ target: { subscriptionId: SUBSCRIPTION.toUpperCase() } }), makeRequest({ target: { resourceGroup: ".bad" } }), makeRequest({ target: { webAppName: "bad--web" } }), makeRequest({ target: { workerAppName: TARGET.webAppName } }), makeRequest({ windowStartUnixMs: `${START}` }), makeRequest({ windowStartUnixMs: START + 0.5 }), makeRequest({ windowEndUnixMs: Number.MAX_SAFE_INTEGER + 1 }), makeRequest({ windowStartUnixMs: END }), makeRequest({ windowStartUnixMs: START - 1, windowEndUnixMs: END + 1_500_000 })];
    for (const input of cases) { const query = vi.fn(); await expect(verifyWith(query, input)).rejects.toThrow(FAILURE); expect(query).not.toHaveBeenCalled(); }
  });

  it("uses one injected clock and rejects future, stale, invalid, or leaking time", async () => {
    for (const input of [makeRequest({ windowStartUnixMs: END - 1_000, windowEndUnixMs: END + 1 }), makeRequest({ windowStartUnixMs: END - 301_000, windowEndUnixMs: END - 300_001 })]) {
      const query = vi.fn(); const clock = vi.fn(() => END); await expect(verifyWith(query, input, clock)).rejects.toThrow(FAILURE); expect(clock).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
    }
    for (const clock of [() => "1700000000000", () => 1.5, () => { throw new Error("credential=private"); }]) await expect(verifyWith(vi.fn(), makeRequest(), clock)).rejects.toThrow(/^Managed Azure observation proof is invalid\.$/);
  });

  it("rejects incomplete metadata and every non-dense or exotic bounded row array", async () => {
    let getterCalled = false; let proxyTrapped = false;
    const invalidPages = [(query) => page(query, undefined, { complete: false }), (query) => page(query, undefined, { truncated: true }), (query) => page(query, undefined, { pageCount: 2 }), (query) => page(query, undefined, { continuationToken: "next" }), (query) => ({ ...page(query), extra: true }), (query) => { const value = page(query); delete value.complete; return value; }, (query) => Object.assign(Object.create({ private: true }), page(query)), (query) => { const value = page(query); Object.defineProperty(value, "complete", { enumerable: true, get: () => { getterCalled = true; return true; } }); return value; }, (query) => new Proxy(page(query), { ownKeys: () => { proxyTrapped = true; throw new Error("private"); } }), (query) => page(query, []), (query) => page(query, Array.from({ length: 65 }, () => selected(query))), (query) => { const rows = Array(1); return page(query, rows); }, (query) => { const rows = [selected(query)]; Object.defineProperty(rows, "0", { enumerable: true, get: () => { getterCalled = true; return selected(query); } }); return page(query, rows); }, (query) => { const rows = [selected(query)]; rows[Symbol("private")] = true; return page(query, rows); }, (query) => { const rows = [selected(query)]; Object.setPrototypeOf(rows, []); return page(query, rows); }, (query) => page(query, new Proxy([selected(query)], { ownKeys: () => { proxyTrapped = true; throw new Error("private"); } }))];
    for (const invalid of invalidPages) await expect(verifyWith(invalid)).rejects.toThrow(FAILURE);
    expect(getterCalled).toBe(false); expect(proxyTrapped).toBe(false);
  });

  it("requires one exact selected row per role and blocks partial physical-target ambiguity", async () => {
    const differentSha = "c".repeat(40); const badRows = [(query) => [sibling(query, uuidAt(700))], (query) => [selected(query), selected(query)], (query) => [selected(query, { status: "NOT_READY" })], (query) => [selected(query, { targetClass: "azure-selfserve" })], (query) => [selected(query, { role: query.role === "WEB" ? "WORKER" : "WEB" })], (query) => [selected(query, { gitSha: differentSha, imageTag: `sha-${differentSha}` })], (query) => [selected(query, { imageTag: `sha-${"d".repeat(40)}` })], (query) => [selected(query, { resourceGroup: "RG-managed" })], (query) => [selected(query, { observedAtUnixMs: START - 1 })], (query) => [selected(query, { observedAtUnixMs: END + 1 })], (query) => [selected(query), sibling(query, uuidAt(701), { subscriptionId: SUBSCRIPTION, resourceGroup: TARGET.resourceGroup.toUpperCase(), appName: query.appName })], (query) => [{ ...selected(query), timestamp: END, raw: "private" }], (query) => { const row = selected(query); delete row.status; return [row]; }, (query) => { const row = selected(query); Object.defineProperty(row, "status", { enumerable: true, get: () => { throw new Error("private"); } }); return [row]; }, (query) => [new Proxy(selected(query), { ownKeys: () => { throw new Error("private"); } })]];
    for (const rows of badRows) await expect(verifyWith((query) => page(query, rows(query)))).rejects.toThrow(FAILURE);
  });

  it("starts both reads once, blocks partial success, and sanitizes every observable failure", async () => {
    const calls = []; const log = vi.spyOn(console, "log").mockImplementation(() => undefined); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let caught; try { await verifyWith((query) => { calls.push(query.role); if (query.role === "WEB") throw new Error("credential=private-value"); return page(query); }); } catch (value) { caught = value; }
    expect(calls).toEqual(["WEB", "WORKER"]); expect(caught).toEqual(new TypeError(FAILURE)); expect(String(caught)).not.toContain("private-value"); expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); log.mockRestore(); error.mockRestore();
  });

  it("keeps the pure API free of I/O and confines a fixed public-safe synthetic CLI", () => {
    const source = readFileSync(new URL("./managed-azure-observation.mjs", import.meta.url), "utf8"); const api = source.slice(0, source.indexOf("async function runSyntheticCli"));
    expect(source.match(/^import .*$/gm)).toEqual(['import { isProxy } from "node:util/types";']); expect(source.match(/\bexport\b/g)).toHaveLength(1); expect(api).not.toMatch(/process\.|console\.|Date\.|fetch\(|node:fs|node:child_process|spawn\(|prisma|DATABASE_URL|AZURE_CLIENT|secret/i); expect(source.indexOf("args[3] !== SENTINEL")).toBeLessThan(source.indexOf("const verifier ="));
    const script = fileURLToPath(new URL("./managed-azure-observation.mjs", import.meta.url)); const args = ["--synthetic", "--dry-run", "--deployment-id", "00000000-0000-4000-8000-000000000001", "--release-sha", SHA, "--window-minutes", "5"];
    const success = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }); const summary = JSON.parse(success.stdout); expect(success.status).toBe(0); expect(success.stderr).toBe(""); expect(summary).toMatchObject({ status: "VERIFIED", targetClass: "azure-managed", deploymentId: args[3], expectedSha: SHA, expectedImageTag: `sha-${SHA}`, ignoredSiblingCount: 0 }); expect(Object.keys(summary)).toEqual(["status", "targetClass", "deploymentId", "expectedSha", "expectedImageTag", "windowStartUnixMs", "windowEndUnixMs", "web", "worker", "ignoredSiblingCount"]);
    for (const changed of [[...args.slice(0, 3), uuidAt(999), ...args.slice(4)], args.map((value, index) => index === 5 ? SHA.toUpperCase() : value), args.map((value, index) => index === 7 ? "31" : value), args.filter((value) => value !== "--dry-run")]) { const blocked = spawnSync(process.execPath, [script, ...changed], { encoding: "utf8" }); expect(blocked.status).not.toBe(0); expect(blocked.stdout).toBe(""); }
  });

  it("locks the workflow to manual sentinel-only synthetic least-privilege execution", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/managed-azure-release.yml", import.meta.url), "utf8");
    expect(workflow.match(/workflow_dispatch:/g)).toHaveLength(1); expect(workflow.match(/uses: [^\n]+/g)).toEqual(["uses: actions/checkout@v5", "uses: actions/setup-node@v5"]); expect(workflow.match(/00000000-0000-4000-8000-000000000001/g)).toHaveLength(2); expect(workflow).toContain("node-version: 22.22.0");
    expect(workflow).toContain("permissions:\n  contents: read\n"); expect(workflow).toContain("cancel-in-progress: false"); expect(workflow).toContain("--synthetic --dry-run"); expect(workflow).toContain('type: choice\n        default: "5"');
    expect(workflow).not.toMatch(/workflow_call:|\n\s+push:|pull_request:|schedule:|repository_dispatch:|workflow_run:|deployment_id:|subscription_id:|resource_group:|app_name:|environment:|secrets\.|vars\.|id-token:|azure\/login|\baz\s|artifact|telemetry|fleet-release-runner|verified.release/i);
  });
});
