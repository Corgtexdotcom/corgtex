import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getGoal, listGoals, postGoalUpdate } from "./goals";
import { recordArtifactInputLineage } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic goals", slug: randomUUID() } });
  const users = await Promise.all(["author", "reader"].map(name => prisma.user.create({ data: { email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: name } })));
  const members = await Promise.all(users.map(user => prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR" } })));
  const actors = users.map(user => ({ kind: "user", user }) as AppActor);
  const source = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: users[0].id, title: "Child source", status: "OPEN" } });
  const goal = await prisma.goal.create({ data: { workspaceId: workspace.id, authorUserId: users[0].id, ownerMemberId: members[0].id, title: "Readable goal", status: "ACTIVE", sortOrder: 0 } });
  const keyResult = await prisma.keyResult.create({ data: { goalId: goal.id, title: "Independent child" } });
  const update = await prisma.goalUpdate.create({ data: { goalId: goal.id, authorMemberId: members[0].id, bodyMd: "Independent update" } });
  await prisma.$transaction(async tx => {
    await recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id, artifact: { kind: "Action", id: source.id }, content: source, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id, artifact: { kind: "Goal", id: goal.id }, content: goal, origin: "HUMAN_ORIGINAL", inputs: [] });
    await recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id, artifact: { kind: "KeyResult", id: keyResult.id }, content: keyResult, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] });
    await recordArtifactInputLineage({ tx, actor: actors[0], workspaceId: workspace.id, artifact: { kind: "GoalUpdate", id: update.id }, content: update, origin: "DERIVED", inputs: [{ kind: "Action", id: source.id }] });
  });
  return { workspace, users, members, actors, source, goal, keyResult, update };
}
it("withholds independently revoked key results and updates from a readable goal", async () => {
  const f = await fixture();
  const before = await getGoal(f.actors[1], { workspaceId: f.workspace.id, goalId: f.goal.id });
  expect(before.keyResults.map(row => row.id)).toEqual([f.keyResult.id]);
  expect(before.updates.map(row => row.id)).toEqual([f.update.id]);
  expect(Object.keys(before.ownerMember!.user).sort()).toEqual(["displayName", "email"]);
  expect(Object.keys(before.updates[0].authorMember!.user).sort()).toEqual(["displayName", "email"]);
  await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: true } });
  const after = await getGoal(f.actors[1], { workspaceId: f.workspace.id, goalId: f.goal.id });
  expect(after.id).toBe(f.goal.id);
  expect(after.keyResults).toEqual([]);
  expect(after.updates).toEqual([]);
  expect((await listGoals(f.actors[1], { workspaceId: f.workspace.id, take: 1 }))[0].keyResults).toEqual([]);
  await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: false } });
  expect((await getGoal(f.actors[1], { workspaceId: f.workspace.id, goalId: f.goal.id })).updates).toEqual([]);
});
it("pages visible skip and take without hydrating the complete goal corpus", async () => {
  const f = await fixture();
  await prisma.goal.createMany({ data: Array.from({ length: 101 }, (_, index) => ({ workspaceId: f.workspace.id, title: `Unproved ${index}`, status: "ACTIVE" as const, sortOrder: -1 })) });
  const query = vi.spyOn(prisma.goal, "findMany");
  const result = await listGoals(f.actors[1], { workspaceId: f.workspace.id, take: 1 });
  expect(result.map(row => row.id)).toEqual([f.goal.id]);
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0][0]?.take).toBe(200);
  expect(await listGoals(f.actors[1], { workspaceId: f.workspace.id, skip: 1, take: 1 })).toEqual([]);
  expect((await listGoals(f.actors[1], { workspaceId: f.workspace.id })).map(row => row.id)).toEqual([f.goal.id]);
});
it.each(["update-head", "child-source", "owner-identity", "author-member", "caller"] as const)(
  "rejects a goal detail if %s changes immediately before final release", async mode => {
    const f = await fixture();
    const finish = DigestReadRelease.prototype.finish;
    vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function<T>(this: DigestReadRelease, value: T) {
      if (mode === "update-head") await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id, artifact: { kind: "GoalUpdate", id: f.update.id }, content: f.update, origin: "DERIVED", inputs: [{ kind: "Action", id: f.source.id }] }));
      if (mode === "child-source") {
        await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: true } });
        await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: false } });
      }
      if (mode === "owner-identity") await prisma.user.update({ where: { id: f.users[0].id }, data: { displayName: "Changed" } });
      if (mode === "author-member") await prisma.member.update({ where: { id: f.members[0].id }, data: { isActive: false } });
      if (mode === "caller") await prisma.member.update({ where: { id: f.members[1].id }, data: { isActive: false } });
      return finish.call(this, value) as Promise<T>;
    });
    await expect(getGoal(f.actors[1], { workspaceId: f.workspace.id, goalId: f.goal.id })).rejects.toMatchObject({ code: mode === "caller" ? "NOT_A_MEMBER" : "SOURCE_CHANGED" });
  },
);
it("rejects an earlier selected goal's original head after the next admission batch", async () => {
  const f = await fixture();
  await prisma.goal.createMany({ data: Array.from({ length: 101 }, () => ({ workspaceId: f.workspace.id, title: "Unproved tail", status: "ACTIVE" as const, sortOrder: 1 })) });
  const observe = DigestReadRelease.prototype.observeRead;
  let calls = 0;
  let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "observeRead").mockImplementation(async function<T>(this: DigestReadRelease, read: () => Promise<T>) {
    calls += 1;
    if (calls === 2) {
      changed = true;
      await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id, artifact: { kind: "Goal", id: f.goal.id }, content: f.goal, origin: "HUMAN_ORIGINAL", inputs: [] }));
    }
    return observe.call(this, read) as Promise<T>;
  });
  await expect(listGoals(f.actors[1], { workspaceId: f.workspace.id, take: 2 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
});
it("preserves tenant isolation and take-zero behavior", async () => {
  const f = await fixture();
  const foreign = await prisma.workspace.create({ data: { name: "Foreign", slug: randomUUID() } });
  await expect(getGoal(f.actors[1], { workspaceId: foreign.id, goalId: f.goal.id })).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
  const query = vi.spyOn(prisma.goal, "findMany");
  expect(await listGoals(f.actors[1], { workspaceId: f.workspace.id, take: 0 })).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});

it("retains the original derived goal authority through its own governed draft transition", async () => {
  const f = await fixture();
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id,
    artifact: { kind: "Goal", id: f.goal.id }, content: f.goal, origin: "DERIVED", inputs: [{ kind: "Action", id: f.source.id }] }));
  await postGoalUpdate(f.actors[0], { workspaceId: f.workspace.id, goalId: f.goal.id,
    bodyMd: "Governed draft transition", statusChange: "DRAFT" });
  expect(await getGoal(f.actors[0], { workspaceId: f.workspace.id, goalId: f.goal.id })).toMatchObject({ status: "DRAFT", isPrivate: true });
  await expect(getGoal(f.actors[1], { workspaceId: f.workspace.id, goalId: f.goal.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
it("does not refresh revoked and restored upstream authority through a goal transition", async () => {
  const f = await fixture();
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actors[0], workspaceId: f.workspace.id,
    artifact: { kind: "Goal", id: f.goal.id }, content: f.goal, origin: "DERIVED", inputs: [{ kind: "Action", id: f.source.id }] }));
  await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: true } });
  await prisma.action.update({ where: { id: f.source.id }, data: { isPrivate: false } });
  await expect(postGoalUpdate(f.actors[0], { workspaceId: f.workspace.id, goalId: f.goal.id,
    bodyMd: "Must not refresh", statusChange: "DRAFT" })).rejects.toBeDefined();
  expect(await prisma.goal.findUnique({ where: { id: f.goal.id } })).toMatchObject({ status: "ACTIVE", isPrivate: false });
  expect(await prisma.goalUpdate.count({ where: { goalId: f.goal.id, bodyMd: "Must not refresh" } })).toBe(0);
});
