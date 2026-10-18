import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, type AppActor } from "@corgtex/shared";
import { getPrismaClient } from "../../shared/src/db";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { recordArtifactInputLineage } from "./source-lineage";
import { WorkItemReadRelease } from "./work-item-readable-page";
import { getCompanyContext, listWritebackTargets } from "./execution-plumbing";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!((database.hostname === "127.0.0.1" && database.port === "63973" && database.pathname === "/child_read_test")
  || (process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432" && database.pathname === "/corgtex_test"))) {
  throw new Error("Execution meeting sample tests require the assigned disposable fixture or CI database.");
}
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

async function fixture(known = 1, denied = 0) {
  const workspace = await prisma.workspace.create({data:{name:"Synthetic execution sample",slug:randomUUID()}});
  const user = await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const member = await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN"}});
  const actor: AppActor = {kind:"user",user};
  const rows = Array.from({length:known+denied},(_,i)=>({id:`meeting-${String(i).padStart(4,"0")}`,workspaceId:workspace.id,
    source:"manual",title:`Meeting ${i}`,recordedAt:new Date(Date.UTC(2026,0,1,0,0,Math.floor(i/2))),
    summaryMd:"Synthetic authorized meeting",participantIds:[],updatedAt:new Date("2027-01-01")}));
  await prisma.meeting.createMany({data:rows});
  const ordered = await prisma.meeting.findMany({where:{workspaceId:workspace.id},orderBy:[{recordedAt:"desc"},{id:"asc"}]});
  for(const row of ordered.slice(denied)) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,
    artifact:{kind:"Meeting",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  return {actor,workspaceId:workspace.id,member,ordered};
}
async function read(f: Awaited<ReturnType<typeof fixture>>, consumer: "company" | "targets") {
  if(consumer === "targets") return (await listWritebackTargets(f.actor,{workspaceId:f.workspaceId,targetTypes:["MEETING"],take:10})).items;
  const context = await getCompanyContext(f.actor,f.workspaceId) as {recent:{meetings:Array<{id:string}>}};
  return context.recent.meetings;
}

it("serves correct newest persisted samples from 201 fully readable meetings without a corpus fold", async () => {
  const f = await fixture(201);
  const client = getPrismaClient().meeting;
  const find = client.findMany.bind(client);
  const pages: number[] = [];
  vi.spyOn(client,"findMany").mockImplementation((async (args: Prisma.MeetingFindManyArgs) => {
    const result = await find(args); pages.push(result.length); return result;
  }) as typeof client.findMany);
  for(const consumer of ["company","targets"] as const) expect((await read(f,consumer)).map(row=>row.id)).toEqual(f.ordered.slice(0,10).map(row=>row.id));
  expect(pages).toEqual([100,100]);
});

it("replenishes a dated denied prefix while keeping tie order and tenant/archive filters", async () => {
  const f = await fixture(3,101);
  const foreign = await prisma.workspace.create({data:{name:"Other",slug:randomUUID()}});
  await prisma.meeting.create({data:{workspaceId:foreign.id,source:"manual",recordedAt:new Date("2030-01-01"),title:"Foreign",participantIds:[]}});
  await prisma.meeting.create({data:{workspaceId:f.workspaceId,source:"manual",recordedAt:new Date("2030-01-01"),archivedAt:new Date(),title:"Archived",participantIds:[]}});
  for(const consumer of ["company","targets"] as const) expect((await read(f,consumer)).map(row=>row.id)).toEqual(f.ordered.slice(101).map(row=>row.id));
});

it("reports unavailable rather than a false empty/latest sample after 200 denied candidates", async () => {
  const f = await fixture(1,201);
  for(const consumer of ["company","targets"] as const) await expect(read(f,consumer)).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
});

it.each(["company","targets"] as const)("retains original meeting head and caller proof at final %s release", async consumer => {
  const f = await fixture();
  const original = WorkItemReadRelease.prototype.finish;
  let changed = false;
  vi.spyOn(WorkItemReadRelease.prototype,"finish").mockImplementation(async function<T>(this:WorkItemReadRelease,value:T):Promise<T> {
    const head = await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"Meeting",artifactId:f.ordered[0].id},orderBy:{revision:"desc"}});
    const {id:_id, ...copy} = head;
    await prisma.artifactInputLineage.create({data:{...copy,revision:head.revision+1,
      inputsJson:head.inputsJson as Prisma.InputJsonValue,rootsJson:head.rootsJson as Prisma.InputJsonValue,permissionEpochsJson:head.permissionEpochsJson as Prisma.InputJsonValue}});
    changed = true;
    return original.call(this,value) as Promise<T>;
  });
  await expect(read(f,consumer)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it.each(["company","targets"] as const)("withholds %s after final caller revoke/restore", async consumer => {
  const f = await fixture();
  const original = WorkItemReadRelease.prototype.finish;
  let changed = false;
  vi.spyOn(WorkItemReadRelease.prototype,"finish").mockImplementation(async function<T>(this:WorkItemReadRelease,value:T):Promise<T> {
    await prisma.member.update({where:{id:f.member.id},data:{isActive:false}});
    await prisma.member.update({where:{id:f.member.id},data:{isActive:true}});
    changed = true;
    return original.call(this,value) as Promise<T>;
  });
  await expect(read(f,consumer)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});
