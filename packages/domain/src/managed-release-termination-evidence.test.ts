import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "./errors";
import { canonicalizeManagedReleaseTerminationEvidenceV1 } from "./managed-release-termination-evidence";

const digest = "a".repeat(64);
const set = (target: object, key: PropertyKey, value: unknown) => Reflect.set(target, key, value);

function sample() {
  return {
    schemaVersion: 1,
    deploymentId: "11111111-1111-1111-1111-111111111111",
    priorLeaseId: "22222222-2222-2222-2222-222222222222",
    priorFence: 7,
    execution: { runId: "execution-1", attempt: 1, outcome: "SUCCEEDED", terminalAtUnixMs: 100 },
    workflow: { runId: "workflow-1", attempt: 2, outcome: "FAILED", terminalAtUnixMs: 110 },
    providerRoles: {
      web: {
        command: { outcome: "EXITED", exitCode: 0, signal: null, terminalAtUnixMs: 120 },
        provider: { appName: "corgtex-web", provisioningState: "SUCCEEDED", observedAtUnixMs: 131, image: `corgtexprod.azurecr.io/corgtex/web@sha256:${digest}`, revision: "corgtex-web--rev1" },
      },
      worker: {
        command: { outcome: "SIGNALED", exitCode: null, signal: "SIGTERM", terminalAtUnixMs: 130 },
        provider: { appName: "corgtex-worker", provisioningState: "FAILED", observedAtUnixMs: 132, image: `corgtexprod.azurecr.io/corgtex/worker@sha256:${digest}`, revision: "corgtex-worker--rev1" },
      },
    },
  };
}

function expectInvalid(value: unknown): AppError {
  let caught: unknown;
  try { canonicalizeManagedReleaseTerminationEvidenceV1(value); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AppError);
  expect(caught).toMatchObject({ status: 400, code: "MANAGED_RELEASE_INVALID_INPUT", message: "Managed release termination evidence is invalid." });
  return caught as AppError;
}

function reversedNullRecord(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const record = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value).reverse()) record[key] = reversedNullRecord(child);
  return record;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("canonicalizeManagedReleaseTerminationEvidenceV1", () => {
  it("reconstructs a fresh fixed-order deeply frozen graph with invocation-local state", () => {
    const input = sample();
    const first = canonicalizeManagedReleaseTerminationEvidenceV1(input);
    const second = canonicalizeManagedReleaseTerminationEvidenceV1(input);
    const reversed = canonicalizeManagedReleaseTerminationEvidenceV1(reversedNullRecord(sample()));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first));
    expect(first).not.toBe(input);
    expect(first.providerRoles.web).not.toBe(input.providerRoles.web);
    expectDeepFrozen(first);
    const before = JSON.stringify(first);
    input.execution.runId = "mutated";
    input.providerRoles.web.provider.revision = "corgtex-web--mutated";
    expect(JSON.stringify(first)).toBe(before);
  });

  it("accepts every closed union value and scalar boundary", () => {
    for (const outcome of ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]) {
      const input = sample(); input.execution.outcome = outcome;
      expect(canonicalizeManagedReleaseTerminationEvidenceV1(input).execution.outcome).toBe(outcome);
    }
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGKILL"]) {
      const input = sample(); set(input.providerRoles.web.command, "outcome", "SIGNALED");
      set(input.providerRoles.web.command, "exitCode", null); set(input.providerRoles.web.command, "signal", signal);
      expect(canonicalizeManagedReleaseTerminationEvidenceV1(input).providerRoles.web.command.signal).toBe(signal);
    }
    const input = sample();
    input.priorFence = 2_147_483_647; input.execution.attempt = 2_147_483_647;
    input.providerRoles.web.command.exitCode = 255;
    input.providerRoles.web.provider.provisioningState = "CANCELED";
    expect(canonicalizeManagedReleaseTerminationEvidenceV1(input).priorFence).toBe(2_147_483_647);
  });

  it("rejects malformed scalar, union, chronology, Azure, and excluded provenance values", () => {
    const mutations: Array<(value: ReturnType<typeof sample>) => void> = [
      (v) => set(v, "schemaVersion", 2), (v) => set(v, "deploymentId", "AAAAAAAA-1111-1111-1111-111111111111"),
      (v) => set(v, "priorLeaseId", "not-a-uuid"), (v) => set(v, "priorFence", 0), (v) => set(v, "priorFence", true),
      (v) => set(v.execution, "attempt", 1.5), (v) => set(v.execution, "runId", "bad run"), (v) => set(v.execution, "runId", `x\0${"y"}`),
      (v) => set(v.execution, "runId", "\ud800"), (v) => set(v.execution, "runId", "x".repeat(129)), (v) => set(v.execution, "outcome", "RUNNING"),
      (v) => set(v.execution, "terminalAtUnixMs", 0), (v) => set(v.workflow, "terminalAtUnixMs", Number.MAX_SAFE_INTEGER + 1),
      (v) => set(v.providerRoles.web.command, "exitCode", -1), (v) => set(v.providerRoles.web.command, "exitCode", 256),
      (v) => set(v.providerRoles.web.command, "signal", "SIGTERM"), (v) => set(v.providerRoles.worker.command, "exitCode", 0),
      (v) => set(v.providerRoles.worker.command, "signal", "SIGQUIT"), (v) => set(v.providerRoles.worker.command, "outcome", "RUNNING"),
      (v) => set(v.providerRoles.web.provider, "provisioningState", "RUNNING"), (v) => set(v.providerRoles.web.provider, "observedAtUnixMs", 130),
      (v) => set(v.providerRoles.worker.provider, "observedAtUnixMs", 120), (v) => set(v.providerRoles.worker.provider, "appName", "corgtex-web"),
      (v) => set(v.providerRoles.web.provider, "appName", `a${"b".repeat(30)}c`), (v) => set(v.providerRoles.web.provider, "appName", "web--app"),
      (v) => set(v.providerRoles.web.provider, "revision", "other-app--rev1"), (v) => set(v.providerRoles.web.provider, "revision", "corgtex-web--bad--rev"),
      (v) => set(v.providerRoles.web.provider, "image", `corgtexprod.azurecr.io/corgtex/web:latest`),
      (v) => set(v.providerRoles.web.provider, "image", `corgtexprod.azurecr.io/corgtex/worker@sha256:${digest}`),
      (v) => set(v.providerRoles.worker.provider, "image", `otherprod.azurecr.io/corgtex/worker@sha256:${digest}`),
      (v) => set(v.providerRoles.worker.provider, "image", `corgtexprod.azurecr.io/corgtex/worker@sha256:${"A".repeat(64)}`),
      (v) => set(v.providerRoles.web.command, "pid", 1), (v) => set(v.providerRoles.web.command, "output", "secret"),
      (v) => set(v.providerRoles.web.provider, "url", "https://private.invalid"), (v) => set(v, "terminationBarrierUnixMs", 130),
      (v) => set(v, "rollbackPayload", {}), (v) => set(v, "releaseVersion", "1.0.0"),
    ];
    for (const mutate of mutations) { const input = sample(); mutate(input); expectInvalid(input); }
  });

  it("rejects hostile topology before getters, traps, cycles, or aliases can be consumed", () => {
    const extra = sample(); set(extra, "extra", true);
    const missing = sample(); Reflect.deleteProperty(missing, "priorFence");
    const symbol = sample(); set(symbol, Symbol("hidden"), true);
    const hidden = sample(); Object.defineProperty(hidden, "hidden", { value: true });
    const repeated = sample(); set(repeated.providerRoles, "worker", repeated.providerRoles.web);
    const cyclic = sample(); set(cyclic, "providerRoles", cyclic);
    for (const value of [null, [], Object.create(sample()), extra, missing, symbol, hidden, repeated, cyclic]) expectInvalid(value);
    let getterCalls = 0; const accessor = sample();
    Object.defineProperty(accessor.providerRoles.web.provider, "image", { enumerable: true, get: () => { getterCalls += 1; return "secret"; } });
    expectInvalid(accessor); expect(getterCalls).toBe(0);
    const transparent = sample(); set(transparent.providerRoles.web, "provider", new Proxy(transparent.providerRoles.web.provider, {}));
    const trapping = sample(); set(trapping, "execution", new Proxy(trapping.execution, { ownKeys: () => { throw new Error("trap"); } }));
    expectInvalid(transparent); expectInvalid(trapping);
  });

  it("measures the maximum legal ASCII graph beneath the defensive 4 KiB cap", () => {
    const input = sample(); const acr = "a".repeat(50);
    input.execution.runId = "e".repeat(128); input.workflow.runId = "w".repeat(128);
    input.priorFence = 2_147_483_647; input.execution.attempt = 2_147_483_647; input.workflow.attempt = 2_147_483_647;
    input.execution.terminalAtUnixMs = Number.MAX_SAFE_INTEGER - 4; input.workflow.terminalAtUnixMs = Number.MAX_SAFE_INTEGER - 3;
    input.providerRoles.web.command.terminalAtUnixMs = Number.MAX_SAFE_INTEGER - 2; input.providerRoles.worker.command.terminalAtUnixMs = Number.MAX_SAFE_INTEGER - 2;
    set(input.providerRoles.web.command, "outcome", "SIGNALED"); set(input.providerRoles.web.command, "exitCode", null); set(input.providerRoles.web.command, "signal", "SIGTERM");
    input.providerRoles.web.provider.observedAtUnixMs = Number.MAX_SAFE_INTEGER - 1; input.providerRoles.worker.provider.observedAtUnixMs = Number.MAX_SAFE_INTEGER;
    input.providerRoles.worker.provider.provisioningState = "SUCCEEDED";
    input.providerRoles.web.provider.appName = `w${"a".repeat(30)}`; input.providerRoles.worker.provider.appName = `x${"b".repeat(30)}`;
    input.providerRoles.web.provider.revision = `${input.providerRoles.web.provider.appName}--${"r".repeat(64)}`;
    input.providerRoles.worker.provider.revision = `${input.providerRoles.worker.provider.appName}--${"s".repeat(64)}`;
    input.providerRoles.web.provider.image = `${acr}.azurecr.io/corgtex/web@sha256:${digest}`;
    input.providerRoles.worker.provider.image = `${acr}.azurecr.io/corgtex/worker@sha256:${digest}`;
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeManagedReleaseTerminationEvidenceV1(input)));
    expect(bytes.byteLength).toBe(1_643); expect(bytes.byteLength).toBeLessThan(4_096);
  });

  it("returns one sanitized error and has the required inert import/export boundary", () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const input = sample(); set(input, "credential", "Bearer private-customer-token");
    const error = expectInvalid(input);
    expect(String(error)).not.toContain("private-customer-token");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const source = readFileSync(new URL("./managed-release-termination-evidence.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1])).toEqual(["./errors", "./managed-release-proof-support"]);
    expect(source.match(/^export (?:type|function) /gm)).toHaveLength(2);
    expect(source.match(/createManagedReleaseProofReader\(invalid\)/g)).toHaveLength(1);
    expect(source).toContain("canonicalJsonBytes(canonical).byteLength > 4_096");
    expect(source).not.toMatch(/node:util|Prisma|prisma|crypto|node:fs|process\.|fetch\(|WeakSet|Object\.freeze|Reflect\.ownKeys|TextEncoder|catch\s*\(/);
  });
});
