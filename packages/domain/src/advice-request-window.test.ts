import { beforeEach, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const f = vi.hoisted(() => ({ rows: [] as any[], allowed: new Set<string>(), versions: new Map<string, number>(), active: true,
  query: vi.fn(), membership: vi.fn(), later: vi.fn(), finalRoots: vi.fn() }));
vi.mock("@corgtex/shared", () => ({ prisma: { adviceRequest: { findMany: f.query } } }));
vi.mock("./auth", () => ({ requireWorkspaceMembership: f.membership }));
vi.mock("./producer-lineage", () => ({ prepareProducerLineage: vi.fn(), finishProducerLineage: vi.fn() }));
vi.mock("./audit-trail", () => ({ recordAudit: vi.fn() }));
vi.mock("./events", () => ({ appendEvents: vi.fn() }));
vi.mock("./source-lineage", () => ({
  readableArtifactIds: async (_a: unknown, _w: string, _k: string, rows: any[]) => new Set(rows.filter(row => f.allowed.has(row.id)).map(row => row.id)),
  captureArtifactInputProof: async (_a: unknown, _w: string, inputs: any[]) => {
    if (inputs.some(row => !f.allowed.has(row.id))) throw new (await import("./errors")).AppError(409, "UNKNOWN_LINEAGE", "Synthetic denied join");
    return inputs.map(row => ({ kind: row.kind, id: row.id, fingerprint: String(f.versions.get(row.id) ?? 1) }));
  },
  captureArtifactReadHeadObservation: async (read: () => Promise<unknown>) => ({ value: await read(), heads: new Map() }),
  mergeLineageInputRoot: (_prior: unknown, next: unknown) => next,
  withArtifactCountReleaseSnapshot: async (_a: unknown, _w: string, roots: any[], remote: () => Promise<void>, done: (tx: any) => Promise<unknown>) => {
    f.finalRoots(roots); await f.later();
    if (roots.some(row => !f.allowed.has(row.id) || row.fingerprint !== String(f.versions.get(row.id) ?? 1)))
      throw new (await import("./errors")).AppError(409, "SOURCE_CHANGED", "Original source changed");
    await remote(); return done({ adviceRequest: { findMany: f.query } });
  },
}));
import { listAdviceRequests, listAdviceRequestWindow } from "./advice-requests";
const actor: AppActor = { kind: "user", user: { id: "reader", email: "reader@example.test", displayName: null } };
function row(index: number, readable = true) {
  const id = `r-${String(index).padStart(4, "0")}`;
  const item = { id, workspaceId: "ws", createdAt: new Date("2026-01-01"), status: "ACTIVE", requestedBy: { id: "requester", email: "person@example.test", displayName: "Person" },
    targetCircle: null, recipients: [], process: { workspaceId: "ws", subjectType: "ACTION", subjectId: `subject-${id}`, authorMemberId: "author", id: "process" } };
  f.rows.push(item); if (readable) { f.allowed.add(id); f.allowed.add(item.process.subjectId); }
  return item;
}
beforeEach(() => {
  vi.clearAllMocks(); f.later.mockReset(); f.rows.length = 0; f.allowed.clear(); f.versions.clear(); f.active = true;
  f.allowed.add("requester"); f.allowed.add("author");
  f.membership.mockImplementation(async () => { if (!f.active) throw new (await import("./errors")).AppError(403, "NOT_A_MEMBER", "Caller departed"); });
  f.query.mockImplementation(async ({ where, take }: any) => structuredClone(f.rows.filter(item => item.workspaceId === where.workspaceId
    && (!where.id || where.id.in.includes(item.id)) && (!where.status || item.status === where.status)
    && (!where.process?.subjectType || where.process.subjectType === item.process.subjectType)
    && (!where.process?.subjectId || where.process.subjectId === item.process.subjectId)
    && (!where.OR || item.createdAt < where.OR[0].createdAt.lt || item.createdAt.getTime() === where.OR[1].createdAt.getTime() && item.id > where.OR[1].id.gt))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)).slice(0, take)));
});
it("legacy list stops after 200 hidden joined subjects instead of searching indefinitely", async () => {
  for (let i = 0; i < 301; i++) { const item = row(i); f.allowed.delete(item.process.subjectId); }
  await expect(listAdviceRequests(actor, { workspaceId: "ws" })).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  expect(f.query).toHaveBeenCalledTimes(2);
});
it("continues an empty hidden window through equal timestamps to later readable requests", async () => {
  for (let i = 0; i < 205; i++) row(i, i >= 200);
  const first = await listAdviceRequestWindow(actor, { workspaceId: "ws" });
  expect(first).toMatchObject({ items: [], complete: false, nextCursor: expect.any(String) });
  expect(f.query.mock.calls.map(([args]) => args.take)).toEqual([100, 100]);
  const second = await listAdviceRequestWindow(actor, { workspaceId: "ws", cursor: first.nextCursor! });
  expect(second).toMatchObject({ complete: true, nextCursor: null });
  expect(second.items.map(item => item.id)).toEqual(f.rows.slice(200).map(item => item.id));
});
it("continues from last consumed row without losing a fetched readable suffix", async () => {
  for (let i = 0; i < 5; i++) row(i);
  const first = await listAdviceRequestWindow(actor, { workspaceId: "ws", take: 2 });
  const second = await listAdviceRequestWindow(actor, { workspaceId: "ws", take: 2, cursor: first.nextCursor! });
  const third = await listAdviceRequestWindow(actor, { workspaceId: "ws", take: 2, cursor: second.nextCursor! });
  expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(f.rows.map(item => item.id));
  expect(third.complete).toBe(true);
  expect(first.items[0].requestedBy).toEqual({ id: "requester", email: "person@example.test", displayName: "Person" });
});
it("binds continuation to caller, workspace and filters and rejects malformed cursors", async () => {
  row(0); row(1);
  const page = await listAdviceRequestWindow(actor, { workspaceId: "ws", take: 1 });
  for (const change of [{ workspaceId: "foreign" }, { subjectType: "TENSION" }, { status: "COMPLETED" as const }, { cursor: "bad" }]) {
    await expect(listAdviceRequestWindow(actor, { workspaceId: "ws", cursor: page.nextCursor!, ...change })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  await expect(listAdviceRequestWindow({ ...actor, user: { ...actor.user, id: "other" } }, { workspaceId: "ws", cursor: page.nextCursor! })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(listAdviceRequestWindow(actor, { workspaceId: "ws", take: 101 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
it.each(["subject", "requester", "author", "caller", "body"])("retains original final-release protection for late %s change", async mode => {
  const item = row(0);
  f.later.mockImplementation(async () => {
    if (mode === "caller") f.active = false;
    else if (mode === "body") item.requestedBy.displayName = "Changed";
    else f.versions.set(mode === "subject" ? item.process.subjectId : mode, 2);
  });
  await expect(listAdviceRequestWindow(actor, { workspaceId: "ws" })).rejects.toMatchObject({ code: mode === "caller" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
});
it("keeps zero-take and empty windows behind the final current caller gate", async () => {
  expect(await listAdviceRequestWindow(actor, { workspaceId: "ws", take: 0 })).toEqual({ items: [], complete: true, nextCursor: null });
  expect(f.query).not.toHaveBeenCalled();
  f.later.mockImplementation(async () => { f.active = false; });
  await expect(listAdviceRequestWindow(actor, { workspaceId: "ws" })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
});
