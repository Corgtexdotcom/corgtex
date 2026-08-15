import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  TENANT_PURGE_BLOCKER_CODES,
  prepareTenantPurgeManifestValues,
  type TenantPurgeManifestPolicies,
  type TenantPurgeManifestValueInput,
  type TenantPurgeTarget,
  type TenantPurgeTopologyInput,
} from "./tenant-purge-manifest-contract";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPLOYMENT = "00000000-0000-4000-8000-000000000002";
const WORKSPACE = "00000000-0000-4000-8000-000000000003";
const TRIAL = "00000000-0000-4000-8000-000000000004";
const SIBLING = "00000000-0000-4000-8000-000000000005";
const OTHER = "00000000-0000-4000-8000-000000000006";
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

function input(overrides: Record<string, unknown> = {}): TenantPurgeManifestValueInput {
  return { target: accountTarget, capabilitySha: SHA, redactionKey: new Uint8Array(32).fill(7), privateAuthority: true, policies: POLICIES, topology: topology(accountTarget), ...overrides } as never;
}

function expectCode(operation: () => unknown, status: number, code = "TENANT_PURGE_CONTRACT_INVALID") {
  try { operation(); throw new Error("expected failure"); } catch (error) { expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ status, code }); }
}

function expectFrozenGraph(value: unknown, seen = new Set<object>()) {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value); expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach((child) => expectFrozenGraph(child, seen));
}

describe("tenant purge manifest value contract", () => {
  it("accepts only exact tuples, primitive SHA, literal authority, bounded policies, and 32-64 byte keys", () => {
    expect(prepareTenantPurgeManifestValues(input()).target).toEqual(accountTarget);
    expect(prepareTenantPurgeManifestValues(input({ target: trialTarget, topology: topology(trialTarget) })).target).toEqual(trialTarget);
    expect(prepareTenantPurgeManifestValues(input({ redactionKey: new Uint8Array(64), policies: { ...POLICIES, cacheMaxTtlSeconds: 0 } })).redactionKeyBytes).toHaveLength(64);
    for (const redactionKey of [new Uint8Array(31), new Uint8Array(65)]) expectCode(() => prepareTenantPurgeManifestValues(input({ redactionKey })), 400);
    for (const target of [{ ...accountTarget, trialId: TRIAL }, { ...accountTarget, accountId: ACCOUNT.toUpperCase() }, { ...trialTarget, mode: "UNKNOWN" }, { ...trialTarget, accountId: ACCOUNT }]) expectCode(() => prepareTenantPurgeManifestValues(input({ target })), 400);
    for (const capabilitySha of [new String(SHA), SHA.toUpperCase(), "a".repeat(39)]) expectCode(() => prepareTenantPurgeManifestValues(input({ capabilitySha })), 400);
    for (const policies of [{ ...POLICIES, pageSize: 0 }, { ...POLICIES, cacheMaxTtlSeconds: Infinity }, { ...POLICIES, extra: 1 }]) expectCode(() => prepareTenantPurgeManifestValues(input({ policies })), 400);
    const trace: string[] = [];
    const deniedSource = input({ privateAuthority: false }); Object.defineProperty(deniedSource, "topology", { enumerable: true, get() { trace.push("topology getter"); return topology(accountTarget); } });
    const denied = new Proxy(deniedSource, { ownKeys() { trace.push("ownKeys"); throw new Error("enumerated"); }, getPrototypeOf() { trace.push("prototype"); throw new Error("prototype read"); }, getOwnPropertyDescriptor(source, key) { trace.push(`descriptor:${String(key)}`); if (key !== "privateAuthority") throw new Error("protected descriptor read"); return Reflect.getOwnPropertyDescriptor(source, key); } });
    expectCode(() => prepareTenantPurgeManifestValues(denied), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED"); expect(trace).toEqual(["descriptor:privateAuthority"]);
    let authorityReads = 0; const allowed = new Proxy(input(), { getOwnPropertyDescriptor(source, key) { if (key === "privateAuthority") authorityReads += 1; return Reflect.getOwnPropertyDescriptor(source, key); } });
    expect(prepareTenantPurgeManifestValues(allowed).target).toEqual(accountTarget); expect(authorityReads).toBe(1);
  });

  it("caps and intrinsically copies redaction bytes before any user iteration", () => {
    let iteratorCalls = 0;
    const key = new Uint8Array(32).fill(4);
    Object.defineProperty(key, Symbol.iterator, { get() { iteratorCalls += 1; throw new Error("iterator accessed"); } });
    const result = prepareTenantPurgeManifestValues(input({ redactionKey: key }));
    key.fill(9); expect(result.redactionKeyBytes).toEqual(new Array(32).fill(4)); expect(iteratorCalls).toBe(0);
    const oversized = new Uint8Array(65);
    Object.defineProperty(oversized, Symbol.iterator, { get() { iteratorCalls += 1; throw new Error("oversized copy attempted"); } });
    expectCode(() => prepareTenantPurgeManifestValues(input({ redactionKey: oversized })), 400); expect(iteratorCalls).toBe(0);
  });

  it("uses one descriptor snapshot and rejects accessors, symbols, hidden fields, and Proxy drift", () => {
    let descriptorReads = 0;
    const target = new Proxy({ ...accountTarget }, { get() { throw new Error("value getter used"); }, getOwnPropertyDescriptor(source, key) { descriptorReads += 1; return Reflect.getOwnPropertyDescriptor(source, key); } });
    expect(prepareTenantPurgeManifestValues(input({ target })).target).toEqual(accountTarget); expect(descriptorReads).toBe(4);
    const drift = new Proxy({ ...accountTarget }, { getOwnPropertyDescriptor(source, key) { return key === "workspaceId" ? undefined : Reflect.getOwnPropertyDescriptor(source, key); } });
    expectCode(() => prepareTenantPurgeManifestValues(input({ target: drift })), 400);
    let getterCalls = 0;
    const accessor = topology(accountTarget);
    Object.defineProperty(accessor, "workspace", { enumerable: true, get() { getterCalls += 1; return topology(accountTarget).workspace; } });
    const hidden = topology(accountTarget); Object.defineProperty(hidden.workspace!, "hidden", { value: true });
    const symbol = topology(accountTarget); Object.defineProperty(symbol, Symbol("extra"), { value: true });
    const extra = topology(accountTarget) as TenantPurgeTopologyInput & { extra?: boolean }; extra.extra = true;
    const nonPlain = topology(accountTarget); nonPlain.account = Object.assign(Object.create({ inherited: true }), nonPlain.account);
    for (const supplied of [accessor, hidden, symbol, extra, nonPlain]) expectCode(() => prepareTenantPurgeManifestValues(input({ topology: supplied })), 400);
    const accessorInput = input(); Object.defineProperty(accessorInput, "capabilitySha", { enumerable: true, get() { getterCalls += 1; return SHA; } });
    expectCode(() => prepareTenantPurgeManifestValues(accessorInput), 400);
    expect(getterCalls).toBe(0);
  });

  it("rejects sparse, huge, accessor, extra, and duplicate values in every list", () => {
    const sparse = (value: string) => { const result = [value]; result.length = 2; return result; };
    const mutations: Array<(value: TenantPurgeTopologyInput, list: string[]) => void> = [
      (value, list) => { value.workspace!.managedDeploymentIds = list; }, (value, list) => { value.workspace!.trialIds = list; },
      (value, list) => { value.deployment!.primaryAccountIds = list; }, (value, list) => { value.account!.deploymentIds = list; },
      (value, list) => { value.blockers = list as never; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const supplied = topology(accountTarget); mutate(supplied, sparse(DEPLOYMENT)); expectCode(() => prepareTenantPurgeManifestValues(input({ topology: supplied })), 400);
      if (index < 4) { const duplicate = topology(accountTarget); mutate(duplicate, [DEPLOYMENT, DEPLOYMENT]); expectCode(() => prepareTenantPurgeManifestValues(input({ topology: duplicate })), 400); }
    }
    let getterCalls = 0;
    const accessor = topology(accountTarget); Object.defineProperty(accessor.workspace!.managedDeploymentIds, 0, { get() { getterCalls += 1; return DEPLOYMENT; } });
    const extra = topology(accountTarget); (extra.workspace!.trialIds as string[] & { extra?: boolean }).extra = true;
    const symbol = topology(accountTarget); Object.defineProperty(symbol.deployment!.primaryAccountIds, Symbol("extra"), { value: true });
    for (const supplied of [accessor, extra, symbol, { ...topology(accountTarget), blockers: new Array(2 ** 32 - 1) }, { ...topology(accountTarget), blockers: ["UNKNOWN"] }, { ...topology(accountTarget), blockers: ["LEGAL_HOLD", "LEGAL_HOLD"] }]) expectCode(() => prepareTenantPurgeManifestValues(input({ topology: supplied })), 400);
    expect(getterCalls).toBe(0);
    const trace: string[] = []; const oversized = new Proxy(new Array(100_001), { ownKeys() { trace.push("ownKeys"); throw new Error("enumerated"); }, getPrototypeOf() { trace.push("prototype"); throw new Error("prototype read"); }, getOwnPropertyDescriptor(source, key) { trace.push(`descriptor:${String(key)}`); if (key !== "length") throw new Error("index descriptor read"); return Reflect.getOwnPropertyDescriptor(source, key); }, get() { trace.push("index"); throw new Error("index read"); } });
    const oversizedTopology = topology(accountTarget); oversizedTopology.blockers = oversized as never;
    expectCode(() => prepareTenantPurgeManifestValues(input({ topology: oversizedTopology })), 400); expect(trace).toEqual(["descriptor:length"]);
  });

  it("normalizes exact topology primitives and fails closed on malformed values", () => {
    const hidden = topology(accountTarget); Object.defineProperty(hidden.workspace!, "id", { value: WORKSPACE, enumerable: false });
    const invalid = [{ ...topology(accountTarget), capturedAt: new Date("invalid") }, { ...topology(accountTarget), capturedAt: { toISOString: () => "fake" } },
      { ...topology(accountTarget), deployment: { ...topology(accountTarget).deployment!, hasProviderCutover: 1 } }, { ...topology(accountTarget), account: { ...topology(accountTarget).account!, id: new String(ACCOUNT) } }, hidden];
    for (const supplied of invalid) expectCode(() => prepareTenantPurgeManifestValues(input({ topology: supplied })), 400);
  });

  it("derives the complete deterministic blocker vocabulary for both modes", () => {
    const unsafe = topology(accountTarget);
    unsafe.workspace = { id: WORKSPACE, managedDeploymentIds: [DEPLOYMENT, SIBLING], trialIds: [TRIAL] };
    unsafe.deployment = { ...unsafe.deployment!, primaryAccountIds: [OTHER], sharedResourceAmbiguous: true, hasManagedReleaseLease: true, hasProviderCutover: true, hasClientMigration: true };
    unsafe.account = { id: ACCOUNT, deploymentIds: [DEPLOYMENT, SIBLING], primaryDeploymentId: SIBLING };
    unsafe.blockers = ["LEGAL_HOLD", "RETENTION_HOLD", "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION", "ACTIVE_CREDENTIAL", "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING", "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED"];
    expect(prepareTenantPurgeManifestValues(input({ topology: unsafe })).blockers).toEqual(TENANT_PURGE_BLOCKER_CODES.filter((code) => !["TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "TRIAL_NOT_EXPIRED"].includes(code)));
    const trialUnsafe = topology(trialTarget); trialUnsafe.trial!.expired = false; trialUnsafe.deployment!.accountId = ACCOUNT; trialUnsafe.account = { id: ACCOUNT, deploymentIds: [DEPLOYMENT], primaryDeploymentId: null };
    expect(prepareTenantPurgeManifestValues(input({ target: trialTarget, topology: trialUnsafe })).blockers).toEqual(["LINKED_ACCOUNT", "TRIAL_NOT_EXPIRED"]);
    const mismatch = topology(accountTarget); mismatch.workspace!.id = OTHER;
    expect(prepareTenantPurgeManifestValues(input({ topology: mismatch })).blockers).toContain("TARGET_TUPLE_MISMATCH");
  });

  it("deep-copies and recursively freezes the complete prepared result", () => {
    const target = { ...accountTarget } as { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string }; const redactionKey = new Uint8Array(32).fill(7); const policies = { ...POLICIES } as TenantPurgeManifestPolicies; const source = topology(accountTarget);
    const result = prepareTenantPurgeManifestValues(input({ target, redactionKey, policies, topology: source }));
    target.accountId = OTHER; redactionKey.fill(9); policies.pageSize = 1; source.capturedAt.setTime(0); source.workspace!.managedDeploymentIds = [SIBLING]; source.deployment!.sharedResourceAmbiguous = true;
    expect(result).toMatchObject({ target: accountTarget, redactionKeyBytes: new Array(32).fill(7), policies: POLICIES, topology: { capturedAt: "2026-08-14T12:00:00.000Z", workspace: { managedDeploymentIds: [DEPLOYMENT] }, deployment: { sharedResourceAmbiguous: false } } });
    expectFrozenGraph(result); expect(() => (result.blockers as string[]).push("LEGAL_HOLD")).toThrow(); expect(() => (result.topology.workspace!.managedDeploymentIds as string[]).push(SIBLING)).toThrow();
  });
});
