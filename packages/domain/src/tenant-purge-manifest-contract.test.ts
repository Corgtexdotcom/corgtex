import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  TENANT_PURGE_BLOCKER_CODES,
  captureTenantPurgeManifestContract,
  type TenantPurgeContractReader,
  type TenantPurgeManifestPolicies,
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
const KEY = new Uint8Array(32).fill(7);
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

function reader(target: TenantPurgeTarget, supplied = topology(target)): TenantPurgeContractReader {
  return { async isTargetAuthorized() { return true; }, async readTopology() { return supplied; } };
}

function capture(overrides: Record<string, unknown> = {}) {
  return captureTenantPurgeManifestContract({ target: accountTarget, capabilitySha: SHA, redactionKey: KEY, privateAuthority: true, reader: reader(accountTarget), policies: POLICIES, ...overrides } as never);
}

async function expectCode(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status, code });
}

describe("tenant purge manifest contract", () => {
  it("accepts only exact canonical target tuples, primitive SHA, copied key, and bounded policies", async () => {
    expect((await capture()).target).toEqual(accountTarget);
    expect((await capture({ target: trialTarget, reader: reader(trialTarget) })).target).toEqual(trialTarget);
    expect((await capture({ policies: { ...POLICIES, cacheMaxTtlSeconds: 0 } })).policies.cacheMaxTtlSeconds).toBe(0);
    const invalidTargets = [
      { ...accountTarget, trialId: TRIAL },
      { ...accountTarget, accountId: ACCOUNT.toUpperCase() },
      { ...accountTarget, accountId: [ACCOUNT] },
      { ...trialTarget, mode: "UNKNOWN" },
      { ...trialTarget, accountId: ACCOUNT },
    ];
    for (const target of invalidTargets) await expectCode(capture({ target }), 400, "TENANT_PURGE_CONTRACT_INVALID");
    for (const capabilitySha of [new String(SHA), SHA.toUpperCase(), "a".repeat(39)]) await expectCode(capture({ capabilitySha }), 400, "TENANT_PURGE_CONTRACT_INVALID");
    await expectCode(capture({ redactionKey: new Uint8Array(31) }), 400, "TENANT_PURGE_CONTRACT_INVALID");
    for (const policies of [{ ...POLICIES, pageSize: 0 }, { ...POLICIES, cacheMaxTtlSeconds: Infinity }, { ...POLICIES, extra: 1 }]) await expectCode(capture({ policies }), 400, "TENANT_PURGE_CONTRACT_INVALID");
  });

  it("requires private and target authority before topology reads", async () => {
    const calls: string[] = [];
    const guarded: TenantPurgeContractReader = {
      async isTargetAuthorized() { calls.push("authorize"); return false; },
      async readTopology() { calls.push("topology"); return topology(accountTarget); },
    };
    await expectCode(capture({ privateAuthority: false, reader: guarded }), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED");
    expect(calls).toEqual([]);
    await expectCode(capture({ privateAuthority: 1, reader: guarded }), 403, "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED");
    expect(calls).toEqual([]);
    await expectCode(capture({ reader: guarded }), 403, "TENANT_PURGE_TARGET_FORBIDDEN");
    expect(calls).toEqual(["authorize"]);
    guarded.isTargetAuthorized = async () => { calls.push("nonboolean"); return 1; };
    await expectCode(capture({ reader: guarded }), 403, "TENANT_PURGE_TARGET_FORBIDDEN");
    expect(calls).not.toContain("topology");
  });

  it("snapshots target, SHA, key, policies, and bound reader methods before awaiting", async () => {
    const mutableTarget = { ...accountTarget } as { mode: "ACCOUNT_WORKSPACE"; accountId: string; deploymentId: string; workspaceId: string };
    const mutableKey = Uint8Array.from(KEY);
    const mutablePolicies = { ...POLICIES } as TenantPurgeManifestPolicies;
    const stableTopology = topology(accountTarget);
    let input: Parameters<typeof captureTenantPurgeManifestContract>[0];
    const mutableReader: TenantPurgeContractReader = {
      async isTargetAuthorized() {
        mutableTarget.accountId = OTHER;
        mutableKey.fill(9);
        mutablePolicies.pageSize = 1;
        input.capabilitySha = "b".repeat(40);
        input.reader.readTopology = async () => { throw new Error("rebound"); };
        return true;
      },
      async readTopology() { return stableTopology; },
    };
    input = { target: mutableTarget, capabilitySha: SHA, redactionKey: mutableKey, privateAuthority: true, reader: mutableReader, policies: mutablePolicies };
    const result = await captureTenantPurgeManifestContract(input);
    expect(result.target).toEqual(accountTarget);
    expect(result.capabilitySha).toBe(SHA);
    expect(result.redactionKeyBytes).toEqual([...KEY]);
    expect(result.policies).toEqual(POLICIES);
    expect(result.topology.capturedAt).toBe("2026-08-14T12:00:00.000Z");
  });

  it("reads top-level accessors, reader methods, and target Proxy descriptors exactly once", async () => {
    const reads: Record<string, number> = {};
    const once = <T>(name: string, value: T) => ({ enumerable: true, get() { reads[name] = (reads[name] ?? 0) + 1; if (reads[name] > 1) throw new Error(`re-read ${name}`); return value; } });
    let modeDescriptors = 0;
    const proxiedTarget = new Proxy({ ...accountTarget }, { get() { throw new Error("target value re-read"); }, getOwnPropertyDescriptor(source, key) { const descriptor = Reflect.getOwnPropertyDescriptor(source, key)!; return key === "mode" ? { ...descriptor, value: ++modeDescriptors === 1 ? "ACCOUNT_WORKSPACE" : "UNKNOWN" } : descriptor; } });
    const accessorReader = Object.defineProperties({}, {
      isTargetAuthorized: once("authorizeMethod", async () => true),
      readTopology: once("topologyMethod", async () => topology(accountTarget)),
    }) as TenantPurgeContractReader;
    const accessorInput = Object.defineProperties({}, {
      target: once("target", proxiedTarget), capabilitySha: once("sha", SHA), redactionKey: once("key", KEY),
      privateAuthority: once("authority", true), reader: once("reader", accessorReader), policies: once("policies", POLICIES),
    }) as Parameters<typeof captureTenantPurgeManifestContract>[0];
    const result = await captureTenantPurgeManifestContract(accessorInput);
    expect(result).toMatchObject({ target: accountTarget, capabilitySha: SHA, redactionKeyBytes: [...KEY] });
    expect(reads).toEqual({ target: 1, sha: 1, key: 1, authority: 1, reader: 1, policies: 1, authorizeMethod: 1, topologyMethod: 1 });
    expect(modeDescriptors).toBe(1);
  });

  it("deep-clones and recursively freezes topology and the final result", async () => {
    const source = topology(accountTarget);
    const result = await capture({ reader: reader(accountTarget, source) });
    source.workspace!.managedDeploymentIds = [SIBLING];
    source.deployment!.sharedResourceAmbiguous = true;
    expect(result.topology.workspace!.managedDeploymentIds).toEqual([DEPLOYMENT]);
    expect(result.topology.deployment!.sharedResourceAmbiguous).toBe(false);
    for (const value of [result, result.target, result.redactionKeyBytes, result.policies, result.topology, result.topology.workspace, result.topology.workspace!.managedDeploymentIds, result.topology.deployment, result.topology.account, result.blockers]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => (result.redactionKeyBytes as number[]).push(9)).toThrow();
    expect(() => (result.topology.workspace!.managedDeploymentIds as string[]).push(SIBLING)).toThrow();
  });

  it("derives the closed topology blocker vocabulary for both modes", async () => {
    const unsafe = topology(accountTarget);
    unsafe.workspace = { id: WORKSPACE, managedDeploymentIds: [DEPLOYMENT, SIBLING], trialIds: [TRIAL] };
    unsafe.deployment = { ...unsafe.deployment!, primaryAccountIds: [OTHER], sharedResourceAmbiguous: true, hasManagedReleaseLease: true, hasProviderCutover: true, hasClientMigration: true };
    unsafe.account = { id: ACCOUNT, deploymentIds: [DEPLOYMENT, SIBLING], primaryDeploymentId: SIBLING };
    unsafe.blockers = ["LEGAL_HOLD", "RETENTION_HOLD", "ACTIVE_WRITE", "ACTIVE_JOB", "ACTIVE_SESSION", "ACTIVE_INTEGRATION", "ACTIVE_CREDENTIAL", "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY", "CACHE_TTL_POLICY_MISSING", "CACHE_TTL_EXCEEDS_POLICY", "CACHE_TTL_UNBOUNDED"];
    const account = await capture({ reader: reader(accountTarget, unsafe) });
    expect(account.blockers).toEqual([...TENANT_PURGE_BLOCKER_CODES].filter((code) => !["TARGET_TUPLE_MISMATCH", "LINKED_ACCOUNT", "TRIAL_NOT_EXPIRED"].includes(code)).sort());
    const trialUnsafe = topology(trialTarget);
    trialUnsafe.trial!.expired = false;
    trialUnsafe.deployment!.accountId = ACCOUNT;
    trialUnsafe.account = { id: ACCOUNT, deploymentIds: [DEPLOYMENT], primaryDeploymentId: null };
    const trial = await capture({ target: trialTarget, reader: reader(trialTarget, trialUnsafe) });
    expect(trial.blockers).toEqual(["LINKED_ACCOUNT", "TRIAL_NOT_EXPIRED"]);
  });

  it("fails closed on malformed topology, unknown blockers, and tuple mismatch", async () => {
    const sparse = (id: string) => { const value = [id]; value.length = 2; return value; };
    let getterCalls = 0;
    const accessorTopology = topology(accountTarget);
    Object.defineProperty(accessorTopology, "workspace", { enumerable: true, get() { getterCalls += 1; return topology(accountTarget).workspace; } });
    const accessorArrayTopology = topology(accountTarget);
    Object.defineProperty(accessorArrayTopology.workspace!.managedDeploymentIds, 0, { get() { getterCalls += 1; return DEPLOYMENT; } });
    const hiddenTopology = topology(accountTarget);
    Object.defineProperty(hiddenTopology.workspace!, "hiddenExtra", { value: true });
    const symbolTopology = topology(accountTarget);
    Object.defineProperty(symbolTopology, Symbol("extra"), { value: true });
    const invalid = [
      { ...topology(accountTarget), capturedAt: new Date("invalid") },
      { ...topology(accountTarget), blockers: ["UNKNOWN"] },
      { ...topology(accountTarget), blockers: ["LEGAL_HOLD", "LEGAL_HOLD"] },
      { ...topology(accountTarget), blockers: sparse("LEGAL_HOLD") },
      { ...topology(accountTarget), workspace: { ...topology(accountTarget).workspace!, extra: true } },
      { ...topology(accountTarget), deployment: { ...topology(accountTarget).deployment!, hasProviderCutover: 1 } },
      accessorTopology, accessorArrayTopology, hiddenTopology, symbolTopology,
    ];
    for (const mutate of [
      (value: TenantPurgeTopologyInput) => { value.workspace!.managedDeploymentIds = sparse(DEPLOYMENT); },
      (value: TenantPurgeTopologyInput) => { value.workspace!.trialIds = sparse(TRIAL); },
      (value: TenantPurgeTopologyInput) => { value.deployment!.primaryAccountIds = sparse(ACCOUNT); },
      (value: TenantPurgeTopologyInput) => { value.account!.deploymentIds = sparse(DEPLOYMENT); },
    ]) { const supplied = topology(accountTarget); mutate(supplied); invalid.push(supplied); }
    for (const supplied of invalid) await expectCode(capture({ reader: reader(accountTarget, supplied as never) }), 400, "TENANT_PURGE_CONTRACT_INVALID");
    expect(getterCalls).toBe(0);
    const mismatched = topology(accountTarget);
    mismatched.workspace!.id = OTHER;
    expect((await capture({ reader: reader(accountTarget, mismatched) })).blockers).toContain("TARGET_TUPLE_MISMATCH");
  });
});
