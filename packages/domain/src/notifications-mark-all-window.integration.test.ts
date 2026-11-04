import { randomUUID } from "node:crypto";
import { Prisma, type Notification } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { markAllNotificationsRead } from "./notifications";
import { recordArtifactInputLineage } from "./source-lineage";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const localFixture = database.hostname === "127.0.0.1" && database.port === "63973" && database.pathname === "/child_read_test";
const hostedFixture = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost"
  && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!localFixture && !hostedFixture) || database.searchParams.get("schema") !== "public") {
  throw new Error("Mark-all tests require their assigned disposable database or the documented hosted CI fixture.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic mark-all", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const member = await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: other.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const source = await prisma.brainSource.create({ data: { workspaceId: workspace.id, sourceType: "DOC", tier: 1, content: "Synthetic notification source" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "BrainSource", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const data = Array.from({ length: 503 }, (_, index) => ({ id: randomUUID(), workspaceId: workspace.id, userId: user.id,
    type: "synthetic", title: `Synthetic ${index}`, bodyMd: "Original notice", createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 503 - index)) }));
  await prisma.notification.createMany({ data });
  const rows = await prisma.notification.findMany({ where: { workspaceId: workspace.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  for (const index of [0, 200, 502]) await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Notification", id: rows[index].id }, content: rows[index], origin: "DERIVED", inputs: [{ kind: "BrainSource", id: source.id }] }));
  await prisma.notification.create({ data: { workspaceId: workspace.id, userId: other.id, type: "synthetic", title: "Other recipient" } });
  const queries: Prisma.NotificationFindManyArgs[] = [];
  const delegate = prisma.notification as unknown as { findMany: (args?: Prisma.NotificationFindManyArgs) => Promise<Notification[]> };
  const original = delegate.findMany.bind(delegate);
  const barrier = { before: async (_queryIndex: number) => {} };
  vi.spyOn(delegate, "findMany").mockImplementation(async args => {
    queries.push(args ?? {}); await barrier.before(queries.length); return original(args);
  });
  return { workspace, user, other, member, actor, rows, queries, barrier };
}

it("advances bounded mark-all batches past hidden rows until readable history is complete", async () => {
  const f = await fixture();
  const first = await markAllNotificationsRead(f.actor, f.workspace.id);
  expect(f.queries).toHaveLength(2);
  expect(first).toMatchObject({ updatedCount: 1, complete: false, nextCursor: expect.any(String) });
  expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"))).toMatchObject({ id: f.rows[199].id });
  expect(await prisma.notification.count({ where: { workspaceId: f.workspace.id, readAt: { not: null } } })).toBe(1);
  const second = await markAllNotificationsRead(f.actor, f.workspace.id, { cursor: first.nextCursor! });
  expect(f.queries).toHaveLength(4);
  expect(second).toMatchObject({ updatedCount: 1, complete: false, nextCursor: expect.any(String) });
  const third = await markAllNotificationsRead(f.actor, f.workspace.id, { cursor: second.nextCursor! });
  expect(f.queries).toHaveLength(6);
  expect(third).toEqual({ updatedCount: 1, complete: true, nextCursor: null });
  expect(f.queries.every(query => query.take === 100 && query.where?.workspaceId === f.workspace.id && query.where.userId === f.user.id && query.where.readAt === null)).toBe(true);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspace.id, readAt: { not: null } } })).toBe(3);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspace.id, userId: f.other.id, readAt: null } })).toBe(1);
});

it.each(["withdrawal", "restore", "head"] as const)("writes no earlier batch rows after late %s", async change => {
  const f = await fixture(); let changed = false;
  f.barrier.before = async queryIndex => {
    if (queryIndex !== 2) return;
    changed = true;
    if (change === "head") {
      const head = await prisma.artifactInputLineage.findFirstOrThrow({ where: { artifactType: "Notification", artifactId: f.rows[0].id }, orderBy: { revision: "desc" } });
      const { id: _id, ...data } = head;
      await prisma.artifactInputLineage.create({ data: { ...data, revision: head.revision + 1,
        inputsJson: head.inputsJson as Prisma.InputJsonValue, rootsJson: head.rootsJson as Prisma.InputJsonValue,
        permissionEpochsJson: head.permissionEpochsJson ?? Prisma.DbNull } });
    } else {
      await prisma.member.update({ where: { id: f.member.id }, data: { isActive: false } });
      if (change === "restore") await prisma.member.update({ where: { id: f.member.id }, data: { isActive: true } });
    }
  };
  await expect(markAllNotificationsRead(f.actor, f.workspace.id)).rejects.toMatchObject({ code: expect.stringMatching(/^(NOT_A_MEMBER|SOURCE_CHANGED)$/) });
  expect(changed).toBe(true);
  expect(await prisma.notification.count({ where: { workspaceId: f.workspace.id, readAt: { not: null } } })).toBe(0);
});

it("does not reuse a mark-all continuation for another recipient", async () => {
  const f = await fixture(); const first = await markAllNotificationsRead(f.actor, f.workspace.id);
  const before = f.queries.length;
  await expect(markAllNotificationsRead({ kind: "user", user: f.other }, f.workspace.id, { cursor: first.nextCursor! }))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(f.queries).toHaveLength(before);
  expect(await prisma.notification.count({ where: { userId: f.other.id, readAt: { not: null } } })).toBe(0);
});
