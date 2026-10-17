import { randomUUID } from "node:crypto";
import { Prisma, type BrainArticle } from "@prisma/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { listWritebackTargets } from "./execution-plumbing";
import { listBrainArticleTypeCounts } from "../../../apps/web/app/[locale]/workspaces/[workspaceId]/brain/article-type-counts";

beforeEach(truncateAllTables);
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic paged readers",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const owner=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const membership=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}});
  const ownerMember=await prisma.member.create({data:{workspaceId:workspace.id,userId:owner.id,role:"ADMIN"}});
  return {workspaceId:workspace.id,user,actor:{kind:"user",user} as AppActor,membership,ownerMember,ownerActor:{kind:"user",user:owner} as AppActor};
}
async function articles(f:Awaited<ReturnType<typeof fixture>>) {
  await prisma.brainArticle.createMany({data:Array.from({length:102},(_,i)=>({id:`article-${String(i).padStart(3,"0")}`,workspaceId:f.workspaceId,slug:`article-${i}`,title:"Synthetic original",type:"PROJECT",authority:"REFERENCE",bodyMd:"Original body",sourceIds:[]}))});
  const admitted=await prisma.brainArticle.findMany({where:{workspaceId:f.workspaceId,id:{in:["article-000","article-101"]}}});
  for(const row of admitted) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.ownerActor,workspaceId:f.workspaceId,artifact:{kind:"BrainArticle",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  return admitted;
}
function pageProbe(f:Awaited<ReturnType<typeof fixture>>,work:()=>Promise<void>) {
  const delegate=prisma.brainArticle as unknown as {findMany:(args?:Prisma.BrainArticleFindManyArgs)=>Promise<BrainArticle[]>};
  const query=delegate.findMany.bind(delegate);let changed=false;
  const canonical:Prisma.BrainArticleFindManyArgs[]=[];
  const proofReads:Prisma.BrainArticleFindManyArgs[]=[];
  const spy=vi.spyOn(delegate,"findMany").mockImplementation(async args=>{
    if(args?.take===undefined){
      expect(args?.where).toEqual({workspaceId:f.workspaceId,id:{in:expect.any(Array)}});
      const ids=(args!.where!.id as {in:string[]}).in;
      expect(ids.length).toBeGreaterThan(0);expect(ids.length).toBeLessThanOrEqual(100);
      proofReads.push(args!);
      return query(args);
    }
    expect(args.take).toBe(100);expect(args.orderBy).toEqual({id:"asc"});
    const clauses=args.where?.AND as Prisma.BrainArticleWhereInput[];
    expect(clauses[0]?.workspaceId).toBe(f.workspaceId);
    canonical.push(args);
    if(!changed&&clauses[0]?.id){changed=true;await work();}
    return query(args);
  });
  return {spy,canonical,proofReads};
}
it("Brain page type counts replenish genuine permitted rows across denied pages without foreign/private bodies",async()=>{
  const f=await fixture();await articles(f);
  const privateArticle=await prisma.brainArticle.create({data:{workspaceId:f.workspaceId,slug:"private",title:"Private",type:"STRATEGY",authority:"DRAFT",bodyMd:"Private original",sourceIds:[],isPrivate:true,ownerMemberId:f.ownerMember.id}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.ownerActor,workspaceId:f.workspaceId,artifact:{kind:"BrainArticle",id:privateArticle.id},content:privateArticle,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const foreign=await prisma.workspace.create({data:{name:"Other workspace",slug:randomUUID()}});
  await prisma.brainArticle.create({data:{workspaceId:foreign.id,slug:"foreign",title:"Foreign",type:"STRATEGY",bodyMd:"Foreign body",sourceIds:[]}});
  const calls=pageProbe(f,async()=>{});
  expect(await listBrainArticleTypeCounts(f)).toEqual([{type:"PROJECT",count:2}]);
  expect(calls.canonical).toHaveLength(2);
  expect(calls.proofReads.length).toBeGreaterThan(0);
});
it.each(["head","epoch"] as const)("rejects a counted first-page original whose %s changes during the second page",async mode=>{
  const f=await fixture();const originals=await articles(f);
  const calls=pageProbe(f,async()=>{
    if(mode==="head") await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.ownerActor,workspaceId:f.workspaceId,artifact:{kind:"BrainArticle",id:originals[0].id},content:originals[0],origin:"HUMAN_ORIGINAL",inputs:[]}));
    else {
      await prisma.member.update({where:{id:f.membership.id},data:{isActive:false}});
      await prisma.member.update({where:{id:f.membership.id},data:{isActive:true}});
    }
  });
  await expect(listBrainArticleTypeCounts(f)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(calls.canonical).toHaveLength(2);
  expect(calls.proofReads.length).toBeGreaterThan(0);
});
it("rechecks current membership before releasing even an empty type count",async()=>{
  const f=await fixture();
  const delegate=prisma.brainArticle as unknown as {findMany:(args?:Prisma.BrainArticleFindManyArgs)=>Promise<BrainArticle[]>};
  const query=delegate.findMany.bind(delegate);
  vi.spyOn(delegate,"findMany").mockImplementation(async args=>{
    const rows=await query(args);await prisma.member.update({where:{id:f.membership.id},data:{isActive:false}});return rows;
  });
  await expect(listBrainArticleTypeCounts(f)).rejects.toMatchObject({code:"NOT_A_MEMBER"});
});
it.each([{prefix:100,available:true},{prefix:5001,available:false}])("actual picker preserves literal matching within its candidate window (prefix=$prefix)",async({prefix,available})=>{
  const f=await fixture();
  await prisma.action.createMany({data:Array.from({length:prefix},(_,i)=>({id:`action-${String(i).padStart(5,"0")}`,workspaceId:f.workspaceId,authorUserId:f.user.id,title:"Unrelated",status:"OPEN",updatedAt:new Date("2026-01-02")}))});
  const row=await prisma.action.create({data:{id:"z-original",workspaceId:f.workspaceId,authorUserId:f.user.id,title:"100% _ İtem",status:"OPEN",updatedAt:new Date("2026-01-01")}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const calls=vi.spyOn(prisma.action,"findMany");
  const result=listWritebackTargets(f.actor,{workspaceId:f.workspaceId,targetTypes:["ACTION"],query:"% _ i̇",take:1});
  if(available) expect((await result).items.map(item=>item.id)).toEqual([row.id]);
  else await expect(result).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
  const pages=calls.mock.calls.filter(([args])=>args?.take!==undefined);
  expect(pages).toHaveLength(2);
  expect(pages.every(([args])=>args?.take===100)).toBe(true);
});
