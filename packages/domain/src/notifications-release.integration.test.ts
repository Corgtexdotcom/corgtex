import { randomUUID } from "node:crypto";
import { Prisma, type Notification } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { countUnreadNotifications, listNotifications, markAllNotificationsRead } from "./notifications";
import { recordArtifactInputLineage } from "./source-lineage";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
  || database.pathname !== "/corgtex_test" || database.searchParams.get("schema") !== "public") {
  throw new Error("Notification release tests require a disposable loopback corgtex_test database.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic notification release", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id,
    sourceType: "DOC", tier: 1, content: "Synthetic original notification source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const rows: Notification[] = [];
  for (let index = 0; index < 101; index++) {
    const row = await prisma.notification.create({ data: { workspaceId: workspace.id, userId: user.id,
      type: "synthetic", title: `Synthetic title ${index}`, bodyMd: `Synthetic body ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 101 - index)) } });
    rows.push(row);
    // Unknown entries must not consume visible pagination or aggregate counts.
    if (index === 0 || index === 100) await prisma.$transaction(tx => recordArtifactInputLineage({
      tx, actor, workspaceId: workspace.id, artifact: { kind: "Notification", id: row.id },
      content: row, origin: "DERIVED", inputs: [{ kind: "BrainSource", id: source.id }],
    }));
  }
  const onLaterPage = (change: () => Promise<void>) => {
    const delegate = prisma.notification as unknown as { findMany: (args?: Prisma.NotificationFindManyArgs) => Promise<Notification[]> };
    const query = delegate.findMany.bind(delegate);
    let changed = false;
    return vi.spyOn(delegate, "findMany").mockImplementation(async args => {
      if (!changed && args?.where?.OR && args.take === 100) { changed = true; await change(); }
      return query(args);
    });
  };
  const revokeRestore = async () => {
    await prisma.member.update({ where: { id: member.id }, data: { isActive: false } });
    await prisma.member.update({ where: { id: member.id }, data: { isActive: true } });
  };
  return { workspaceId: workspace.id, actor, member, source, rows, onLaterPage, revokeRestore };
}

it("keeps visible pagination, unread counts and recipient-scoped mark-all across hidden pages", async () => {
  const f = await fixture();
  expect((await listNotifications(f.actor, f.workspaceId, { skip: 1, take: 1 })).map(row => row.id)).toEqual([f.rows[100].id]);
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(2);
  await markAllNotificationsRead(f.actor, f.workspaceId);
  expect(await prisma.notification.count({ where: { readAt: { not: null } } })).toBe(2);
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(0);
});

it("rejects retained first-page bodies after membership revoke and restore on a later page", async () => {
  const f = await fixture();
  const barrier = f.onLaterPage(f.revokeRestore);
  await expect(listNotifications(f.actor, f.workspaceId, { take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(barrier).toHaveBeenCalledTimes(2);
});

it("rejects the original selected lineage head even if a later replacement keeps the body unchanged", async () => {
  const f = await fixture();
  f.onLaterPage(async () => {
    const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: {
      artifactType: "Notification", artifactId: f.rows[0].id }, orderBy: { revision: "desc" } });
    await prisma.artifactInputLineage.create({ data: { workspaceId: head.workspaceId, artifactType: head.artifactType,
      artifactId: head.artifactId, revision: head.revision + 1, origin: head.origin, contentHash: head.contentHash,
      inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
      epochProofVersion: head.epochProofVersion,
      permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull } });
  });
  await expect(listNotifications(f.actor, f.workspaceId, { take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it("does not release stale unread totals after a later page revokes and restores membership", async () => {
  const f = await fixture();
  f.onLaterPage(f.revokeRestore);
  expect(await countUnreadNotifications(f.actor, f.workspaceId)).toBe(0);
});

it("revalidates the selected notification's source closure after a later page archives its source", async () => {
  const f = await fixture();
  f.onLaterPage(async () => {
    await prisma.brainSource.update({ where: { id: f.source.id }, data: { archivedAt: new Date() } });
  });
  await expect(listNotifications(f.actor, f.workspaceId, { take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it("does not partially mark earlier pages when later-page authority changes", async () => {
  const f = await fixture();
  f.onLaterPage(f.revokeRestore);
  await expect(markAllNotificationsRead(f.actor, f.workspaceId)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(await prisma.notification.count({ where: { readAt: { not: null } } })).toBe(0);
});
