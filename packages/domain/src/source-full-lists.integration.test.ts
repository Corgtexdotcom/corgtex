import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prisma as db, type AppActor } from "@corgtex/shared";
import { listDocuments } from "./documents";
import { DigestReadRelease } from "./digest-lineage";
import { scanSourceReadableRecords } from "./source-scoped-read";
import { lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";

const workspaces: string[] = [];
const users: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of workspaces.splice(0)) await db.workspace.delete({where: {id}});
  for (const id of users.splice(0)) await db.user.delete({where: {id}});
});
async function fixture() {
  const workspace = await db.workspace.create({data: {name: "Synthetic full lists", slug: randomUUID()}});
  const user = await db.user.create({data: {email: `${randomUUID()}@full-list.test`, passwordHash: "synthetic"}});
  workspaces.push(workspace.id); users.push(user.id);
  const member = await db.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  async function original(id: string) {
    const row = await db.document.create({data: {id, workspaceId: workspace.id, title: id, source: "UPLOAD", storageKey: `workspaces/${workspace.id}/uploads/${randomUUID()}/fixture.txt`, textContent: "Authentic original"}});
    await db.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
      artifact: {kind: "Document", id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []}));
    return row;
  }
  return {workspaceId: workspace.id, actor, member, original};
}
it("returns late permitted Documents beyond 5000 unknown records in canonical pages", async () => {
  const f = await fixture();
  await db.document.createMany({data: Array.from({length: 5001}, (_, index) => ({id: `${f.workspaceId}-a-${String(index).padStart(5,"0")}`,
    workspaceId: f.workspaceId, title: "Unknown", source: "UPLOAD", storageKey: `workspaces/${f.workspaceId}/uploads/${index}/fixture.txt`, textContent: "Unproved"}))});
  const row = await f.original(`${f.workspaceId}-z-visible`);
  const query = vi.spyOn(db.document, "findMany");
  expect((await listDocuments(f.actor,f.workspaceId)).map(item => item.id)).toEqual([row.id]);
  expect(query.mock.calls.length).toBe(51);
  expect(query.mock.calls.every(([args]) => args?.take === 100 && args.orderBy && !args.select)).toBe(true);
},120_000);
it.each(["membership", "head"] as const)("retains the first admitted Document through a later-page %s change", async change => {
  const f = await fixture(), row = await f.original(`${randomUUID()}-a-original`);
  await db.document.createMany({data: Array.from({length:99},(_,index) => ({id:`zz-${f.workspaceId}-${String(index).padStart(3,"0")}`,
    workspaceId:f.workspaceId,title:"Unknown",source:"UPLOAD",storageKey:`workspaces/${f.workspaceId}/uploads/${index}/fixture.txt`,textContent:"Unproved"}))});
  const load = db.document.findMany.bind(db.document);
  let page = 0;
  const result = scanSourceReadableRecords({actor: f.actor, workspaceId: f.workspaceId, kind: "Document", load: async (afterId,take) => {
    expect(take).toBe(100);
    if (++page === 2) {
      if (change === "membership") {
        await db.member.update({where: {id:f.member.id},data:{isActive:false}});
        await db.member.update({where: {id:f.member.id},data:{isActive:true}});
      } else {
        const head = await db.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"Document",artifactId:row.id},orderBy:{revision:"desc"}});
        await db.artifactInputLineage.create({data:{workspaceId:f.workspaceId,artifactType:"Document",artifactId:row.id,revision:head.revision+1,
          origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint("Document",row),inputsJson:[],rootsJson:[]}});
      }
    }
    return load({where:{workspaceId:f.workspaceId,...(afterId?{id:{gt:afterId}}:{})},orderBy:{id:"asc"},take});
  }});
  await expect(result).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
it("checks the current caller inside the final snapshot even when no rows are admitted",async()=>{
  const f=await fixture(), release=new DigestReadRelease(f.actor,f.workspaceId);
  await db.member.update({where:{id:f.member.id},data:{isActive:false}});
  await expect(release.finish([])).rejects.toMatchObject({code:"NOT_A_MEMBER"});
});
