import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, sha256, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listBrainSourceArchiveImpacts } from "./brain-source-impact";
import { recordNewspaperLinkClick } from "./newspaper-delivery";
import { recordArtifactInputLineage } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";

beforeEach(truncateAllTables);
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"Source response",slug:randomUUID()}});
  const users=await Promise.all(["author","reader"].map(name=>prisma.user.create({data:{email:`${name}-${randomUUID()}@example.test`,passwordHash:"synthetic"}})));
  const members=await Promise.all(users.map(user=>prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}})));
  const actors=users.map(user=>({kind:"user",user}) as AppActor);
  const action=await prisma.action.create({data:{workspaceId:workspace.id,authorUserId:users[0].id,title:"Original authority",status:"OPEN"}});
  const source=await prisma.brainSource.create({data:{workspaceId:workspace.id,sourceType:"DOC",tier:1,title:"Requested original",content:"Original source body"}});
  const article=await prisma.brainArticle.create({data:{workspaceId:workspace.id,title:"Original visible title",slug:"original-visible",bodyMd:"Original article body",type:"PROJECT",authority:"REFERENCE",sourceIds:[source.id]}});
  for(const [kind,row,origin,inputs] of [
    ["Action",action,"HUMAN_ORIGINAL",[]],
    ["BrainSource",source,"DERIVED",[{kind:"Action",id:action.id}]],
    ["BrainArticle",article,"HUMAN_ORIGINAL",[]],
  ] as const) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:actors[0],workspaceId:workspace.id,artifact:{kind,id:row.id},content:row,origin,inputs:[...inputs]}));
  return {workspace,users,members,actors,action,source,article};
}
async function trackedFixture() {
  const f=await fixture();const token=randomUUID();const targetUrl="https://synthetic.example.test/original-private-target";
  const edition=await prisma.newspaperEdition.create({data:{workspaceId:f.workspace.id,cadence:"DAILY",dateKey:"2026-10-16",runKey:"original-run",title:"Original edition",slug:"original-edition",digestJson:{},bodyMd:"Original edition body",sourceCounts:{}}});
  const link=await prisma.newspaperTrackedLink.create({data:{workspaceId:f.workspace.id,runKey:edition.runKey,targetUrl,targetUrlHash:sha256(targetUrl),tokenHash:sha256(token)}});
  for(const [kind,row] of [["NewspaperEdition",edition],["NewspaperTrackedLink",link]] as const) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"DERIVED",inputs:[{kind:"Action",id:f.action.id}]}));
  return {...f,edition,link,token,targetUrl};
}

it("returns proven requested source impact with exact admitted article title and slug",async()=>{
  const f=await fixture();
  expect(await listBrainSourceArchiveImpacts(f.actors[1],{workspaceId:f.workspace.id,sourceIds:[f.source.id,f.source.id]})).toEqual([
    {sourceId:f.source.id,blocked:true,visibleArticles:[{id:f.article.id,title:f.article.title,slug:f.article.slug,kind:"unclassified"}],hasHiddenArticles:false},
  ]);
});
it.each(["unknown","private","foreign"] as const)("denies %s requested source even without readable linked articles",async mode=>{
  const f=await fixture();let id=f.source.id;
  if(mode==="unknown") {
    id=(await prisma.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"DOC",tier:1,content:"Unproven original"}})).id;
  }else if(mode==="private")await prisma.action.update({where:{id:f.action.id},data:{isPrivate:true}});
  else{
    const other=await prisma.workspace.create({data:{name:"Other",slug:randomUUID()}});
    id=(await prisma.brainSource.create({data:{workspaceId:other.id,sourceType:"DOC",tier:1,content:"Foreign original"}})).id;
  }
  await expect(listBrainSourceArchiveImpacts(f.actors[1],{workspaceId:f.workspace.id,sourceIds:[id]})).rejects.toMatchObject({status:404,code:"NOT_FOUND"});
});
it.each(["source-restore","caller-loss","caller-restore","article-head"] as const)("retains original impact source/article/caller at final release: %s",async mode=>{
  const f=await fixture();let changed=false;const finish=DigestReadRelease.prototype.finish;
  vi.spyOn(DigestReadRelease.prototype,"finish").mockImplementation(async function<T>(this:DigestReadRelease,value:T){
    if(!changed){
      if(mode==="source-restore"){
        await prisma.action.update({where:{id:f.action.id},data:{isPrivate:true}});
        await prisma.action.update({where:{id:f.action.id},data:{isPrivate:false}});
      }else if(mode==="article-head")await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind:"BrainArticle",id:f.article.id},content:f.article,origin:"HUMAN_ORIGINAL",inputs:[]}));
      else{
        await prisma.member.update({where:{id:f.members[1].id},data:{isActive:false}});
        if(mode==="caller-restore")await prisma.member.update({where:{id:f.members[1].id},data:{isActive:true}});
      }
      changed=true;
    }
    return finish.call(this,value) as Promise<T>;
  });
  await expect(listBrainSourceArchiveImpacts(f.actors[1],{workspaceId:f.workspace.id,sourceIds:[f.source.id]})).rejects.toMatchObject({code:mode==="caller-loss"?"NOT_A_MEMBER":"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("returns the original tracked target and increments one authorized click",async()=>{
  const f=await trackedFixture();
  expect(await recordNewspaperLinkClick(f.actors[1],f.token)).toEqual({targetUrl:f.targetUrl});
  expect((await prisma.newspaperTrackedLink.findUniqueOrThrow({where:{id:f.link.id}})).clickCount).toBe(1);
});
it.each(["source-loss","source-restore","caller-loss","caller-restore","edition-run","link-run","link-target"] as const)("withholds tracked URL after %s during the click update await",async mode=>{
  const f=await trackedFixture();let changed=false;
  const finish=DigestReadRelease.prototype.finish;
  vi.spyOn(DigestReadRelease.prototype,"finish").mockImplementation(function<T>(this:DigestReadRelease,value:T,validate?: (tx:Prisma.TransactionClient)=>Promise<void>) {
    return finish.call(this,value,validate ? async tx=>{
      const update=tx.newspaperTrackedLink.update.bind(tx.newspaperTrackedLink);
      const spy=vi.spyOn(tx.newspaperTrackedLink,"update").mockImplementation((async (...args:Parameters<typeof update>)=>{
        const result=await update(...args);
        if(!changed){
          if(mode==="source-loss"||mode==="source-restore"){
            await tx.action.update({where:{id:f.action.id},data:{isPrivate:true}});
            if(mode==="source-restore")await tx.action.update({where:{id:f.action.id},data:{isPrivate:false}});
          }else if(mode==="caller-loss"||mode==="caller-restore"){
            await tx.member.update({where:{id:f.members[1].id},data:{isActive:false}});
            if(mode==="caller-restore")await tx.member.update({where:{id:f.members[1].id},data:{isActive:true}});
          }else if(mode==="edition-run")await tx.newspaperEdition.update({where:{id:f.edition.id},data:{runKey:"changed-run"}});
          else await update({where:{id:f.link.id},data:mode==="link-run"?{runKey:"changed-run"}:{targetUrl:"https://synthetic.example.test/replaced-private-target"}});
          changed=true;
        }
        return result;
      }) as unknown as typeof tx.newspaperTrackedLink.update);
      try{await validate(tx);}finally{spy.mockRestore();}
    } : undefined) as Promise<T>;
  });
  const result=await recordNewspaperLinkClick(f.actors[1],f.token).catch(error=>error);
  expect(changed).toBe(true);
  expect(result).toMatchObject({status:404,code:"NOT_FOUND",message:"Newspaper link not found."});
  expect(result).not.toHaveProperty("targetUrl");
  expect(String(result)).not.toContain("private-target");
  // Telemetry was authorized before the change; the fresh response fence rejects afterward.
  expect((await prisma.newspaperTrackedLink.findUniqueOrThrow({where:{id:f.link.id}})).clickCount).toBe(1);
});
