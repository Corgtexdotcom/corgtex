import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { captureAuthorizedTenantPurgeManifestValues } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import * as adapter from "./tenant-purge-prisma-snapshot-adapter";
type Transaction = (operation: (client: unknown) => Promise<unknown>, received?: unknown) => Promise<unknown>;
const shared = vi.hoisted(() => ({ prisma: { $transaction: undefined as unknown as Transaction } }));
vi.mock("@corgtex/shared", () => ({ prisma: shared.prisma }));
const RUN = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const TRIAL = "55555555-5555-4555-8555-555555555555";
const TRIAL_MODE = "SELF_SERVE_TRIAL_WORKSPACE";
const SHA = "a".repeat(40); const MODE = "ACCOUNT_WORKSPACE";
const HAS_OWN = Object.hasOwn; const GET = Reflect.get;
type Values = Record<string, unknown>;
const create = adapter.createTenantPurgePrismaAuthorizeAndCapture;
function owned(values: readonly unknown[]) {
  let result = createTenantPurgeOwnedVector<unknown>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result = pushTenantPurgeOwnedVector(result, values[index]);
  }
  return result;
}
function key() { return owned(new Array(32).fill(7)); }
function callback() { return create(true, MODE, RUN, key(), 100, 10, 1_000, 60); }
function fixed(error: unknown, status: 400 | 403) {
  const code = status === 400 ? "TENANT_PURGE_CONTRACT_INVALID" : "TENANT_PURGE_TARGET_FORBIDDEN";
  expect(error).toMatchObject({ status, code });
}
function strict(name: string, methods: Values, accesses: string[]) {
  return new Proxy(Object.freeze(methods), { get(target, property, receiver) {
    accesses.push(`${name}.${String(property)}`);
    if (!HAS_OWN(target, property)) throw new Error(`unexpected ${name}.${String(property)}`);
    return GET(target, property, receiver);
  } });
}
type FixtureOptions = { linkedAccount?: boolean; missingRun?: boolean; rejectAt?: number };
function fixture(changes: Values = {}, workspace: unknown = { id: WORKSPACE }, trialMode = false,
  options: FixtureOptions = {}) {
  const ledger: string[] = [];
  const accesses: string[] = [];
  const rejection = new Error("injected query rejection");
  const queries: { method: string; args: unknown }[] = [];
  const method = (name: string, value: unknown) => async (args: unknown) => {
    ledger.push(name); queries.push({ method: name, args });
    if (queries.length - 1 === options.rejectAt) throw rejection;
    return value;
  };
  const mode = trialMode ? TRIAL_MODE : MODE;
  const canonical = `${mode}:${trialMode ? TRIAL : ACCOUNT}:${DEPLOYMENT}:${WORKSPACE}`;
  const run = { id: RUN, mode, status: "PLANNED", targetAccountId: trialMode ? null : ACCOUNT,
    targetDeploymentId: DEPLOYMENT, targetWorkspaceId: WORKSPACE, targetTrialId: trialMode ? TRIAL : null,
    canonicalTargetKey: canonical, activeTargetKey: canonical, capabilitySha: SHA, terminalAt: null,
    ...changes };
  const deployment = { id: DEPLOYMENT, managedWorkspaceId: WORKSPACE, customerAccountId: trialMode && !options.linkedAccount ? null : ACCOUNT,
    releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null,
    releaseLeaseExpectedImageTag: null, releaseLeaseIncomingImageTag: null,
    releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null,
    releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: null,
    releaseLeaseRecoveryEvidence: null, releaseLeaseError: null };
  const tx = strict("tx", {
    tenantPurgeRun: strict("run", { findUnique: method("tenantPurgeRun.findUnique", options.missingRun ? null : run) }, accesses),
    workspace: strict("workspace", { findUnique: method("workspace.findUnique", workspace) }, accesses),
    customerDeployment: strict("deployment", {
      findUnique: method("customerDeployment.findUnique", deployment),
      findMany: method("customerDeployment.findMany", [{ id: DEPLOYMENT }]),
    }, accesses),
    customerAccount: strict("account", {
      findUnique: method("customerAccount.findUnique", { id: ACCOUNT, primaryDeploymentId: null }),
      findMany: method("customerAccount.findMany", []),
    }, accesses),
    procurementTrial: strict("trial", {
      findUnique: method("procurementTrial.findUnique", { id: TRIAL, workspaceId: WORKSPACE, trialExpiresAt: new Date(0) }),
      findMany: method("procurementTrial.findMany", trialMode ? [{ id: TRIAL }] : []),
    }, accesses),
    providerCutover: strict("cutover", { findFirst: method("providerCutover.findFirst", null) }, accesses),
    clientMigrationRun: strict("migration", { findFirst: method("clientMigrationRun.findFirst", null) }, accesses),
  }, accesses);
  let transactionOptions: unknown;
  shared.prisma.$transaction = async (operation: (client: unknown) => Promise<unknown>, received?: unknown) => {
    ledger.push("$transaction"); transactionOptions = received;
    if (options.rejectAt === -1) throw rejection;
    return operation(tx);
  };
  return { ledger, accesses, queries, run, rejection, get options() { return transactionOptions; } };
}
function importsAdapter(source: string): boolean {
  const file = ts.createSourceFile("consumer.ts", source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node) {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) specifier = node.arguments[0];
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (specifier && ts.isStringLiteralLike(specifier)
      && /(?:^|\/)tenant-purge-prisma-snapshot-adapter(?:\.[cm]?[jt]s)?$/.test(specifier.text)) found = true;
    ts.forEachChild(node, visit);
  }
  visit(file); return found;
}
function select(...fields: string[]) { return Object.fromEntries(fields.map((field) => [field, true])); }
function expectedQueries(trialMode = false, linkedAccount = false) {
  const query = (method: string, where: unknown, selection: unknown, bounded = false) => ({ method,
    args: { where, select: selection, ...(bounded ? { orderBy: { id: "asc" }, take: 1_001 } : {}) } });
  const relation = { OR: [...(trialMode ? [] : [{ customerAccountId: ACCOUNT }]),
    { sourceDeploymentId: DEPLOYMENT }, { destinationDeploymentId: DEPLOYMENT }] };
  return [
    query("tenantPurgeRun.findUnique", { id: RUN }, select("id", "mode", "status", "targetAccountId",
      "targetDeploymentId", "targetWorkspaceId", "targetTrialId", "canonicalTargetKey", "activeTargetKey", "capabilitySha", "terminalAt")),
    query("workspace.findUnique", { id: WORKSPACE }, select("id")),
    query("customerDeployment.findUnique", { id: DEPLOYMENT }, select("id", "managedWorkspaceId", "customerAccountId",
      "releaseLeaseId", "releaseLeaseTokenHash", "releaseLeaseOwner", "releaseLeaseExpectedImageTag",
      "releaseLeaseIncomingImageTag", "releaseLeaseIncomingVersion", "releaseLeasePhase", "releaseLeaseAcquiredAt",
      "releaseLeaseHeartbeatAt", "releaseLeaseExpiresAt", "releaseLeaseRollbackRecord", "releaseLeaseRecoveryEvidence", "releaseLeaseError")),
    ...(!trialMode || linkedAccount ? [query("customerAccount.findUnique", { id: ACCOUNT }, select("id", "primaryDeploymentId"))] : []),
    ...(trialMode ? [query("procurementTrial.findUnique", { id: TRIAL }, select("id", "workspaceId", "trialExpiresAt"))] : []),
    query("customerDeployment.findMany", { managedWorkspaceId: WORKSPACE }, select("id"), true),
    query("procurementTrial.findMany", { workspaceId: WORKSPACE }, select("id"), true),
    ...(!trialMode || linkedAccount ? [query("customerDeployment.findMany", { customerAccountId: ACCOUNT }, select("id"), true)] : []),
    query("customerAccount.findMany", { primaryDeploymentId: DEPLOYMENT }, select("id"), true),
    query("providerCutover.findFirst", relation, select("id")),
    query("clientMigrationRun.findFirst", relation, select("id")),
  ];
}
const NON_PLANNED_STATUSES = ["DRY_RUN_COMPLETE", "BACKUP_COMPLETE", "RESTORE_VERIFIED", "APPROVED",
  "EXECUTING", "CLEANUP_PENDING", "VERIFYING", "COMPLETED", "RESTORING", "RESTORED", "CANCELLED", "FAILED"];
type DenialCase = [label: string, trialMode: boolean, changes: Values, missingRun?: boolean, requestedTrialMode?: boolean];
const DENIALS: DenialCase[] = [
  ...[false, true].flatMap((trialMode): DenialCase[] => [
    ["missing run", trialMode, {}, true],
    ["different returned run", trialMode, { id: ACCOUNT }],
    ["wrong mode", trialMode, {}, false, !trialMode],
    ["null active key", trialMode, { activeTargetKey: null }],
    ["wrong active key", trialMode, { activeTargetKey: "wrong" }],
    ["canonical mismatch", trialMode, { canonicalTargetKey: "wrong" }],
    ["terminal run", trialMode, { terminalAt: new Date(0) }],
    ...NON_PLANNED_STATUSES.map((status): DenialCase => [status, trialMode, { status }]),
  ]),
  ["account missing account", false, { targetAccountId: null,
    canonicalTargetKey: `${MODE}:null:${DEPLOYMENT}:${WORKSPACE}`, activeTargetKey: `${MODE}:null:${DEPLOYMENT}:${WORKSPACE}` }],
  ["account has trial", false, { targetTrialId: TRIAL }],
  ["trial missing trial", true, { targetTrialId: null,
    canonicalTargetKey: `${TRIAL_MODE}:null:${DEPLOYMENT}:${WORKSPACE}`, activeTargetKey: `${TRIAL_MODE}:null:${DEPLOYMENT}:${WORKSPACE}` }],
  ["trial has account", true, { targetAccountId: ACCOUNT }],
];
const REJECTIONS = [false, true].flatMap((trialMode) => {
  const queries = expectedQueries(trialMode, trialMode);
  return [{ label: "$transaction", trialMode, rejectAt: -1 },
    ...queries.map((query, rejectAt) => ({ label: `${rejectAt}: ${query.method}`, trialMode, rejectAt }))];
});
describe("tenant purge Prisma snapshot adapter", () => {
  it("denies before hostile later values or a transaction", async () => {
    let traps = 0; let transactions = 0;
    const observed = () => { traps += 1; throw new Error("observed"); };
    const hostile = new Proxy({}, { get: observed, ownKeys: observed,
      getOwnPropertyDescriptor: observed, getPrototypeOf: observed, has: observed });
    shared.prisma.$transaction = async () => { transactions += 1; return false; };
    const operation = create(false, hostile, hostile, hostile, hostile, hostile, hostile, hostile);
    expect(Object.isFrozen(operation)).toBe(true); expect(operation).toHaveLength(0);
    await expect(operation()).resolves.toBe(false);
    expect({ traps, transactions }).toEqual({ traps: 0, transactions: 0 });
  });
  it("rejects bad mode, raw U8, and revoked owned ingress", () => {
    let transactions = 0; shared.prisma.$transaction = async () => { transactions += 1; return false; };
    const revoked = Proxy.revocable(key() as object, {}); revoked.revoke();
    const cases: readonly (readonly [string, readonly unknown[]])[] = [
      ["mode", [true, "BAD", RUN, key(), 1, 1, 1, 0]],
      ["raw U8", [true, MODE, RUN, new Uint8Array(32), 1, 1, 1, 0]],
      ["revoked", [true, MODE, RUN, revoked.proxy, 1, 1, 1, 0]],
    ];
    for (const [label, args] of cases) {
      expect(() => (create as (...values: unknown[]) => unknown)(...args), label).toThrow();
    }
    expect(transactions).toBe(0);
  });
  it("rejects pending reentrancy and replay before another transaction", async () => {
    let calls = 0; let release!: (value: false) => void;
    shared.prisma.$transaction = async () => {
      calls += 1; return new Promise<false>((done) => { release = done; });
    };
    const operation = callback(); const first = operation();
    await expect(operation()).rejects.toSatisfy((error) => { fixed(error, 400); return true; });
    expect(calls).toBe(1); release(false); await expect(first).resolves.toBe(false);
    await expect(operation()).rejects.toSatisfy((error) => { fixed(error, 400); return true; });
    expect(calls).toBe(1);
  });
  it("captures one exact account transaction into detached owned output", async () => {
    const state = fixture(); const operation = callback();
    const result = await captureAuthorizedTenantPurgeManifestValues(true, MODE, operation);
    expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique", "workspace.findUnique",
      "customerDeployment.findUnique", "customerAccount.findUnique", "customerDeployment.findMany",
      "procurementTrial.findMany", "customerDeployment.findMany", "customerAccount.findMany",
      "providerCutover.findFirst", "clientMigrationRun.findFirst"]);
    expect(state.queries).toEqual(expectedQueries());
    expect(state.options).toEqual({ maxWait: 5_000, timeout: 10_000, isolationLevel: "RepeatableRead" });
    expect(result.target).toEqual({ mode: MODE, accountId: ACCOUNT, deploymentId: DEPLOYMENT,
      workspaceId: WORKSPACE });
    expect(result.policies).toEqual({ pageSize: 100, maxPagesPerModel: 10,
      maxEvidenceItems: 1_000, cacheMaxTtlSeconds: 60 });
    expect(result.redactionKeyBytes).toEqual(new Array(32).fill(7));
    expect(result.topology.workspace?.managedDeploymentIds).toEqual([DEPLOYMENT]);
    expect(result.topology.capturedAt).toMatch(/Z$/); expect(result.blockers).toEqual([]);
    expect(Object.getPrototypeOf(result)).toBeNull(); expect(Object.isFrozen(result.topology)).toBe(true);
    state.run.targetDeploymentId = RUN; expect(result.target.deploymentId).toBe(DEPLOYMENT);
  });
  it("captures an expired trial with exact queries and no target account lookup", async () => {
    const state = fixture({}, { id: WORKSPACE }, true);
    const operation = create(true, TRIAL_MODE, RUN, key(), 100, 10, 1_000, 60);
    const result = await captureAuthorizedTenantPurgeManifestValues(true, TRIAL_MODE, operation);
    expect(state.queries).toEqual(expectedQueries(true));
    expect(state.options).toEqual({ maxWait: 5_000, timeout: 10_000, isolationLevel: "RepeatableRead" });
    expect(result.target).toEqual({ mode: TRIAL_MODE, trialId: TRIAL, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE });
    expect(result.topology.trial).toEqual({ id: TRIAL, workspaceId: WORKSPACE, expired: true });
    expect(result.topology.account).toBeNull();
    expect(result.topology.workspace?.trialIds).toEqual([TRIAL]);
    expect(result.blockers).toEqual([]);
  });
  it("captures exact linked-account trial queries while keeping trial relation filters", async () => {
    const state = fixture({}, { id: WORKSPACE }, true, { linkedAccount: true });
    const operation = create(true, TRIAL_MODE, RUN, key(), 100, 10, 1_000, 60);
    const result = await captureAuthorizedTenantPurgeManifestValues(true, TRIAL_MODE, operation);
    expect(state.ledger).toEqual(["$transaction", ...expectedQueries(true, true).map((query) => query.method)]);
    expect(state.queries).toEqual(expectedQueries(true, true));
    expect(state.options).toEqual({ maxWait: 5_000, timeout: 10_000, isolationLevel: "RepeatableRead" });
    expect(result.target).toEqual({ mode: TRIAL_MODE, trialId: TRIAL, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE });
    expect(result.topology.account).toEqual({ id: ACCOUNT, deploymentIds: [DEPLOYMENT], primaryDeploymentId: null });
    expect(result.topology.deployment?.accountId).toBe(ACCOUNT);
    expect(result.topology.deployment?.sharedResourceAmbiguous).toBe(true);
    expect(result.blockers).toContain("SHARED_RESOURCE_AMBIGUITY");
  });
  it.each(DENIALS)("denies authority %s (trial=%s) before topology access", async (_label, trialMode, changes, missingRun, requestedTrialMode = trialMode) => {
    const state = fixture(changes, { id: WORKSPACE }, trialMode, { missingRun });
    const operation = create(true, requestedTrialMode ? TRIAL_MODE : MODE, RUN, key(), 100, 10, 1_000, 60);
    await expect(operation()).resolves.toBe(false);
    expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique"]);
    expect(state.queries).toEqual(expectedQueries(trialMode).slice(0, 1));
    expect(state.accesses).toEqual(["tx.tenantPurgeRun", "run.findUnique"]);
  });
  it.each(REJECTIONS)("normalizes rejection at $label (trial=$trialMode) and consumes the callback", async ({ trialMode, rejectAt }) => {
    const state = fixture({}, { id: WORKSPACE }, trialMode, { linkedAccount: trialMode, rejectAt });
    const operation = create(true, trialMode ? TRIAL_MODE : MODE, RUN, key(), 100, 10, 1_000, 60);
    const queries = expectedQueries(trialMode, trialMode).slice(0, rejectAt + 1);
    const ledger = ["$transaction", ...queries.map((query) => query.method)];
    const rejected = (error: unknown) => { fixed(error, 400); expect(error).not.toBe(state.rejection); return true; };
    await expect(operation()).rejects.toSatisfy(rejected);
    expect(state.ledger).toEqual(ledger);
    expect(state.queries).toEqual(queries);
    const accesses = state.accesses.slice();
    expect(accesses).toHaveLength(queries.length * 2);
    await expect(operation()).rejects.toSatisfy(rejected);
    expect(state.ledger).toEqual(ledger);
    expect(state.queries).toEqual(queries);
    expect(state.accesses).toEqual(accesses);
  });
  it.each([
    'import(/* comment */ "./tenant-purge-prisma-snapshot-adapter")',
    'require(/* comment */ "./tenant-purge-prisma-snapshot-adapter")',
    'export { create } from "./tenant-purge-prisma-snapshot-adapter"',
    'import "./tenant-purge-prisma-snapshot-adapter"',
    'type Adapter = import("./tenant-purge-prisma-snapshot-adapter").Adapter',
  ])("detects adapter consumers through syntax: %s", (source) => {
    expect(importsAdapter(source)).toBe(true);
  });
  it("ignores import-shaped comments and unrelated module names", () => {
    expect(importsAdapter('// import("./tenant-purge-prisma-snapshot-adapter")')).toBe(false);
    expect(importsAdapter('import "./tenant-purge-prisma-snapshot-adapter.test"')).toBe(false);
  });
  it("denies a terminal Date but rejects an unknown status after authority", async () => {
    let state = fixture({ terminalAt: new Date(0) });
    await expect(captureAuthorizedTenantPurgeManifestValues(true, MODE, callback())).rejects
      .toSatisfy((error) => { fixed(error, 403); return true; });
    expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique"]);
    state = fixture({ status: "UNKNOWN" });
    await expect(callback()()).rejects.toSatisfy((error) => { fixed(error, 400); return true; });
    expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique"]);
  });
  it("rejects a malformed workspace before any later read", async () => {
    const state = fixture({}, { id: "BAD" });
    await expect(callback()()).rejects.toSatisfy((error) => { fixed(error, 400); return true; });
    expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique", "workspace.findUnique"]);
  });
  it("keeps the exact private API without any consumer or barrel", () => {
    expect(create).toHaveLength(8);
    expect(Object.keys(adapter)).toEqual(["createTenantPurgePrismaAuthorizeAndCapture"]);
    const pending = ["packages"]; const consumers: string[] = [];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(file);
        else if (file.endsWith(".ts")
          && file !== "packages/domain/src/tenant-purge-prisma-snapshot-adapter.test.ts"
          && importsAdapter(readFileSync(file, "utf8"))) consumers.push(file);
      }
    }
    expect(consumers).toEqual([]);
  });
});
