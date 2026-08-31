import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthorizedTenantPurgeManifestValues } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from
  "./tenant-purge-owned-vector-kernel";
import * as adapter from "./tenant-purge-prisma-snapshot-adapter";
type Mode = "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE";
type Values = Record<string, unknown>;
type Data = Record<"run" | "workspace" | "deployment" | "account" | "trial" |
  "workspaceDeployments" | "workspaceTrials" | "accountDeployments" | "primaryAccounts" |
  "cutover" | "migration", unknown>;
type Query = readonly [name: string, value: unknown];
type Transaction = (operation: (tx: unknown) => Promise<unknown>, options: unknown) => Promise<unknown>;
const shared = vi.hoisted(() => ({ accesses: [] as string[],
  transaction: undefined as unknown as Transaction }));
const prisma = vi.hoisted(() => new Proxy(Object.freeze({}), { get(_target, property) {
  shared.accesses.push(String(property));
  if (property !== "$transaction") throw new Error(`unexpected prisma.${String(property)}`);
  return shared.transaction; } }));
vi.mock("@corgtex/shared", () => ({ prisma }));
const create = adapter.createTenantPurgePrismaAuthorizeAndCapture;
const RUN = "11111111-1111-4111-8111-111111111111"; const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT = "33333333-3333-4333-8333-333333333333"; const WORKSPACE = "44444444-4444-4444-8444-444444444444";
const TRIAL = "55555555-5555-4555-8555-555555555555"; const OTHER = "66666666-6666-4666-8666-666666666666";
const SHA = "a".repeat(40); const INDEX = readFileSync(new URL("index.ts", import.meta.url), "utf8");
const SOURCE = readFileSync(new URL("tenant-purge-prisma-snapshot-adapter.ts", import.meta.url), "utf8");
const STATUSES = ["DRY_RUN_COMPLETE", "BACKUP_COMPLETE", "RESTORE_VERIFIED", "APPROVED", "EXECUTING",
  "CLEANUP_PENDING", "VERIFYING", "COMPLETED", "RESTORING", "RESTORED", "CANCELLED", "FAILED"];
const RUN_SELECT = { id: true, mode: true, status: true, targetAccountId: true, targetDeploymentId: true,
  targetWorkspaceId: true, targetTrialId: true, canonicalTargetKey: true, activeTargetKey: true,
  capabilitySha: true, terminalAt: true };
const DEPLOYMENT_SELECT = { id: true, managedWorkspaceId: true, customerAccountId: true, releaseLeaseId: true,
  releaseLeaseTokenHash: true, releaseLeaseOwner: true, releaseLeaseExpectedImageTag: true,
  releaseLeaseIncomingImageTag: true, releaseLeaseIncomingVersion: true, releaseLeasePhase: true,
  releaseLeaseAcquiredAt: true, releaseLeaseHeartbeatAt: true, releaseLeaseExpiresAt: true,
  releaseLeaseRollbackRecord: true, releaseLeaseRecoveryEvidence: true, releaseLeaseError: true };
const BOUNDED = { select: { id: true }, orderBy: { id: "asc" }, take: 1_001 };
function owned(values: readonly unknown[], maximum = values.length) {
  let result = createTenantPurgeOwnedVector<unknown>(maximum);
  for (const value of values) result = pushTenantPurgeOwnedVector(result, value); return result; }
function key(length = 32, value: unknown = 7, max = length) { return owned(new Array(length).fill(value), max); }
function fixed(error: unknown, status = 400) {
  expect(error).toMatchObject({ status, code: status === 403
    ? "TENANT_PURGE_TARGET_FORBIDDEN" : "TENANT_PURGE_CONTRACT_INVALID" });
}
async function invalid(promise: Promise<unknown>, status = 400) {
  await expect(promise).rejects.toSatisfy((error) => { fixed(error, status); return true; }); }
function defaults(mode: Mode, linked = false): Data {
  const accountId = mode === "ACCOUNT_WORKSPACE" || linked ? ACCOUNT : null;
  const canonical = `${mode}:${mode === "ACCOUNT_WORKSPACE" ? ACCOUNT : TRIAL}:${DEPLOYMENT}:${WORKSPACE}`;
  return { run: { id: RUN, mode, status: "PLANNED", targetAccountId: mode === "ACCOUNT_WORKSPACE" ? ACCOUNT : null,
    targetDeploymentId: DEPLOYMENT, targetWorkspaceId: WORKSPACE,
    targetTrialId: mode === "SELF_SERVE_TRIAL_WORKSPACE" ? TRIAL : null, canonicalTargetKey: canonical,
    activeTargetKey: canonical, capabilitySha: SHA, terminalAt: null }, workspace: { id: WORKSPACE },
    deployment: { id: DEPLOYMENT, managedWorkspaceId: WORKSPACE, customerAccountId: accountId,
      releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null,
      releaseLeaseExpectedImageTag: null, releaseLeaseIncomingImageTag: null, releaseLeaseIncomingVersion: null,
      releaseLeasePhase: null, releaseLeaseAcquiredAt: null, releaseLeaseHeartbeatAt: null,
      releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: null, releaseLeaseRecoveryEvidence: null,
      releaseLeaseError: null }, account: { id: ACCOUNT, primaryDeploymentId: null },
    trial: { id: TRIAL, workspaceId: WORKSPACE, trialExpiresAt: new Date(0) },
    workspaceDeployments: [{ id: DEPLOYMENT }],
    workspaceTrials: mode === "SELF_SERVE_TRIAL_WORKSPACE" ? [{ id: TRIAL }] : [],
    accountDeployments: [{ id: DEPLOYMENT }], primaryAccounts: [], cutover: null, migration: null };
}
function strict(name: string, values: Values, accesses: string[]) {
  return new Proxy(Object.freeze(values), { get(target, property, receiver) {
    const path = `${name}.${String(property)}`; accesses.push(path);
    if (!Object.hasOwn(target, property)) throw new Error(`unexpected ${path}`);
    return Reflect.get(target, property, receiver); } }); }
function fixture(mode: Mode, linked = false, changes: Partial<Data> = {}, reject = "") {
  const data = { ...defaults(mode, linked), ...changes } as Data;
  const calls: string[] = []; const accesses: string[] = []; const queries: Query[] = [];
  const call = (name: string, value: unknown) => async (query: unknown) => {
    calls.push(name); queries.push([name, query]);
    if (reject === name) throw new Error("injected rejection"); return value; };
  const many = async (query: unknown) => {
    const where = (query as { where: Values }).where;
    return Object.hasOwn(where, "managedWorkspaceId")
      ? call("workspaceDeployments", data.workspaceDeployments)(query)
      : call("accountDeployments", data.accountDeployments)(query); };
  const tx = strict("tx", {
    tenantPurgeRun: strict("tenantPurgeRun", { findUnique: call("run", data.run) }, accesses),
    workspace: strict("workspace", { findUnique: call("workspace", data.workspace) }, accesses),
    customerDeployment: strict("customerDeployment", {
      findUnique: call("deployment", data.deployment), findMany: many }, accesses),
    customerAccount: strict("customerAccount", { findUnique: call("account", data.account),
      findMany: call("primaryAccounts", data.primaryAccounts) }, accesses),
    procurementTrial: strict("procurementTrial", { findUnique: call("trial", data.trial),
      findMany: call("workspaceTrials", data.workspaceTrials) }, accesses),
    providerCutover: strict("providerCutover", { findFirst: call("cutover", data.cutover) }, accesses),
    clientMigrationRun: strict("clientMigrationRun", { findFirst: call("migration", data.migration) }, accesses),
  }, accesses);
  let options: unknown; shared.accesses.length = 0;
  shared.transaction = async (operation, received) => {
    calls.push("transaction"); options = received;
    if (reject === "transaction") throw new Error("injected rejection"); return operation(tx); };
  return { data, calls, accesses, queries, get options() { return options; } }; }
function operation(mode: Mode, values: readonly unknown[] = [100, 10, 1_000, 60], bytes = key()) {
  return create(true, mode, RUN, bytes, values[0], values[1], values[2], values[3]); }
function queryOracle(mode: Mode, linked = false): Query[] {
  const accountId = mode === "ACCOUNT_WORKSPACE" || linked ? ACCOUNT : null;
  const relation = mode === "ACCOUNT_WORKSPACE" ? { OR: [{ customerAccountId: ACCOUNT },
    { sourceDeploymentId: DEPLOYMENT }, { destinationDeploymentId: DEPLOYMENT }] }
    : { OR: [{ sourceDeploymentId: DEPLOYMENT }, { destinationDeploymentId: DEPLOYMENT }] };
  const result: Query[] = [["run", { where: { id: RUN }, select: RUN_SELECT }],
    ["workspace", { where: { id: WORKSPACE }, select: { id: true } }],
    ["deployment", { where: { id: DEPLOYMENT }, select: DEPLOYMENT_SELECT }]];
  if (accountId) result.push(["account", { where: { id: accountId },
    select: { id: true, primaryDeploymentId: true } }]);
  if (mode === "SELF_SERVE_TRIAL_WORKSPACE") result.push(["trial", { where: { id: TRIAL },
    select: { id: true, workspaceId: true, trialExpiresAt: true } }]);
  result.push(["workspaceDeployments", { where: { managedWorkspaceId: WORKSPACE }, ...BOUNDED }],
    ["workspaceTrials", { where: { workspaceId: WORKSPACE }, ...BOUNDED }]);
  if (accountId) result.push(["accountDeployments", { where: { customerAccountId: accountId }, ...BOUNDED }]);
  result.push(["primaryAccounts", { where: { primaryDeploymentId: DEPLOYMENT }, ...BOUNDED }],
    ["cutover", { where: relation, select: { id: true } }],
    ["migration", { where: relation, select: { id: true } }]); return result;
}
function boundary(fn: () => unknown, ok: boolean) { if (ok) expect(fn()).toHaveLength(0); else expect(fn).toThrow(); }
afterEach(() => { vi.restoreAllMocks(); shared.accesses.length = 0; });
describe("tenant purge Prisma snapshot adapter authority conformance", () => {
  it.each([["targetMode", 1], ["runId", 2], ["redactionKeyBytes", 3], ["pageSize", 4],
    ["maxPagesPerModel", 5], ["maxEvidenceItems", 6], ["cacheMaxTtlSeconds", 7]])(
    "false authority leaves %s and Prisma unobserved", async (name, index) => {
      let traps = 0; const hostile = new Proxy({}, { get() { traps += 1; throw new Error(String(name)); } });
      const values: unknown[] = [false, "ACCOUNT_WORKSPACE", RUN, key(), 1, 1, 1, 0]; values[index] = hostile;
      const denied = (create as (...args: unknown[]) => ReturnType<typeof create>)(...values);
      expect(Object.isFrozen(denied)).toBe(true); expect(denied).toHaveLength(0);
      await expect(denied()).resolves.toBe(false);
      expect({ traps, prisma: shared.accesses }).toEqual({ traps: 0, prisma: [] }); });
  it.each([["account mode", "ACCOUNT_WORKSPACE", true], ["trial mode", "SELF_SERVE_TRIAL_WORKSPACE", true],
    ["bad mode", "BAD", false]])("factory mode: %s", (_name, mode, allowed) => {
    boundary(() => create(true, mode, RUN, key(), 1, 1, 1, 0), allowed); });
  it.each([["canonical", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", true],
    ["case varied", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", false], ["malformed", "bad", false]])(
    "factory UUID: %s", (_name, runId, allowed) => {
      boundary(() => create(true, "ACCOUNT_WORKSPACE", runId, key(), 1, 1, 1, 0), allowed); });
  const rawKeys: [string, () => unknown][] = [["object", () => ({})], ["array", () => []],
    ["Uint8Array", () => new Uint8Array(32)], ["Date", () => new Date()],
    ["Proxy", () => new Proxy(key() as object, {})], ["forged", () => Object.freeze(Object.create(null))]];
  it.each(rawKeys)("rejects raw or forged key: %s", (_name, make) => {
    expect(() => create(true, "ACCOUNT_WORKSPACE", RUN, make(), 1, 1, 1, 0)).toThrow(); });
  it("rejects a revoked owned-key proxy", () => {
    const revoked = Proxy.revocable(key() as object, {}); revoked.revoke();
    expect(() => create(true, "ACCOUNT_WORKSPACE", RUN, revoked.proxy, 1, 1, 1, 0)).toThrow(); });
  it.each([["31 bytes", 31, 7, false], ["32 bytes", 32, 7, true], ["64 bytes", 64, 7, true],
    ["65 bytes", 65, 7, false], ["negative", 32, -1, false], ["over 255", 32, 256, false],
    ["zero byte", 32, 0, true], ["255 byte", 32, 255, true],
    ["fractional", 32, 1.5, false], ["unsafe", 32, Number.MAX_SAFE_INTEGER + 1, false],
    ["nonnumber", 32, "7", false]])("key boundary: %s", (_name, length, value, allowed) => {
    boundary(() => operation("ACCOUNT_WORKSPACE", [1, 1, 1, 0], key(length, value)), allowed); });
  const policies: [string, number[], boolean][] = [
    ["page min", [1, 1, 1, 0], true], ["page max", [1_000, 1, 1, 0], true],
    ["page below", [0, 1, 1, 0], false], ["page above", [1_001, 1, 1, 0], false],
    ["page fractional", [1.5, 1, 1, 0], false], ["pages min", [1, 1, 1, 0], true],
    ["pages max", [1, 1_000, 1, 0], true], ["pages below", [1, 0, 1, 0], false],
    ["pages above", [1, 1_001, 1, 0], false], ["pages fractional", [1, 1.5, 1, 0], false],
    ["evidence min", [1, 1, 1, 0], true], ["evidence max", [1, 1, 100_000, 0], true],
    ["evidence below", [1, 1, 0, 0], false], ["evidence above", [1, 1, 100_001, 0], false],
    ["evidence fractional", [1, 1, 1.5, 0], false], ["ttl min", [1, 1, 1, 0], true],
    ["ttl max", [1, 1, 1, 31_536_000], true], ["ttl below", [1, 1, 1, -1], false],
    ["ttl above", [1, 1, 1, 31_536_001], false], ["ttl fractional", [1, 1, 1, 0.5], false],
  ];
  it.each(policies)("policy boundary: %s", (_name, values, allowed) => {
    boundary(() => operation("ACCOUNT_WORKSPACE", values), allowed); });
  it("copies an authentic key before successor creation and caller-view revocation", async () => {
    fixture("ACCOUNT_WORKSPACE"); const source = key(32, 7, 64); const view = Proxy.revocable(source as object, {});
    const callback = operation("ACCOUNT_WORKSPACE", [100, 10, 1_000, 60], source);
    const successor = pushTenantPurgeOwnedVector(source, 9); view.revoke();
    const result = await captureAuthorizedTenantPurgeManifestValues(true, "ACCOUNT_WORKSPACE", callback);
    expect(result.redactionKeyBytes).toEqual(new Array(32).fill(7)); expect(successor).not.toBe(source); });
  it("uses captured clock and builtins after late iterator, accessor, and toJSON poison", async () => {
    fixture("ACCOUNT_WORKSPACE"); const callback = operation("ACCOUNT_WORKSPACE"); const now = Date.now;
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    const json = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"); let result: unknown;
    try {
      Date.now = () => { throw new Error("late Date.now"); };
      Object.defineProperty(Array.prototype, Symbol.iterator,
        { configurable: true, value: () => { throw new Error("iterator"); } });
      Object.defineProperty(Object.prototype, "toJSON",
        { configurable: true, get: () => { throw new Error("accessor"); } });
      result = await captureAuthorizedTenantPurgeManifestValues(true, "ACCOUNT_WORKSPACE", callback);
    } finally {
      Date.now = now; if (iterator) Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
      if (json) Object.defineProperty(Object.prototype, "toJSON", json);
      else delete (Object.prototype as Values).toJSON;
    } expect((result as { topology: { capturedAt: string } }).topology.capturedAt).toMatch(/Z$/); });
  it.each(["pending", "settled", "rejected"])("one-shot transaction: %s replay", async (kind) => {
    fixture("ACCOUNT_WORKSPACE"); const callback = operation("ACCOUNT_WORKSPACE"); let calls = 0;
    let release!: (value: false) => void;
    shared.transaction = async () => { calls += 1;
      if (kind === "pending") return new Promise<false>((done) => { release = done; });
      if (kind === "rejected") throw new Error("rejected"); return false; };
    const first = callback(); if (kind === "pending") { await invalid(callback()); release(false); }
    if (kind === "rejected") await invalid(first); else await expect(first).resolves.toBe(false);
    await invalid(callback()); expect(calls).toBe(1); });
  it.each(STATUSES)("authority denies non-PLANNED status: %s", async (status) => {
    const run = { ...(defaults("ACCOUNT_WORKSPACE").run as Values), status };
    const state = fixture("ACCOUNT_WORKSPACE", false, { run });
    await invalid(captureAuthorizedTenantPurgeManifestValues(
      true, "ACCOUNT_WORKSPACE", operation("ACCOUNT_WORKSPACE")), 403);
    expect(state.calls).toEqual(["transaction", "run"]); });
  const denials: [string, Mode, string, unknown][] = [["missing run", "ACCOUNT_WORKSPACE", "run", null],
    ["null active key", "ACCOUNT_WORKSPACE", "activeTargetKey", null],
    ["wrong active key", "ACCOUNT_WORKSPACE", "activeTargetKey", "wrong"],
    ["wrong mode", "ACCOUNT_WORKSPACE", "mode", "SELF_SERVE_TRIAL_WORKSPACE"],
    ["account missing account", "ACCOUNT_WORKSPACE", "targetAccountId", null],
    ["account has trial", "ACCOUNT_WORKSPACE", "targetTrialId", TRIAL],
    ["trial missing trial", "SELF_SERVE_TRIAL_WORKSPACE", "targetTrialId", null],
    ["trial has account", "SELF_SERVE_TRIAL_WORKSPACE", "targetAccountId", ACCOUNT],
    ["canonical mismatch", "ACCOUNT_WORKSPACE", "canonicalTargetKey", "wrong"],
    ["terminal run", "ACCOUNT_WORKSPACE", "terminalAt", new Date(0)],
    ["different returned run", "ACCOUNT_WORKSPACE", "id", OTHER]];
  it.each(denials)("authority denial: %s", async (_name, mode, field, value) => {
    const run = field === "run" ? value : { ...(defaults(mode).run as Values), [field]: value };
    const state = fixture(mode, false, { run });
    await invalid(captureAuthorizedTenantPurgeManifestValues(true, mode, operation(mode)), 403);
    expect(state.calls).toEqual(["transaction", "run"]); });
  const malformed: [string, Mode, string, unknown][] = [["run UUID", "ACCOUNT_WORKSPACE", "id", "BAD"],
    ["mode enum", "ACCOUNT_WORKSPACE", "mode", "BAD"], ["status enum", "ACCOUNT_WORKSPACE", "status", "BAD"],
    ["account UUID", "ACCOUNT_WORKSPACE", "targetAccountId", "BAD"],
    ["deployment UUID", "ACCOUNT_WORKSPACE", "targetDeploymentId", "BAD"],
    ["workspace UUID", "ACCOUNT_WORKSPACE", "targetWorkspaceId", "BAD"],
    ["trial UUID", "SELF_SERVE_TRIAL_WORKSPACE", "targetTrialId", "BAD"],
    ["capability SHA", "ACCOUNT_WORKSPACE", "capabilitySha", "BAD"],
    ["terminal Date shape", "ACCOUNT_WORKSPACE", "terminalAt", {}],
    ["terminal invalid Date", "ACCOUNT_WORKSPACE", "terminalAt", new Date(NaN)]];
  it.each(malformed)("malformed authority: %s", async (_name, mode, field, value) => {
    const run = { ...(defaults(mode).run as Values), [field]: value };
    const state = fixture(mode, false, { run });
    await invalid(operation(mode)()); expect(state.calls).toEqual(["transaction", "run"]); });
  it.each([["account", "ACCOUNT_WORKSPACE", false], ["trial no account", "SELF_SERVE_TRIAL_WORKSPACE", false],
    ["trial linked account", "SELF_SERVE_TRIAL_WORKSPACE", true]] as const)(
    "exact transaction and query surface: %s", async (_name, mode, linked) => {
      const state = fixture(mode, linked); const result = await operation(mode)();
      const oracle = queryOracle(mode, linked);
      expect(result).not.toBe(false); expect(shared.accesses).toEqual(["$transaction"]);
      expect(state.options).toEqual({ maxWait: 5_000, timeout: 10_000, isolationLevel: "RepeatableRead" });
      expect(state.calls).toEqual(["transaction", ...oracle.map(([name]) => name)]);
      expect(state.queries).toEqual(oracle); expect(state.accesses).toHaveLength(oracle.length * 2);
      expect(() => (prisma as { delete: unknown }).delete).toThrow("unexpected prisma.delete"); });
  const rejections: [string, Mode, boolean][] = [["transaction", "ACCOUNT_WORKSPACE", false],
    ["run", "ACCOUNT_WORKSPACE", false], ["workspace", "ACCOUNT_WORKSPACE", false],
    ["deployment", "ACCOUNT_WORKSPACE", false], ["account", "ACCOUNT_WORKSPACE", false],
    ["trial", "SELF_SERVE_TRIAL_WORKSPACE", false], ["workspaceDeployments", "ACCOUNT_WORKSPACE", false],
    ["workspaceTrials", "ACCOUNT_WORKSPACE", false], ["accountDeployments", "ACCOUNT_WORKSPACE", false],
    ["primaryAccounts", "ACCOUNT_WORKSPACE", false], ["cutover", "ACCOUNT_WORKSPACE", false],
    ["migration", "ACCOUNT_WORKSPACE", false]];
  it.each(rejections)("Prisma rejection stops at: %s", async (point, mode, linked) => {
    const state = fixture(mode, linked, {}, point); await invalid(operation(mode)());
    const sequence = ["transaction", ...queryOracle(mode, linked).map(([name]) => name)];
    expect(state.calls).toEqual(sequence.slice(0, sequence.indexOf(point) + 1)); });
  function violations(source: string, index = false): string[] {
    const found: string[] = []; const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true);
    const methods = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany",
      "count", "aggregate", "groupBy", "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"]);
    let factory: ts.FunctionDeclaration | undefined; let exports = 0;
    const methodName = (node: ts.Expression) => ts.isPropertyAccessExpression(node) ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text : "";
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node)
        && node.name?.text === "createTenantPurgePrismaAuthorizeAndCapture") factory = node;
      if (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) exports += 1;
      if (!index && (ts.isExportAssignment(node) || ts.isExportDeclaration(node))) {
        exports += 1; found.push("export"); }
      if (ts.isCallExpression(node) && methods.has(methodName(node.expression)))
        found.push(methodName(node.expression));
      if (ts.isTaggedTemplateExpression(node) && methods.has(methodName(node.tag))) found.push(methodName(node.tag));
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ["fetch", "lock", "retry", "log", "route"].includes(node.expression.text)) found.push(node.expression.text);
      if (ts.isPropertyAssignment(node) && node.name.getText(file).replace(/["']/g, "") === "include")
        found.push("include");
      if (ts.isCallExpression(node) && /\bprisma\.(?:schema|migrations)\b/.test(node.expression.getText(file)))
        found.push("schema");
      if (ts.isImportDeclaration(node)
        && /["'](?:@azure|node:(?:http|net)|https?:)/.test(node.moduleSpecifier.getText(file))) found.push("network");
      if (index && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && /tenant-purge-prisma-snapshot-adapter/.test(node.moduleSpecifier?.getText(file) ?? "")) found.push("index");
      ts.forEachChild(node, walk);
    };
    walk(file); const names = factory?.parameters.map((parameter) => parameter.name.getText(file)) ?? [];
    const expected = ["privateAuthority", "targetMode", "runId", "redactionKeyBytes", "pageSize",
      "maxPagesPerModel", "maxEvidenceItems", "cacheMaxTtlSeconds"];
    if (!index && (exports !== 1 || JSON.stringify(names) !== JSON.stringify(expected))) found.push("surface");
    return found;
  }
  it("keeps the exact syntax-aware source, index, namespace, arity, and parameters", () => {
    expect(violations(SOURCE)).toEqual([]); expect(violations(INDEX, true)).toEqual([]);
    expect(Object.keys(adapter)).toEqual(["createTenantPurgePrismaAuthorizeAndCapture"]);
    expect(create).toHaveLength(8); });
  const specimens: [string, string][] = [["dot create", "x.create({})"], ["bracket create", "x['create']({})"],
    ["dot update", "x.update({})"], ["bracket update", "x['update']({})"], ["dot upsert", "x.upsert({})"],
    ["bracket upsert", "x['upsert']({})"], ["dot delete", "x.delete({})"], ["bracket delete", "x['delete']({})"],
    ["aggregate", "x.aggregate({})"], ["include", "x.findMany({ include: {} })"],
    ["queryRaw", "x.$queryRaw`SELECT 1`"], ["queryRawUnsafe", "x.$queryRawUnsafe('SELECT 1')"],
    ["executeRaw", "x.$executeRaw({})"], ["executeRawUnsafe", "x.$executeRawUnsafe({})"],
    ["network", "fetch('https://example.test')"], ["provider SDK", "import x from '@azure/identity'"],
    ["schema", "prisma.schema.push()"], ["migration", "prisma.migrations.apply()"],
    ["lock", "lock()"], ["retry", "retry()"], ["log", "log()"], ["route", "route()"],
    ["extra export", "export const extra = 1"], ["default export", "export default 1"],
    ["re-export", "export { extra } from './extra'"]];
  it.each(specimens)("rejects static specimen: %s", (_name, specimen) => {
    expect(violations(`${SOURCE}\n${specimen}`).length).toBeGreaterThan(0); });
  it.each(["client", "reader", "rawAggregate"])("rejects extra factory alias: %s", (alias) => {
    const changed = SOURCE.replace("cacheMaxTtlSeconds: unknown,", `cacheMaxTtlSeconds: unknown, ${alias}: unknown,`);
    expect(violations(changed)).toContain("surface"); });
});
