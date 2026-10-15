import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listActions } from "./actions";
import { listTensions, upvoteTension } from "./tensions";
import { recordArtifactInputLineage } from "./source-lineage";
import { WorkItemReadRelease } from "./work-item-readable-page";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function setup(kind: "Action" | "Tension", otherAuthor = false) {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic joined release", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", displayName: "Admitted profile" } });
  for (const member of [user, other]) await prisma.member.create({ data: { workspaceId: workspace.id, userId: member.id, role: "CONTRIBUTOR" } });
  const actor: AppActor = { kind: "user", user };
  const otherActor: AppActor = { kind: "user", user: other };
  const data = { workspaceId: workspace.id, authorUserId: otherAuthor ? other.id : user.id, title: "Independent public body", bodyMd: "Original", isPrivate: false, status: "OPEN" as const };
  const target = kind === "Action" ? await prisma.action.create({ data }) : await prisma.tension.create({ data });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: otherAuthor ? otherActor : actor, workspaceId: workspace.id,
    artifact: { kind, id: target.id }, content: target, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const privateInput = await prisma.action.create({ data: { workspaceId: workspace.id, authorUserId: other.id, title: "Private contributor", bodyMd: "Private", isPrivate: true } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: otherActor, workspaceId: workspace.id,
    artifact: { kind: "Action", id: privateInput.id }, content: privateInput, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const withdrawProfile = () => prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: otherActor, workspaceId: workspace.id,
    artifact: { kind: "User", id: other.id }, content: other, origin: "DERIVED", inputs: [{ kind: "Action", id: privateInput.id }] }));
  return { workspaceId: workspace.id, actor, otherActor, other, target, withdrawProfile };
}
function beforeRelease(effect: (value: unknown) => Promise<unknown>) {
  const finish = WorkItemReadRelease.prototype.finish;
  return vi.spyOn(WorkItemReadRelease.prototype, "finish").mockImplementation(async function<T>(this: WorkItemReadRelease, value: T) {
    await effect(value);
    return finish.call(this, value) as Promise<T>;
  });
}

it.each(["Action", "Tension"] as const)("withholds selected %s author labels withdrawn after admission", async kind => {
  const f = await setup(kind, true);
  const barrier = beforeRelease(async value => {
    expect(value).toMatchObject({ items: [{ author: { displayName: "Admitted profile" } }] });
    await f.withdrawProfile();
  });
  const read = kind === "Action" ? listActions(f.actor, f.workspaceId, { take: 1 }) : listTensions(f.actor, f.workspaceId, { take: 1, sort: "date" });
  await expect(read).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(barrier).toHaveBeenCalledTimes(1);
});

it.each(["date", "alpha"] as const)("withholds selected %s-sort votes after voter authority is withdrawn", async sort => {
  const f = await setup("Tension");
  const vote = await upvoteTension(f.otherActor, { workspaceId: f.workspaceId, tensionId: f.target.id });
  const barrier = beforeRelease(async value => {
    expect(value).toMatchObject({ items: [{ upvotes: [{ id: vote.id }] }] });
    await f.withdrawProfile();
  });
  await expect(listTensions(f.actor, f.workspaceId, { take: 1, sort })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(barrier).toHaveBeenCalledTimes(1);
});

it("withholds a selected checklist count when its admitted item changes before release", async () => {
  const f = await setup("Action");
  const item = await prisma.actionChecklistItem.create({ data: { workspaceId: f.workspaceId, actionId: f.target.id, title: "Admitted checklist item" } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: { kind: "ActionChecklistItem", id: item.id }, content: item, origin: "DERIVED", inputs: [{ kind: "Action", id: f.target.id }] }));
  beforeRelease(async value => {
    expect(value).toMatchObject({ items: [{ checklistItemCount: 1 }] });
    await prisma.actionChecklistItem.update({ where: { id: item.id }, data: { title: "Unproved changed item" } });
  });
  await expect(listActions(f.actor, f.workspaceId, { take: 1 })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
});

it.each(["Action", "Tension"] as const)("withholds selected %s advice counts when an admitted request changes before release", async kind => {
  const f = await setup(kind);
  const userId = f.actor.kind === "user" ? f.actor.user.id : "";
  const member = await prisma.member.findFirstOrThrow({where:{workspaceId:f.workspaceId,userId}});
  const process = await prisma.adviceProcess.create({data:{workspaceId:f.workspaceId,authorMemberId:member.id,subjectType:kind.toUpperCase(),subjectId:f.target.id}});
  const request = await prisma.adviceRequest.create({data:{workspaceId:f.workspaceId,processId:process.id,requestedByUserId:userId,audienceType:"WORKSPACE",messageMd:"Admitted request"}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"AdviceRequest",id:request.id},content:request,origin:"DERIVED",inputs:[{kind,id:f.target.id}]}));
  beforeRelease(async value=>{
    expect(value).toMatchObject({items:[{inputRequestCount:1}]});
    await prisma.adviceRequest.update({where:{id:request.id},data:{messageMd:"Changed unproved request"}});
  });
  const read = kind === "Action" ? listActions(f.actor,f.workspaceId,{take:1}) : listTensions(f.actor,f.workspaceId,{take:1,sort:"date"});
  await expect(read).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
