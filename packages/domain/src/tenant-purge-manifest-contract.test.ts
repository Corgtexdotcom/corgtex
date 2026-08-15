import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  TENANT_PURGE_BLOCKER_CODES,
  normalizeTenantPurgeManifestValues,
  type TenantPurgeManifestPolicies,
  type TenantPurgeTarget,
  type TenantPurgeTopologyInput,
} from "./tenant-purge-manifest-contract";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPLOYMENT = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-000000000003";
const TRIAL = "00000000-0000-4000-8000-000000000004";
const OTHER = "00000000-0000-4000-8000-000000000005";
const SHA = "a".repeat(40);
const POLICIES = { pageSize: 250, maxPagesPerModel: 1_000, maxEvidenceItems: 100_000, cacheMaxTtlSeconds: 3_600 } as const;
const accountTarget = { mode: "ACCOUNT_WORKSPACE", accountId: ACCOUNT, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE } as const;
const trialTarget = { mode: "SELF_SERVE_TRIAL_WORKSPACE", trialId: TRIAL, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE } as const;

function topology(target: TenantPurgeTarget): TenantPurgeTopologyInput {
  return {
    capturedAt: new Date("2026-08-14T12:00:00.000Z"),
    workspace: { id: target.workspaceId, managedDeploymentIds: [target.deploymentId], trialIds: target.mode === "SELF_SERVE_TRIAL_WORKSPACE" ? [target.trialId] : [] },
    deployment: { id: target.deploymentId, managedWorkspaceId: target.workspaceId, accountId: target.mode === "ACCOUNT_WORKSPACE" ? target.accountId : null, primaryAccountIds: [], sharedResourceAmbiguous: false, hasManagedReleaseLease: false, hasProviderCutover: false, hasClientMigration: false },
    account: target.mode === "ACCOUNT_WORKSPACE" ? { id: target.accountId, deploymentIds: [target.deploymentId], primaryDeploymentId: null } : null,
    trial: target.mode === "SELF_SERVE_TRIAL_WORKSPACE" ? { id: target.trialId, workspaceId: target.workspaceId, expired: true } : null,
    blockers: [],
  };
}

function input(overrides: Record<string, unknown> = {}) { return { target: accountTarget, capabilitySha: SHA, redactionKey: new Uint8Array(32).fill(7), privateAuthority: true, policies: POLICIES, topology: topology(accountTarget), ...overrides }; }
function caught(operation: () => unknown): AppError { try { operation(); } catch (error) { expect(error).toBeInstanceOf(AppError); expect(Object.isFrozen(error)).toBe(true); return error as AppError; } throw new Error("expected failure"); }
function expectError(operation: () => unknown, status = 400, code = "TENANT_PURGE_CONTRACT_INVALID") { const error = caught(operation); expect(error).toMatchObject({ status, code }); return error; }
function expectFrozenGraph(value: unknown, seen = new Set<object>()) { if (typeof value !== "object" || value === null || seen.has(value)) return; seen.add(value); expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach((child) => expectFrozenGraph(child, seen)); }

describe("tenant purge manifest normalization", () => {
  it("accepts only closed targets, primitive identifiers, literal authority, and bounded policies", () => {
    expect(normalizeTenantPurgeManifestValues(input()).target).toEqual(accountTarget);
    expect(normalizeTenantPurgeManifestValues(input({ target: trialTarget, topology: topology(trialTarget) })).target).toEqual(trialTarget);
    expect(normalizeTenantPurgeManifestValues(input({ policies: { ...POLICIES, cacheMaxTtlSeconds: 0 } })).policies.cacheMaxTtlSeconds).toBe(0);
    for (const target of [{ ...accountTarget, trialId: TRIAL }, { ...accountTarget, accountId: ACCOUNT.toUpperCase() }, { ...trialTarget, mode: "unknown" }, { ...trialTarget, accountId: ACCOUNT }, { ...accountTarget, workspaceId: new String(WORKSPACE) }]) expectError(() => normalizeTenantPurgeManifestValues(input({ target })));
    for (const capabilitySha of [new String(SHA), SHA.toUpperCase(), "a".repeat(39)]) expectError(() => normalizeTenantPurgeManifestValues(input({ capabilitySha })));
    for (const policies of [{ ...POLICIES, pageSize: 0 }, { ...POLICIES, maxPagesPerModel: 1_001 }, { ...POLICIES, maxEvidenceItems: Infinity }, { ...POLICIES, cacheMaxTtlSeconds: -1 }, { ...POLICIES, pageSize: new Number(2) }, { ...POLICIES, extra: 1 }]) expectError(() => normalizeTenantPurgeManifestValues(input({ policies })));
  });

  it("observes authority once and denies before every protected observation", () => {
    const trace: string[] = []; const source = input({ privateAuthority: false });
    const denied = new Proxy(source, { ownKeys() { trace.push("ownKeys"); throw new Error("enumerated"); }, getPrototypeOf() { trace.push("prototype"); throw new Error("prototype"); }, getOwnPropertyDescriptor(value, key) { trace.push(`descriptor:${String(key)}`); if (key !== "privateAuthority") throw new Error("protected"); return Reflect.getOwnPropertyDescriptor(value, key); } });
    expectError(() => normalizeTenantPurgeManifestValues(denied), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED"); expect(trace).toEqual(["descriptor:privateAuthority"]);
    let reads = 0; const allowed = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "privateAuthority") reads += 1; return Reflect.getOwnPropertyDescriptor(value, key); } });
    expect(normalizeTenantPurgeManifestValues(allowed).target).toEqual(accountTarget); expect(reads).toBe(1);
    let getterCalls = 0; const accessor = input(); Object.defineProperty(accessor, "privateAuthority", { enumerable: true, get() { getterCalls += 1; return true; } });
    expectError(() => normalizeTenantPurgeManifestValues(accessor), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED"); expect(getterCalls).toBe(0);
  });

  it("normalizes stale, reentrant, forged, revoked, and primitive trap errors per invocation", () => {
    const prior403 = expectError(() => normalizeTenantPurgeManifestValues(input({ privateAuthority: false })), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED");
    const prior400 = expectError(() => normalizeTenantPurgeManifestValues(input({ capabilitySha: "bad" })));
    for (const replay of [prior403, prior400]) { const hostile = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") throw replay; return Reflect.getOwnPropertyDescriptor(value, key); } }); const outer = expectError(() => normalizeTenantPurgeManifestValues(hostile)); expect(outer).not.toBe(replay); expect(outer.message).toBe("Invalid tenant purge contract input."); }
    let nested: AppError | undefined; const reentrant = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") { nested = expectError(() => normalizeTenantPurgeManifestValues(input({ capabilitySha: "nested-bad" }))); throw nested; } return Reflect.getOwnPropertyDescriptor(value, key); } });
    const outer = expectError(() => normalizeTenantPurgeManifestValues(reentrant)); expect(outer).not.toBe(nested);
    for (const thrown of [new AppError(200, "FORGED", "forged"), new Proxy(new AppError(201, "WRAPPED", "wrapped"), {}), new Error("ordinary"), "primitive"]) { const hostile = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") throw thrown; return Reflect.getOwnPropertyDescriptor(value, key); } }); expectError(() => normalizeTenantPurgeManifestValues(hostile)); }
    const revocable = Proxy.revocable(input(), {}); revocable.revoke(); expectError(() => normalizeTenantPurgeManifestValues(revocable.proxy));
    const repeated = [expectError(() => normalizeTenantPurgeManifestValues(input({ capabilitySha: "a" }))), expectError(() => normalizeTenantPurgeManifestValues(input({ capabilitySha: "a" })))]; expect(repeated[0]).not.toBe(repeated[1]);
  });

  it("uses captured security intrinsics after caller traps mutate ambient methods", () => {
    const originalFreeze = Object.freeze; let denial: unknown;
    try { const denied = new Proxy(input({ privateAuthority: false }), { getOwnPropertyDescriptor(value, key) { if (key === "privateAuthority") Object.freeze = (() => undefined) as unknown as typeof Object.freeze; return Reflect.getOwnPropertyDescriptor(value, key); } }); try { normalizeTenantPurgeManifestValues(denied); } catch (error) { denial = error; } } finally { Object.freeze = originalFreeze; }
    expect(denial).toMatchObject({ status: 403, code: "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED" }); expect(Object.isFrozen(denial)).toBe(true);
    const originalTest = RegExp.prototype.test; let validation: unknown;
    try { const hostile = new Proxy(input({ capabilitySha: "bad" }), { getOwnPropertyDescriptor(value, key) { if (key === "target") RegExp.prototype.test = () => true; return Reflect.getOwnPropertyDescriptor(value, key); } }); try { normalizeTenantPurgeManifestValues(hostile); } catch (error) { validation = error; } } finally { RegExp.prototype.test = originalTest; }
    expect(validation).toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(validation)).toBe(true);
    const originalIndex = Object.getOwnPropertyDescriptor(Array.prototype, "0"); let setterCalls = 0; let normalized: ReturnType<typeof normalizeTenantPurgeManifestValues> | undefined;
    try { const hostile = new Proxy(input(), { getOwnPropertyDescriptor(value, key) { if (key === "target") Object.defineProperty(Array.prototype, "0", { configurable: true, set() { setterCalls += 1; } }); return Reflect.getOwnPropertyDescriptor(value, key); } }); normalized = normalizeTenantPurgeManifestValues(hostile); } finally { if (originalIndex) Object.defineProperty(Array.prototype, "0", originalIndex); else delete (Array.prototype as unknown as Record<string, unknown>)["0"]; }
    expect(setterCalls).toBe(0); expect(normalized?.redactionKeyBytes).toEqual(new Array(32).fill(7)); expect(normalized?.topology.workspace?.managedDeploymentIds).toEqual([DEPLOYMENT]);
  });

  it("uses exact data descriptors and one target snapshot without invoking getters", () => {
    let descriptorReads = 0; const target = new Proxy({ ...accountTarget }, { get() { throw new Error("property get"); }, getOwnPropertyDescriptor(value, key) { descriptorReads += 1; return Reflect.getOwnPropertyDescriptor(value, key); } });
    expect(normalizeTenantPurgeManifestValues(input({ target })).target).toEqual(accountTarget); expect(descriptorReads).toBe(4);
    const nullPrototype = Object.assign(Object.create(null), accountTarget); expect(normalizeTenantPurgeManifestValues(input({ target: nullPrototype })).target).toEqual(accountTarget);
    let getterCalls = 0; const accessor = { ...accountTarget }; Object.defineProperty(accessor, "workspaceId", { enumerable: true, get() { getterCalls += 1; return WORKSPACE; } });
    const hidden = { ...accountTarget }; Object.defineProperty(hidden, "hidden", { value: true });
    const symbol = { ...accountTarget }; Object.defineProperty(symbol, Symbol("extra"), { value: true });
    const nonPlain = Object.assign(Object.create({ inherited: true }), accountTarget);
    const drift = new Proxy({ ...accountTarget }, { getOwnPropertyDescriptor(value, key) { return key === "workspaceId" ? undefined : Reflect.getOwnPropertyDescriptor(value, key); } });
    for (const supplied of [accessor, hidden, symbol, nonPlain, drift]) expectError(() => normalizeTenantPurgeManifestValues(input({ target: supplied })));
    expect(getterCalls).toBe(0);
  });

  it("bounds and intrinsically copies only genuine Uint8Array values", () => {
    expect(normalizeTenantPurgeManifestValues(input({ redactionKey: new Uint8Array(32) })).redactionKeyBytes).toHaveLength(32);
    expect(normalizeTenantPurgeManifestValues(input({ redactionKey: new Uint8Array(64) })).redactionKeyBytes).toHaveLength(64);
    for (const redactionKey of [new Uint8Array(31), new Uint8Array(65), new Int8Array(32), new Uint8ClampedArray(32), new DataView(new ArrayBuffer(32)), new Array(32), new Proxy(new Uint8Array(32), {})]) expectError(() => normalizeTenantPurgeManifestValues(input({ redactionKey })));
    let instanceCalls = 0; class Key extends Uint8Array {} const key = new Key(32).fill(4); Object.defineProperties(key, { set: { get() { instanceCalls += 1; throw new Error("set"); } }, [Symbol.iterator]: { get() { instanceCalls += 1; throw new Error("iterator"); } } });
    const result = normalizeTenantPurgeManifestValues(input({ redactionKey: key })); key.fill(9); expect(result.redactionKeyBytes).toEqual(new Array(32).fill(4)); expect(instanceCalls).toBe(0);
    const oversized = new Uint8Array(65); Object.defineProperty(oversized, Symbol.iterator, { get() { instanceCalls += 1; throw new Error("copy attempted"); } }); expectError(() => normalizeTenantPurgeManifestValues(input({ redactionKey: oversized }))); expect(instanceCalls).toBe(0);
  });

  it("bounds arrays before expansion and requires canonical length plus index keys", () => {
    const trace: string[] = []; const oversized = new Proxy(new Array(100_001), { ownKeys() { trace.push("ownKeys"); throw new Error("enumerated"); }, getPrototypeOf() { trace.push("prototype"); throw new Error("prototype"); }, getOwnPropertyDescriptor(value, key) { trace.push(`descriptor:${String(key)}`); if (key !== "length") throw new Error("index"); return Reflect.getOwnPropertyDescriptor(value, key); } });
    const oversizedTopology = topology(accountTarget); oversizedTopology.blockers = oversized as never; expectError(() => normalizeTenantPurgeManifestValues(input({ topology: oversizedTopology }))); expect(trace).toEqual(["descriptor:length"]);
    let indexReads = 0; const substituted = new Proxy(["LEGAL_HOLD"], { ownKeys() { return ["length", "extra"]; }, getOwnPropertyDescriptor(value, key) { if (key === "0") indexReads += 1; return Reflect.getOwnPropertyDescriptor(value, key); } });
    const substitutedTopology = topology(accountTarget); substitutedTopology.blockers = substituted as never; expectError(() => normalizeTenantPurgeManifestValues(input({ topology: substitutedTopology }))); expect(indexReads).toBe(0);
    for (const keys of [["length"], ["length", "01"], ["length", Symbol("0")]]) { const supplied = topology(accountTarget); supplied.blockers = new Proxy(["LEGAL_HOLD"], { ownKeys() { return keys; } }) as never; expectError(() => normalizeTenantPurgeManifestValues(input({ topology: supplied }))); }
    for (const badLength of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) { const fake = {}; Object.defineProperty(fake, "length", { value: badLength }); const supplied = topology(accountTarget); supplied.blockers = fake as never; expectError(() => normalizeTenantPurgeManifestValues(input({ topology: supplied }))); }
    const bounded = topology(accountTarget); bounded.blockers = Array.from({ length: 100_000 }, (_, index) => `UNKNOWN_${index}`) as never; expectError(() => normalizeTenantPurgeManifestValues(input({ topology: bounded })));
  });

  it("rejects holes, accessors, extras, prototype drift, and duplicates in every list", () => {
    const mutations: Array<(value: TenantPurgeTopologyInput, list: string[]) => void> = [(value, list) => { value.workspace!.managedDeploymentIds = list; }, (value, list) => { value.workspace!.trialIds = list; }, (value, list) => { value.deployment!.primaryAccountIds = list; }, (value, list) => { value.account!.deploymentIds = list; }, (value, list) => { value.blockers = list as never; }];
    for (const [index, mutate] of mutations.entries()) { const sparse = topology(accountTarget); const hole = [DEPLOYMENT]; hole.length = 2; mutate(sparse, hole); expectError(() => normalizeTenantPurgeManifestValues(input({ topology: sparse }))); const duplicate = topology(accountTarget); mutate(duplicate, index === 4 ? ["LEGAL_HOLD", "LEGAL_HOLD"] : [DEPLOYMENT, DEPLOYMENT]); expectError(() => normalizeTenantPurgeManifestValues(input({ topology: duplicate }))); }
    let getters = 0; const accessor = topology(accountTarget); Object.defineProperty(accessor.workspace!.managedDeploymentIds, 0, { get() { getters += 1; return DEPLOYMENT; } });
    const extra = topology(accountTarget); (extra.workspace!.trialIds as string[] & { extra?: boolean }).extra = true;
    const symbol = topology(accountTarget); Object.defineProperty(symbol.deployment!.primaryAccountIds, Symbol("extra"), { value: true });
    const drift = topology(accountTarget); Object.setPrototypeOf(drift.account!.deploymentIds, null);
    for (const supplied of [accessor, extra, symbol, drift, { ...topology(accountTarget), blockers: ["UNKNOWN"] }]) expectError(() => normalizeTenantPurgeManifestValues(input({ topology: supplied })));
    expect(getters).toBe(0);
  });

  it("normalizes exact topology and closed blockers while rejecting malformed dates and fields", () => {
    const all = topology(accountTarget); all.blockers = [...TENANT_PURGE_BLOCKER_CODES]; expect(normalizeTenantPurgeManifestValues(input({ topology: all })).suppliedBlockers).toEqual(TENANT_PURGE_BLOCKER_CODES);
    const empty = { ...topology(accountTarget), workspace: null, deployment: null, account: null, trial: null }; expect(normalizeTenantPurgeManifestValues(input({ topology: empty })).topology).toMatchObject({ workspace: null, deployment: null, account: null, trial: null });
    class Later extends Date {} const dateWithExtra = new Date(); Object.defineProperty(dateWithExtra, "hidden", { value: true });
    const invalid = [{ ...topology(accountTarget), capturedAt: new Date("invalid") }, { ...topology(accountTarget), capturedAt: { toISOString: () => "fake" } }, { ...topology(accountTarget), capturedAt: new Later() }, { ...topology(accountTarget), capturedAt: dateWithExtra }, { ...topology(accountTarget), deployment: { ...topology(accountTarget).deployment!, hasProviderCutover: 1 } }, { ...topology(accountTarget), account: { ...topology(accountTarget).account!, id: ACCOUNT.toUpperCase() } }];
    for (const supplied of invalid) expectError(() => normalizeTenantPurgeManifestValues(input({ topology: supplied })));
  });

  it("copies and recursively freezes every normalized value without retaining caller objects", () => {
    const target = { ...accountTarget } as { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }; const key = new Uint8Array(32).fill(7); const policies = { ...POLICIES } as TenantPurgeManifestPolicies; const source = topology(accountTarget); source.blockers = ["LEGAL_HOLD"];
    const result = normalizeTenantPurgeManifestValues(input({ target, redactionKey: key, policies, topology: source }));
    target.accountId = OTHER; key.fill(9); policies.pageSize = 1; source.capturedAt.setTime(0); source.workspace!.managedDeploymentIds = [OTHER]; source.blockers = [];
    expect(result).toMatchObject({ target: accountTarget, redactionKeyBytes: new Array(32).fill(7), policies: POLICIES, topology: { capturedAt: "2026-08-14T12:00:00.000Z", workspace: { managedDeploymentIds: [DEPLOYMENT] } }, suppliedBlockers: ["LEGAL_HOLD"] });
    expect(result.target).not.toBe(target); expect(result.policies).not.toBe(policies); expect(result.topology).not.toBe(source); expectFrozenGraph(result);
    expect(() => (result.suppliedBlockers as string[]).push("RETENTION_HOLD")).toThrow(); expect(() => (result.topology.workspace!.managedDeploymentIds as string[]).push(OTHER)).toThrow();
  });
});
