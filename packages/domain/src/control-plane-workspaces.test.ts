import { performance } from "node:perf_hooks";
import type { AppActor } from "@corgtex/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  workspace: { findMany: vi.fn(), findUnique: vi.fn() },
  customerDeployment: { findMany: vi.fn() },
  customerDeploymentEvent: { findFirst: vi.fn() },
}));
vi.mock("@corgtex/shared", () => ({ prisma: {
  workspace: mocks.workspace, customerDeployment: mocks.customerDeployment, customerDeploymentEvent: mocks.customerDeploymentEvent,
} }));
vi.mock("./control-plane", () => ({ requireControlPlaneAccess: mocks.access }));

import { getControlPlaneWorkspaceSummary, listControlPlaneWorkspaces } from "./control-plane-workspaces";

const actor: AppActor = { kind: "agent", authProvider: "control-plane", label: "ops-reader", scopes: ["control-plane:read"] };
const date = new Date("2026-09-01T12:00:00.000Z");
const account = { id: "account-1", displayName: "Shared Customer" };
function local(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: `Workspace ${id}`, slug: id, plan: "CORE_FREE", updatedAt: date,
    managedCustomerDeployment: null, ...overrides };
}
function remote(id: string, overrides: Record<string, unknown> = {}) {
  return { id, label: `Remote ${id}`, remoteWorkspaceId: `workspace-${id}`, remoteWorkspaceSlug: `slug-${id}`,
    managedWorkspaceId: null, deploymentKind: "SHARED_WORKSPACE", deploymentStatus: "DRAFT",
    updatedAt: date, customerAccount: account, ...overrides };
}
type LocalFixture = ReturnType<typeof local>;
type RemoteFixture = ReturnType<typeof remote>;

// These fixture selectors model only the predicates under test. They measure
// service calls/returned rows, not PostgreSQL plans, physical SQL count or latency.
function fixture(locals: LocalFixture[] = [], remotes: RemoteFixture[] = []) {
  const state = { returnedDirectoryRecords: 0 };
  mocks.workspace.findMany.mockImplementation(async ({ where, take }) => {
    const query: string = where.OR?.[0]?.name?.contains?.toLowerCase() ?? "";
    const records = locals.filter((item) => (!where.id || item.id > where.id.gt)
      && (!query || [item.name, item.slug, (item.managedCustomerDeployment as { customerAccount?: { displayName: string } } | null)?.customerAccount?.displayName]
        .some((value) => value?.toLowerCase().includes(query))))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take);
    state.returnedDirectoryRecords += records.length;
    return records;
  });
  mocks.customerDeployment.findMany.mockImplementation(async ({ where, take }) => {
    const query: string = where.OR?.[0]?.label?.contains?.toLowerCase() ?? "";
    const records = remotes.filter((item) => item.deploymentKind === where.deploymentKind && item.managedWorkspaceId === null
      && item.remoteWorkspaceId !== null && item.remoteWorkspaceId !== "" && (!where.id || item.id > where.id.gt)
      && (!query || [item.label, item.remoteWorkspaceSlug, item.customerAccount?.displayName]
        .some((value) => value?.toLowerCase().includes(query))))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take);
    state.returnedDirectoryRecords += records.length;
    return records;
  });
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ role: "OPERATOR" });
  mocks.workspace.findUnique.mockResolvedValue(null);
  mocks.customerDeploymentEvent.findFirst.mockResolvedValue(null);
  fixture();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Directory must not perform HTTP calls"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("control-plane workspace directory", () => {
  it.each(["FORBIDDEN", "CONTROL_PLANE_SCOPE_REQUIRED"])("delegates global authorization and rejects %s before any data reads", async (code) => {
    mocks.access.mockRejectedValueOnce({ status: 403, code });
    await expect(listControlPlaneWorkspaces(actor)).rejects.toMatchObject({ status: 403, code });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.workspace.findMany).not.toHaveBeenCalled();
    expect(mocks.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(mocks.customerDeploymentEvent.findFirst).not.toHaveBeenCalled();
  });

  it("includes every local plan, including actual trial workspaces, without trial-derived enumeration", async () => {
    fixture([local("free"), local("payg", { plan: "PAYG_AI" }), local("enterprise", { plan: "ENTERPRISE_MANAGED" }), local("trial", { plan: "TRIAL" })]);
    const result = await listControlPlaneWorkspaces(actor);
    expect(result.rows.map((row) => row.workspaceId)).toEqual(["enterprise", "free", "payg", "trial"]);
    expect(result.rows.every((row) => row.source === "local" && row.accountLabel === null && row.observedStatus === null && !row.deploymentId)).toBe(true);
    expect(mocks.workspace.findMany.mock.calls[0][0]).toMatchObject({ where: {}, orderBy: { id: "asc" }, take: 26 });
    expect(mocks.workspace.findMany.mock.calls[0][0].where).not.toHaveProperty("plan");
    expect(result.coverage.local).toBe("authoritative-local-database");
    expect(result.coverage.counts).toEqual({ scope: "returned-page", local: 4, remote: 0 });
    expect(result.nextCursor).toBeNull();
    expect(result).not.toHaveProperty("totalCustomers");
  });

  it("preserves several workspaces per account across sources/providers and deduplicates only the local link", async () => {
    fixture([
      local("a", { managedCustomerDeployment: remote("linked-a", { customerAccount: account, cloudProvider: "RAILWAY" }) }),
      local("b", { managedCustomerDeployment: remote("linked-b", { customerAccount: account, cloudProvider: "AZURE" }) }),
    ], [remote("linked-a", { managedWorkspaceId: "a" }), remote("linked-b", { managedWorkspaceId: "b" }),
      remote("remote-c", { cloudProvider: "AZURE" }), remote("remote-d", { cloudProvider: "RAILWAY" })]);
    const result = await listControlPlaneWorkspaces(actor);
    expect(result.rows.map((row) => row.key)).toEqual(["local:a", "local:b", "remote:remote-c", "remote:remote-d"]);
    expect(result.rows.every((row) => row.accountId === account.id && row.accountLabel === account.displayName)).toBe(true);
    expect(mocks.customerDeployment.findMany.mock.calls[0][0].where).not.toHaveProperty("cloudProvider");
    expect(result.rows.every((row) => !Object.hasOwn(row, "capabilities"))).toBe(true);
  });

  it("does not collapse equal remote/local workspace IDs or slugs, or two remote sources with equal workspace IDs", async () => {
    fixture([local("collision")], [remote("one", { remoteWorkspaceId: "collision", remoteWorkspaceSlug: "collision" }),
      remote("two", { remoteWorkspaceId: "collision", remoteWorkspaceSlug: "collision" })]);
    const result = await listControlPlaneWorkspaces(actor);
    expect(result.rows.map((row) => row.key)).toEqual(["local:collision", "remote:one", "remote:two"]);
    expect(result.rows.map((row) => row.workspaceId)).toEqual(["collision", "collision", "collision"]);
  });

  it("excludes nonworkspace registrations and deduplicates linked trials without excluding their local workspace", async () => {
    fixture([local("trial", { plan: "TRIAL", managedCustomerDeployment: remote("linked-trial", { managedWorkspaceId: "trial" }) })], [remote("root", { remoteWorkspaceId: null }),
      remote("empty", { remoteWorkspaceId: "" }), remote("dedicated", { deploymentKind: "REMOTE_MANAGED" }),
      remote("linked-trial", { managedWorkspaceId: "trial" }), remote("registered")]);
    const result = await listControlPlaneWorkspaces(actor);
    expect(result.rows.map((row) => row.key)).toEqual(["local:trial", "remote:registered"]);
    expect(result.rows[0].plan).toBe("TRIAL");
    expect(result.rows[0].deploymentId).toBe("linked-trial");
    expect(result.rows[1]).not.toHaveProperty("plan");
    expect(result.rows[1].observedStatus).toBe("DRAFT");
    expect(result.rows[1].freshness).toEqual({ workspaceUpdatedAt: null, registrationUpdatedAt: date.toISOString(), liveChecked: false });
  });

  it("retains an explicit registry triage capability for the remote-only synchronized fixture with no deployment rows", async () => {
    mocks.customerDeploymentEvent.findFirst.mockResolvedValue({ id: "sync-event-1", deploymentId: "deployment-azure", createdAt: date });
    const result = await listControlPlaneWorkspaces(actor);
    expect(result.rows).toEqual([]);
    expect(result.coverage).toMatchObject({ directory: "partial", remoteInventory: "unverified", remote: "registered-shared-workspaces-only",
      unreconciledSources: { status: "not-reconciled", href: "/control-plane/self-serve",
        latestSync: { eventId: "sync-event-1", sourceDeploymentId: "deployment-azure", recordedAt: date.toISOString() } } });
    expect(mocks.customerDeploymentEvent.findFirst).toHaveBeenCalledWith({
      where: { action: "self_serve.registry_synced" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, deploymentId: true, createdAt: true },
    });
    expect(result.coverage.unreconciledSources).not.toHaveProperty("count");
  });

  it("keyset-pages across the source boundary without offsets, skips or duplicates", async () => {
    fixture([local("a"), local("b"), local("c")], [remote("d"), remote("e"), remote("f")]);
    const first = await listControlPlaneWorkspaces(actor, { pageSize: 2 });
    const second = await listControlPlaneWorkspaces(actor, { pageSize: 2, cursor: first.nextCursor! });
    const third = await listControlPlaneWorkspaces(actor, { pageSize: 2, cursor: second.nextCursor! });
    expect([...first.rows, ...second.rows, ...third.rows].map((row) => row.key)).toEqual(["local:a", "local:b", "local:c", "remote:d", "remote:e", "remote:f"]);
    expect(third.nextCursor).toBeNull();
    expect(mocks.workspace.findMany).toHaveBeenCalledTimes(2);
    expect(mocks.customerDeployment.findMany).toHaveBeenCalledTimes(2);
    expect(mocks.workspace.findMany.mock.calls[1][0].where.id).toEqual({ gt: "b" });
    expect(mocks.customerDeployment.findMany.mock.calls[1][0].where.id).toEqual({ gt: "d" });
    for (const [query] of [...mocks.workspace.findMany.mock.calls, ...mocks.customerDeployment.findMany.mock.calls]) {
      expect(query.take).toBeGreaterThan(0);
      expect(query.take).toBeLessThanOrEqual(3);
      expect(query).not.toHaveProperty("skip");
      expect(query).not.toHaveProperty("include");
    }
  });

  it("uses a remote lookahead when the local page is exactly full", async () => {
    fixture([local("a"), local("b")], [remote("c")]);
    const first = await listControlPlaneWorkspaces(actor, { pageSize: 2 });
    expect(mocks.customerDeployment.findMany.mock.calls[0][0].take).toBe(1);
    const second = await listControlPlaneWorkspaces(actor, { pageSize: 2, cursor: first.nextCursor! });
    expect(second.rows.map((row) => row.key)).toEqual(["remote:c"]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(["local", "remote"] as const)("scopes %s reads without enumerating the other source", async (scope) => {
    fixture([local("local")], [remote("remote")]);
    const result = await listControlPlaneWorkspaces(actor, { scope });
    expect(result.scope).toBe(scope);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].source).toBe(scope);
    expect(scope === "local" ? mocks.customerDeployment.findMany : mocks.workspace.findMany).not.toHaveBeenCalled();
  });

  it("searches local/remote names, slugs and account labels in the DB predicates", async () => {
    fixture([local("plain"), local("local", { name: "Alpha Team" }),
      local("linked", { managedCustomerDeployment: remote("link", { customerAccount: { id: "ac", displayName: "Alpha Group" } }) })],
    [remote("remote", { remoteWorkspaceSlug: "alpha-remote" }), remote("other")]);
    const result = await listControlPlaneWorkspaces(actor, { query: " Alpha " });
    expect(result.query).toBe("Alpha");
    expect(result.rows.map((row) => row.key)).toEqual(["local:linked", "local:local", "remote:remote"]);
    expect(mocks.workspace.findMany.mock.calls[0][0].where.OR).toContainEqual({ managedCustomerDeployment: { is: { customerAccount: { is: { displayName: { contains: "Alpha", mode: "insensitive" } } } } } });
  });

  it.each([{ pageSize: 0 }, { pageSize: 101 }, { pageSize: 1.5 }, { pageSize: NaN }, { query: "x".repeat(121) },
    { cursor: "not-json" }, { cursor: "" }, { cursor: "x".repeat(2049) }, { scope: "azure" }])("rejects unbounded/invalid parameters %j before querying", async (params) => {
    await expect(listControlPlaneWorkspaces(actor, params as Parameters<typeof listControlPlaneWorkspaces>[1])).rejects.toMatchObject({ status: 400 });
    expect(mocks.workspace.findMany).not.toHaveBeenCalled();
    expect(mocks.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(mocks.customerDeploymentEvent.findFirst).not.toHaveBeenCalled();
  });

  it("binds cursors to scope and search, and reauthorizes every page", async () => {
    fixture([local("a"), local("b")]);
    const first = await listControlPlaneWorkspaces(actor, { pageSize: 1 });
    await expect(listControlPlaneWorkspaces(actor, { cursor: first.nextCursor!, query: "changed" })).rejects.toMatchObject({ status: 400 });
    await expect(listControlPlaneWorkspaces(actor, { cursor: first.nextCursor!, scope: "remote" })).rejects.toMatchObject({ status: 400 });
    mocks.access.mockRejectedValueOnce({ status: 403 });
    await expect(listControlPlaneWorkspaces(actor, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 403 });
    expect(mocks.access).toHaveBeenCalledTimes(4);
  });

  it("selects only directory metadata and no credentials, snapshots, member records, recorder state or provider capabilities", async () => {
    await listControlPlaneWorkspaces(actor);
    const localSelect = mocks.workspace.findMany.mock.calls[0][0].select;
    expect(Object.keys(localSelect).sort()).toEqual(["id", "managedCustomerDeployment", "name", "plan", "slug", "updatedAt"]);
    expect(Object.keys(localSelect.managedCustomerDeployment.select).sort()).toEqual(["customerAccount", "deploymentStatus", "id", "updatedAt"]);
    const remoteSelect = mocks.customerDeployment.findMany.mock.calls[0][0].select;
    expect(Object.keys(remoteSelect).sort()).toEqual(["customerAccount", "deploymentStatus", "id", "label", "remoteWorkspaceId", "remoteWorkspaceSlug", "updatedAt"]);
    expect(Object.keys(remoteSelect.customerAccount.select).sort()).toEqual(["displayName", "id"]);
  });

  it.each([250, 10000])("bounds directory results and ORM calls on a %i-record synthetic fixture", async (size) => {
    const state = fixture(Array.from({ length: size }, (_, index) => local(String(index).padStart(8, "0"))));
    const started = performance.now();
    const result = await listControlPlaneWorkspaces(actor, { pageSize: 100 });
    const elapsedMs = performance.now() - started;
    const ormCalls = mocks.workspace.findMany.mock.calls.length + mocks.customerDeployment.findMany.mock.calls.length + mocks.customerDeploymentEvent.findFirst.mock.calls.length;
    expect(result.rows).toHaveLength(100);
    expect(state.returnedDirectoryRecords).toBe(101);
    expect(ormCalls).toBe(2);
    console.info(JSON.stringify({ proof: "synthetic-service-only", fixtureRecords: size, returnedDirectoryRecords: 101, ormCalls, elapsedMs: Number(elapsedMs.toFixed(3)), physicalSqlQueries: "unmeasured" }));
  });

  it("bounds a mixed-source page to three ORM calls and one combined lookahead", async () => {
    const state = fixture([local("a")], Array.from({ length: 10000 }, (_, index) => remote(String(index).padStart(8, "0"))));
    const started = performance.now();
    const result = await listControlPlaneWorkspaces(actor, { pageSize: 100 });
    const elapsedMs = performance.now() - started;
    const ormCalls = mocks.workspace.findMany.mock.calls.length + mocks.customerDeployment.findMany.mock.calls.length + mocks.customerDeploymentEvent.findFirst.mock.calls.length;
    expect(result.coverage.counts).toEqual({ scope: "returned-page", local: 1, remote: 99 });
    expect(state.returnedDirectoryRecords).toBe(101);
    expect(mocks.customerDeployment.findMany.mock.calls[0][0].take).toBe(100);
    expect(ormCalls).toBe(3);
    console.info(JSON.stringify({ proof: "synthetic-service-only", fixtureRecords: 10001, returnedDirectoryRecords: 101, ormCalls, elapsedMs: Number(elapsedMs.toFixed(3)), physicalSqlQueries: "unmeasured" }));
  });
});

describe("control-plane local workspace summary", () => {
  it("rejects unauthorized access before querying and requires global rather than deployment access", async () => {
    mocks.access.mockRejectedValueOnce({ status: 403, code: "FORBIDDEN" });
    await expect(getControlPlaneWorkspaceSummary(actor, "local-1")).rejects.toMatchObject({ status: 403 });
    expect(mocks.access).toHaveBeenCalledExactlyOnceWith(actor);
    expect(mocks.workspace.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing local ID without looking up remote tenants", async () => {
    await expect(getControlPlaneWorkspaceSummary(actor, "remote-id")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(mocks.customerDeployment.findMany).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(129)])("rejects invalid summary ID before querying", async (workspaceId) => {
    await expect(getControlPlaneWorkspaceSummary(actor, workspaceId)).rejects.toMatchObject({ status: 400 });
    expect(mocks.workspace.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, { id: "deployment-1", label: "Linked deployment", customerAccount: account }])("reads minimal local metadata and optional managed link %j", async (managedCustomerDeployment) => {
    mocks.workspace.findUnique.mockResolvedValue({ ...local("local-1"), createdAt: date, trialEndsAt: null,
      _count: { members: 3 }, managedCustomerDeployment });
    const result = await getControlPlaneWorkspaceSummary(actor, "local-1");
    expect(result).toMatchObject({ workspaceId: "local-1", name: "Workspace local-1", plan: "CORE_FREE", memberCount: 3, createdAt: date.toISOString() });
    expect(result.managedDeployment).toEqual(managedCustomerDeployment ? { deploymentId: "deployment-1", label: "Linked deployment", accountId: account.id, accountLabel: account.displayName } : null);
    const query = mocks.workspace.findUnique.mock.calls[0][0];
    expect(query.where).toEqual({ id: "local-1" });
    expect(query).not.toHaveProperty("include");
    expect(Object.keys(query.select).sort()).toEqual(["_count", "createdAt", "id", "managedCustomerDeployment", "name", "plan", "slug", "trialEndsAt", "updatedAt"]);
    expect(query.select._count).toEqual({ select: { members: true } });
    expect(mocks.workspace.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.customerDeployment.findMany).not.toHaveBeenCalled();
    expect(mocks.customerDeploymentEvent.findFirst).not.toHaveBeenCalled();
  });
});
