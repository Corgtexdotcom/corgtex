import {randomUUID} from "node:crypto";
import {afterAll, afterEach, beforeEach, expect, it, vi} from "vitest";
import type {AppActor} from "@corgtex/shared";
const measured = vi.hoisted(() => ({queries: 0}));
vi.mock("@corgtex/shared", async original => {
  const actual = await original<typeof import("@corgtex/shared")>();
  const {PrismaClient} = await import("@prisma/client");
  const client = new PrismaClient({datasources: {db: {url: process.env.DATABASE_URL}}, log: [{level: "query", emit: "event"}]});
  client.$on("query", () => {measured.queries++;});
  return {...actual, prisma: client};
});
import {prisma} from "@corgtex/shared";
import {truncateAllTables} from "../../packages/shared/src/db-test-utils";
import {DigestReadRelease} from "../../packages/domain/src/digest-lineage";
import {captureReadableDirectoryInputs, recordArtifactInputLineage} from "../../packages/domain/src/source-lineage";
import {loadRoleDirectoryData} from "./app/[locale]/workspaces/[workspaceId]/roles/role-directory";
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());
async function fixture(count=120) {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic role directory",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,displayName:"Shared holder",bio:"Original holder biography",passwordHash:"synthetic"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN"}});
  const actor:AppActor={kind:"user",user};
  const circle=await prisma.circle.create({data:{workspaceId:workspace.id,name:"Shared circle"}});
  await prisma.$transaction(async tx=>{
    await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"Circle",id:circle.id},content:circle,origin:"HUMAN_ORIGINAL",inputs:[]});
    for(let i=0;i<count;i++){
      const role=await tx.role.create({data:{circleId:circle.id,name:`Role ${i}`,sortOrder:i}});
      await recordArtifactInputLineage({tx,actor,workspaceId:workspace.id,artifact:{kind:"Role",id:role.id},content:role,origin:"HUMAN_ORIGINAL",inputs:[]});
      await tx.roleAssignment.create({data:{roleId:role.id,memberId:member.id}});
    }
  },{timeout:30_000});
  return {workspaceId:workspace.id,actor,user,member,circle};
}
it("batches120role shared-holder directory admissions while preserving every role and profile",async()=>{
  const f=await fixture();
  const capture=vi.spyOn(DigestReadRelease.prototype,"captureDirectory");
  measured.queries=0; const started=performance.now();
  const result=await loadRoleDirectoryData(f.actor,f.workspaceId);
  const queries=measured.queries;
  console.info("ROLE_DIRECTORY_MEASUREMENT",JSON.stringify({roles:120,sqlQueries:queries,durationMs:Math.round(performance.now()-started),captures:capture.mock.calls.map(([kind,rows])=>[kind,rows.length])}));
  expect(result.roles).toHaveLength(120);
  expect(result.roles.map(role=>role.name)).toEqual(Array.from({length:120},(_,i)=>`Role ${i}`));
  expect(result.roles.every(role=>role.assignments.length===1&&role.assignments[0].member.user?.bio===f.user.bio)).toBe(true);
  expect(result.members).toEqual([{id:f.member.id,name:f.user.displayName,email:f.user.email}]);
  expect(queries).toBeLessThan(3500);
  expect(capture.mock.calls.length).toBeLessThanOrEqual(12);
  expect(capture.mock.calls.every(([,rows])=>rows.length<=75)).toBe(true);
},180_000);

it.each(["caller-restore", "profile-body", "role-head"] as const)("retains original directory proof after final shared-profile admission: %s", async mode => {
  const f = await fixture(2);
  const capture = DigestReadRelease.prototype.captureDirectory;
  let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "captureDirectory").mockImplementation(async function(this: DigestReadRelease, ...args: Parameters<typeof capture>) {
    const result = await capture.apply(this, args);
    if (!changed && args[0] === "User") {
      if (mode === "caller-restore") {
        await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
      } else if (mode === "profile-body") await prisma.user.update({where: {id: f.user.id}, data: {bio: "Changed profile"}});
      else {
        const role = await prisma.role.findFirstOrThrow({where: {circleId: f.circle.id}});
        await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: {kind: "Role", id: role.id}, content: role, origin: "HUMAN_ORIGINAL", inputs: []}));
      }
      changed = true;
    }
    return result;
  });
  await expect(loadRoleDirectoryData(f.actor, f.workspaceId)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it("uses ordinary derived/unknown admission and rejects foreign canonical rows", async () => {
  const f = await fixture(1);
  const derived = await prisma.role.create({data: {circleId: f.circle.id, name: "Derived role", sortOrder: 2}});
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "Role", id: derived.id}, content: derived, origin: "DERIVED", inputs: [{kind: "Circle", id: f.circle.id}]}));
  const unknown = await prisma.role.create({data: {circleId: f.circle.id, name: "Unknown role", sortOrder: 3}});
  expect(await captureReadableDirectoryInputs(f.actor, f.workspaceId, "Role", [derived])).toBeNull();
  expect(await captureReadableDirectoryInputs(f.actor, f.workspaceId, "Role", [unknown])).toBeNull();
  const foreign = await prisma.workspace.create({data: {name: "Other synthetic tenant", slug: randomUUID()}});
  const foreignCircle = await prisma.circle.create({data: {workspaceId: foreign.id, name: "Foreign circle"}});
  const foreignRole = await prisma.role.create({data: {circleId: foreignCircle.id, name: "Foreign canary"}});
  expect(await captureReadableDirectoryInputs(f.actor, f.workspaceId, "Role", [foreignRole])).toBeNull();
  const result = await loadRoleDirectoryData(f.actor, f.workspaceId);
  expect(result.roles.map(role => role.name)).toEqual(["Role 0", "Derived role"]);
  expect(JSON.stringify(result)).not.toContain("Foreign canary");
  const filtered = await loadRoleDirectoryData(f.actor, f.workspaceId, {roleIds: [foreignRole.id]});
  expect(filtered.roles).toEqual([]);
});
