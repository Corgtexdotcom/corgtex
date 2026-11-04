import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { countActionsByStatus, listActions, listActionsWithStatusCounts } from "./actions";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture(count = 150) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic Action count", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "CONTRIBUTOR"}});
  const actor: AppActor = {kind: "user", user};
  const transaction = prisma.$transaction.bind(prisma);
  const seed = async (tx: Prisma.TransactionClient, id: string, status: "OPEN" | "COMPLETED" = "OPEN", proven = true) => {
    const row = await tx.action.create({data: {id, workspaceId: workspace.id, authorUserId: user.id, title: id, status, isPrivate: false}});
    if (proven) await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind: "Action", id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
    return row;
  };
  await transaction(async tx => {
    for (let i = 0; i < count; i++) await seed(tx, `row-${String(i).padStart(3,"0")}`);
    await seed(tx, "row-hidden", "OPEN", false);
  }, {timeout: 30_000});
  // Preinitialize actual caller/row epoch keys; concurrency is measured on the successful snapshot, not initialization retries.
  await countActionsByStatus(actor, workspace.id);
  await listActions(actor, workspace.id, {take: 1});
  return {workspace, user, member, actor, transaction, seed};
}

function afterRead(f: Awaited<ReturnType<typeof fixture>>, matches: (args: any, rows: any[]) => boolean, mutate: () => Promise<void>) {
  const writer = new AsyncResource("independent-action-count-writer");
  let mutations = 0;
  const read = async (args: any, load: () => Promise<any[]>) => {
    const rows = await load();
    if (!mutations && matches(args, rows)) { mutations++; await writer.runInAsyncScope(mutate); }
    return rows;
  };
  const globalRead = prisma.action.findMany.bind(prisma.action);
  vi.spyOn(prisma.action, "findMany").mockImplementation(((args: any) => read(args, () => globalRead(args))) as unknown as typeof prisma.action.findMany);
  vi.spyOn(getPrismaClient(), "$transaction").mockImplementation(((operation: any, options: any) => f.transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
      if (property === "action") return new Proxy(target.action, {get(model, method) {
        if (method === "findMany") return (args: any) => read(args, () => model.findMany(args));
        const value = Reflect.get(model, method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  return () => mutations;
}

it("keeps exact status counts at one snapshot across atomic insertions before and after the cursor", async () => {
  const f = await fixture();
  const changed = afterRead(f, args => args.take === 100 && (args.orderBy?.id === "asc" || args.orderBy?.[0]?.id === "asc"), () => f.transaction(async tx => {
    await f.seed(tx, "aaa-new"); await f.seed(tx, "zzz-new");
  }));
  const counts = await countActionsByStatus(f.actor, f.workspace.id);
  expect(changed()).toBe(1);
  expect(counts).toMatchObject({OPEN: 150, ALL: 150});
  expect(await prisma.action.count({where: {workspaceId: f.workspace.id}})).toBe(153);
}, 60_000);

it.each(["first-count-page", "count-complete"] as const)("keeps the clamped selected page with status buckets when an insertion commits at %s", async phase => {
  const f = await fixture();
  await f.transaction(async tx => {await f.seed(tx,"done-a","COMPLETED");await f.seed(tx,"done-b","COMPLETED");});
  await countActionsByStatus(f.actor,f.workspace.id);
  await listActions(f.actor,f.workspace.id,{take:1});
  const changed=afterRead(f,(args,rows)=>args.take===100 && args.orderBy?.id==="asc"
    && (phase==="first-count-page"?rows.length===100:rows.length<100),()=>f.transaction(async tx=>{
      await f.seed(tx,"aaa-new");await f.seed(tx,"zzz-new");
    }));
  const result=await listActionsWithStatusCounts(f.actor,f.workspace.id,{statuses:["OPEN"],sort:"alpha",take:50,page:99});
  expect(changed()).toBe(1);
  expect(result).toMatchObject({total:150,take:50,skip:100,page:3,pageCount:3,statusCounts:{OPEN:150,COMPLETED:2,ALL:152}});
  expect(result.items.map(row=>row.id)).toEqual(Array.from({length:50},(_,i)=>`row-${i+100}`));
  expect(await prisma.action.count({where:{workspaceId:f.workspace.id}})).toBe(155);
},60_000);

it.each(["off-page-head", "caller-aba", "source-aba"] as const)("rejects the original combined count/page union after %s",async mode=>{
  const f=await fixture(3);
  if(mode==="source-aba"){
    await f.transaction(async tx=>{
      const source=await f.seed(tx,"source");
      const row=await tx.action.findUniqueOrThrow({where:{id:"row-000"}});
      await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"Action",id:row.id},content:row,origin:"DERIVED",inputs:[{kind:"Action",id:source.id}]});
    });
    await countActionsByStatus(f.actor,f.workspace.id);
  }
  const changed=afterRead(f,args=>args.take===100&&args.orderBy?.id==="asc",()=>f.transaction(async tx=>{
    if(mode==="caller-aba"){
      await tx.member.update({where:{id:f.member.id},data:{isActive:false}});
      await tx.member.update({where:{id:f.member.id},data:{isActive:true}});
    }else if(mode==="source-aba"){
      await tx.action.update({where:{id:"source"},data:{isPrivate:true}});
      await tx.action.update({where:{id:"source"},data:{isPrivate:false}});
    }else{
      const row=await tx.action.findUniqueOrThrow({where:{id:"row-000"}});
      await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"Action",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
    }
  }));
  await expect(listActionsWithStatusCounts(f.actor,f.workspace.id,{sort:"alpha",take:1,page:3})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(changed()).toBe(1);
},60_000);

it("keeps zero-count, status-filter, tenant and own-draft behavior with exact clamping",async()=>{
  const f=await fixture(0);
  expect(await listActionsWithStatusCounts(f.actor,f.workspace.id,{statuses:["OPEN"],take:2,page:9})).toMatchObject({items:[],total:0,page:1,pageCount:1,statusCounts:{ALL:0}});
  const draft=await prisma.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.user.id,title:"Own draft",isPrivate:true,status:"DRAFT"}});
  await f.transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"Action",id:draft.id},content:draft,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const result=await listActionsWithStatusCounts(f.actor,f.workspace.id,{assigneeMemberIds:[f.member.id],includeOwnDrafts:true,statuses:["DRAFT"],take:2,page:9});
  expect(result).toMatchObject({total:1,page:1,pageCount:1,statusCounts:{DRAFT:1,OPEN:0,ALL:1}});
  expect(result.items.map(row=>row.id)).toEqual([draft.id]);
  const foreign=await prisma.workspace.create({data:{name:"Foreign",slug:randomUUID()}});
  await expect(listActionsWithStatusCounts(f.actor,foreign.id)).rejects.toMatchObject({code:"NOT_A_MEMBER"});
});
