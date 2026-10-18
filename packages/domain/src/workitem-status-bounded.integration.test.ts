import { AsyncResource } from "node:async_hooks";
import type { Action } from "@prisma/client";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { listActions, countActionsByStatus } from "./actions";
import { listProposals } from "./proposals";
import { listTensions, upvoteTension } from "./tensions";
import { getBrainStatus } from "./brain";
import { captureArtifactInputProof, withArtifactCountReleaseSnapshot, recordArtifactInputLineage, type LineageRoot } from "./source-lineage";

function isQueryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fresh lineage comparisons load complete rows by a bounded original ID set.
 * Unlike a corpus page, an IN query needs no take; projections and joins are
 * forbidden here, and IDs must belong to the actual original fixture cohort. */
function isBoundedProofRead(query: unknown, workspaceId: string, originalIds: ReadonlySet<string>) {
  if (!isQueryRecord(query) || Object.keys(query).some(key => key !== "where")) return false;
  const where = query.where;
  if (!isQueryRecord(where) || where.workspaceId !== workspaceId
    || Object.keys(where).some(key => key !== "workspaceId" && key !== "id")) return false;
  const id = where.id;
  if (!isQueryRecord(id) || Object.keys(id).some(key => key !== "in")) return false;
  const ids = id.in;
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && new Set(ids).size === ids.length
    && ids.every(value => typeof value === "string" && originalIds.has(value));
}

function isSelectedHydration(query: unknown, workspaceId: string, selectedIds: readonly string[]) {
  if (!selectedIds.length || !isQueryRecord(query) || !query.include || query.select !== undefined
    || !isQueryRecord(query.where) || !Array.isArray(query.where.AND)) return false;
  const clauses = query.where.AND;
  if (!clauses.some(clause => isQueryRecord(clause) && clause.workspaceId === workspaceId)) return false;
  return clauses.some(clause => isQueryRecord(clause) && isQueryRecord(clause.id)
    && Array.isArray(clause.id.in) && clause.id.in.length === selectedIds.length
    && new Set(clause.id.in).size === selectedIds.length && clause.id.in.every(id => selectedIds.includes(id)));
}

/** Observe the actual RR delegate as well as the outside-TX final proof pass. */
function observeReads(delegate: "action" | "proposal" | "tension", afterRead?: (args: any) => Promise<void>) {
  const queries = vi.fn<(args: any) => void>();
  const candidateIds = new Set<string>();
  const globalRead = (prisma[delegate].findMany as any).bind(prisma[delegate]);
  const transaction = prisma.$transaction.bind(prisma);
  const read = async (args: any, load: () => Promise<unknown>) => {
    const rows = await load();
    if (args?.take === 100 && args.orderBy && !args.select && !args.include) {
      for (const row of rows as Array<{id: string}>) candidateIds.add(row.id);
    }
    queries(args); await afterRead?.(args); return rows;
  };
  vi.spyOn(prisma[delegate], "findMany").mockImplementation(((args: any) => read(args, () => globalRead(args))) as any);
  vi.spyOn(getPrismaClient(), "$transaction").mockImplementation(((operation: any, options: any) => transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
      if (property === delegate) return new Proxy(target[delegate], {get(model, method) {
        if (method === "findMany") return (args: any) => read(args, () => (model.findMany as any)(args));
        const value = Reflect.get(model, method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  return Object.assign(queries, {candidateIds});
}

beforeEach(truncateAllTables);
afterEach(()=>vi.restoreAllMocks());
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"Bounded synthetic history",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}});
  const other=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  await prisma.member.create({data:{workspaceId:workspace.id,userId:other.id,role:"ADMIN"}});
  return {workspaceId:workspace.id,user,member,other,actor:{kind:"user",user} as AppActor};
}

it.each(["Action","Proposal","Tension"] as const)("keeps %s lists and zero-take counts usable at and beyond 5000 canonical candidates",async kind=>{
  const f=await fixture();
  const hidden=Array.from({length:5000},(_,i)=>({id:`z-${String(i).padStart(5,"0")}`,workspaceId:f.workspaceId,
    authorUserId:f.user.id,title:"Unknown copied history",bodyMd:"unproved ".repeat(64),isPrivate:false,createdAt:new Date("2026-10-01")}));
  if(kind==="Action") await prisma.action.createMany({data:hidden.map(row=>({...row,status:"OPEN"}))});
  if(kind==="Proposal") await prisma.proposal.createMany({data:hidden.map(row=>({...row,status:"OPEN"}))});
  if(kind==="Tension") await prisma.tension.createMany({data:hidden.map(row=>({...row,status:"OPEN"}))});
  const list=(take:number,skip=0)=>kind==="Action"?listActions(f.actor,f.workspaceId,{take,skip,sort:"date"})
    :kind==="Proposal"?listProposals(f.actor,f.workspaceId,{take,skip,sort:"date"}):listTensions(f.actor,f.workspaceId,{take,skip,sort:"date"});
  expect(await list(0)).toMatchObject({items:[],total:0});
  for(const id of ["v3","v2","v1"]) {
    const data={id,workspaceId:f.workspaceId,authorUserId:f.user.id,title:id,bodyMd:"Authentic original",isPrivate:false,createdAt:new Date("2026-09-01")};
    const row=kind==="Action"?await prisma.action.create({data:{...data,status:"OPEN"}})
      :kind==="Proposal"?await prisma.proposal.create({data:{...data,status:"OPEN"}}):await prisma.tension.create({data:{...data,status:"OPEN"}});
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
      artifact:{kind,id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  }
  const args={workspaceId:f.workspaceId,authorUserId:f.other.id,title:"Private",bodyMd:"Private body",isPrivate:true};
  if(kind==="Action") await prisma.action.create({data:args});
  if(kind==="Proposal") await prisma.proposal.create({data:args});
  if(kind==="Tension") await prisma.tension.create({data:args});
  const queries=observeReads(kind === "Action" ? "action" : kind === "Proposal" ? "proposal" : "tension");
  const originals = new Set(["v1", "v2", "v3"]);
  const page=await list(1,1);
  expect(page.total).toBe(3);expect(page.items.map(row=>row.id)).toEqual(["v2"]);
  expect(queries.mock.calls.filter(([query])=>query?.take===100).length).toBeGreaterThan(50);
  expect(queries.mock.calls.every(([query])=>query?.take===100 && !query.select && !query.include
    || isSelectedHydration(query,f.workspaceId,["v2"]) || isBoundedProofRead(query,f.workspaceId,originals)
    // The RR admission cache also hydrates denied candidates, but only IDs
    // already discovered in bounded canonical pages, never arbitrary bodies.
    || isBoundedProofRead(query,f.workspaceId,queries.candidateIds))).toBe(true);
  queries.mockClear(); queries.candidateIds.clear();
  expect(await list(0)).toMatchObject({items:[],total:3});
  const countQueries = queries.mock.calls.map(([query])=>query);
  expect(countQueries.some(query=>isBoundedProofRead(query,f.workspaceId,originals))).toBe(true);
  expect(countQueries.every(query=>query?.include===undefined && query?.select===undefined
    && (query?.take===100 || isBoundedProofRead(query,f.workspaceId,originals)
      || isBoundedProofRead(query,f.workspaceId,queries.candidateIds))),JSON.stringify(countQueries)).toBe(true);
  if(kind==="Action") expect(await countActionsByStatus(f.actor,f.workspaceId)).toMatchObject({OPEN:3,ALL:3});
  if(kind==="Action") await prisma.action.update({where:{id:"v2"},data:{archivedAt:new Date()}});
  if(kind==="Proposal") await prisma.proposal.update({where:{id:"v2"},data:{archivedAt:new Date()}});
  if(kind==="Tension") await prisma.tension.update({where:{id:"v2"},data:{archivedAt:new Date()}});
  expect((await list(1,1)).items.map(row=>row.id)).toEqual(["v1"]);
  expect((await list(0)).total).toBe(2);
},180_000);

it("folds large Brain status from canonical pages without loading comment bodies or all backlinks",async()=>{
  const f=await fixture();
  await prisma.brainArticle.createMany({data:Array.from({length:5001},(_,i)=>({id:`a-hidden-${String(i).padStart(5,"0")}`,
    workspaceId:f.workspaceId,title:"Unknown article",slug:`hidden-${i}`,type:"PROJECT",authority:"REFERENCE",bodyMd:"unknown ".repeat(64)}))});
  for(const id of ["visible-a","visible-b","visible-c"]) {
    const row=await prisma.brainArticle.create({data:{id,workspaceId:f.workspaceId,title:id,slug:id,type:"PROJECT",authority:"REFERENCE",bodyMd:"Original company knowledge",createdAt:new Date("2020-01-01")}});
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"BrainArticle",id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  }
  await prisma.brainBacklink.createMany({data:[{workspaceId:f.workspaceId,fromArticleId:"visible-a",toArticleId:"visible-b"},
    {workspaceId:f.workspaceId,fromArticleId:"a-hidden-00000",toArticleId:"visible-c"}]});
  await prisma.brainDiscussionThread.createMany({data:Array.from({length:105},(_,i)=>({id:`hidden-thread-${i}`,articleId:"visible-a",authorMemberId:f.member.id,targetType:"ARTICLE"}))});
  const thread=await prisma.brainDiscussionThread.create({data:{id:"visible-thread",articleId:"visible-a",authorMemberId:f.member.id,targetType:"ARTICLE"}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"BrainDiscussionThread",id:thread.id},content:thread,origin:"DERIVED",inputs:[{kind:"BrainArticle",id:"visible-a"}]}));
  await prisma.brainDiscussionComment.createMany({data:Array.from({length:205},(_,i)=>({threadId:thread.id,authorMemberId:f.member.id,bodyMd:`Comment ${i} `+"not needed ".repeat(256)}))});
  const articles=vi.spyOn(prisma.brainArticle,"findMany"),links=vi.spyOn(prisma.brainBacklink,"findMany"),threads=vi.spyOn(prisma.brainDiscussionThread,"findMany"),comments=vi.spyOn(prisma.brainDiscussionComment,"findMany");
  expect(await getBrainStatus(f.actor,f)).toMatchObject({totalArticles:3,staleArticles:3,unownedArticles:3,orphanArticles:2,openDiscussionThreads:1,articleCountByType:{PROJECT:3},articleCountByAuthority:{REFERENCE:3}});
  const originalArticles = new Set(["visible-a", "visible-b", "visible-c"]);
  expect(articles.mock.calls.filter(([query]) => query?.take === 10001)).toHaveLength(1);
  expect(articles.mock.calls.every(([query]) => query?.take === 10001 && query.select === undefined && query.include === undefined
    || isBoundedProofRead(query, f.workspaceId, originalArticles))).toBe(true);
  expect(links.mock.calls.every(([query])=>query?.take===100 && query.include?.fromArticle===true)).toBe(true);
  expect(threads.mock.calls.every(([query])=>query?.take===10001 && query.include===undefined)).toBe(true);
  expect(comments).not.toHaveBeenCalled();
  await prisma.brainArticle.update({where:{id:"visible-a"},data:{archivedAt:new Date()}});
  expect(await getBrainStatus(f.actor,f)).toMatchObject({totalArticles:2,orphanArticles:2,openDiscussionThreads:0});
},180_000);


it("measures a genuine 100-original release and rejects revocation across the final release boundary", async()=>{
  const f=await fixture();
  const rows: Action[]=[];
  const size=process.env.WORKITEM_RELEASE_CAPACITY==="10002"?10002:100;
  const start=performance.now();
  for(let i=0;i<size;i++) {
    const row=await prisma.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.user.id,title:`Original ${i}`,bodyMd:"Actual original",isPrivate:false,status:"OPEN"}});
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
    rows.push(row);
  }
  const created=performance.now();
  const proof:LineageRoot[]=[];
  for(let i=0;i<rows.length;i+=100) proof.push(...await captureArtifactInputProof(f.actor,f.workspaceId,rows.slice(i,i+100).map(row=>({kind:"Action",id:row.id,snapshot:row}))));
  const captured=performance.now();
  const txStart: number[]=[];
  const value=await withArtifactCountReleaseSnapshot(f.actor,f.workspaceId,proof,async()=>{txStart.push(performance.now());},async()=>size);
  const released=performance.now();
  expect(value).toBe(size);
  expect(new Set(proof.map(root=>`${root.kind}:${root.id}`)).size).toBe(size);
  expect(proof.every(root=>root.permissionEpochs)).toBe(true);
  writeFileSync(`.artifacts/workitem-original-release-${size}-metrics.json`,JSON.stringify({metric:"actual-original-release",rows:size,roots:proof.length,createMs:created-start,captureMs:captured-created,releaseMs:released-captured,finalTxMs:released-txStart[0]}));
  await expect(withArtifactCountReleaseSnapshot(f.actor,f.workspaceId,proof,async()=>{
    await prisma.action.update({where:{id:rows[0].id},data:{archivedAt:new Date()}});
  },async()=>size)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
},600_000);


it("ranks readable votes across multiple canonical and rank windows before selecting a deep page",async()=>{
  const f=await fixture();
  await prisma.tension.createMany({data:Array.from({length:105},(_,i)=>({id:`a-unknown-${i}`,workspaceId:f.workspaceId,authorUserId:f.user.id,title:"Unknown",bodyMd:"Unproved",priority:99,status:"OPEN",isPrivate:false}))});
  for(let i=0;i<105;i++) {
    const row=await prisma.tension.create({data:{id:`t${String(i).padStart(3,"0")}`,workspaceId:f.workspaceId,authorUserId:f.user.id,title:"Same title",bodyMd:"Original",priority:1,createdAt:new Date("2026-01-01"),status:"OPEN",isPrivate:false}});
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Tension",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  }
  await upvoteTension(f.actor,{workspaceId:f.workspaceId,tensionId:"t000"});
  expect((await listTensions(f.actor,f.workspaceId,{take:1})).items.map(row=>row.id)).toEqual(["t000"]);
  const queries=observeReads("tension");
  const page=await listTensions(f.actor,f.workspaceId,{take:3,skip:100});
  expect(page.total).toBe(105);
  expect(page.items.map(row=>row.id)).toEqual(["t005","t004","t003"]);
  expect(queries.mock.calls.filter(([query])=>query?.take===100).length).toBeGreaterThan(3);
  const originals = new Set(Array.from({length:105},(_,i)=>`t${String(i).padStart(3,"0")}`));
  const rankQueries = queries.mock.calls.map(([query])=>query);
  expect(rankQueries.some(query=>isBoundedProofRead(query,f.workspaceId,originals))).toBe(true);
  expect(rankQueries.every(query=>query?.take===100 && !query.select && !query.include
    || isSelectedHydration(query,f.workspaceId,["t005","t004","t003"])
    || isBoundedProofRead(query,f.workspaceId,originals)
    || isBoundedProofRead(query,f.workspaceId,queries.candidateIds)),JSON.stringify(rankQueries)).toBe(true);
},180_000);

it("refuses an early admitted count when a later canonical page withdraws it",async()=>{
  const f=await fixture();
  for(const id of ["a-original","z-original"]) {
    const row=await prisma.action.create({data:{id,workspaceId:f.workspaceId,authorUserId:f.user.id,title:id,bodyMd:"Original",isPrivate:false,status:"OPEN",createdAt:new Date("2026-01-01")}});
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  }
  await prisma.action.createMany({data:Array.from({length:100},(_,i)=>({id:`m-${i}`,workspaceId:f.workspaceId,authorUserId:f.user.id,title:"Unknown",bodyMd:"Unproved",status:"OPEN",isPrivate:false,createdAt:new Date("2026-01-01")}))});
  // Initialization retries may legitimately replace an unadmitted snapshot.
  await listActions(f.actor,f.workspaceId,{take:0,sort:"date"});
  const writer = new AsyncResource("independent-status-withdrawal");
  let pages=0, mutations=0;
  observeReads("action", async args => {
    if (args?.take===100 && ++pages===2) {
      await writer.runInAsyncScope(() => prisma.action.update({where:{id:"z-original"},data:{archivedAt:new Date()}}));
      mutations++;
    }
  });
  await expect(listActions(f.actor,f.workspaceId,{take:0,sort:"date"})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(pages).toBe(2);
  expect(mutations).toBe(1);
  expect((await prisma.action.findUniqueOrThrow({where:{id:"z-original"}})).archivedAt).not.toBeNull();
},60_000);

it("keeps the proof-read query exception canonical, tenant-bound and bounded",()=>{
  const originals = new Set(Array.from({length:101},(_,i)=>`original-${i}`));
  const where = {workspaceId:"workspace",id:{in:["original-0"]}};
  expect(isBoundedProofRead({where},"workspace",originals)).toBe(true);
  for (const query of [
    {}, {where:{workspaceId:"workspace"}}, {where:{...where,workspaceId:"foreign"}},
    {where:{...where,id:{in:[]}}}, {where:{...where,id:{in:[...originals]}}},
    {where:{...where,id:{in:["original-0","original-0"]}}}, {where:{...where,id:{in:["unknown"]}}},
    {where,select:{id:true}}, {where,include:{author:true}},
  ]) expect(isBoundedProofRead(query,"workspace",originals)).toBe(false);
});
