import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contract from "./tenant-purge-manifest-contract";
import { createTenantPurgeOwnedEntry } from "./tenant-purge-owned-collection-kernel";
import { createTenantPurgeOwnedSchema } from "./tenant-purge-owned-schema-kernel";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
const { TENANT_PURGE_BLOCKER_CODES, normalizeTenantPurgeManifestValues: normalize, prepareTenantPurgeManifestValues: prepare } = contract;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(40);
function vector(values: readonly unknown[], maximum = values.length): TenantPurgeOwnedVector<unknown> {
  let result = createTenantPurgeOwnedVector<unknown>(maximum);
  for (let index = 0; index < values.length; index += 1) result = pushTenantPurgeOwnedVector(result, values[index]);
  return result;
}

function record(fields: readonly (readonly [string, unknown])[]): TenantPurgeOwnedVector<unknown> {
  let result = createTenantPurgeOwnedVector<unknown>(fields.length);
  for (let index = 0; index < fields.length; index += 1) result = pushTenantPurgeOwnedVector(result, createTenantPurgeOwnedEntry(fields[index][0], fields[index][1]));
  return result;
}

function policies(pageSize: unknown = 1): TenantPurgeOwnedVector<unknown> {
  return record([["pageSize", pageSize], ["maxPagesPerModel", 1000], ["maxEvidenceItems", 100_000], ["cacheMaxTtlSeconds", 0]]);
}

function topology(workspace: unknown = null): TenantPurgeOwnedVector<unknown> {
  return record([["capturedAt", 0], ["workspace", workspace], ["deployment", null], ["account", null], ["trial", null]]);
}

type RootOptions = { innerMode?: unknown; target?: unknown; sha?: unknown; key?: unknown; policies?: unknown; topology?: unknown; blockers?: unknown };
function root(mode: "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE", options: RootOptions = {}): TenantPurgeOwnedVector<unknown> {
  const target = options.target ?? (mode === "ACCOUNT_WORKSPACE"
    ? record([["mode", options.innerMode ?? mode], ["accountId", A], ["deploymentId", B], ["workspaceId", C]])
    : record([["mode", options.innerMode ?? mode], ["trialId", A], ["deploymentId", B], ["workspaceId", C]]));
  return record([["target", target], ["capabilitySha", options.sha ?? SHA], ["redactionKeyBytes", options.key ?? vector(new Array(32).fill(7))], ["policies", options.policies ?? policies()], ["topology", options.topology ?? topology()], ["suppliedBlockers", options.blockers ?? vector([])]]);
}

function fullTopology(): TenantPurgeOwnedVector<unknown> {
  const deployments = vector([B]); const workspace = record([["id", C], ["managedDeploymentIds", deployments], ["trialIds", vector([A])]]);
  const deployment = record([["id", B], ["managedWorkspaceId", C], ["accountId", A], ["primaryAccountIds", vector([A])], ["sharedResourceAmbiguous", true], ["hasManagedReleaseLease", true], ["hasProviderCutover", false], ["hasClientMigration", true]]);
  const account = record([["id", A], ["deploymentIds", deployments], ["primaryDeploymentId", B]]);
  const trial = record([["id", A], ["workspaceId", C], ["expired", false]]);
  return record([["capturedAt", 8_640_000_000_000_000], ["workspace", workspace], ["deployment", deployment], ["account", account], ["trial", trial]]);
}

function nullableTopology(): TenantPurgeOwnedVector<unknown> {
  const workspace = record([["id", C], ["managedDeploymentIds", vector([])], ["trialIds", vector([])]]); const deployment = record([["id", B], ["managedWorkspaceId", null], ["accountId", null], ["primaryAccountIds", vector([])], ["sharedResourceAmbiguous", false], ["hasManagedReleaseLease", false], ["hasProviderCutover", false], ["hasClientMigration", false]]);
  const account = record([["id", A], ["deploymentIds", vector([])], ["primaryDeploymentId", null]]); const trial = record([["id", A], ["workspaceId", null], ["expired", true]]);
  return record([["capturedAt", -8_640_000_000_000_000], ["workspace", workspace], ["deployment", deployment], ["account", account], ["trial", trial]]);
}

function workspaceNode(id = C, deployments: readonly unknown[] = [B], trials: readonly unknown[] = []): TenantPurgeOwnedVector<unknown> {
  return record([["id", id], ["managedDeploymentIds", vector(deployments)], ["trialIds", vector(trials)]]);
}

type DeploymentOptions = { id?: string; workspaceId?: string | null; accountId?: string | null; primaryAccounts?: readonly unknown[]; shared?: boolean; lease?: boolean; cutover?: boolean; migration?: boolean };
function deploymentNode(options: DeploymentOptions = {}): TenantPurgeOwnedVector<unknown> {
  return record([["id", options.id ?? B], ["managedWorkspaceId", options.workspaceId === undefined ? C : options.workspaceId], ["accountId", options.accountId === undefined ? A : options.accountId], ["primaryAccountIds", vector(options.primaryAccounts ?? [])], ["sharedResourceAmbiguous", options.shared ?? false], ["hasManagedReleaseLease", options.lease ?? false], ["hasProviderCutover", options.cutover ?? false], ["hasClientMigration", options.migration ?? false]]);
}

function accountNode(id = A, deployments: readonly unknown[] = [B], primary: string | null = null): TenantPurgeOwnedVector<unknown> {
  return record([["id", id], ["deploymentIds", vector(deployments)], ["primaryDeploymentId", primary]]);
}

function trialNode(id = A, workspaceId: string | null = C, expired = true): TenantPurgeOwnedVector<unknown> {
  return record([["id", id], ["workspaceId", workspaceId], ["expired", expired]]);
}

function graph(workspace: unknown, deployment: unknown, account: unknown, trial: unknown): TenantPurgeOwnedVector<unknown> {
  return record([["capturedAt", 0], ["workspace", workspace], ["deployment", deployment], ["account", account], ["trial", trial]]);
}

function accountGraph(workspace: unknown = workspaceNode(), deployment: unknown = deploymentNode(), account: unknown = accountNode(), trial: unknown = null): TenantPurgeOwnedVector<unknown> {
  return graph(workspace, deployment, account, trial);
}

function trialGraph(workspace: unknown = workspaceNode(C, [B], [A]), deployment: unknown = deploymentNode({ accountId: null }), account: unknown = null, trial: unknown = trialNode()): TenantPurgeOwnedVector<unknown> {
  return graph(workspace, deployment, account, trial);
}

function expectFixedError(operation: () => unknown, status = 400): unknown {
  try { operation(); } catch (error) { expect(error).toMatchObject({ status, code: status === 403 ? "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED" : "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error; }
  throw new Error("expected failure");
}

describe("tenant purge manifest canonicalizer", () => {
  it("normalizes both closed modes, nullable variants, endpoints, and every supplied blocker", () => {
    const account = normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: fullTopology(), blockers: vector(TENANT_PURGE_BLOCKER_CODES) }));
    const trial = normalize(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { key: vector(new Array(64).fill(255)), topology: nullableTopology() }));
    expect(account.target).toEqual({ mode: "ACCOUNT_WORKSPACE", accountId: A, deploymentId: B, workspaceId: C });
    expect(account.topology).toMatchObject({ capturedAt: "+275760-09-13T00:00:00.000Z", workspace: { id: C, managedDeploymentIds: [B], trialIds: [A] }, deployment: { id: B, sharedResourceAmbiguous: true, hasClientMigration: true }, account: { id: A }, trial: { expired: false } });
    expect(account.suppliedBlockers).toEqual(TENANT_PURGE_BLOCKER_CODES); expect(account.policies).toEqual({ pageSize: 1, maxPagesPerModel: 1000, maxEvidenceItems: 100_000, cacheMaxTtlSeconds: 0 });
    expect(trial.target).toEqual({ mode: "SELF_SERVE_TRIAL_WORKSPACE", trialId: A, deploymentId: B, workspaceId: C }); expect(trial.redactionKeyBytes).toHaveLength(64); expect(trial.topology).toMatchObject({ capturedAt: "-271821-04-20T00:00:00.000Z", deployment: { accountId: null, managedWorkspaceId: null }, account: { primaryDeploymentId: null }, trial: { workspaceId: null, expired: true } });
  });

  it("checks literal authority first and creates fresh fixed failures without touching hostile mode/root", () => {
    let traps = 0; const hostile = new Proxy({}, { get: () => { traps += 1; throw new Error(); }, ownKeys: () => { traps += 1; throw new Error(); }, getPrototypeOf: () => { traps += 1; throw new Error(); } });
    const first = expectFixedError(() => normalize(false, hostile, hostile), 403); const second = expectFixedError(() => normalize(null, hostile, hostile), 403);
    expect(first).not.toBe(second); expect(traps).toBe(0); expectFixedError(() => normalize(true, hostile, hostile)); expect(traps).toBe(0);
  });

  it("rejects raw, forged, revoked, cross-kind, reordered, and mode-mismatched roots without traps", () => {
    let ownKeys = 0; const raw = new Proxy(Object.create(null), { ownKeys: () => { ownKeys += 1; return new Array(100_002).fill("x"); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [
      {},
      [],
      raw,
      revoked.proxy,
      new Date(),
      new Uint8Array(32),
      createTenantPurgeOwnedSchema("uuid"),
    ]) expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", value));
    expect(ownKeys).toBe(0); expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { innerMode: "SELF_SERVE_TRIAL_WORKSPACE" })));
    expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", vector([createTenantPurgeOwnedEntry("capabilitySha", SHA)])));
  });

  it("rejects hostile raw values at every representative nested position before caller code", () => {
    let traps = 0; const raw = new Proxy({}, { get: () => { traps += 1; throw new Error(); }, ownKeys: () => { traps += 1; throw new Error(); }, getOwnPropertyDescriptor: () => { traps += 1; throw new Error(); }, getPrototypeOf: () => { traps += 1; throw new Error(); } });
    const rawWorkspace = record([["id", C], ["managedDeploymentIds", raw], ["trialIds", vector([])]]); const rawDate = record([["capturedAt", raw], ["workspace", null], ["deployment", null], ["account", null], ["trial", null]]);
    const reorderedPolicies = record([["maxPagesPerModel", 1], ["pageSize", 1], ["maxEvidenceItems", 1], ["cacheMaxTtlSeconds", 0]]);
    for (const options of [
      { target: raw },
      { sha: raw },
      { key: raw },
      { policies: raw },
      { topology: raw },
      { blockers: raw },
      { topology: topology(rawWorkspace) },
      { topology: rawDate },
      { policies: reorderedPolicies },
    ]) {
      expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", options)));
      expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", options)));
    }
    const prior = expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { sha: Symbol("x") }))); expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { sha: prior }))); expect(traps).toBe(0);
  });

  it("enforces scalar, policy, entry, topology, and unique-list contracts without coercion", () => {
    const badBytes = new Array(32).fill(0); badBytes[31] = 256; const badDate = record([["capturedAt", Number.MAX_SAFE_INTEGER], ["workspace", null], ["deployment", null], ["account", null], ["trial", null]]);
    const cases = [
      root("ACCOUNT_WORKSPACE", { sha: "A".repeat(40) }),
      root("ACCOUNT_WORKSPACE", { sha: new String(SHA) }),
      root("ACCOUNT_WORKSPACE", { policies: policies(0) }),
      root("ACCOUNT_WORKSPACE", { policies: policies(1.5) }),
      root("ACCOUNT_WORKSPACE", { policies: policies(Infinity) }),
      root("ACCOUNT_WORKSPACE", { policies: record([["pageSize", 1], ["maxPagesPerModel", 1], ["maxEvidenceItems", 1], ["cacheMaxTtlSeconds", 0], ["extra", 1]]) }),
      root("ACCOUNT_WORKSPACE", { key: vector(new Array(31).fill(0)) }),
      root("ACCOUNT_WORKSPACE", { key: vector(new Array(65).fill(0)) }),
      root("ACCOUNT_WORKSPACE", { key: vector(badBytes) }),
      root("ACCOUNT_WORKSPACE", { topology: badDate }),
      root("ACCOUNT_WORKSPACE", { target: record([["mode", "ACCOUNT_WORKSPACE"], ["accountId", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"], ["deploymentId", B], ["workspaceId", C]]) }),
      root("ACCOUNT_WORKSPACE", { topology: topology(record([["id", C], ["managedDeploymentIds", vector([B, B])], ["trialIds", vector([])]])) }),
    ];
    for (const value of cases) expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", value));
    const mismatch = normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: topology(record([["id", A], ["managedDeploymentIds", vector([C])], ["trialIds", vector([B])]])) }));
    expect(mismatch.topology.workspace).toEqual({ id: A, managedDeploymentIds: [C], trialIds: [B] });
  });

  it("accepts exactly the blocker vocabulary once and preserves order", () => {
    const reversedValues = new Array<string>(23); for (let index = 0; index < 23; index += 1) reversedValues[index] = TENANT_PURGE_BLOCKER_CODES[22 - index];
    const over = new Array<string>(24); for (let index = 0; index < 23; index += 1) over[index] = TENANT_PURGE_BLOCKER_CODES[index]; over[23] = "UNKNOWN";
    expect(normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { blockers: vector(reversedValues) })).suppliedBlockers).toEqual(reversedValues);
    for (const blockers of [
      vector(["UNKNOWN"]),
      vector(["ACTIVE_JOB", "ACTIVE_JOB"]),
      vector(over, 24),
      vector([Symbol("x")]),
      vector([new String("ACTIVE_JOB")]),
      ["ACTIVE_JOB"],
    ]) expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { blockers })));
  });

  it("shares the exact 100000-slot root budget and fails before excess materialization", { timeout: 30_000 }, () => {
    const ids = (length: number) => { const values = new Array<string>(length); for (let index = 0; index < length; index += 1) values[index] = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; values[0] = B; return vector(values, 100_000); };
    const workspace = (length: number) => record([["id", C], ["managedDeploymentIds", ids(length)], ["trialIds", vector([])]]);
    const atLimit = prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: topology(workspace(99_902)) }));
    expect(atLimit.topology.workspace?.managedDeploymentIds).toHaveLength(99_902); expect(atLimit.blockers).toEqual(["TARGET_TUPLE_MISMATCH", "LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]);
    expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: topology(workspace(99_903)) })));
  });

  it("returns fresh detached deeply frozen propertyless graphs under ambient poisoning", () => {
    const input = root("ACCOUNT_WORKSPACE", { topology: fullTopology(), blockers: vector(["ACTIVE_JOB"]) }); const keys = [[Object.prototype, "toJSON"], [Object.prototype, "target"], [Array.prototype, "toJSON"], [Array.prototype, "0"], [Set.prototype, "has"]] as const; const descriptors = keys.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
    let first!: ReturnType<typeof normalize>; let second!: ReturnType<typeof normalize>; let json = "";
    try { Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: () => "poison" }); Object.defineProperty(Object.prototype, "target", { configurable: true, set: () => { throw new Error("setter"); } }); Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => "poison" }); Object.defineProperty(Array.prototype, "0", { configurable: true, set: () => { throw new Error("setter"); } }); Object.defineProperty(Set.prototype, "has", { configurable: true, value: () => false });
      first = normalize(true, "ACCOUNT_WORKSPACE", input); second = normalize(true, "ACCOUNT_WORKSPACE", input); json = JSON.stringify(first);
    } finally { for (let index = 0; index < keys.length; index += 1) descriptors[index] ? Object.defineProperty(keys[index][0], keys[index][1], descriptors[index]!) : delete (keys[index][0] as Record<string, unknown>)[keys[index][1]]; }
    const walk = (value: unknown): void => { if (value && typeof value === "object") { expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true); for (const key of Reflect.ownKeys(value)) if (key !== "length") walk((value as Record<PropertyKey, unknown>)[key]); } };
    walk(first); expect(first).toEqual(second); expect(first).not.toBe(second); expect(first.target).not.toBe(second.target); expect(JSON.parse(json)).toMatchObject({ capabilitySha: SHA, suppliedBlockers: ["ACTIVE_JOB"] });
  });

  it("locks the runtime surface, direct dependency hashes, and absence of raw ingress or later capability", () => {
    expect(Object.keys(contract).sort()).toEqual(["TENANT_PURGE_BLOCKER_CODES", "TENANT_PURGE_TARGET_MODES", "normalizeTenantPurgeManifestValues", "prepareTenantPurgeManifestValues"].sort());
    for (const vocabulary of [contract.TENANT_PURGE_TARGET_MODES, TENANT_PURGE_BLOCKER_CODES]) { expect(Object.getPrototypeOf(vocabulary)).toBeNull(); expect(Object.isFrozen(vocabulary)).toBe(true); }
    const expected: Record<string, string> = { "tenant-purge-observation-kernel.ts": "6541628f1133924ca96818c2b50bc416d23d3d428176fc100562ae3c776aea2c", "tenant-purge-value-scalar-kernel.ts": "1fb3bc13f0f033d95880bf908cc578ebf1eaf7f2a4a96aa4f41ad88b889c8e71", "tenant-purge-owned-vector-kernel.ts": "0eabb8e24774af290a89f48ec564c4cf3dbf8f69828eb8c1b83e49ba7abc73ba", "tenant-purge-owned-schema-kernel.ts": "26cf6047bb8ccca99979420287abffacc7e96b3cbf5cd341293d221d867e1875", "tenant-purge-owned-collection-kernel.ts": "dfc191e036f76c134a142438356fbfe53ec5a2997fbc0b5ce982c63904270f7e" };
    for (const [file, hash] of Object.entries(expected)) expect(createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")).toBe(hash);
    const source = readFileSync(new URL("tenant-purge-manifest-contract.ts", import.meta.url), "utf8"); expect(source).not.toMatch(/Reflect\.ownKeys|Object\.(?:keys|values)|for\s*\([^)]*\bin\b|captureTenantPurgeRootFields\((?:ownedValues|privateAuthority)|\basync\b|derive|provider|reader|adapter/); expect(source.match(/copyTenantPurgeOwnedCollection\(/g)).toHaveLength(1);
  });

  it("prepares exact blocker-free account and trial values in digest-ready order", () => {
    const account = prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph() }));
    const trial = prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph() }));
    expect(Reflect.ownKeys(account)).toEqual(["schemaVersion", "target", "capabilitySha", "redactionKeyBytes", "policies", "topology", "blockers"]);
    expect(account).toMatchObject({ schemaVersion: 1, target: { mode: "ACCOUNT_WORKSPACE", accountId: A, deploymentId: B, workspaceId: C }, capabilitySha: SHA, blockers: [] });
    expect(trial).toMatchObject({ schemaVersion: 1, target: { mode: "SELF_SERVE_TRIAL_WORKSPACE", trialId: A, deploymentId: B, workspaceId: C }, blockers: [] });
    expect(Reflect.ownKeys(account)).not.toContain("suppliedBlockers");
    expect(JSON.stringify(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph() })))).toBe(JSON.stringify(account));
    const walk = (value: unknown): void => { if (value && typeof value === "object") { expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true); for (const key of Reflect.ownKeys(value)) if (key !== "length") walk((value as Record<PropertyKey, unknown>)[key]); } };
    walk(account); walk(trial);
  });

  it("derives common tuple, linkage, routing, and deployment-state blockers exactly", () => {
    const cases: readonly [TenantPurgeOwnedVector<unknown>, readonly string[]][] = [
      [accountGraph(null), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(A)), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(), null), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(), deploymentNode({ id: C })), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(), deploymentNode({ workspaceId: A })), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(C, [])), ["TARGET_TUPLE_MISMATCH"]],
      [accountGraph(workspaceNode(C, [B, "44444444-4444-4444-8444-444444444444"])), ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]],
      [accountGraph(workspaceNode(), deploymentNode({ primaryAccounts: [A] })), ["PRIMARY_ROUTING"]],
      [accountGraph(workspaceNode(), deploymentNode(), accountNode(A, [B], B)), ["PRIMARY_ROUTING"]],
      [accountGraph(workspaceNode(), deploymentNode({ shared: true })), ["SHARED_RESOURCE_AMBIGUITY"]],
      [accountGraph(workspaceNode(), deploymentNode({ lease: true })), ["MANAGED_RELEASE_LEASE"]],
      [accountGraph(workspaceNode(), deploymentNode({ cutover: true })), ["PROVIDER_CUTOVER"]],
      [accountGraph(workspaceNode(), deploymentNode({ migration: true })), ["CLIENT_MIGRATION"]],
    ];
    for (let index = 0; index < cases.length; index += 1) expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: cases[index][0] })).blockers).toEqual(cases[index][1]);
  });

  it("keeps account tuple mismatches distinct from sibling and trial links", () => {
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), null) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), accountNode(C)) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode({ accountId: null })) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), accountNode(A, [])) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), accountNode(A, [B, C])) })).blockers).toEqual(["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), accountNode(A, [B], C)) })).blockers).toEqual(["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(C, [B], [A])) })).blockers).toEqual(["LINKED_TRIAL"]);
    expect(prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(), deploymentNode(), accountNode(), trialNode()) })).blockers).toEqual(["LINKED_TRIAL"]);
  });

  it("keeps trial tuple mismatches distinct from linked account, trial, and expiry state", () => {
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null }), null, null) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null }), null, trialNode(C)) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null }), null, trialNode(A, B)) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], []), deploymentNode({ accountId: null })) })).blockers).toEqual(["TARGET_TUPLE_MISMATCH"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A, C]), deploymentNode({ accountId: null })) })).blockers).toEqual(["LINKED_TRIAL"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null }), null, trialNode(A, C, false)) })).blockers).toEqual(["TRIAL_NOT_EXPIRED"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null }), accountNode()) })).blockers).toEqual(["LINKED_ACCOUNT"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: A })) })).blockers).toEqual(["LINKED_ACCOUNT"]);
    expect(prepare(true, "SELF_SERVE_TRIAL_WORKSPACE", root("SELF_SERVE_TRIAL_WORKSPACE", { topology: trialGraph(workspaceNode(C, [B], [A]), deploymentNode({ accountId: null, primaryAccounts: [A] })) })).blockers).toEqual(["LINKED_ACCOUNT", "PRIMARY_ROUTING"]);
  });

  it("closes, deduplicates, and declaration-orders all supplied and derived evidence", () => {
    const reversed = new Array<string>(23); for (let index = 0; index < 23; index += 1) reversed[index] = TENANT_PURGE_BLOCKER_CODES[22 - index];
    const all = prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(C, [B, C]), deploymentNode({ migration: true })), blockers: vector(reversed) }));
    expect(all.blockers).toEqual(TENANT_PURGE_BLOCKER_CODES); expect(all.blockers).toHaveLength(23);
    const overlap = prepare(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: accountGraph(workspaceNode(C, [B, C])), blockers: vector(["SIBLING_DEPLOYMENT", "ACTIVE_WRITE"]) }));
    expect(overlap.blockers).toEqual(["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT", "ACTIVE_WRITE"]);
  });

  it("preserves authority-first trap silence and rejects every raw bypass through prepare", () => {
    let traps = 0; const hostile = new Proxy({}, { get: () => { traps += 1; throw new Error(); }, ownKeys: () => { traps += 1; throw new Error(); }, getPrototypeOf: () => { traps += 1; throw new Error(); } });
    const first = expectFixedError(() => prepare(false, hostile, hostile), 403); const second = expectFixedError(() => prepare(null, hostile, hostile), 403); expect(first).not.toBe(second); expect(traps).toBe(0);
    expectFixedError(() => prepare(true, hostile, hostile)); expect(traps).toBe(0);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [{}, [], revoked.proxy, new Date(), new Uint8Array(32), createTenantPurgeOwnedSchema("uuid")]) expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", value));
  });

  it("stays detached and deterministic while ambient setters, Set methods, iteration, and toJSON are poisoned", () => {
    const input = root("ACCOUNT_WORKSPACE", { topology: accountGraph(), blockers: vector(["ACTIVE_JOB"]) });
    const keys = [[Object.prototype, "toJSON"], [Object.prototype, "blockers"], [Array.prototype, "toJSON"], [Array.prototype, "0"], [Set.prototype, "add"], [Set.prototype, "has"], [Array.prototype, Symbol.iterator], [globalThis, "Array"], [globalThis, "Set"]] as const;
    const descriptors = keys.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key)); let first!: ReturnType<typeof prepare>; let second!: ReturnType<typeof prepare>;
    try { Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: () => "poison" }); Object.defineProperty(Object.prototype, "blockers", { configurable: true, set: () => { throw new Error("setter"); } }); Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: () => "poison" }); Object.defineProperty(Array.prototype, "0", { configurable: true, set: () => { throw new Error("setter"); } }); Object.defineProperty(Set.prototype, "add", { configurable: true, value: () => { throw new Error("add"); } }); Object.defineProperty(Set.prototype, "has", { configurable: true, value: () => false }); Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, value: () => { throw new Error("iterator"); } }); Object.defineProperty(globalThis, "Array", { configurable: true, value: () => { throw new Error("Array"); } }); Object.defineProperty(globalThis, "Set", { configurable: true, value: () => { throw new Error("Set"); } }); first = prepare(true, "ACCOUNT_WORKSPACE", input); second = prepare(true, "ACCOUNT_WORKSPACE", input); }
    finally { for (let index = 0; index < keys.length; index += 1) descriptors[index] ? Object.defineProperty(keys[index][0], keys[index][1], descriptors[index]!) : delete (keys[index][0] as Record<PropertyKey, unknown>)[keys[index][1]]; }
    expect(first).toEqual(second); expect(first).not.toBe(second); expect(first.target).not.toBe(second.target); expect(first.blockers).toEqual(["ACTIVE_JOB"]); expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("locks normalize-once assembly, predecessor bytes, and the no-bypass/no-digest surface", () => {
    const source = readFileSync(new URL("tenant-purge-manifest-contract.ts", import.meta.url), "utf8"); const marker = "\nexport type TenantPurgePreparedManifestValues"; const predecessor = source.slice(0, source.indexOf(marker));
    expect(createHash("sha256").update(predecessor).digest("hex")).toBe("5e977ed78b6e13dacfe62b41cdb45395e284bf76288e90846d59820f57952915");
    const prepareSource = source.slice(source.indexOf("export function prepareTenantPurgeManifestValues")); expect(prepareSource.match(/normalizeTenantPurgeManifestValues\(/g)).toHaveLength(1);
    expect(prepareSource).not.toMatch(/Reflect\.ownKeys|Object\.(?:keys|values)|copyTenantPurgeOwnedCollection|captureTenantPurgeRootFields|\.sort\(|localeCompare|\b(?:digest|hmac|crypto|reader|provider|adapter|async)\b/i);
    expect(contract.prepareTenantPurgeManifestValues.constructor.name).toBe("Function"); expect(contract.prepareTenantPurgeManifestValues).toHaveLength(3);
  });
});
