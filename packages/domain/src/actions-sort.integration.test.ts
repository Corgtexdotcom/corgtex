import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { getPrismaClient, type AppActor } from "@corgtex/shared";
import { countActionsByStatus, listActions } from "./actions";

const prisma = getPrismaClient();

it("sorts filtered Actions before pagination, with undated Actions last in either due direction", async () => {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const ids = {
    noDue: randomUUID(),
    firstDue: randomUUID(),
    tiedA: randomUUID(),
    tiedB: randomUUID(),
    lastDue: randomUUID(),
  };
  const actor: AppActor = {
    kind: "user",
    user: { id: userId, email: `action-sort-${userId}@example.test`, displayName: "Synthetic action sort", globalRole: "USER" },
  };

  await prisma.user.create({ data: { id: userId, email: actor.user.email, passwordHash: "synthetic" } });
  try {
    await prisma.workspace.create({ data: { id: workspaceId, slug: `action-sort-${workspaceId}`, name: "Action sort test" } });
    await prisma.member.create({ data: { id: randomUUID(), workspaceId, userId, role: "ADMIN" } });
    await prisma.action.createMany({ data: [
      { id: ids.noDue, workspaceId, authorUserId: userId, title: "No due date", status: "OPEN", isPrivate: false,
        createdAt: new Date("2026-10-10T12:00:00.000Z") },
      { id: ids.firstDue, workspaceId, authorUserId: userId, title: "Due first", status: "OPEN", isPrivate: false,
        dueAt: new Date("2026-10-08T00:00:00.000Z"), createdAt: new Date("2026-10-06T12:00:00.000Z") },
      { id: ids.tiedA, workspaceId, authorUserId: userId, title: "Due tied A", status: "OPEN", isPrivate: false,
        dueAt: new Date("2026-10-09T00:00:00.000Z"), createdAt: new Date("2026-10-07T12:00:00.000Z") },
      { id: ids.tiedB, workspaceId, authorUserId: userId, title: "Due tied B", status: "OPEN", isPrivate: false,
        dueAt: new Date("2026-10-09T00:00:00.000Z"), createdAt: new Date("2026-10-07T12:00:00.000Z") },
      { id: ids.lastDue, workspaceId, authorUserId: userId, title: "Due last", status: "OPEN", isPrivate: false,
        dueAt: new Date("2026-10-30T00:00:00.000Z"), createdAt: new Date("2026-10-05T12:00:00.000Z") },
    ] });
    await prisma.action.createMany({ data: Array.from({ length: 205 }, (_, index) => ({
      id: randomUUID(), workspaceId, authorUserId: userId, title: `Older completed ${index}`,
      status: "COMPLETED" as const, isPrivate: false,
      dueAt: new Date("2026-10-01T00:00:00.000Z"), createdAt: new Date("2026-10-01T12:00:00.000Z"),
    })) });

    const visible = await listActions(actor, workspaceId, { statuses: ["OPEN"], sort: "due_asc", take: 200 });
    expect(visible.items.map((action) => action.id)).toEqual([ids.firstDue, ...[ids.tiedA, ids.tiedB].sort().reverse(), ids.lastDue, ids.noDue]);
    expect(visible.total).toBe(5);
    const counts = await countActionsByStatus(actor, workspaceId);
    expect(counts).toMatchObject({ OPEN: 5, COMPLETED: 205, ALL: 210 });

    const tied = [ids.tiedA, ids.tiedB].sort().reverse();
    const asc = await listActions(actor, workspaceId, { statuses: ["OPEN"], sort: "due_asc", take: 10 });
    expect(asc.items.map((action) => action.id)).toEqual([ids.firstDue, ...tied, ids.lastDue, ids.noDue]);
    expect(asc.total).toBe(5);

    const desc = await listActions(actor, workspaceId, { statuses: ["OPEN"], sort: "due_desc", take: 10 });
    expect(desc.items.map((action) => action.id)).toEqual([ids.lastDue, ...tied, ids.firstDue, ids.noDue]);

    const page = await listActions(actor, workspaceId, { statuses: ["OPEN"], sort: "due_asc", take: 2, skip: 1 });
    expect(page.items.map((action) => action.id)).toEqual(tied);
    expect(page.total).toBe(5);

    const legacyDate = await listActions(actor, workspaceId, { statuses: ["OPEN"], sort: "date", take: 10 });
    expect(legacyDate.items[0].id).toBe(ids.noDue);
  } finally {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
