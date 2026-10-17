import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getGoalTree } from "./goals";
import { listCircles } from "./circles";
import { DigestReadRelease } from "./digest-lineage";
import * as lineage from "./source-lineage";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data:{name:"Goal circle release",slug:randomUUID()}});
  const users = await Promise.all(["author","reader"].map(name => prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic",displayName:name,bio:"Original profile"}})));
  const members = await Promise.all(users.map(user => prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}})));
  const actors = users.map(user => ({kind:"user",user}) as AppActor);
  const source = await prisma.action.create({data:{workspaceId:workspace.id,authorUserId:users[0].id,title:"Private ancestry",status:"OPEN"}});
  const parent = await prisma.circle.create({data:{workspaceId:workspace.id,name:"Parent",sortOrder:0}});
  const circle = await prisma.circle.create({data:{workspaceId:workspace.id,name:"Original circle",purposeMd:"Original circle purpose",parentCircleId:parent.id,sortOrder:1}});
  const role = await prisma.role.create({data:{circleId:circle.id,name:"Original role",accountabilities:[],artifacts:[]}});
  const goal = await prisma.goal.create({data:{workspaceId:workspace.id,authorUserId:users[0].id,ownerMemberId:members[0].id,circleId:circle.id,title:"Original goal",status:"ACTIVE",cadence:"ANNUAL",sortOrder:0}});
  const child = await prisma.goal.create({data:{workspaceId:workspace.id,authorUserId:users[0].id,parentGoalId:goal.id,title:"Child goal",status:"ACTIVE",cadence:"QUARTERLY",sortOrder:1}});
  const keyResult = await prisma.keyResult.create({data:{goalId:goal.id,title:"Original key result"}});
  const rows = [["Action",source],["Circle",parent],["Circle",circle],["Role",role],["Goal",goal],["Goal",child],["KeyResult",keyResult]] as const;
  for (const [kind,row] of rows) await prisma.$transaction(tx => lineage.recordArtifactInputLineage({tx,actor:actors[0],workspaceId:workspace.id,artifact:{kind,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
  return {workspace,users,members,actors,source,parent,circle,role,goal,child,keyResult};
}

it("preserves readable goal hierarchy, owner DTO, cadence and circle role ordering with tenant isolation", async () => {
  const f=await fixture();
  const tree=await getGoalTree(f.actors[1],f.workspace.id);
  expect(tree).toHaveLength(1);
  expect(tree[0]).toMatchObject({id:f.goal.id,circle:{id:f.circle.id,name:"Original circle"},ownerMember:{id:f.members[0].id,user:{displayName:"author",email:f.users[0].email}}});
  expect(tree[0].keyResults.map((row:{id:string})=>row.id)).toEqual([f.keyResult.id]);
  expect(tree[0].childGoals.map((row:{id:string})=>row.id)).toEqual([f.child.id]);
  expect(Object.keys(tree[0].ownerMember!.user).sort()).toEqual(["displayName","email"]);
  expect((await getGoalTree(f.actors[1],f.workspace.id,{cadence:"QUARTERLY"})).map(row=>row.id)).toEqual([f.child.id]);
  const circles=await listCircles(f.actors[1],f.workspace.id);
  expect(circles.map(row=>row.id)).toEqual([f.parent.id,f.circle.id]);
  expect(circles[1].roles.map(row=>row.id)).toEqual([f.role.id]);
  expect(circles[1]).not.toHaveProperty("parentCircle");
  const foreign=await prisma.workspace.create({data:{name:"Foreign",slug:randomUUID()}});
  await expect(getGoalTree(f.actors[1],foreign.id)).rejects.toMatchObject({code:"NOT_A_MEMBER"});
  await expect(listCircles(f.actors[1],foreign.id)).rejects.toMatchObject({code:"NOT_A_MEMBER"});
});

it.each(["KeyResult","Circle","Member","User"] as const)("withholds independently private %s joins from a readable goal",async kind=>{
  const f=await fixture();
  const row=kind==="KeyResult"?f.keyResult:kind==="Circle"?f.circle:kind==="User"?f.users[0]:{...f.members[0],user:{id:f.users[0].id,email:f.users[0].email,displayName:f.users[0].displayName}};
  await prisma.$transaction(tx=>lineage.recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"DERIVED",inputs:[{kind:"Action",id:f.source.id}]}));
  await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});
  const tree=await getGoalTree(f.actors[1],f.workspace.id);
  expect(tree[0].id).toBe(f.goal.id);
  if(kind==="KeyResult") expect(tree[0].keyResults).toEqual([]);
  else if(kind==="Circle") expect(tree[0].circle).toBeNull();
  else expect(tree[0].ownerMember).toBeNull();
});

it.each(["goal-head","key-result-head","circle-restore","member-restore","user-restore","caller-loss","caller-restore"] as const)("fences original goal tree contributors at release: %s",async mode=>{
  const f=await fixture();let changed=false;
  if(mode==="user-restore") await prisma.$transaction(tx=>lineage.recordArtifactInputLineage({
    tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind:"User",id:f.users[0].id},content:f.users[0],
    origin:"DERIVED",inputs:[{kind:"Action",id:f.source.id}],
  }));
  const finish=DigestReadRelease.prototype.finish;
  vi.spyOn(DigestReadRelease.prototype,"finish").mockImplementation(async function<T>(this:DigestReadRelease,value:T){
    if(!changed){
      if(mode==="goal-head"||mode==="key-result-head") {
        const kind=mode==="goal-head"?"Goal":"KeyResult",row=mode==="goal-head"?f.goal:f.keyResult;
        await prisma.$transaction(tx=>lineage.recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
      } else if(mode==="circle-restore") {
        await prisma.circle.update({where:{id:f.circle.id},data:{archivedAt:new Date()}});
        await prisma.circle.update({where:{id:f.circle.id},data:{archivedAt:null,updatedAt:f.circle.updatedAt}});
      } else if(mode==="user-restore") {
        await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});
        await prisma.action.update({where:{id:f.source.id},data:{isPrivate:false}});
      } else {
        const member=mode==="member-restore"?f.members[0]:f.members[1];
        await prisma.member.update({where:{id:member.id},data:{isActive:false}});
        if(mode!=="caller-loss") await prisma.member.update({where:{id:member.id},data:{isActive:true}});
      }
      changed=true;
    }
    return finish.call(this,value) as Promise<T>;
  });
  await expect(getGoalTree(f.actors[1],f.workspace.id)).rejects.toMatchObject({code:mode==="caller-loss"?"NOT_A_MEMBER":"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});

it.each(["head","circle-restore","caller-loss","caller-restore"] as const)("fences original list circle after later Role admission: %s",async mode=>{
  const f=await fixture();let changed=false;
  const mutate=async()=>{
    if(changed)return;
    if(mode==="head") await prisma.$transaction(tx=>lineage.recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind:"Circle",id:f.circle.id},content:f.circle,origin:"HUMAN_ORIGINAL",inputs:[]}));
    else if(mode==="circle-restore") {
      await prisma.circle.update({where:{id:f.circle.id},data:{archivedAt:new Date()}});
      await prisma.circle.update({where:{id:f.circle.id},data:{archivedAt:null,updatedAt:f.circle.updatedAt}});
    }else{
      await prisma.member.update({where:{id:f.members[1].id},data:{isActive:false}});
      if(mode==="caller-restore")await prisma.member.update({where:{id:f.members[1].id},data:{isActive:true}});
    }
    changed=true;
  };
  const ids=lineage.readableArtifactIds,proof=lineage.captureArtifactInputProof;
  vi.spyOn(lineage,"readableArtifactIds").mockImplementation(async(...args)=>{const result=await ids(...args);if(args[2]==="Role")await mutate();return result;});
  vi.spyOn(lineage,"captureArtifactInputProof").mockImplementation(async(...args)=>{const result=await proof(...args);if(args[2].some(row=>row.kind==="Role"))await mutate();return result;});
  await expect(listCircles(f.actors[1],f.workspace.id)).rejects.toMatchObject({code:mode==="caller-loss"?"NOT_A_MEMBER":"SOURCE_CHANGED"});
  expect(changed).toBe(true);
  if(mode==="head")expect((await prisma.artifactInputLineage.findFirstOrThrow({where:{artifactType:"Circle",artifactId:f.circle.id},orderBy:{revision:"desc"}})).revision).toBe(2);
});
