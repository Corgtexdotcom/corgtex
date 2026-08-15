import { describe, expect, it, vi } from "vitest";
import { captureAuthorizedTenantPurgeManifestValues } from "./tenant-purge-atomic-capture-contract";
import { createTenantPurgeOwnedVector, pushTenantPurgeOwnedVector } from "./tenant-purge-owned-vector-kernel";
const mock = vi.hoisted(() => ({ gets: 0, calls: [] as string[], options: null as unknown, tx: null as unknown }));
vi.mock("@corgtex/shared", () => ({
  prisma: new Proxy({}, {
    get(_target, property) {
      mock.gets += 1;
      if (property !== "$transaction") throw new Error(`unexpected client access ${String(property)}`);
      return async (operation: (tx: unknown) => unknown, options: unknown) => {
        mock.options = options; return operation(mock.tx);
      };
    },
  }),
}));
import { createTenantPurgePrismaAuthorizeAndCapture as create } from "./tenant-purge-prisma-reader";
const A = "10000000-0000-4000-8000-000000000001"; const D = "20000000-0000-4000-8000-000000000002";
const W = "30000000-0000-4000-8000-000000000003"; const T = "40000000-0000-4000-8000-000000000004";
const SHA = "a".repeat(40);
const BLOCKED = ["LINKED_DEPLOYMENT", "SIBLING_DEPLOYMENT", "SHARED_RESOURCE_AMBIGUITY",
  "MANAGED_RELEASE_LEASE", "PROVIDER_CUTOVER", "CLIENT_MIGRATION"];
const ACCOUNT_CALLS = ["run.findUnique", "workspace.findUnique", "deployment.findUnique", "deployment.findMany",
  "trial.findMany", "account.findUnique", "deployment.findMany", "account.findMany", "cutover.findFirst",
  "migration.findFirst"];
const TRIAL_CALLS = ["run.findUnique", "workspace.findUnique", "deployment.findUnique", "deployment.findMany",
  "trial.findMany", "account.findMany", "trial.findUnique", "cutover.findFirst", "migration.findFirst"];
function key() {
  let result = createTenantPurgeOwnedVector<number>(32);
  for (let index = 0; index < 32; index += 1) result = pushTenantPurgeOwnedVector(result, index);
  return result;
}
function delegate(name: string, methods: Record<string, (input: any) => unknown>) {
  return new Proxy(methods, {
    get(target, property) {
      mock.calls.push(`${name}.${String(property)}`);
      if (!(property in target)) throw new Error(`unexpected delegate access ${String(property)}`);
      return target[property as string];
    },
  });
}
function transaction(mode: "ACCOUNT_WORKSPACE" | "SELF_SERVE_TRIAL_WORKSPACE", runChanges = {}, blocked = false) {
  const trial = mode === "SELF_SERVE_TRIAL_WORKSPACE";
  const run = { mode, status: "PLANNED", targetAccountId: trial ? null : A,
    targetDeploymentId: D, targetWorkspaceId: W, targetTrialId: trial ? T : null,
    canonicalTargetKey: `${mode}:${trial ? T : A}:${D}:${W}`,
    activeTargetKey: `${mode}:${trial ? T : A}:${D}:${W}`, capabilitySha: SHA, ...runChanges };
  mock.tx = {
    tenantPurgeRun: delegate("run", { findUnique: () => run }),
    workspace: delegate("workspace", { findUnique: () => ({ id: W }) }),
    customerDeployment: delegate("deployment", {
      findUnique: () => ({ id: D, managedWorkspaceId: W, customerAccountId: trial ? null : A,
        releaseLeaseId: blocked ? A : null, releaseLeaseTokenHash: null, releaseLeaseOwner: null,
        releaseLeaseExpectedImageTag: null, releaseLeaseIncomingImageTag: null,
        releaseLeaseIncomingVersion: null, releaseLeasePhase: null, releaseLeaseAcquiredAt: null,
        releaseLeaseHeartbeatAt: null, releaseLeaseExpiresAt: null, releaseLeaseRollbackRecord: null,
        releaseLeaseRecoveryEvidence: null, releaseLeaseError: null }),
      findMany: (input) => input.where.customerAccountId && blocked ? [{ id: D }, { id: T }] : [{ id: D }],
    }),
    customerAccount: delegate("account", { findUnique: () => trial ? null : ({ id: A, primaryDeploymentId: null }),
      findMany: () => [] }),
    procurementTrial: delegate("trial", {
      findUnique: () => trial ? ({ id: T, workspaceId: W, trialExpiresAt: new Date(2_000) }) : null,
      findMany: () => trial ? [{ id: T }] : [],
    }),
    providerCutover: delegate("cutover", { findFirst: () => blocked ? ({ id: T }) : null }),
    clientMigrationRun: delegate("migration", { findFirst: () => blocked ? ({ id: T }) : null }),
  };
}
describe("tenant purge Prisma snapshot adapter", () => {
  it("denies before observing later inputs or resolving Prisma", async () => {
    const hostile = new Proxy({}, { get() { throw new Error("observed"); } });
    const callback = create(false, hostile, hostile, hostile, hostile, hostile, hostile, hostile);
    expect(Object.isFrozen(callback)).toBe(true); expect(callback).toHaveLength(0);
    expect(await callback()).toBe(false);
    expect(mock.gets).toBe(0);
  });
  it("captures both modes through one exact repeatable-read snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    for (const mode of ["ACCOUNT_WORKSPACE", "SELF_SERVE_TRIAL_WORKSPACE"] as const) {
      mock.calls = [];
      transaction(mode, {}, mode === "ACCOUNT_WORKSPACE");
      const callback = create(true, mode, A, key(), 10, 20, 30, 40);
      const result = await captureAuthorizedTenantPurgeManifestValues(true, mode, callback);
      expect(result.target.mode).toBe(mode);
      expect(result.blockers).toEqual(mode === "ACCOUNT_WORKSPACE" ? BLOCKED : ["TRIAL_NOT_EXPIRED"]);
      expect(mock.options).toEqual({ isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
      expect(mock.calls).toEqual(mode === "ACCOUNT_WORKSPACE" ? ACCOUNT_CALLS : TRIAL_CALLS);
      await expect(callback()).rejects.toMatchObject({ code: "TENANT_PURGE_CONTRACT_INVALID" });
    }
  });
  it("fails closed for forged inputs, inactive authority, overflow, and malformed rows", async () => {
    expect(() => create(true, "ACCOUNT_WORKSPACE", A, {}, 1, 1, 1, 0)).toThrow();
    expect(() => create(true, "ACCOUNT_WORKSPACE", A, key(), 0, 1, 1, 0)).toThrow();
    transaction("ACCOUNT_WORKSPACE", { activeTargetKey: null });
    const denied = create(true, "ACCOUNT_WORKSPACE", A, key(), 1, 1, 1, 0);
    await expect(captureAuthorizedTenantPurgeManifestValues(true, "ACCOUNT_WORKSPACE", denied))
      .rejects.toMatchObject({ status: 403, code: "TENANT_PURGE_TARGET_FORBIDDEN" });
    transaction("ACCOUNT_WORKSPACE");
    (mock.tx as any).customerDeployment.findMany = () => new Array(1_001).fill({ id: D });
    const overflow = create(true, "ACCOUNT_WORKSPACE", A, key(), 1, 1, 1, 0);
    await expect(captureAuthorizedTenantPurgeManifestValues(true, "ACCOUNT_WORKSPACE", overflow))
      .rejects.toMatchObject({ status: 400, code: "TENANT_PURGE_CONTRACT_INVALID" });
  });
});
