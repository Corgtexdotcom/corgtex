import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import * as atomic from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedEntry } from "./tenant-purge-owned-collection-kernel";
import { createTenantPurgeOwnedSchema } from "./tenant-purge-owned-schema-kernel";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector,
  type TenantPurgeOwnedVector,
} from "./tenant-purge-owned-vector-kernel";
const capture = atomic.captureAuthorizedTenantPurgeManifestValues;
const A = "11111111-1111-4111-8111-111111111111"; const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333"; const SHA = "a".repeat(40);
type Mode = "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE";
function vector(values: readonly unknown[]): TenantPurgeOwnedVector<unknown> {
  let result = createTenantPurgeOwnedVector<unknown>(values.length);
  for (let index = 0; index < values.length; index += 1)
    result = pushTenantPurgeOwnedVector(result, values[index]);
  return result;
}
function record(fields: readonly (readonly [string, unknown])[]): TenantPurgeOwnedVector<unknown> {
  return vector(fields.map(([name, value]) => createTenantPurgeOwnedEntry(name, value)));
}
function topology(mode: Mode): TenantPurgeOwnedVector<unknown> {
  const workspace = record([
    ["id", C], ["managedDeploymentIds", vector([B])],
    ["trialIds", vector(mode === "SELF_SERVE_TRIAL_WORKSPACE" ? [A] : [])],
  ]);
  const deployment = record([
    ["id", B], ["managedWorkspaceId", C],
    ["accountId", mode === "ACCOUNT_WORKSPACE" ? A : null],
    ["primaryAccountIds", vector([])], ["sharedResourceAmbiguous", false],
    ["hasManagedReleaseLease", false], ["hasProviderCutover", false],
    ["hasClientMigration", false],
  ]);
  const account = mode === "ACCOUNT_WORKSPACE" ? record([
    ["id", A], ["deploymentIds", vector([B])], ["primaryDeploymentId", null]]) : null;
  const trial = mode === "SELF_SERVE_TRIAL_WORKSPACE" ? record([
    ["id", A], ["workspaceId", C], ["expired", true]]) : null;
  return record([
    ["capturedAt", 0], ["workspace", workspace], ["deployment", deployment],
    ["account", account], ["trial", trial],
  ]);
}
function root(mode: Mode, changed: Record<string, unknown> = {}): TenantPurgeOwnedVector<unknown> {
  const target = mode === "ACCOUNT_WORKSPACE" ? record([
    ["mode", mode], ["accountId", A], ["deploymentId", B], ["workspaceId", C],
  ]) : record([["mode", mode], ["trialId", A], ["deploymentId", B], ["workspaceId", C]]);
  return record([
    ["target", changed.target ?? target],
    ["capabilitySha", changed.capabilitySha ?? SHA],
    ["redactionKeyBytes", changed.redactionKeyBytes ?? vector(new Array(32).fill(7))],
    ["policies", changed.policies ?? record([
      ["pageSize", 1], ["maxPagesPerModel", 2],
      ["maxEvidenceItems", 3], ["cacheMaxTtlSeconds", 0],
    ])],
    ["topology", changed.topology ?? topology(mode)],
    ["suppliedBlockers", changed.suppliedBlockers ?? vector([])],
  ]);
}
async function fixed(operation: Promise<unknown>, status: 400 | 403, code: string): Promise<AppError> {
  try { await operation; } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status, code });
    expect(Object.isFrozen(error)).toBe(true);
    return error as AppError;
  }
  throw new Error("Expected fixed error");
}
function expectFrozenPropertyless(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length") expectFrozenPropertyless((value as Record<PropertyKey, unknown>)[key]);
  }
}
describe("tenant purge atomic capture contract", () => {
  it("prepares successful account and trial callbacks once with no receiver or arguments", async () => {
    for (const mode of ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"] as const) {
      const owned = root(mode);
      let calls = 0;
      let receiver: unknown = null;
      let argumentCount = -1;
      const callback = function (this: unknown): Promise<TenantPurgeOwnedVector<unknown>> {
        calls += 1;
        receiver = this;
        argumentCount = arguments.length;
        return Promise.resolve(owned);
      };
      const result = await capture(true, mode, callback);
      expect({ calls, receiver, argumentCount }).toEqual({ calls: 1, receiver: undefined, argumentCount: 0 });
      expect(result.target.mode).toBe(mode);
      expect(result.blockers).toEqual([]);
      expectFrozenPropertyless(result);
    }
  });
  it("checks private authority before hostile mode, callback identity, or reader topology", async () => {
    let getterCount = 0;
    let callbackCount = 0;
    const reader = Object.create(null, {
      readTopology: { get: () => { getterCount += 1; throw new Error("read"); } },
    });
    const hostileMode = new Proxy({}, { get: () => { throw new Error("mode"); } });
    const denied = await fixed(capture(false, hostileMode, reader), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED");
    const deniedAgain = await fixed(
      capture(null, hostileMode, () => { callbackCount += 1; }),
      403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED",
    );
    expect({ getterCount, callbackCount }).toEqual({ getterCount: 0, callbackCount: 0 });
    expect(deniedAgain).not.toBe(denied);
    await fixed(capture(true, hostileMode, reader), 400, "TENANT_PURGE_CONTRACT_INVALID");
    expect(getterCount).toBe(0);
  });
  it("rejects reader shapes without access and preserves the captured callable identity", async () => {
    let getterCount = 0;
    const legacy = Object.create(null, {
      isTargetAuthorized: { get: () => { getterCount += 1; return true; } },
      readTopology: { get: () => { getterCount += 1; return root("ACCOUNT_WORKSPACE"); } },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [legacy, {}, revoked.proxy, null, 1]) {
      await fixed(capture(true, "ACCOUNT_WORKSPACE", input), 400, "TENANT_PURGE_CONTRACT_INVALID");
    }
    expect(getterCount).toBe(0);
    let resolve!: (value: TenantPurgeOwnedVector<unknown>) => void;
    let outer = () => new Promise<TenantPurgeOwnedVector<unknown>>((done) => { resolve = done; });
    const original = outer;
    const pending = capture(true, "ACCOUNT_WORKSPACE", outer);
    outer = () => Promise.reject(new Error("replacement"));
    resolve(root("ACCOUNT_WORKSPACE"));
    expect((await pending).target.mode).toBe("ACCOUNT_WORKSPACE");
    expect(outer).not.toBe(original);
  });
  it("treats only literal false as target forbidden and rejects malformed fulfilled values", async () => {
    const first = await fixed(
      capture(true, "ACCOUNT_WORKSPACE", async () => false), 403, "TENANT_PURGE_TARGET_FORBIDDEN",
    );
    const second = await fixed(
      capture(true, "ACCOUNT_WORKSPACE", async () => false), 403, "TENANT_PURGE_TARGET_FORBIDDEN",
    );
    expect(second).not.toBe(first);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const invalid = [
      null, true, undefined, new Boolean(false), {}, [], revoked.proxy, new Date(),
      new Uint8Array(32), createTenantPurgeOwnedSchema("uuid"),
      createTenantPurgeOwnedEntry("x", 1), createTenantPurgeOwnedVector(0),
    ];
    for (const value of invalid) {
      await fixed(
        capture(true, "ACCOUNT_WORKSPACE", async () => value as never), 400, "TENANT_PURGE_CONTRACT_INVALID",
      );
    }
    await fixed(
      capture(true, "ACCOUNT_WORKSPACE", async () => root("SELF_SERVE_TRIAL_WORKSPACE")),
      400, "TENANT_PURGE_CONTRACT_INVALID",
    );
  });
  it("replaces synchronous, rejected, thenable, reentrant, and replay failures", async () => {
    const callerErrors: unknown[] = [new Error("ordinary"), 7, new AppError(409, "CALLER", "caller")];
    for (const callerError of callerErrors) {
      const error = await fixed(
        capture(true, "ACCOUNT_WORKSPACE", () => { throw callerError; }),
        400, "TENANT_PURGE_CONTRACT_INVALID",
      );
      expect(error).not.toBe(callerError);
    }
    const rejected = () => Promise.reject(new Error("rejected"));
    const replayOne = await fixed(capture(true, "ACCOUNT_WORKSPACE", rejected), 400, "TENANT_PURGE_CONTRACT_INVALID");
    const replayTwo = await fixed(capture(true, "ACCOUNT_WORKSPACE", rejected), 400, "TENANT_PURGE_CONTRACT_INVALID");
    expect(replayTwo).not.toBe(replayOne);
    const hostileThenable = { then: () => { throw new Error("then"); } };
    await fixed(
      capture(true, "ACCOUNT_WORKSPACE", () => hostileThenable), 400, "TENANT_PURGE_CONTRACT_INVALID",
    );
    const nested = () => capture(true, "ACCOUNT_WORKSPACE", rejected) as never;
    await fixed(capture(true, "ACCOUNT_WORKSPACE", nested), 400, "TENANT_PURGE_CONTRACT_INVALID");
  });
  it("uses only the producer owned snapshot and rejects raw mutable slots", async () => {
    let target = { raw: true }; let capabilitySha = "b".repeat(40);
    let key = [1, 2, 3]; let policies = { pageSize: 999 };
    let rawTopology = { capturedAt: 1 }; let currentRoot = root("ACCOUNT_WORKSPACE");
    const capturedRoot = currentRoot;
    const result = await capture(true, "ACCOUNT_WORKSPACE", async () => {
      target = { raw: false }; capabilitySha = "c".repeat(40);
      key = []; policies = { pageSize: 1 };
      rawTopology = { capturedAt: 2 }; currentRoot = createTenantPurgeOwnedVector(0);
      return Promise.resolve(capturedRoot);
    });
    expect(result.capabilitySha).toBe(SHA);
    const mutableSources = { target, capabilitySha, key, policies, rawTopology, currentRoot };
    expect(Object.values(mutableSources)).not.toContain(capturedRoot);
    for (const changed of [{ redactionKeyBytes: [] }, { topology: {} }, { policies: {} }]) {
      await fixed(
        capture(true, "ACCOUNT_WORKSPACE", async () => root("ACCOUNT_WORKSPACE", changed)),
        400, "TENANT_PURGE_CONTRACT_INVALID",
      );
    }
  });
  it("survives poisoned globals, prototypes, setters, serialization, and AppError hierarchy", async () => {
    const appToJson = Object.getOwnPropertyDescriptor(AppError.prototype, "toJSON");
    let forbidden: unknown;
    const originals = {
      apply: Reflect.apply, freeze: Object.freeze, define: Object.defineProperty,
      construct: Reflect.construct, error: globalThis.Error,
    };
    try {
      const operation = capture(true, "ACCOUNT_WORKSPACE", async () => {
        const poisoned = { configurable: true, set: () => { throw new Error("set"); } };
        originals.define(Object.prototype, "tenantPurgePoison", poisoned);
        originals.define(Array.prototype, "tenantPurgePoison", poisoned);
        originals.define(AppError.prototype, "toJSON", {
          configurable: true, value: () => { throw new Error("json"); },
        });
        Reflect.apply = (() => { throw new Error("apply"); }) as typeof Reflect.apply;
        Object.freeze = (() => { throw new Error("freeze"); }) as typeof Object.freeze;
        Object.defineProperty = (() => { throw new Error("define"); }) as typeof Object.defineProperty;
        Reflect.construct = (() => { throw new Error("construct"); }) as typeof Reflect.construct;
        globalThis.Error = (() => { throw new originals.error("error"); }) as unknown as ErrorConstructor;
        return root("ACCOUNT_WORKSPACE");
      });
      expect((await operation).target.mode).toBe("ACCOUNT_WORKSPACE");
      try { await capture(true, "ACCOUNT_WORKSPACE", async () => false); }
      catch (error) { forbidden = error; }
    } finally {
      Reflect.apply = originals.apply;
      Object.freeze = originals.freeze;
      Object.defineProperty = originals.define;
      Reflect.construct = originals.construct;
      globalThis.Error = originals.error;
      delete (Object.prototype as Record<string, unknown>).tenantPurgePoison;
      delete (Array.prototype as unknown as Record<string, unknown>).tenantPurgePoison;
      if (appToJson) originals.define(AppError.prototype, "toJSON", appToJson);
      else delete (AppError.prototype as unknown as Record<string, unknown>).toJSON;
    }
    expect(forbidden).toMatchObject({ status: 403, code: "TENANT_PURGE_TARGET_FORBIDDEN" });
    expect(Object.isFrozen(forbidden)).toBe(true);
  });
  it("returns fresh deterministic detached graphs when replaying a root and callback", async () => {
    const owned = root("ACCOUNT_WORKSPACE");
    const callback = async () => owned;
    const first = await capture(true, "ACCOUNT_WORKSPACE", callback);
    const second = await capture(true, "ACCOUNT_WORKSPACE", callback);
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expectFrozenPropertyless(first);
    expect(JSON.stringify(first)).not.toContain("revision");
    expect(JSON.stringify(first)).not.toContain("Promise");
  });
  it("proves the exact surface, dependency hashes, call counts, and forbidden absence", () => {
    expect(Object.keys(atomic)).toEqual(["captureAuthorizedTenantPurgeManifestValues"]);
    expect(capture).toHaveLength(3);
    const directory = new URL(".", import.meta.url);
    const source = readFileSync(new URL("tenant-purge-atomic-capture-contract.ts", directory), "utf8");
    const hashes: Record<string, string> = {
      "tenant-purge-observation-kernel.ts": "6541628f1133924ca96818c2b50bc416d23d3d428176fc100562ae3c776aea2c",
      "tenant-purge-value-scalar-kernel.ts": "1fb3bc13f0f033d95880bf908cc578ebf1eaf7f2a4a96aa4f41ad88b889c8e71",
      "tenant-purge-owned-vector-kernel.ts": "0eabb8e24774af290a89f48ec564c4cf3dbf8f69828eb8c1b83e49ba7abc73ba",
      "tenant-purge-owned-schema-kernel.ts": "26cf6047bb8ccca99979420287abffacc7e96b3cbf5cd341293d221d867e1875",
      "tenant-purge-owned-collection-kernel.ts": "dfc191e036f76c134a142438356fbfe53ec5a2997fbc0b5ce982c63904270f7e",
      "tenant-purge-manifest-contract.ts": "43995085c03eb7c5abf8a2eb79cd49dcca8257b2a8f9868e935dce37b7365062",
    };
    for (const [file, expected] of Object.entries(hashes)) {
      const bytes = readFileSync(new URL(file, directory));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }
    expect(source.match(/APPLY\(callback/g)).toHaveLength(1);
    expect(source.match(/prepareTenantPurgeManifestValues\(/g)).toHaveLength(1);
    for (const forbidden of [
      "isTargetAuthorized", "readTopology", "revision", "session", "Reflect.ownKeys",
      "Uint8Array", "Date", "Prisma", "HMAC", "digest", "provider", "route", "index.ts",
    ]) expect(source).not.toContain(forbidden);
  });
});
