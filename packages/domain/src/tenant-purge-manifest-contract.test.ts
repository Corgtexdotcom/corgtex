import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contract from "./tenant-purge-manifest-contract";
import { createTenantPurgeOwnedEntry } from "./tenant-purge-owned-collection-kernel";
import { createTenantPurgeOwnedSchema } from "./tenant-purge-owned-schema-kernel";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector, type TenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
const {
  TENANT_PURGE_BLOCKER_CODES,
  normalizeTenantPurgeManifestValues: normalize,
  prepareTenantPurgeManifestValues: prepare,
} = contract;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
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

type Mode = "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE";
type BlockerCode = (typeof TENANT_PURGE_BLOCKER_CODES)[number];
type PreparedOptions = {
  withoutWorkspace?: boolean; withoutDeployment?: boolean; withoutAccount?: boolean;
  withoutTrial?: boolean; includeAccount?: boolean; includeTrial?: boolean;
  workspaceId?: string; workspaceDeployments?: readonly string[];
  workspaceTrials?: readonly string[]; deploymentId?: string; managedWorkspaceId?: string | null;
  deploymentAccountId?: string | null; primaryAccountIds?: readonly string[];
  lease?: boolean; cutover?: boolean; migration?: boolean;
  shared?: boolean; accountId?: string; accountDeployments?: readonly string[];
  primaryDeploymentId?: string | null; trialId?: string; trialWorkspaceId?: string | null;
  trialExpired?: boolean;
};

function option<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function preparedTopology(mode: Mode, options: PreparedOptions = {}): TenantPurgeOwnedVector<unknown> {
  const trialMode = mode === "SELF_SERVE_TRIAL_WORKSPACE";
  const workspace = options.withoutWorkspace ? null : record([
    ["id", option(options.workspaceId, C)],
    ["managedDeploymentIds", vector(option(options.workspaceDeployments, [B]))],
    ["trialIds", vector(option(options.workspaceTrials, trialMode ? [A] : []))],
  ]);
  const deployment = options.withoutDeployment ? null : record([
    ["id", option(options.deploymentId, B)],
    ["managedWorkspaceId", option(options.managedWorkspaceId, C)],
    ["accountId", option(options.deploymentAccountId, trialMode ? null : A)],
    ["primaryAccountIds", vector(option(options.primaryAccountIds, []))],
    ["sharedResourceAmbiguous", option(options.shared, false)],
    ["hasManagedReleaseLease", option(options.lease, false)],
    ["hasProviderCutover", option(options.cutover, false)],
    ["hasClientMigration", option(options.migration, false)],
  ]);
  const accountPresent = trialMode ? options.includeAccount : !options.withoutAccount;
  const account = accountPresent ? record([
    ["id", option(options.accountId, A)],
    ["deploymentIds", vector(option(options.accountDeployments, [B]))],
    ["primaryDeploymentId", option(options.primaryDeploymentId, null)],
  ]) : null;
  const trialPresent = trialMode ? !options.withoutTrial : options.includeTrial;
  const trial = trialPresent ? record([
    ["id", option(options.trialId, A)],
    ["workspaceId", option(options.trialWorkspaceId, C)],
    ["expired", option(options.trialExpired, true)],
  ]) : null;
  return record([
    ["capturedAt", 0],
    ["workspace", workspace],
    ["deployment", deployment],
    ["account", account],
    ["trial", trial],
  ]);
}

function prepared(
  mode: Mode,
  options: PreparedOptions = {},
  blockers: readonly BlockerCode[] = [],
): contract.TenantPurgePreparedManifestValues {
  const owned = root(mode, { topology: preparedTopology(mode, options), blockers: vector(blockers) });
  return prepare(true, mode, owned);
}

function expectFrozenPropertyless(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBeNull();
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value))
    if (key !== "length") expectFrozenPropertyless((value as Record<PropertyKey, unknown>)[key]);
}

type BlockerCase = readonly [string, PreparedOptions, readonly BlockerCode[]];
const accountBlockerCases: readonly BlockerCase[] = [
  ["common absent workspace", { withoutWorkspace: true }, ["TARGET_TUPLE_MISMATCH"]],
  ["common wrong workspace", { workspaceId: A }, ["TARGET_TUPLE_MISMATCH"]],
  ["common absent deployment", { withoutDeployment: true }, ["TARGET_TUPLE_MISMATCH"]],
  ["common wrong deployment", { deploymentId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["common wrong managed link", { managedWorkspaceId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["common missing target deployment", { workspaceDeployments: [] }, ["TARGET_TUPLE_MISMATCH"]],
  ["common other workspace deployment", { workspaceDeployments: [B, D] },
    ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]],
  ["common primary account routing", { primaryAccountIds: [A] }, ["PRIMARY_ROUTING"]],
  ["common primary deployment routing", { primaryDeploymentId: B }, ["PRIMARY_ROUTING"]],
  ["common shared ambiguity", { shared: true }, ["SHARED_RESOURCE_AMBIGUITY"]],
  ["common managed lease", { lease: true }, ["MANAGED_RELEASE_LEASE"]],
  ["common provider cutover", { cutover: true }, ["PROVIDER_CUTOVER"]],
  ["common client migration", { migration: true }, ["CLIENT_MIGRATION"]],
  ["account absent account", { withoutAccount: true }, ["TARGET_TUPLE_MISMATCH"]],
  ["account wrong account", { accountId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["account wrong deployment link", { deploymentAccountId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["account missing membership", { accountDeployments: [] }, ["TARGET_TUPLE_MISMATCH"]],
  ["account other deployment", { accountDeployments: [B, D] },
    ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"]],
  ["account divergent primary", { primaryDeploymentId: D },
    ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING"]],
  ["account workspace trial", { workspaceTrials: [D] }, ["LINKED_TRIAL"]],
  ["account trial record", { includeTrial: true }, ["LINKED_TRIAL"]],
];
const trialBlockerCases: readonly BlockerCase[] = [
  ["trial absent trial", { withoutTrial: true }, ["TARGET_TUPLE_MISMATCH"]],
  ["trial wrong trial", { trialId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["trial wrong workspace link", { trialWorkspaceId: D }, ["TARGET_TUPLE_MISMATCH"]],
  ["trial missing membership", { workspaceTrials: [] }, ["TARGET_TUPLE_MISMATCH"]],
  ["trial other workspace trial", { workspaceTrials: [A, D] }, ["LINKED_TRIAL"]],
  ["trial unexpired trial", { trialExpired: false }, ["TRIAL_NOT_EXPIRED"]],
  ["trial account record", { includeAccount: true }, ["LINKED_ACCOUNT"]],
  ["trial deployment account", { deploymentAccountId: A }, ["LINKED_ACCOUNT"]],
  ["trial primary account", { primaryAccountIds: [A] }, ["LINKED_ACCOUNT", "PRIMARY_ROUTING"]],
];

function expectFixedError(operation: () => unknown, status = 400): unknown {
  try { operation(); } catch (error) { expect(error).toMatchObject({ status, code: status === 403 ? "TENANT_PURGE_PRIVATE_AUTHORITY_REQUIRED" : "TENANT_PURGE_CONTRACT_INVALID" }); expect(Object.isFrozen(error)).toBe(true); return error; }
  throw new Error("expected failure");
}

describe("tenant purge manifest canonicalizer", () => {
  it("prepares exact deterministic frozen values for both modes", () => {
    const account = prepared("ACCOUNT_WORKSPACE");
    const trial = prepared("SELF_SERVE_TRIAL_WORKSPACE");
    expect(Object.keys(account)).toEqual([
      "schemaVersion", "target", "capabilitySha", "redactionKeyBytes", "policies", "topology", "blockers",
    ]);
    expect(account.schemaVersion).toBe(1);
    expect(account.target).toEqual({ mode: "ACCOUNT_WORKSPACE", accountId: A, deploymentId: B, workspaceId: C });
    expect(trial.target).toEqual({ mode: "SELF_SERVE_TRIAL_WORKSPACE", trialId: A, deploymentId: B,
      workspaceId: C });
    expect([account.blockers, trial.blockers]).toEqual([[], []]);
    expect("suppliedBlockers" in account).toBe(false);
    expect(JSON.stringify(prepared("ACCOUNT_WORKSPACE"))).toBe(JSON.stringify(account));
    expectFrozenPropertyless(account);
    expectFrozenPropertyless(trial);
  });

  it.each(accountBlockerCases)("%s", (label, options, expected) => {
    const result = prepared("ACCOUNT_WORKSPACE", options);
    expect(result.blockers, label).toEqual(expected);
  });

  it.each(trialBlockerCases)("%s", (label, options, expected) => {
    const result = prepared("SELF_SERVE_TRIAL_WORKSPACE", options);
    expect(result.blockers, label).toEqual(expected);
  });

  it("emits all supplied and overlapping blockers once in declaration order", () => {
    const reversed = new Array<BlockerCode>(TENANT_PURGE_BLOCKER_CODES.length);
    for (let index = 0; index < reversed.length; index += 1) {
      reversed[index] = TENANT_PURGE_BLOCKER_CODES[reversed.length - index - 1];
    }
    const all = prepared("ACCOUNT_WORKSPACE", { workspaceDeployments: [B, D] }, reversed);
    expect(all.blockers).toEqual(TENANT_PURGE_BLOCKER_CODES);
    expect(all.blockers).toHaveLength(23);
    expect(new Set(Array.from(all.blockers)).size).toBe(23);
    const preserved = ["ACTIVE_WRITE", "STORAGE_REFERENCE_AMBIGUITY", "SEARCH_REFERENCE_AMBIGUITY",
      "CACHE_TTL_POLICY_MISSING", "LEGAL_HOLD", "RETENTION_HOLD"] as const;
    expect(prepared("ACCOUNT_WORKSPACE", {}, preserved).blockers).toEqual(preserved);
  });

  it("keeps authority first and rejects raw or forged values without caller traps", () => {
    let traps = 0;
    const hostile = new Proxy({}, { get: () => { traps += 1; throw new Error("trap"); } });
    const first = expectFixedError(() => prepare(false, hostile, hostile), 403);
    const second = expectFixedError(() => prepare(null, hostile, hostile), 403);
    expect(first).not.toBe(second);
    expectFixedError(() => prepare(true, hostile, hostile));
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const rawRoots = [{}, [], revoked.proxy, new Date(), new Uint8Array(32), createTenantPurgeOwnedSchema("uuid")];
    for (const value of rawRoots) expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", value));
    const nested = [
      root("ACCOUNT_WORKSPACE", { target: {} }),
      root("ACCOUNT_WORKSPACE", { blockers: [] }),
      root("ACCOUNT_WORKSPACE", { key: new Uint8Array(32) }),
      root("ACCOUNT_WORKSPACE", { topology: topology(new Date()) }),
      root("ACCOUNT_WORKSPACE", { sha: hostile }),
    ];
    for (const value of nested) expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", value));
    expect(traps).toBe(0);
  });

  it("preserves the exact root slot boundary through prepare", { timeout: 30_000 }, () => {
    const ids = (length: number): string[] => {
      const values = new Array<string>(length);
      for (let index = 0; index < length; index += 1) {
        values[index] = `${D.slice(0, 24)}${index.toString(16).padStart(12, "0")}`;
      }
      return values;
    };
    const workspace = (length: number) => record([
      ["id", C], ["managedDeploymentIds", vector(ids(length))], ["trialIds", vector([])],
    ]);
    const owned = (length: number) => root("ACCOUNT_WORKSPACE", { topology: topology(workspace(length)) });
    const pass = prepare(true, "ACCOUNT_WORKSPACE", owned(99_902));
    expect(pass.topology.workspace?.managedDeploymentIds).toHaveLength(99_902);
    expectFixedError(() => prepare(true, "ACCOUNT_WORKSPACE", owned(99_903)));
  });

  it("prepares fresh stable values after ambient constructors and prototypes are poisoned", () => {
    const input = root("ACCOUNT_WORKSPACE", { topology: preparedTopology("ACCOUNT_WORKSPACE") });
    const failure = () => { throw new Error("poison"); };
    const poisons: readonly [object, PropertyKey, PropertyDescriptor][] = [
      [Object.prototype, "schemaVersion", { configurable: true, set: failure }],
      [Object.prototype, "toJSON", { configurable: true, value: () => "poison" }],
      [Array.prototype, "0", { configurable: true, set: failure }],
      [Array.prototype, "toJSON", { configurable: true, value: () => "poison" }],
      [Array.prototype, Symbol.iterator, { configurable: true, value: failure }],
      [Set.prototype, "add", { configurable: true, value: failure }],
      [Set.prototype, "has", { configurable: true, value: failure }],
      [globalThis, "Array", { configurable: true, value: failure }],
      [globalThis, "Set", { configurable: true, value: failure }],
    ];
    const saved = poisons.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
    let first!: ReturnType<typeof prepare>;
    let second!: ReturnType<typeof prepare>;
    let json = "";
    try {
      for (let index = 0; index < poisons.length; index += 1) {
        Object.defineProperty(poisons[index][0], poisons[index][1], poisons[index][2]);
      }
      first = prepare(true, "ACCOUNT_WORKSPACE", input);
      second = prepare(true, "ACCOUNT_WORKSPACE", input);
      json = JSON.stringify(first);
    } finally {
      for (let index = 0; index < poisons.length; index += 1) {
        if (saved[index]) Object.defineProperty(poisons[index][0], poisons[index][1], saved[index]!);
        else Reflect.deleteProperty(poisons[index][0], poisons[index][1]);
      }
    }
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.target).not.toBe(second.target);
    expect(json).toBe(JSON.stringify(second));
    expectFrozenPropertyless(first);
  });

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
    ]) expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", options)));
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
    const ids = (length: number) => { const values = new Array<string>(length); for (let index = 0; index < length; index += 1) values[index] = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; return vector(values, 100_000); };
    const workspace = (length: number) => record([["id", C], ["managedDeploymentIds", ids(length)], ["trialIds", vector([])]]);
    expect(normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: topology(workspace(99_902)) })).topology.workspace?.managedDeploymentIds).toHaveLength(99_902);
    expectFixedError(() => normalize(true, "ACCOUNT_WORKSPACE", root("ACCOUNT_WORKSPACE", { topology: topology(workspace(99_903)) })));
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
    const runtimeExports = ["TENANT_PURGE_BLOCKER_CODES", "TENANT_PURGE_TARGET_MODES",
      "normalizeTenantPurgeManifestValues", "prepareTenantPurgeManifestValues"];
    expect(Object.keys(contract).sort()).toEqual(runtimeExports.sort());
    expect(prepare).toHaveLength(3);
    for (const vocabulary of [contract.TENANT_PURGE_TARGET_MODES, TENANT_PURGE_BLOCKER_CODES]) { expect(Object.getPrototypeOf(vocabulary)).toBeNull(); expect(Object.isFrozen(vocabulary)).toBe(true); }
    const expected: Record<string, string> = { "tenant-purge-observation-kernel.ts": "6541628f1133924ca96818c2b50bc416d23d3d428176fc100562ae3c776aea2c", "tenant-purge-value-scalar-kernel.ts": "1fb3bc13f0f033d95880bf908cc578ebf1eaf7f2a4a96aa4f41ad88b889c8e71", "tenant-purge-owned-vector-kernel.ts": "0eabb8e24774af290a89f48ec564c4cf3dbf8f69828eb8c1b83e49ba7abc73ba", "tenant-purge-owned-schema-kernel.ts": "26cf6047bb8ccca99979420287abffacc7e96b3cbf5cd341293d221d867e1875", "tenant-purge-owned-collection-kernel.ts": "dfc191e036f76c134a142438356fbfe53ec5a2997fbc0b5ce982c63904270f7e" };
    for (const [file, hash] of Object.entries(expected)) expect(createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex")).toBe(hash);
    const source = readFileSync(new URL("tenant-purge-manifest-contract.ts", import.meta.url), "utf8");
    const boundary = source.indexOf("\n\nexport type TenantPurgePreparedManifestValues");
    const prefixHash = createHash("sha256").update(source.slice(0, boundary + 1)).digest("hex");
    expect(prefixHash).toBe("5e977ed78b6e13dacfe62b41cdb45395e284bf76288e90846d59820f57952915");
    const prepareSource = source.slice(source.indexOf("export function prepareTenantPurgeManifestValues"));
    expect(prepareSource.match(/normalizeTenantPurgeManifestValues\(/g)).toHaveLength(1);
    expect(prepareSource).not.toMatch(/Reflect\.ownKeys|Object\.(?:keys|values)|for\s*\([^)]*\bin\b/);
    expect(prepareSource).not.toMatch(/copyTenantPurgeOwnedCollection|captureTenantPurgeRootFields|sort|localeCompare/);
    expect(prepareSource).not.toMatch(/digest|hmac|crypto|provider|reader|adapter|async/);
    expect(source.match(/copyTenantPurgeOwnedCollection\(/g)).toHaveLength(1);
  });
});
