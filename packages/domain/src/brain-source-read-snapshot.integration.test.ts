import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listSources } from "./brain";
import { findSourceArticleImpacts } from "./brain-source-impact";
import { lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(count=101) {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic Brain snapshot",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,displayName:"Original author",passwordHash:"synthetic"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN"}});
  const actor:AppActor={kind:"user",user};
  const transaction=prisma.$transaction.bind(prisma);
  const seed=async(tx:Prisma.TransactionClient,id:string,createdAt:Date)=>{
    const row=await tx.brainSource.create({data:{id,workspaceId:workspace.id,sourceType:"DOC",tier:1,title:id,content:"Synthetic original",authorMemberId:member.id,createdAt}});
    await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"BrainSource",id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
    return row;
  };
  await transaction(async tx=>{for(let i=0;i<count;i++)await seed(tx,`source-${String(i).padStart(3,"0")}`,new Date(Date.UTC(2026,0,1)-i*1000));},{timeout:30_000});
  const list=()=>listSources(actor,{workspaceId:workspace.id,take:200});
  return {workspace,user,member,actor,transaction,seed,list};
}
function afterPage(f:Awaited<ReturnType<typeof fixture>>,mutate:()=>Promise<void>){
  let pages=0,mutations=0;const writer=new AsyncResource("independent-brain-source-writer");
  const after=async(args:any,rows:any[])=>{if(args?.take===100&&args?.orderBy&&++pages===1){mutations++;await writer.runInAsyncScope(mutate);}return rows;};
  const original=prisma.brainSource.findMany.bind(prisma.brainSource);
  vi.spyOn(prisma.brainSource,"findMany").mockImplementation((async args=>after(args,await original(args))) as typeof prisma.brainSource.findMany);
  vi.spyOn(getPrismaClient(),"$transaction").mockImplementation(((operation:any,options:any)=>f.transaction(async tx=>operation(new Proxy(tx,{
    get(target,property){if(property==="brainSource")return new Proxy(target.brainSource,{get(model,method){
      if(method==="findMany")return (args:any)=>model.findMany(args).then(rows=>after(args,rows));
      const value=Reflect.get(model,method);return typeof value==="function"?value.bind(model):value;
    }});const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;},
  })),options)) as typeof prisma.$transaction);
  return ()=>({pages,mutations});
}
it("keeps page and exact source total in one snapshot across atomic ahead-and-behind inserts",async()=>{
  const f=await fixture();await f.list();
  const observed=afterPage(f,()=>f.transaction(async tx=>{await f.seed(tx,"insert-ahead",new Date("2027-01-01"));await f.seed(tx,"insert-behind",new Date("2025-01-01"));}));
  const result=await f.list();
  expect(observed().mutations).toBe(1);expect(result.total).toBe(101);expect(result.items).toHaveLength(101);
  expect(result.items.some(row=>row.id.startsWith("insert-"))).toBe(false);
  expect(await prisma.brainSource.count({where:{workspaceId:f.workspace.id}})).toBe(103);
},60_000);
it("targets source impact candidates without hydrating unrelated derived articles",async()=>{
  const f=await fixture(2);
  const sources=await prisma.brainSource.findMany({where:{workspaceId:f.workspace.id},orderBy:{id:"asc"}});
  const [selected,unrelated]=sources;
  const rows=await prisma.brainArticle.createManyAndReturn({data:Array.from({length:301},(_,i)=>({id:`article-${String(i).padStart(4,"0")}`,workspaceId:f.workspace.id,
    slug:`article-${i}`,title:`Synthetic ${i}`,type:"PROJECT" as const,bodyMd:"Synthetic body",sourceIds:i===300?[selected.id]:[]}))});
  await prisma.artifactInputLineage.createMany({data:rows.filter(row=>row.id!=="article-0300").map(row=>({workspaceId:f.workspace.id,artifactType:"BrainArticle",artifactId:row.id,
    revision:1,origin:"DERIVED" as const,contentHash:lineageContentFingerprint("BrainArticle",row),inputsJson:[],rootsJson:[{kind:"BrainSource",id:unrelated.id,fingerprint:lineageContentFingerprint("BrainSource",unrelated)}]}))});
  const rootArticle = await prisma.brainArticle.create({data: {id: "root-only", workspaceId: f.workspace.id,
    slug: "root-only", title: "Root only", type: "PROJECT", bodyMd: "Root body"}});
  const derivationArticle = await prisma.brainArticle.create({data: {id: "derivation-only", workspaceId: f.workspace.id,
    slug: "derivation-only", title: "Derivation only", type: "PROJECT", bodyMd: "Derived body",
    derivationJson: {version: 1, origin: "brain-absorb", agentRunId: "synthetic", sources: [{sourceId: selected.id, fingerprint: "a".repeat(64)}]}}});
  const superseded = await prisma.brainArticle.create({data: {id: "superseded-root", workspaceId: f.workspace.id,
    slug: "superseded-root", title: "Superseded root", type: "PROJECT", bodyMd: "Unrelated now"}});
  const stale = await prisma.brainArticle.create({data: {id: "stale-body-root", workspaceId: f.workspace.id,
    slug: "stale-body-root", title: "Changed body", type: "PROJECT", bodyMd: "Changed body"}});
  const head = (row: typeof rootArticle, revision: number, source: typeof selected, contentHash = lineageContentFingerprint("BrainArticle", row)) => ({
    workspaceId: f.workspace.id, artifactType: "BrainArticle", artifactId: row.id, revision,
    origin: "DERIVED" as const, contentHash, inputsJson: [],
    rootsJson: [{kind: "BrainSource", id: source.id, fingerprint: lineageContentFingerprint("BrainSource", source)}],
  });
  await prisma.artifactInputLineage.createMany({data: [head(rootArticle, 1, selected),
    head(superseded, 1, selected), head(superseded, 2, unrelated), head(stale, 1, selected, "0".repeat(64))]});
  const hydrate=vi.spyOn(prisma.brainArticle,"findMany");
  const query=vi.spyOn(getPrismaClient(),"$queryRaw");
  const impacts=await findSourceArticleImpacts(prisma,f.workspace.id,[selected.id]);
  expect(impacts.get(selected.id)?.articles.map(({id, kind})=>({id, kind}))).toEqual([
    {id: "article-0300", kind: "unclassified"}, {id: derivationArticle.id, kind: "derived"},
    {id: rootArticle.id, kind: "derived"},
  ]);
  expect(hydrate.mock.calls.flatMap(([args])=>(args?.where?.id as {in?:string[]})?.in??[])).toEqual(["article-0300", derivationArticle.id, rootArticle.id, stale.id]);
  expect(query.mock.calls.filter(([args])=>(args as Prisma.Sql).text?.includes('FROM "BrainArticle" a'))).toHaveLength(1);
},60_000);
