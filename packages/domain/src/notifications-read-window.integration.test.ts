import { randomUUID } from "node:crypto";
import { Prisma, type Notification } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { readNotificationPage, readUnreadNotificationSummary } from "./notifications-read-window";
import { countUnreadNotifications, listNotifications } from "./notifications";
import { recordArtifactInputLineage } from "./source-lineage";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
  || database.pathname !== "/corgtex_test" || database.searchParams.get("schema") !== "public") {
  throw new Error("Notification window tests require a disposable loopback corgtex_test database.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(total: number, known: number[], tied = false) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic bounded notifications", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Original synthetic source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  await prisma.notification.createMany({ data: Array.from({ length: total }, (_, index) => ({
    id: `synthetic-notification-${String(total - index).padStart(5, "0")}`, workspaceId: workspace.id, userId: user.id,
    type: "synthetic", title: `Title ${index}`, bodyMd: `Original body ${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, tied ? 0 : total - index)),
  })) });
  const rows = await prisma.notification.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  for (const index of known) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Notification", id: rows[index].id }, content: rows[index], origin: "DERIVED", inputs: [{ kind: "BrainSource", id: source.id }] }));
  return { workspaceId: workspace.id, actor, member, source, rows };
}
function queryBoundary(change?: () => Promise<void>) {
  const delegate = prisma.notification as unknown as { findMany: (args?: Prisma.NotificationFindManyArgs) => Promise<Notification[]> };
  const query = delegate.findMany.bind(delegate);
  let changed = false, completed = false;
  const spy = vi.spyOn(delegate, "findMany").mockImplementation(async args => {
    if (change && !changed && args?.where?.OR && args.take === 100) {
      changed = true; await change(); completed = true;
    }
    return query(args);
  });
  return { spy, assertChanged: () => expect(completed).toBe(true) };
}

describe("bounded notification history windows", () => {
  it("advances beyond 201 hidden rows through an empty bounded window without losing the readable tail", async () => {
    const f = await fixture(202, [201]);
    const { spy } = queryBoundary();
    const first = await readNotificationPage(f.actor, f.workspaceId, { take: 1 });
    expect(first).toMatchObject({ items: [], complete: false, hasMore: true, nextCursor: expect.any(String) });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.every(([args]) => args?.take === 100)).toBe(true);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toMatchObject({ id: f.rows[199].id });
    const next = await readNotificationPage(f.actor, f.workspaceId, { take: 1, cursor: first.nextCursor! });
    expect(next.items.map(row => row.id)).toEqual([f.rows[201].id]);
    expect(next).toMatchObject({ complete: true, hasMore: false, nextCursor: null });
    expect(spy).toHaveBeenCalledTimes(3);
    await expect(listNotifications(f.actor, f.workspaceId, { take: 1 })).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  });

  it("orders equal timestamps by descending id and continues without duplicates", async () => {
    const f = await fixture(4, [0, 1, 2, 3], true);
    const first = await readNotificationPage(f.actor, f.workspaceId, { take: 2 });
    const second = await readNotificationPage(f.actor, f.workspaceId, { take: 2, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(f.rows.map(row => row.id));
    expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(4);
    expect(second.complete).toBe(true);
  });

  it("rejects malformed, filter-mismatched and out-of-range continuations", async () => {
    const f = await fixture(2, [0, 1]);
    const first = await readNotificationPage(f.actor, f.workspaceId, { take: 1, unreadOnly: true });
    for (const opts of [{ cursor: "not-json" }, { cursor: first.nextCursor!, unreadOnly: false }, { take: 101 }, { skip: 201 }, { take: -1 }]) {
      await expect(readNotificationPage(f.actor, f.workspaceId, opts)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect(await readNotificationPage(f.actor, f.workspaceId, { take: 0 })).toEqual({ items: [], nextCursor: null, hasMore: false, complete: true });
  });

  it("keeps every cursor query bound to the caller workspace and recipient", async () => {
    const f = await fixture(2, [0, 1]);
    const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
    const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
    await prisma.notification.createMany({ data: [
      { workspaceId: foreign.id, userId: f.actor.user.id, type: "synthetic", title: "Foreign secret", bodyMd: "Foreign body" },
      { workspaceId: f.workspaceId, userId: other.id, type: "synthetic", title: "Other recipient", bodyMd: "Other body" },
    ] });
    const { spy } = queryBoundary();
    const first = await readNotificationPage(f.actor, f.workspaceId, { take: 1 });
    const second = await readNotificationPage(f.actor, f.workspaceId, { take: 1, cursor: first.nextCursor! });
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(f.rows.map(row => row.id));
    for (const [args] of spy.mock.calls) expect(args?.where).toMatchObject({ workspaceId: f.workspaceId, userId: f.actor.user.id });
    await expect(readNotificationPage(f.actor, foreign.id, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  });

  it("reports a 100-item unread lower bound without claiming an exact count", async () => {
    const f = await fixture(101, Array.from({ length: 101 }, (_, index) => index));
    const { spy } = queryBoundary();
    expect(await readUnreadNotificationSummary(f.actor, f.workspaceId)).toEqual({ count: 100, complete: false, available: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.take).toBe(100);
    await expect(countUnreadNotifications(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  });

  it("does not present a denied-history window as an exact zero", async () => {
    const f = await fixture(202, [201]);
    expect(await readUnreadNotificationSummary(f.actor, f.workspaceId)).toEqual({ count: 0, complete: false, available: true });
    await expect(countUnreadNotifications(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_READ_SCAN_LIMIT" });
  });

  it("withholds the original first-page body after a later-page edit", async () => {
    const f = await fixture(101, [0, 100]);
    const boundary = queryBoundary(async () => {
      await prisma.notification.update({ where: { id: f.rows[0].id }, data: { bodyMd: "Changed after original admission" } });
    });
    await expect(readNotificationPage(f.actor, f.workspaceId, { take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    boundary.assertChanged();
    expect(await prisma.notification.findUnique({ where: { id: f.rows[0].id }, select: { bodyMd: true } }))
      .toEqual({ bodyMd: "Changed after original admission" });
  });

  it("distinguishes unavailable unread authority from an available empty result", async () => {
    const f = await fixture(101, [0, 100]);
    const boundary = queryBoundary(async () => {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    });
    expect(await readUnreadNotificationSummary(f.actor, f.workspaceId)).toEqual({ count: 0, complete: false, available: false });
    boundary.assertChanged();
  });
});
