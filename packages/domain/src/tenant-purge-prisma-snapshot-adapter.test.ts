import { afterEach, describe, expect, it, vi } from "vitest";
import { captureAuthorizedTenantPurgeManifestValues } from "./tenant-purge-atomic-capture-contract";
import { captureTenantPurgeOwnedVector, createTenantPurgeOwnedVector,
  pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
import * as adapter from "./tenant-purge-prisma-snapshot-adapter";
type Transaction = (operation: (client: unknown) => Promise<unknown>, received?: unknown) => Promise<unknown>;
const shared = vi.hoisted(() => {
  const observations: string[] = [];
  const prisma = new Proxy({ $transaction: undefined as unknown as Transaction }, {
    get(target, property, receiver) { observations.push("get"); return Reflect.get(target, property, receiver); },
    ownKeys(target) { observations.push("ownKeys"); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, property) {
      observations.push("getOwnPropertyDescriptor"); return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf(target) { observations.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
    has(target, property) { observations.push("has"); return Reflect.has(target, property); },
  });
  return { prisma, observations };
});
vi.mock("@corgtex/shared", () => ({ prisma: shared.prisma }));
// Observe the real trusted kernel boundary, without forging its WeakMap-branded handles.
const kernelProbe = vi.hoisted(() => ({
  constructing: false, constructed: new WeakSet<object>(), captures: [] as unknown[],
  forbiddenCapture: undefined as unknown, entries: [] as { name: string; value: unknown }[],
  failEntry: null as string | null, failVector: false, failPush: false, clock: null as number | null,
}));
vi.mock("./tenant-purge-owned-vector-kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tenant-purge-owned-vector-kernel")>();
  return { ...real,
    createTenantPurgeOwnedVector<T>(maximum: number) {
      if (kernelProbe.failVector) throw new Error("injected owned-vector construction failure");
      const value = real.createTenantPurgeOwnedVector<T>(maximum);
      if (kernelProbe.constructing) kernelProbe.constructed.add(value);
      return value;
    },
    pushTenantPurgeOwnedVector<T>(previous: unknown, item: T) {
      if (kernelProbe.failPush) throw new Error("injected owned-vector push failure");
      const value = real.pushTenantPurgeOwnedVector(previous, item);
      if (kernelProbe.constructing) kernelProbe.constructed.add(value);
      return value;
    },
    captureTenantPurgeOwnedVector<T>(value: unknown, maximum: number) {
      kernelProbe.captures.push(value);
      if (kernelProbe.forbiddenCapture !== undefined && value === kernelProbe.forbiddenCapture)
        throw new Error("caller handle was retained");
      return real.captureTenantPurgeOwnedVector<T>(value, maximum);
    },
  };
});
vi.mock("./tenant-purge-owned-collection-kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tenant-purge-owned-collection-kernel")>();
  return { ...real, createTenantPurgeOwnedEntry(name: string, value: unknown) {
    if (name === kernelProbe.failEntry) throw new Error("injected owned-entry construction failure");
    kernelProbe.entries.push({ name, value });
    return real.createTenantPurgeOwnedEntry(name, value);
  } };
});
vi.mock("./tenant-purge-prisma-snapshot-value-kernel", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tenant-purge-prisma-snapshot-value-kernel")>();
  return { ...real, captureTenantPurgePrismaClockMilliseconds() {
    return kernelProbe.clock ?? real.captureTenantPurgePrismaClockMilliseconds();
  } };
});
afterEach(() => {
  kernelProbe.constructing = false; kernelProbe.constructed = new WeakSet();
  kernelProbe.captures = []; kernelProbe.entries = []; kernelProbe.forbiddenCapture = undefined;
  kernelProbe.failEntry = null; kernelProbe.failVector = false; kernelProbe.failPush = false;
  kernelProbe.clock = null;
  vi.restoreAllMocks();
});
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
  const message = status === 400 ? "Invalid tenant purge contract input." : "Tenant purge target is forbidden.";
  expect(error).toMatchObject({ status, code, message });
  expect(Object.isFrozen(error)).toBe(true);
}
function strict(name: string, methods: Values, accesses: string[]) {
  return new Proxy(Object.freeze(methods), { get(target, property, receiver) {
    accesses.push(`${name}.${String(property)}`);
    if (!HAS_OWN(target, property)) throw new Error(`unexpected ${name}.${String(property)}`);
    return GET(target, property, receiver);
  } });
}
type FixtureOptions = { linkedAccount?: boolean; missingRun?: boolean; rejectAt?: number;
  resultAt?: { index: number; replace: (value: unknown) => unknown };
  results?: Record<number, unknown>; beforeQuery?: (index: number) => void;
  beforeCommit?: (value: unknown) => void };
function fixture(changes: Values = {}, workspace: unknown = { id: WORKSPACE }, trialMode = false,
  options: FixtureOptions = {}) {
  const ledger: string[] = [];
  const accesses: string[] = [];
  const rejection = new Error("injected query rejection");
  const queries: { method: string; args: unknown }[] = [];
  const method = (name: string, value: unknown) => async (args: unknown) => {
    options.beforeQuery?.(queries.length);
    ledger.push(name); queries.push({ method: name, args });
    if (queries.length - 1 === options.rejectAt) throw rejection;
    if (HAS_OWN(options.results ?? {}, queries.length - 1)) return options.results![queries.length - 1];
    return queries.length - 1 === options.resultAt?.index ? options.resultAt.replace(value) : value;
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
    const result = await operation(tx);
    options.beforeCommit?.(result);
    return result;
  };
  return { ledger, accesses, queries, run, rejection, get options() { return transactionOptions; } };
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
const QUERY_PLANS = [
  { label: "account", trialMode: false, linkedAccount: false },
  { label: "unlinked trial", trialMode: true, linkedAccount: false },
  { label: "linked trial", trialMode: true, linkedAccount: true },
];
const REJECTIONS = QUERY_PLANS.flatMap(({ label: plan, trialMode, linkedAccount }) => {
  const queries = expectedQueries(trialMode, linkedAccount);
  return [{ label: `${plan}: $transaction`, trialMode, linkedAccount, rejectAt: -1 },
    ...queries.map((query, rejectAt) => ({ label: `${plan}: ${rejectAt}: ${query.method}`,
      trialMode, linkedAccount, rejectAt }))];
});
type IngressCase = { label: string; bad: unknown; good: unknown; argument: number };
const INGRESS: IngressCase[] = [
  { label: "malformed run UUID", argument: 2, bad: "BAD", good: RUN },
  { label: "noncanonical run UUID", argument: 2, bad: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", good: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ...[31, 65].map((length) => ({ label: `${length}-byte key`, argument: 3,
    bad: owned(new Array(length).fill(7)), good: owned(new Array(length === 31 ? 32 : 64).fill(7)) })),
  ...[-1, 256, 1.5, NaN, "7"].map((byte) => ({ label: `invalid byte ${String(byte)}`, argument: 3,
    bad: owned([...new Array(31).fill(7), byte]), good: owned([...new Array(31).fill(7), byte === 256 ? 255 : 0]) })),
  ...[["pageSize", 4, 1, 1_000], ["maxPagesPerModel", 5, 1, 1_000],
    ["maxEvidenceItems", 6, 1, 100_000], ["cacheMaxTtlSeconds", 7, 0, 31_536_000]].flatMap(
    ([name, position, minimum, maximum]) => [
      { label: `${name} below minimum`, argument: position as number, bad: (minimum as number) - 1, good: minimum },
      { label: `${name} above maximum`, argument: position as number, bad: (maximum as number) + 1, good: maximum },
      { label: `${name} fractional`, argument: position as number, bad: (minimum as number) + 0.5, good: minimum },
      { label: `${name} nonnumber`, argument: position as number, bad: String(minimum), good: minimum },
      ...[NaN, Infinity, null, true].map((bad) => ({ label: `${name} invalid scalar ${String(bad)}`,
        argument: position as number, bad, good: minimum })),
    ]),
];
type MalformedResult = { label: string; trialMode?: boolean; index: number;
  replace: (value: unknown) => unknown; control?: (value: unknown) => unknown; controlDenied?: boolean };
const field = (name: string, value: unknown) => (row: unknown) => ({ ...(row as Values), [name]: value });
const MALFORMED_RESULTS: MalformedResult[] = [
  { label: "run UUID", index: 0, replace: field("id", "BAD") },
  { label: "run capability SHA", index: 0, replace: field("capabilitySha", "BAD") },
  ...["targetAccountId", "targetDeploymentId", "targetWorkspaceId", "targetTrialId"].map((name) => ({
    label: `authority ${name}`, index: 0, replace: field(name, "BAD"),
  })),
  ...["mode", "status"].map((name) => ({ label: `authority unknown ${name}`, index: 0,
    replace: field(name, "UNKNOWN") })),
  ...["canonicalTargetKey", "activeTargetKey"].flatMap((name) => [
    { label: `authority ${name} object`, index: 0, replace: field(name, {}) },
    { label: `authority ${name} overflow`, index: 0, replace: field(name, "x".repeat(161)) },
  ]),
  { label: "authority uppercase SHA", index: 0, replace: field("capabilitySha", "A".repeat(40)) },
  { label: "authority forged Date", index: 0, replace: field("terminalAt", Object.create(Date.prototype)) },
  { label: "run terminal Date", index: 0, replace: field("terminalAt", new Date(NaN)),
    control: field("terminalAt", new Date(0)), controlDenied: true },
  { label: "deployment UUID", index: 2, replace: field("id", "BAD") },
  { label: "deployment workspace UUID", index: 2, replace: field("managedWorkspaceId", "BAD") },
  { label: "deployment account UUID", index: 2, replace: field("customerAccountId", "BAD") },
  { label: "missing selected deployment field", index: 2, replace: (row) => {
    const result = { ...(row as Values) }; delete result.releaseLeaseError; return result;
  } },
  { label: "account UUID", index: 3, replace: field("id", "BAD") },
  { label: "account primary deployment UUID", index: 3, replace: field("primaryDeploymentId", "BAD"),
    control: field("primaryDeploymentId", DEPLOYMENT) },
  { label: "trial UUID", trialMode: true, index: 3, replace: field("id", "BAD") },
  { label: "trial workspace UUID", trialMode: true, index: 3, replace: field("workspaceId", "BAD") },
  { label: "trial expiration Date", trialMode: true, index: 3, replace: field("trialExpiresAt", new Date(NaN)) },
  { label: "non-Date trial expiration", trialMode: true, index: 3, replace: field("trialExpiresAt", 0),
    control: field("trialExpiresAt", new Date(0)) },
  { label: "forged trial expiration Date", trialMode: true, index: 3,
    replace: field("trialExpiresAt", Object.create(Date.prototype)) },
  ...[4, 5, 6, 7].map((index) => ({ label: `ordered UUID result at account query ${index}`, index,
    replace: () => [{ id: "BAD" }], control: () => [{ id: DEPLOYMENT }] })),
  { label: "nonarray ordered UUID result", index: 4, replace: () => ({ id: DEPLOYMENT }) },
  { label: "duplicate ordered UUID result", index: 4, replace: () => [{ id: DEPLOYMENT }, { id: DEPLOYMENT }],
    control: () => [{ id: ACCOUNT }, { id: DEPLOYMENT }] },
  { label: "descending ordered UUID result", index: 4, replace: () => [{ id: DEPLOYMENT }, { id: ACCOUNT }],
    control: () => [{ id: ACCOUNT }, { id: DEPLOYMENT }] },
  { label: "sparse ordered UUID result", index: 4, replace: () => new Array(1),
    control: () => [{ id: DEPLOYMENT }] },
  { label: "overflow sentinel ordered UUID result", index: 4,
    replace: () => Array.from({ length: 1_001 }, (_, index) => ({ id: `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}` })),
    control: () => Array.from({ length: 1_000 }, (_, index) => ({ id: `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}` })) },
];
function invalidError(error: unknown) {
  fixed(error, 400);
  expect(error).toMatchObject({ message: "Invalid tenant purge contract input." });
  expect(Object.isFrozen(error)).toBe(true); return true;
}
const OTHER = "66666666-6666-4666-8666-666666666666";
const CAPTURE_TIME = 1_800_000_000_000;
type TopologyCase = { label: string; trialMode?: boolean; linkedAccount?: boolean;
  results: Record<number, unknown>; blockers: string[]; topology: Values };
const queryIndex = (trial: boolean, method: string) => expectedQueries(trial).findIndex((q) => q.method === method);
const deploymentRow = (trialMode: boolean, changes: Values) => ({
  id: DEPLOYMENT, managedWorkspaceId: WORKSPACE, customerAccountId: trialMode ? null : ACCOUNT,
  releaseLeaseId: null, releaseLeaseTokenHash: null, releaseLeaseOwner: null,
  releaseLeaseExpectedImageTag: null, releaseLeaseIncomingImageTag: null,
  releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null,
  releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: null,
  releaseLeaseRecoveryEvidence: null, releaseLeaseError: null, ...changes,
});
const LEASE_FIELDS = ["releaseLeaseId", "releaseLeaseTokenHash", "releaseLeaseOwner",
  "releaseLeaseExpectedImageTag", "releaseLeaseIncomingImageTag", "releaseLeaseIncomingVersion",
  "releaseLeasePhase", "releaseLeaseAcquiredAt", "releaseLeaseHeartbeatAt", "releaseLeaseExpiresAt",
  "releaseLeaseRollbackRecord", "releaseLeaseRecoveryEvidence", "releaseLeaseError"];
const TOPOLOGY: TopologyCase[] = [
  ...[false, true].flatMap((trialMode): TopologyCase[] => [
    { label: "missing workspace", trialMode, results: { 1: null },
      blockers: ["TARGET_TUPLE_MISMATCH"], topology: { workspace: null } },
    { label: "different workspace", trialMode, results: { 1: { id: OTHER } },
      blockers: ["TARGET_TUPLE_MISMATCH"], topology: { workspace: { id: OTHER } } },
    { label: "missing deployment", trialMode, results: { 2: null },
      blockers: ["TARGET_TUPLE_MISMATCH"], topology: { deployment: null } },
    { label: "different deployment", trialMode, results: { 2: deploymentRow(trialMode, { id: OTHER }) },
      blockers: ["TARGET_TUPLE_MISMATCH"], topology: { deployment: { id: OTHER } } },
    { label: "null managed link", trialMode,
      results: { 2: deploymentRow(trialMode, { managedWorkspaceId: null }) },
      blockers: ["TARGET_TUPLE_MISMATCH"],
      topology: { deployment: { managedWorkspaceId: null, sharedResourceAmbiguous: false } } },
    { label: "different managed link", trialMode,
      results: { 2: deploymentRow(trialMode, { managedWorkspaceId: OTHER }) },
      blockers: ["TARGET_TUPLE_MISMATCH", "SHARED_RESOURCE_AMBIGUITY"],
      topology: { deployment: { managedWorkspaceId: OTHER, sharedResourceAmbiguous: true } } },
    { label: "missing workspace deployment membership", trialMode, results: { 4: [] },
      blockers: ["TARGET_TUPLE_MISMATCH"], topology: { workspace: { managedDeploymentIds: [] } } },
    { label: "workspace deployment sibling", trialMode, results: { 4: [{ id: DEPLOYMENT }, { id: OTHER }] },
      blockers: ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"],
      topology: { workspace: { managedDeploymentIds: [DEPLOYMENT, OTHER] } } },
    { label: "workspace only has sibling", trialMode, results: { 4: [{ id: OTHER }] },
      blockers: ["TARGET_TUPLE_MISMATCH", "LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"],
      topology: { workspace: { managedDeploymentIds: [OTHER] } } },
    { label: "primary account routing", trialMode,
      results: { [queryIndex(trialMode, "customerAccount.findMany")]: [{ id: ACCOUNT }] },
      blockers: trialMode ? ["LINKED_ACCOUNT", "PRIMARY_ROUTING"] : ["PRIMARY_ROUTING"],
      topology: { deployment: { primaryAccountIds: [ACCOUNT] } } },
    ...LEASE_FIELDS.map((name): TopologyCase => ({ label: `lease field ${name}`, trialMode,
      results: { 2: deploymentRow(trialMode, { [name]: name.endsWith("At") ? new Date(0) : "" }) },
      blockers: ["MANAGED_RELEASE_LEASE"], topology: { deployment: { hasManagedReleaseLease: true } } })),
    { label: "provider cutover", trialMode,
      results: { [queryIndex(trialMode, "providerCutover.findFirst")]: { id: OTHER } },
      blockers: ["PROVIDER_CUTOVER"], topology: { deployment: { hasProviderCutover: true } } },
    { label: "client migration", trialMode,
      results: { [queryIndex(trialMode, "clientMigrationRun.findFirst")]: { id: OTHER } },
      blockers: ["CLIENT_MIGRATION"], topology: { deployment: { hasClientMigration: true } } },
  ]),
  { label: "missing account", results: { 3: null }, blockers: ["TARGET_TUPLE_MISMATCH"], topology: { account: null } },
  { label: "different account", results: { 3: { id: OTHER, primaryDeploymentId: null } },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { account: { id: OTHER } } },
  { label: "null deployment account link", results: { 2: deploymentRow(false, { customerAccountId: null }) },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { deployment: { accountId: null, sharedResourceAmbiguous: false } } },
  { label: "different deployment account link", results: { 2: deploymentRow(false, { customerAccountId: OTHER }) },
    blockers: ["TARGET_TUPLE_MISMATCH", "SHARED_RESOURCE_AMBIGUITY"],
    topology: { deployment: { accountId: OTHER, sharedResourceAmbiguous: true } } },
  { label: "missing account deployment membership", results: { 6: [] },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { account: { deploymentIds: [] } } },
  { label: "account sibling", results: { 6: [{ id: DEPLOYMENT }, { id: OTHER }] },
    blockers: ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT"], topology: { account: { deploymentIds: [DEPLOYMENT, OTHER] } } },
  { label: "account primary is target", results: { 3: { id: ACCOUNT, primaryDeploymentId: DEPLOYMENT } },
    blockers: ["PRIMARY_ROUTING"], topology: { account: { primaryDeploymentId: DEPLOYMENT } } },
  { label: "account primary is another deployment", results: { 3: { id: ACCOUNT, primaryDeploymentId: OTHER } },
    blockers: ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT", "PRIMARY_ROUTING"],
    topology: { account: { primaryDeploymentId: OTHER } } },
  { label: "account workspace has trial", results: { 5: [{ id: TRIAL }] }, blockers: ["LINKED_TRIAL"],
    topology: { workspace: { trialIds: [TRIAL] } } },
  { label: "missing trial", trialMode: true, results: { 3: null },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { trial: null } },
  { label: "different trial", trialMode: true,
    results: { 3: { id: OTHER, workspaceId: WORKSPACE, trialExpiresAt: new Date(0) } },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { trial: { id: OTHER } } },
  ...[null, OTHER].map((workspaceId): TopologyCase => ({ label: `trial workspace link ${workspaceId}`,
    trialMode: true, results: { 3: { id: TRIAL, workspaceId, trialExpiresAt: new Date(0) } },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { trial: { workspaceId } } })),
  { label: "missing trial membership", trialMode: true, results: { 5: [] },
    blockers: ["TARGET_TUPLE_MISMATCH"], topology: { workspace: { trialIds: [] } } },
  { label: "sibling trial", trialMode: true, results: { 5: [{ id: TRIAL }, { id: OTHER }] },
    blockers: ["LINKED_TRIAL"], topology: { workspace: { trialIds: [TRIAL, OTHER] } } },
  ...[-1, 0, 1].map((offset): TopologyCase => ({ label: `trial expires at captured time ${offset}`,
    trialMode: true, results: { 3: { id: TRIAL, workspaceId: WORKSPACE,
      trialExpiresAt: new Date(CAPTURE_TIME + offset) } },
    blockers: offset > 0 ? ["TRIAL_NOT_EXPIRED"] : [], topology: { trial: { expired: offset <= 0 } } })),
  { label: "trial account link with absent account row", trialMode: true, linkedAccount: true,
    results: { 3: null }, blockers: ["LINKED_ACCOUNT", "SHARED_RESOURCE_AMBIGUITY"],
    topology: { account: null, deployment: { accountId: ACCOUNT, sharedResourceAmbiguous: true } } },
];
function expectFrozenCopy(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBeNull(); expect(Object.isFrozen(value)).toBe(true);
  for (const name of Reflect.ownKeys(value)) {
    if (name !== "length") expectFrozenCopy((value as Record<PropertyKey, unknown>)[name]);
  }
}
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
  it("rejects bad mode, raw U8, and a revoked Proxy around owned ingress", () => {
    let transactions = 0; shared.prisma.$transaction = async () => { transactions += 1; return false; };
    const revoked = Proxy.revocable(key() as object, {}); revoked.revoke();
    const cases: readonly (readonly [string, readonly unknown[]])[] = [
      ["mode", [true, "BAD", RUN, key(), 1, 1, 1, 0]],
      ["raw U8", [true, MODE, RUN, new Uint8Array(32), 1, 1, 1, 0]],
      ["revoked", [true, MODE, RUN, revoked.proxy, 1, 1, 1, 0]],
    ];
    for (const [label, args] of cases) {
      let error: unknown;
      try { (create as (...values: unknown[]) => unknown)(...args); } catch (caught) { error = caught; }
      expect(invalidError(error), label).toBe(true);
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
  it.each(INGRESS)("validates factory ingress $label against a valid control before a transaction", ({ argument, bad, good }) => {
    let transactions = 0;
    shared.prisma.$transaction = async () => { transactions += 1; return false; };
    const args: unknown[] = [true, MODE, RUN, key(), 100, 10, 1_000, 60];
    args[argument] = good;
    const make = () => (create as (...values: unknown[]) => ReturnType<typeof create>)(...args);
    expect(make()).toHaveLength(0);
    args[argument] = bad;
    let error: unknown;
    try { make(); } catch (caught) { error = caught; }
    invalidError(error);
    expect(transactions).toBe(0);
  });
  it("captures maximum policies and a 64-byte key with endpoint bytes", async () => {
    fixture(); const bytes = owned(new Array(64).fill(0).map((_value, index) => index % 2 === 0 ? 0 : 255));
    const operation = create(true, MODE, RUN, bytes, 1_000, 1_000, 100_000, 31_536_000);
    const result = await captureAuthorizedTenantPurgeManifestValues(true, MODE, operation);
    expect(result.redactionKeyBytes).toEqual(new Array(64).fill(0).map((_value, index) => index % 2 === 0 ? 0 : 255));
    expect(result.policies).toEqual({ pageSize: 1_000, maxPagesPerModel: 1_000,
      maxEvidenceItems: 100_000, cacheMaxTtlSeconds: 31_536_000 });
  });
  it.each(MALFORMED_RESULTS)("rejects malformed $label, stops reads and rejects replay", async ({ trialMode = false, index, replace, control, controlDenied = false }) => {
    const mode = trialMode ? TRIAL_MODE : MODE;
    const make = () => create(true, mode, RUN, key(), 100, 10, 1_000, 60);
    const valid = fixture({}, { id: WORKSPACE }, trialMode, { resultAt: { index, replace: control ?? ((value) => value) } });
    if (controlDenied) await expect(make()()).resolves.toBe(false);
    else await expect(make()()).resolves.not.toBe(false);
    expect(valid.queries).toEqual(controlDenied ? expectedQueries(trialMode).slice(0, index + 1) : expectedQueries(trialMode));
    const state = fixture({}, { id: WORKSPACE }, trialMode, { resultAt: { index, replace } });
    const operation = make();
    await expect(operation()).rejects.toSatisfy(invalidError);
    const queries = expectedQueries(trialMode).slice(0, index + 1);
    expect(state.queries).toEqual(queries);
    expect(state.ledger).toEqual(["$transaction", ...queries.map((query) => query.method)]);
    const accesses = state.accesses.slice();
    expect(accesses).toHaveLength(queries.length * 2);
    await expect(operation()).rejects.toSatisfy(invalidError);
    expect(state.queries).toEqual(queries);
    expect(state.ledger).toEqual(["$transaction", ...queries.map((query) => query.method)]);
    expect(state.accesses).toEqual(accesses);
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
  it.each(REJECTIONS)("normalizes rejection at $label and consumes the callback", async ({ trialMode, linkedAccount, rejectAt }) => {
    const state = fixture({}, { id: WORKSPACE }, trialMode, { linkedAccount, rejectAt });
    const operation = create(true, trialMode ? TRIAL_MODE : MODE, RUN, key(), 100, 10, 1_000, 60);
    const queries = expectedQueries(trialMode, linkedAccount).slice(0, rejectAt + 1);
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
  it("keeps the exact private runtime API", () => {
    expect(create).toHaveLength(8);
    expect(Object.keys(adapter)).toEqual(["createTenantPurgePrismaAuthorizeAndCapture"]);
  });
});

describe("complete actual-adapter conformance", () => {
  it.each([false, undefined, null, 0, 1, "true", {}, Object(true)])(
    "observes neither later inputs nor Prisma for non-literal authority %s", async (authority) => {
      const observations: string[] = [];
      const trap = () => { observations.push("observed"); throw new Error("hostile input"); };
      const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap,
        getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
      shared.observations.length = 0;
      const operation = create(authority, hostile, hostile, hostile, hostile, hostile, hostile, hostile);
      expect(Object.isFrozen(operation)).toBe(true); expect(operation).toHaveLength(0);
      await expect(operation()).resolves.toBe(false);
      expect(observations).toEqual([]); expect(shared.observations).toEqual([]);
    },
  );
  it("copies the genuine caller key during construction, before any transaction", async () => {
    const state = fixture(); const caller = key(); kernelProbe.captures = [];
    kernelProbe.constructing = true;
    const operation = create(true, MODE, RUN, caller, 100, 10, 1_000, 60);
    kernelProbe.constructing = false;
    expect(state.ledger).toEqual([]);
    expect(kernelProbe.captures.filter((value) => value === caller)).toHaveLength(1);
    // A branded handle cannot be revoked by revoking a Proxy around it. Instead the
    // trusted seam rejects a future capture of this exact handle, including normalization.
    kernelProbe.forbiddenCapture = caller;
    const result = await captureAuthorizedTenantPurgeManifestValues(true, MODE, operation);
    const emitted = kernelProbe.entries.filter((entry) => entry.name === "redactionKeyBytes");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].value).not.toBe(caller);
    expect(kernelProbe.constructed.has(emitted[0].value as object)).toBe(true);
    expect(kernelProbe.captures.filter((value) => value === caller)).toHaveLength(1);
    expect(result.redactionKeyBytes).toEqual(new Array(32).fill(7));
    // Positive fault control: retention of the original handle really is observable.
    expect(() => captureTenantPurgeOwnedVector(caller, 64)).toThrow("caller handle was retained");
    expect(state.queries).toEqual(expectedQueries());
  });
  it.each(["raw array", "raw object", "forged frozen handle", "Date", "live Proxy", "revoked Proxy"])(
    "rejects unbranded key ingress: %s", (kind) => {
      let traps = 0;
      const trapped = () => { traps += 1; throw new Error("unbranded handle observed"); };
      const proxy = Proxy.revocable(key() as object, { get: trapped, ownKeys: trapped,
        getOwnPropertyDescriptor: trapped, getPrototypeOf: trapped, has: trapped });
      const values: Record<string, unknown> = { "raw array": new Array(32).fill(7), "raw object": {},
        "forged frozen handle": Object.freeze(Object.create(null)), Date: new Date(0),
        "live Proxy": proxy.proxy, "revoked Proxy": proxy.proxy };
      if (kind === "revoked Proxy") proxy.revoke();
      shared.observations.length = 0;
      let error: unknown;
      try { create(true, MODE, RUN, values[kind], 100, 10, 1_000, 60); } catch (caught) { error = caught; }
      invalidError(error);
      expect(traps).toBe(0); expect(shared.observations).toEqual([]);
    },
  );
  it.each(TOPOLOGY)("derives exact topology/blockers: $label (trial=$trialMode)", async (test) => {
    const trialMode = test.trialMode ?? false; kernelProbe.clock = CAPTURE_TIME;
    const state = fixture({}, { id: WORKSPACE }, trialMode,
      { results: test.results, linkedAccount: test.linkedAccount });
    const mode = trialMode ? TRIAL_MODE : MODE;
    const operation = create(true, mode, RUN, key(), 100, 10, 1_000, 60);
    const result = await captureAuthorizedTenantPurgeManifestValues(true, mode, operation);
    expect(result.topology).toMatchObject(test.topology);
    expect(result.topology.capturedAt).toBe("2027-01-15T08:00:00.000Z");
    expect(result.blockers).toEqual(test.blockers);
    expect(state.queries).toEqual(expectedQueries(trialMode, test.linkedAccount));
    expect(state.accesses).toHaveLength(state.queries.length * 2);
    expectFrozenCopy(result);
    const accesses = state.accesses.slice();
    await expect(operation()).rejects.toSatisfy(invalidError);
    expect(state.accesses).toEqual(accesses);
    expect(state.ledger.filter((entry) => entry === "$transaction")).toHaveLength(1);
  });
  it.each(DENIALS)("maps valid denial to fixed403 and forbids replay: %s (trial=%s)",
    async (_label, trialMode, changes, missingRun, requestedTrialMode = trialMode) => {
      const state = fixture(changes, { id: WORKSPACE }, trialMode, { missingRun });
      const mode = requestedTrialMode ? TRIAL_MODE : MODE;
      const operation = create(true, mode, RUN, key(), 100, 10, 1_000, 60);
      await expect(captureAuthorizedTenantPurgeManifestValues(true, mode, operation))
        .rejects.toSatisfy((error) => { fixed(error, 403); return true; });
      await expect(operation()).rejects.toSatisfy(invalidError);
      expect(state.queries).toEqual(expectedQueries(trialMode).slice(0, 1));
      expect(state.ledger).toEqual(["$transaction", "tenantPurgeRun.findUnique"]);
      expect(state.accesses).toEqual(["tx.tenantPurgeRun", "run.findUnique"]);
    },
  );
  it("consumes the callback while its first transaction is pending and later rejects", async () => {
    let reject!: (error: unknown) => void; let calls = 0;
    shared.prisma.$transaction = () => {
      calls += 1; return new Promise((_resolve, fail) => { reject = fail; });
    };
    const operation = callback(); const first = operation();
    await expect(operation()).rejects.toSatisfy(invalidError);
    const checked = expect(first).rejects.toSatisfy(invalidError);
    reject(new Error("private transaction detail")); await checked;
    await expect(operation()).rejects.toSatisfy(invalidError);
    expect(calls).toBe(1);
  });
  it.each(["vector", "push", "mode", "capturedAt", "target", "suppliedBlockers"])(
    "fails closed on actual owned construction failure at %s", async (point) => {
      const state = fixture({}, { id: WORKSPACE }, false, { beforeQuery(index) {
        if (index !== 9) return;
        kernelProbe.failVector = point === "vector"; kernelProbe.failPush = point === "push";
        kernelProbe.failEntry = point;
      } });
      const operation = callback();
      await expect(operation()).rejects.toSatisfy(invalidError);
      expect(state.queries).toEqual(expectedQueries());
      const accesses = state.accesses.slice();
      await expect(operation()).rejects.toSatisfy(invalidError);
      expect(state.accesses).toEqual(accesses);
    },
  );
  it.each(QUERY_PLANS)("builds an owned schema-order root before $label transaction closes", async (plan) => {
    let inspected = 0;
    const state = fixture({}, { id: WORKSPACE }, plan.trialMode, { linkedAccount: plan.linkedAccount,
      beforeCommit(value) {
        expect(value).not.toBe(false); expect(Object.isFrozen(value)).toBe(true);
        expect(captureTenantPurgeOwnedVector(value, 6)).toHaveLength(6);
        expect(kernelProbe.entries.slice(-6).map((entry) => entry.name)).toEqual([
          "target", "capabilitySha", "redactionKeyBytes", "policies", "topology", "suppliedBlockers",
        ]);
        inspected += 1;
      },
    });
    const mode = plan.trialMode ? TRIAL_MODE : MODE;
    const result = await captureAuthorizedTenantPurgeManifestValues(true, mode,
      create(true, mode, RUN, key(), 100, 10, 1_000, 60));
    expect(inspected).toBe(1); expectFrozenCopy(result);
    expect(state.queries).toEqual(expectedQueries(plan.trialMode, plan.linkedAccount));
    expect(Object.keys(result)).toEqual([
      "schemaVersion", "target", "capabilitySha", "redactionKeyBytes", "policies", "topology", "blockers",
    ]);
  });
  it.each(QUERY_PLANS.flatMap((plan) => expectedQueries(plan.trialMode, plan.linkedAccount)
    .map((query, index) => ({ ...plan, point: `${plan.label}: ${index}: ${query.method}`, index,
      list: query.method.endsWith("findMany") }))))(
    "rejects malformed descriptors and shapes at $point before another read", async (point) => {
      const mode = point.trialMode ? TRIAL_MODE : MODE;
      const cases = ["undefined", "primitive", "wrong prototype", "selected accessor", "revoked Proxy"];
      for (const kind of cases) {
        let getterCalls = 0;
        const state = fixture({}, { id: WORKSPACE }, point.trialMode, { linkedAccount: point.linkedAccount,
          resultAt: { index: point.index, replace(value) {
            if (kind === "undefined") return undefined;
            if (kind === "primitive") return 1;
            if (kind === "wrong prototype") return Object.create({ id: RUN });
            const source = point.list ? [{ id: DEPLOYMENT }] : { ...(value as Values ?? { id: OTHER }) };
            if (kind === "revoked Proxy") {
              const revocable = Proxy.revocable(source, {}); revocable.revoke(); return revocable.proxy;
            }
            Object.defineProperty(source, point.list ? "0" : "id", { enumerable: true, configurable: true,
              get() { getterCalls += 1; throw new Error("selected getter must not execute"); } });
            return source;
          } },
        });
        const operation = create(true, mode, RUN, key(), 100, 10, 1_000, 60);
        await expect(operation(), kind).rejects.toSatisfy(invalidError);
        expect(getterCalls, kind).toBe(0);
        const prefix = expectedQueries(point.trialMode, point.linkedAccount).slice(0, point.index + 1);
        expect(state.queries, kind).toEqual(prefix);
        expect(state.ledger, kind).toEqual(["$transaction", ...prefix.map((query) => query.method)]);
        const accesses = state.accesses.slice(); expect(accesses).toHaveLength(prefix.length * 2);
        await expect(operation()).rejects.toSatisfy(invalidError);
        expect(state.accesses, kind).toEqual(accesses);
      }
    },
  );
  it.each(QUERY_PLANS.flatMap((plan) => expectedQueries(plan.trialMode, plan.linkedAccount)
    .map((query, index) => ({ ...plan, index, method: query.method }))
    .filter((point) => point.method.endsWith("findMany"))))(
    "enforces duplicate/order/density/overflow bounds on $label list query $index", async (point) => {
      const maximum = Array.from({ length: 1_000 }, (_, index) => ({
        id: `123e4567-e89b-12d3-a456-${String(index).padStart(12, "0")}`,
      }));
      const valid = fixture({}, { id: WORKSPACE }, point.trialMode,
        { linkedAccount: point.linkedAccount, results: { [point.index]: maximum } });
      await expect(create(true, point.trialMode ? TRIAL_MODE : MODE, RUN, key(), 100, 10, 1_000, 60)())
        .resolves.not.toBe(false);
      expect(valid.queries).toEqual(expectedQueries(point.trialMode, point.linkedAccount));
      const badLists = [[{ id: DEPLOYMENT }, { id: DEPLOYMENT }],
        [{ id: OTHER }, { id: DEPLOYMENT }], new Array(1),
        [...maximum, { id: "123e4567-e89b-12d3-a456-000000001000" }]];
      for (const rows of badLists) {
        const state = fixture({}, { id: WORKSPACE }, point.trialMode,
          { linkedAccount: point.linkedAccount, results: { [point.index]: rows } });
        const operation = create(true, point.trialMode ? TRIAL_MODE : MODE, RUN, key(), 100, 10, 1_000, 60);
        await expect(operation()).rejects.toSatisfy(invalidError);
        expect(state.queries).toEqual(expectedQueries(point.trialMode, point.linkedAccount).slice(0, point.index + 1));
        const accesses = state.accesses.slice();
        await expect(operation()).rejects.toSatisfy(invalidError);
        expect(state.accesses).toEqual(accesses);
      }
    },
  );
  it.each(QUERY_PLANS.flatMap((plan) => expectedQueries(plan.trialMode, plan.linkedAccount)
    .slice(0, -1).map((query, index) => ({ ...plan, index, point: `${plan.label}: ${index}: ${query.method}` }))))(
    "decodes and detaches $point before the next awaited query", async (point) => {
      let revoke: (() => void) | undefined; let revoked = 0; let date: Date | undefined;
      const state = fixture({}, { id: WORKSPACE }, point.trialMode, { linkedAccount: point.linkedAccount,
        resultAt: { index: point.index, replace(value) {
          const source = value ?? { id: OTHER };
          if (!Array.isArray(source) && (source as Values).trialExpiresAt instanceof Date)
            date = (source as Values).trialExpiresAt as Date;
          const revocable = Proxy.revocable(source as object, {});
          revoke = revocable.revoke;
          return revocable.proxy;
        } },
        beforeQuery(index) {
          if (index === point.index + 1) { revoke!(); date?.setTime(NaN); revoked += 1; }
        },
      });
      const mode = point.trialMode ? TRIAL_MODE : MODE;
      const result = await captureAuthorizedTenantPurgeManifestValues(true, mode,
        create(true, mode, RUN, key(), 100, 10, 1_000, 60));
      expect(revoked).toBe(1);
      expect(result.target).toMatchObject({ mode, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE });
      expect(result.capabilitySha).toBe(SHA); expect(result.topology.workspace?.id).toBe(WORKSPACE);
      if (point.trialMode) expect(result.topology.trial?.expired).toBe(true);
      expect(state.queries).toEqual(expectedQueries(point.trialMode, point.linkedAccount));
      expectFrozenCopy(result);
    },
  );
  it("ignores late poisoning of Date clock and Date value methods captured by the real kernel", async () => {
    const state = fixture({}, { id: WORKSPACE }, true);
    const operation = create(true, TRIAL_MODE, RUN, key(), 100, 10, 1_000, 60);
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("late clock poison"); });
    const time = vi.spyOn(Date.prototype, "getTime").mockImplementation(() => { throw new Error("late Date poison"); });
    let result;
    try { result = await captureAuthorizedTenantPurgeManifestValues(true, TRIAL_MODE, operation); }
    finally { now.mockRestore(); time.mockRestore(); }
    expect(result?.topology.trial?.expired).toBe(true);
    expect(state.queries).toEqual(expectedQueries(true));
  });
  it.each(QUERY_PLANS)("captures and normalizes $label under late iterator/toJSON/clock poison", async (plan) => {
    const state = fixture({}, { id: WORKSPACE }, plan.trialMode, { linkedAccount: plan.linkedAccount });
    const caller = key(); const mode = plan.trialMode ? TRIAL_MODE : MODE;
    const define = Object.defineProperty; const remove = Reflect.deleteProperty;
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    const toJSON = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const now = Object.getOwnPropertyDescriptor(Date, "now")!;
    const iteratorError = new Error("late iterator poison"); const jsonError = new Error("late toJSON accessor poison");
    const clockError = new Error("late clock poison");
    let iteratorReads = 0; let jsonReads = 0; let clockReads = 0;
    let iteratorFault: unknown; let jsonFault: unknown; let clockFault: unknown;
    let result: Awaited<ReturnType<typeof captureAuthorizedTenantPurgeManifestValues>> | undefined;
    try {
      define(Array.prototype, Symbol.iterator, { configurable: true, writable: true,
        value() { iteratorReads += 1; throw iteratorError; } });
      define(Object.prototype, "toJSON", { configurable: true,
        get() { jsonReads += 1; throw jsonError; } });
      define(Date, "now", { configurable: true, writable: true,
        value() { clockReads += 1; throw clockError; } });
      // Positive controls run without assertions while shared prototypes are poisoned.
      try { Reflect.apply(Array.prototype[Symbol.iterator], [], []); } catch (error) { iteratorFault = error; }
      try { Reflect.get({}, "toJSON"); } catch (error) { jsonFault = error; }
      try { Date.now(); } catch (error) { clockFault = error; }
      iteratorReads = 0; jsonReads = 0; clockReads = 0;
      // Both the actual factory and released normalization execute under all three poisons.
      result = await captureAuthorizedTenantPurgeManifestValues(true, mode,
        create(true, mode, RUN, caller, 100, 10, 1_000, 60));
    } finally {
      define(Array.prototype, Symbol.iterator, iterator);
      if (toJSON) define(Object.prototype, "toJSON", toJSON); else remove(Object.prototype, "toJSON");
      define(Date, "now", now);
    }
    expect(iteratorFault).toBe(iteratorError); expect(jsonFault).toBe(jsonError); expect(clockFault).toBe(clockError);
    expect({ iteratorReads, jsonReads, clockReads }).toEqual({ iteratorReads: 0, jsonReads: 0, clockReads: 0 });
    expect(result?.target).toEqual(plan.trialMode
      ? { mode, trialId: TRIAL, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE }
      : { mode, accountId: ACCOUNT, deploymentId: DEPLOYMENT, workspaceId: WORKSPACE });
    expect(result?.redactionKeyBytes).toEqual(new Array(32).fill(7));
    expect(result?.blockers).toEqual(plan.linkedAccount ? ["LINKED_ACCOUNT", "SHARED_RESOURCE_AMBIGUITY"] : []);
    expect(state.queries).toEqual(expectedQueries(plan.trialMode, plan.linkedAccount));
    expectFrozenCopy(result);
  });
  it.each(QUERY_PLANS)("detaches the last $label result before its transaction closes", async (plan) => {
    let revoke!: () => void;
    const index = expectedQueries(plan.trialMode, plan.linkedAccount).length - 1;
    const state = fixture({}, { id: WORKSPACE }, plan.trialMode, { linkedAccount: plan.linkedAccount,
      resultAt: { index, replace() {
        const result = Proxy.revocable({ id: OTHER }, {}); revoke = result.revoke; return result.proxy;
      } }, beforeCommit() { revoke(); },
    });
    const mode = plan.trialMode ? TRIAL_MODE : MODE;
    const result = await captureAuthorizedTenantPurgeManifestValues(true, mode,
      create(true, mode, RUN, key(), 100, 10, 1_000, 60));
    expect(result.topology.deployment?.hasClientMigration).toBe(true);
    expect(result.blockers).toContain("CLIENT_MIGRATION"); expectFrozenCopy(result);
    expect(state.queries).toEqual(expectedQueries(plan.trialMode, plan.linkedAccount));
  });
});
