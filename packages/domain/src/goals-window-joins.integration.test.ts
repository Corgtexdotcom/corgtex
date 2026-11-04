import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { getMyGoalSlice, getMyGoalSlicePage, listRecognitions, listRecognitionsPage, listGoalsPage } from "./goals";
import { recordArtifactInputLineage } from "./source-lineage";
import { DigestReadRelease } from "./digest-lineage";
beforeEach(truncateAllTables);
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const workspace=await prisma.workspace.create({data:{name:"Synthetic goal joins",slug:randomUUID()}});
  const users=await Promise.all(["author","reader"].map(name=>prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:"synthetic",displayName:name}})));
  const members=await Promise.all(users.map(user=>prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}})));
  const actors=users.map(user=>({kind:"user",user}) as AppActor);
  const source=await prisma.action.create({data:{workspaceId:workspace.id,title:"Private source",authorUserId:users[0].id,status:"OPEN"}});
  const circle=await prisma.circle.create({data:{workspaceId:workspace.id,name:"Joined circle"}});
  const parent=await prisma.goal.create({data:{workspaceId:workspace.id,title:"Parent secret",descriptionMd:"Parent body",authorUserId:users[0].id,status:"ACTIVE",circleId:circle.id}});
  const child=await prisma.goal.create({data:{workspaceId:workspace.id,title:"Owned child",authorUserId:users[0].id,ownerMemberId:members[1].id,status:"ACTIVE",parentGoalId:parent.id}});
  const recognition=await prisma.recognition.create({data:{workspaceId:workspace.id,goalId:parent.id,authorMemberId:members[0].id,recipientMemberId:members[1].id,title:"Recognition secret",storyMd:"Sensitive story"}});
  await prisma.$transaction(async tx=>{
    for(const [kind,row] of [["Action",source],["Circle",circle],["Goal",child]] as const)await recordArtifactInputLineage({tx,actor:actors[0],workspaceId:workspace.id,artifact:{kind,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
    await recordArtifactInputLineage({tx,actor:actors[0],workspaceId:workspace.id,artifact:{kind:"Goal",id:parent.id},content:parent,origin:"DERIVED",inputs:[{kind:"Action",id:source.id}]});
    await recordArtifactInputLineage({tx,actor:actors[0],workspaceId:workspace.id,artifact:{kind:"Recognition",id:recognition.id},content:recognition,origin:"DERIVED",inputs:[{kind:"Goal",id:parent.id}]});
  });
  return {workspace,users,members,actors,source,circle,parent,child,recognition};
}
it("omits a recognition whose recorded goal source became private",async()=>{
  const f=await fixture();
  expect((await listRecognitions(f.actors[1],{workspaceId:f.workspace.id,recipientMemberId:f.members[1].id})).map(row=>row.id)).toEqual([f.recognition.id]);
  await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});
  expect(await listRecognitions(f.actors[1],{workspaceId:f.workspace.id,recipientMemberId:f.members[1].id})).toEqual([]);
});
it("keeps an owned child but redacts a separately restricted joined parent",async()=>{
  const f=await fixture();
  expect((await getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id))[0].parentGoal).toMatchObject({id:f.parent.id,circle:{id:f.circle.id}});
  await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});
  const rows=await getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id);
  expect(rows.map(row=>row.id)).toEqual([f.child.id]);expect(rows[0].parentGoal).toBeNull();
});
it.each(["recognition","parents"] as const)("fences original %s proof after late source restoration",async kind=>{
  const f=await fixture();const original=DigestReadRelease.prototype.finish;let changed=false;
  vi.spyOn(DigestReadRelease.prototype,"finish").mockImplementation(async function<T>(this:DigestReadRelease,value:T){
    if(!changed){changed=true;await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});await prisma.action.update({where:{id:f.source.id},data:{isPrivate:false}});}
    return original.call(this,value) as Promise<T>;
  });
  const read=kind==="recognition"?listRecognitions(f.actors[1],{workspaceId:f.workspace.id}):getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id);
  await expect(read).rejects.toMatchObject({code:"SOURCE_CHANGED"});expect(changed).toBe(true);
});
it("continues a hidden goal window without skipping its permitted tail and binds scope",async()=>{
  const f=await fixture();
  await prisma.goal.createMany({data:Array.from({length:201},(_,i)=>({id:`hidden-${i}`,workspaceId:f.workspace.id,title:"Unknown",sortOrder:-1,status:"ACTIVE"}))});
  const first=await listGoalsPage(f.actors[1],{workspaceId:f.workspace.id});
  expect(first.items).toEqual([]);expect(first.complete).toBe(false);expect(first.nextCursor).toBeTruthy();
  const second=await listGoalsPage(f.actors[1],{workspaceId:f.workspace.id,cursor:first.nextCursor!});
  expect(new Set(second.items.map(row=>row.id))).toEqual(new Set([f.parent.id,f.child.id]));expect(second.complete).toBe(true);
  await expect(listGoalsPage(f.actors[1],{workspaceId:f.workspace.id,cursor:first.nextCursor!,status:"COMPLETED"})).rejects.toMatchObject({code:"INVALID_INPUT"});
});

it.each(["recognition-head", "recipient-label", "caller-restored", "parent-head"] as const)("rejects original joined output after late %s", async mode => {
  const f = await fixture();
  const finish = DigestReadRelease.prototype.finish;
  let changed = false;
  vi.spyOn(DigestReadRelease.prototype, "finish").mockImplementation(async function<T>(this: DigestReadRelease, value: T) {
    changed = true;
    if (mode === "recipient-label") await prisma.user.update({where:{id:f.users[1].id},data:{displayName:"Changed label"}});
    else if (mode === "caller-restored") {
      await prisma.member.update({where:{id:f.members[1].id},data:{isActive:false}});
      await prisma.member.update({where:{id:f.members[1].id},data:{isActive:true}});
    } else {
      const kind = mode === "parent-head" ? "Goal" : "Recognition";
      const row = mode === "parent-head" ? f.parent : f.recognition;
      const inputs = mode === "parent-head" ? [{kind:"Action" as const,id:f.source.id}] : [{kind:"Goal" as const,id:f.parent.id}];
      await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"DERIVED",inputs}));
    }
    return finish.call(this,value) as Promise<T>;
  });
  const read = mode === "parent-head" ? getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id) : listRecognitions(f.actors[1],{workspaceId:f.workspace.id});
  await expect(read).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(changed).toBe(true);
});
it("independently redacts an unknown grandparent and joined circle while preserving readable parent", async()=>{
  const f=await fixture();
  const grandparent=await prisma.goal.create({data:{workspaceId:f.workspace.id,title:"Unknown grandparent",status:"ACTIVE"}});
  const parent=await prisma.goal.update({where:{id:f.parent.id},data:{parentGoalId:grandparent.id}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actors[0],workspaceId:f.workspace.id,artifact:{kind:"Goal",id:parent.id},content:parent,origin:"HUMAN_ORIGINAL",inputs:[]}));
  await prisma.artifactInputLineage.deleteMany({where:{workspaceId:f.workspace.id,artifactType:"Circle",artifactId:f.circle.id}});
  const rows=await getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id);
  expect(rows[0].id).toBe(f.child.id);
  expect(rows[0].parentGoal).toMatchObject({id:f.parent.id,parentGoal:null,circle:null});
});
it.each(["window", "slice", "recognitions"] as const)("retains original %s proof through later caller awaits",async mode=>{
  const f=await fixture();const release=new DigestReadRelease(f.actors[1],f.workspace.id);
  if(mode==="window")await listGoalsPage(f.actors[1],{workspaceId:f.workspace.id},release);
  else if(mode==="slice")await getMyGoalSlice(f.actors[1],f.members[1].id,f.workspace.id,release);
  else await listRecognitions(f.actors[1],{workspaceId:f.workspace.id},release);
  await prisma.action.update({where:{id:f.source.id},data:{isPrivate:true}});
  await prisma.action.update({where:{id:f.source.id},data:{isPrivate:false}});
  await expect(release.finish("page")).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it.each(["owned", "recognition"] as const)("bounds a hidden %s window and continues without omission or scope reuse", async kind=>{
  const f=await fixture();
  if(kind==="owned")await prisma.goal.createMany({data:Array.from({length:201},(_,i)=>({id:`unknown-goal-${i.toString().padStart(3,"0")}`,workspaceId:f.workspace.id,title:"Unknown owned",ownerMemberId:f.members[1].id,status:"ACTIVE",targetDate:new Date("2020-01-01"),updatedAt:new Date("2020-01-01")}))});
  else await prisma.recognition.createMany({data:Array.from({length:201},(_,i)=>({id:`unknown-rec-${i.toString().padStart(3,"0")}`,workspaceId:f.workspace.id,title:"Unknown recognition",storyMd:"Unknown",authorMemberId:f.members[0].id,recipientMemberId:f.members[1].id,createdAt:new Date("2099-01-01")}))});
  const query=vi.spyOn(kind==="owned"?prisma.goal:prisma.recognition,"findMany");
  const read=(cursor?:string,memberId=f.members[1].id)=>kind==="owned"
    ?getMyGoalSlicePage(f.actors[1],memberId,f.workspace.id,{cursor})
    :listRecognitionsPage(f.actors[1],{workspaceId:f.workspace.id,recipientMemberId:memberId,cursor});
  const first=await read();
  expect(first.items).toEqual([]);expect(first.complete).toBe(false);expect(first.nextCursor).toBeTruthy();
  expect(query.mock.calls.filter(([args])=>args?.take===200)).toHaveLength(1);
  const second=await read(first.nextCursor!);
  expect(second.items.map(row=>row.id)).toEqual([kind==="owned"?f.child.id:f.recognition.id]);expect(second.complete).toBe(true);
  await expect(read(first.nextCursor!,f.members[0].id)).rejects.toMatchObject({code:"INVALID_INPUT"});
});
