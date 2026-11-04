import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { listWorkspaceAgreements } from "./agreements";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const local = database.hostname === "127.0.0.1" && database.port === "63973" && database.pathname === "/child_read_test";
const hosted = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!local && !hosted) || database.searchParams.get("schema") !== "public") throw new Error("Agreement tests require the owned disposable fixture or documented hosted CI fixture.");
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const workspace = await prisma.workspace.create({data:{name:"Synthetic agreements",slug:randomUUID()}});
  const user = await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const member = await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}});
  const actor: AppActor = {kind:"user",user};
  const addPolicy = async (id: string, circleId: string | null = null) => {
    const proposal = await prisma.proposal.create({data:{workspaceId:workspace.id,authorUserId:user.id,
      title:`Proposal ${id}`,bodyMd:"Synthetic policy source",status:"RESOLVED",resolutionOutcome:"ADOPTED",
      isPrivate:false,publishedAt:new Date("2026-01-01")}});
    const policy = await prisma.policyCorpus.create({data:{id,workspaceId:workspace.id,proposalId:proposal.id,circleId,
      title:`Policy ${id}`,bodyMd:proposal.bodyMd,acceptedAt:new Date("2026-01-01")}});
    await prisma.$transaction(async tx => {
      await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"Proposal",id:proposal.id},content:proposal,origin:"HUMAN_ORIGINAL",inputs:[]});
      await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"PolicyCorpus",id:policy.id},content:policy,origin:"DERIVED",inputs:[{kind:"Proposal",id:proposal.id}]});
    });
    return {policy,proposal};
  };
  return {workspaceId:workspace.id,user,member,actor,addPolicy};
}

it("continues through 201 unknown policies to the permitted policy without exceeding 200 raw rows per request", async () => {
  const f = await fixture();
  const visible = await f.addPolicy("visible");
  const ids = Array.from({length:201},(_,i)=>`unknown-${String(i).padStart(3,"0")}`);
  await prisma.proposal.createMany({data:ids.map(id=>({id,workspaceId:f.workspaceId,authorUserId:f.user.id,title:"Unknown source",bodyMd:"Unproven"}))});
  await prisma.policyCorpus.createMany({data:ids.map(id=>({id,workspaceId:f.workspaceId,proposalId:id,title:"Unknown policy",bodyMd:"Unproven",acceptedAt:new Date("2026-02-01")}))});
  const client = getPrismaClient().policyCorpus;
  const find = client.findMany.bind(client);
  const sizes: number[] = [];
  vi.spyOn(client,"findMany").mockImplementation((async (args: Prisma.PolicyCorpusFindManyArgs) => {
    const rows = await find(args); sizes.push(rows.length); return rows;
  }) as typeof client.findMany);
  const first = await listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId});
  expect(first).toMatchObject({policyCorpus:[],policyWindow:{complete:false,nextCursor:expect.any(String),continued:false}});
  expect(sizes).toEqual([100,100]);
  const second = await listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId,policyCursor:first.policyWindow.nextCursor!});
  expect(second.policyCorpus.map(row=>row.id)).toEqual([visible.policy.id]);
  expect(second.policyWindow).toEqual({complete:true,nextCursor:null,continued:true});
  expect(sizes).toEqual([100,100,2]);
  expect(second.policyCorpus[0].proposal).toEqual({id:visible.proposal.id,title:visible.proposal.title});
});

it("binds continuation to its selected circle and workspace", async () => {
  const f = await fixture();
  const circle = await prisma.circle.create({data:{workspaceId:f.workspaceId,name:"Selected circle"}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Circle",id:circle.id},content:circle,origin:"HUMAN_ORIGINAL",inputs:[]}));
  await f.addPolicy("selected-a",circle.id); await f.addPolicy("selected-b",circle.id); await f.addPolicy("workspace-policy");
  const first = await listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId,policyScope:circle.id,policyTake:1});
  expect(first.policyCorpus.map(row=>row.id)).toEqual(["selected-b"]);
  expect(first.policyCorpus[0].circle).toEqual({id:circle.id,name:circle.name});
  const cursor = first.policyWindow.nextCursor!;
  const next = await listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId,policyScope:circle.id,policyTake:1,policyCursor:cursor});
  expect(next.policyCorpus.map(row=>row.id)).toEqual(["selected-a"]);
  await expect(listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId,policyScope:"workspace",policyCursor:cursor})).rejects.toMatchObject({code:"INVALID_INPUT"});
  const other = await prisma.workspace.create({data:{name:"Other tenant",slug:randomUUID()}});
  await prisma.member.create({data:{workspaceId:other.id,userId:f.user.id,role:"CONTRIBUTOR"}});
  await expect(listWorkspaceAgreements(f.actor,{workspaceId:other.id,policyScope:circle.id,policyCursor:cursor})).rejects.toMatchObject({code:"INVALID_INPUT"});
});

it("preserves tie order and does not omit prefetched readable policies when take is smaller than the page", async () => {
  const f = await fixture();
  for(const id of ["policy-a","policy-c","policy-b"]) await f.addPolicy(id);
  const collected: string[] = [];
  let cursor: string | undefined;
  let windows = 0;
  do {
    const page = await listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId,policyTake:1,policyCursor:cursor});
    expect(page.policyCorpus).toHaveLength(1);
    collected.push(page.policyCorpus[0].id);
    cursor = page.policyWindow.nextCursor ?? undefined;
    windows++;
    expect(windows).toBeLessThanOrEqual(3);
  } while(cursor);
  expect(collected).toEqual(["policy-c","policy-b","policy-a"]);
});

it.each(["head","member-restore"] as const)("rejects original policy output after late %s during the proposal join", async change => {
  const f = await fixture();
  const {policy} = await f.addPolicy("visible");
  const client = getPrismaClient().proposal;
  const find = client.findMany.bind(client);
  let changed = false;
  vi.spyOn(client,"findMany").mockImplementation((async (args: Prisma.ProposalFindManyArgs) => {
    const rows = await find(args);
    if (!changed && args.where?.publishedAt && args.where?.id) {
      changed = true;
      if(change === "head") {
        const head = await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"PolicyCorpus",artifactId:policy.id},orderBy:{revision:"desc"}});
        const {id:_id,...copy} = head;
        await prisma.artifactInputLineage.create({data:{...copy,revision:head.revision+1,
          inputsJson:head.inputsJson as Prisma.InputJsonValue,rootsJson:head.rootsJson as Prisma.InputJsonValue,permissionEpochsJson:head.permissionEpochsJson as Prisma.InputJsonValue}});
      } else {
        await prisma.member.update({where:{id:f.member.id},data:{isActive:false}});
        await prisma.member.update({where:{id:f.member.id},data:{isActive:true}});
      }
    }
    return rows;
  }) as typeof client.findMany);
  await expect(listWorkspaceAgreements(f.actor,{workspaceId:f.workspaceId})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});
