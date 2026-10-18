import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle } from "./brain";
import { archiveWorkspaceArtifact, listArchivedWorkspaceArtifacts, listArchivedWorkspaceArtifactsPage, purgeWorkspaceArtifact } from "./archive";
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic archive", slug: randomUUID() } });
  const owner = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const reader = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  const ownerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: owner.id, role: "ADMIN" } });
  const readerMember = await prisma.member.create({ data: { workspaceId: workspace.id, userId: reader.id, role: "ADMIN" } });
  const ownerActor: AppActor = { kind: "user", user: { id: owner.id, email: owner.email, displayName: "Owner" } };
  const actor: AppActor = { kind: "user", user: { id: reader.id, email: reader.email, displayName: "Reader" } };
  const article = await createArticle(ownerActor, { workspaceId: workspace.id, slug: "visible", title: "Synthetic original",
    bodyMd: "Synthetic archive body", type: "PROJECT", authority: "REFERENCE" });
  await archiveWorkspaceArtifact(ownerActor, { workspaceId: workspace.id, entityType: "BrainArticle", entityId: article.id });
  const record = await prisma.workspaceArchiveRecord.findFirstOrThrow({ where: { workspaceId: workspace.id, entityId: article.id } });
  return { workspaceId: workspace.id, actor, ownerActor, ownerMember, readerMember, article, record };
}


describe("bounded archive metadata windows", () => {
  it("bounds denied raw discovery before reaching a readable tail", async () => {
    const f = await setup();
    await prisma.workspaceArchiveRecord.createMany({ data: Array.from({length: 201}, (_,i) => ({
      id: `hidden-${String(i).padStart(4,"0")}`, workspaceId:f.workspaceId,entityType:"UnknownArtifact",entityId:`hidden-${i}`,
      entityLabel:"Unadmitted", archivedAt:new Date("2099-01-01T00:00:00Z"),
    })) });
    const query=vi.spyOn(prisma.workspaceArchiveRecord,"findMany");
    const result=await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,take:100});
    expect(result.items).toHaveLength(0);
    expect(result.complete).toBe(false);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({take:200}));
    const next=await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,cursor:result.nextCursor});
    expect(next.items.map(row=>row.id)).toEqual([f.record.id]);
    expect(next.complete).toBe(true);
    expect(next.nextCursor).toBeNull();
    await expect(listArchivedWorkspaceArtifacts(f.actor,{workspaceId:f.workspaceId})).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
  });
  it("continues within a fetched tie without omitting unread candidates and binds filter/workspace", async()=>{
    const f=await setup();
    await prisma.workspaceArchiveRecord.deleteMany({where:{workspaceId:f.workspaceId}});
    await prisma.workspaceArchiveRecord.createMany({data:Array.from({length:3},(_,i)=>({id:`tie-${i}`,workspaceId:f.workspaceId,
      entityType:"BrainArticle",entityId:f.article.id,entityLabel:"Synthetic",archivedAt:new Date("2026-01-01")}))});
    const first=await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,entityType:"BrainArticle",take:1});
    expect(first.items.map(row=>row.id)).toEqual(["tie-0"]);expect(first.complete).toBe(false);
    const second=await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,entityType:"BrainArticle",take:2,cursor:first.nextCursor});
    expect(second.items.map(row=>row.id)).toEqual(["tie-1","tie-2"]);expect(second.complete).toBe(true);
    for(const mismatch of [{entityType:"Action"},{includeRestored:true},{includePurged:true}]){
      await expect(listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,entityType:"BrainArticle",cursor:first.nextCursor,...mismatch}))
        .rejects.toMatchObject({code:"INVALID_INPUT"});
    }
    const other=await prisma.workspace.create({data:{name:"Other synthetic",slug:randomUUID()}});
    await prisma.member.create({data:{workspaceId:other.id,userId:f.readerMember.userId,role:"ADMIN"}});
    await expect(listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:other.id,entityType:"BrainArticle",cursor:first.nextCursor})).rejects.toMatchObject({code:"INVALID_INPUT"});
    await expect(listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,cursor:"malformed"})).rejects.toMatchObject({code:"INVALID_INPUT"});
    await expect(listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,take:101})).rejects.toMatchObject({code:"INVALID_INPUT"});
  });
  it("keeps authorized purged audit metadata separate from erased content",async()=>{
    const f=await setup();
    await purgeWorkspaceArtifact(f.ownerActor,{workspaceId:f.workspaceId,entityType:"BrainArticle",entityId:f.article.id,reason:"Synthetic erased reason"});
    expect((await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId})).items).toEqual([]);
    const result=await listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId,includePurged:true});
    expect(result.items).toHaveLength(1);expect(result.items[0].purgedAt).toBeInstanceOf(Date);
    expect(result.items[0].permanentPath).toEqual(expect.any(String));expect(result.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Synthetic archive body");
  });
  it.each(["caller-loss","caller-restore","role-loss","archive-state","head-replacement","source-restore"] as const)("withholds original metadata after %s during permalink lookup",async change=>{
    const f=await setup();let changed=false;
    const original=prisma.workspacePermalink.findMany.bind(prisma.workspacePermalink);
    vi.spyOn(prisma.workspacePermalink,"findMany").mockImplementation((async args=>{
      const result=await original(args);
      if(change.startsWith("caller")){
        await prisma.member.update({where:{id:f.readerMember.id},data:{isActive:false}});
        if(change==="caller-restore")await prisma.member.update({where:{id:f.readerMember.id},data:{isActive:true}});
      }else if(change==="role-loss")await prisma.member.update({where:{id:f.readerMember.id},data:{role:"CONTRIBUTOR"}});
      else if(change==="archive-state")await prisma.workspaceArchiveRecord.update({where:{id:f.record.id},data:{restoredAt:new Date()}});
      else if(change==="source-restore"){
        const before=await prisma.brainArticle.findUniqueOrThrow({where:{id:f.article.id}});
        await prisma.brainArticle.update({where:{id:f.article.id},data:{isPrivate:true}});
        await prisma.brainArticle.update({where:{id:f.article.id},data:{isPrivate:before.isPrivate,updatedAt:before.updatedAt}});
      }else{
        const head=await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"BrainArticle",artifactId:f.article.id},orderBy:{revision:"desc"}});
        await prisma.$executeRaw`INSERT INTO "ArtifactInputLineage" ("id", "workspaceId", "artifactType", "artifactId", "revision", "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson") SELECT ${randomUUID()}, "workspaceId", "artifactType", "artifactId", "revision" + 1, "origin", "contentHash", "inputsJson", "rootsJson", "epochProofVersion", "permissionEpochsJson" FROM "ArtifactInputLineage" WHERE "id" = ${head.id}`;
      }
      changed=true;return result;
    }) as typeof prisma.workspacePermalink.findMany);
    await expect(listArchivedWorkspaceArtifactsPage(f.actor,{workspaceId:f.workspaceId})).rejects.toThrow();
    expect(changed).toBe(true);
  });

});
