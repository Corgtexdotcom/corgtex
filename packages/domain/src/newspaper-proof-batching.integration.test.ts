import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureReadableNewspaperDeliveryInputs,
  recordArtifactInputLineage } from "./source-lineage";
import { captureReadableDigestInputs, DigestReadRelease } from "./digest-lineage";
import { recordNewspaperDelivery } from "./newspaper-delivery";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data:{name:"Delivery batch",slug:randomUUID()}});
  const users = await Promise.all(["reader","other"].map(name => prisma.user.create({data:{email:`${name}-${randomUUID()}@example.test`,passwordHash:"synthetic"}})));
  const members = await Promise.all(users.map(user => prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}})));
  const actor: AppActor = {kind:"user",user:users[0]};
  const roots = await captureArtifactInputProof(actor,workspace.id,[{kind:"Workspace",id:workspace.id},{kind:"Member",id:members[0].id},{kind:"Member",id:members[1].id}]);
  async function delivery(memberId=members[0].id, lineageRoots=roots) {
    return recordNewspaperDelivery({workspaceId:workspace.id,runKey:randomUUID(),kind:"MEMBER_NEWSPAPER",memberId,
      recipientEmail:"synthetic@example.test",subject:"Exact synthetic subject",status:"SENT",actor,lineageRoots});
  }
  async function rewriteHead(kind: string,id: string) {
    const head = await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:workspace.id,artifactType:kind,artifactId:id},orderBy:{revision:"desc"}});
    const {id: _id,createdAt: _created,...data} = head;
    return prisma.artifactInputLineage.create({data:{...data,revision:head.revision+1,
      inputsJson:data.inputsJson as never,rootsJson:data.rootsJson as never,permissionEpochsJson:data.permissionEpochsJson as never}});
  }
  return {workspaceId:workspace.id,actor,members,roots,delivery,rewriteHead};
}

it("preserves per-delivery original proofs while batching canonical row reads",async()=>{
  const f=await fixture();
  for (let index=0;index<6;index++) await f.delivery();
  const canonical=await prisma.newspaperDelivery.findMany({where:{workspaceId:f.workspaceId}});
  expect(canonical).toHaveLength(6);
  const expected=await Promise.all(canonical.map(row=>captureArtifactInputProof(f.actor,f.workspaceId,[{kind:"NewspaperDelivery",id:row.id,snapshot:row}])));
  const single=vi.spyOn(prisma.newspaperDelivery,"findFirst");
  const batched=await captureReadableNewspaperDeliveryInputs(f.actor,f.workspaceId,canonical);
  expect(batched?.records).toEqual(canonical);
  expect(canonical.map(row=>batched?.proofs.get(row.id))).toEqual(expected);
  expect(single).not.toHaveBeenCalled();
});

it("omits only denied siblings and preserves audience and additional input fallbacks",async()=>{
  const f=await fixture(), visible=await f.delivery(), denied=await f.delivery(f.members[1].id);
  const result=await captureReadableDigestInputs({actor:f.actor,workspaceId:f.workspaceId,kind:"NewspaperDelivery",records:[visible,denied]});
  expect(result.records.map(row=>row.id)).toEqual([visible.id]);
  const extra=await captureReadableDigestInputs({actor:f.actor,workspaceId:f.workspaceId,kind:"NewspaperDelivery",records:[visible],
    audience:[f.actor],additionalInputs:()=>[{kind:"Member",id:f.members[1].id}]});
  expect(extra.roots.some(root=>root.kind==="Member"&&root.id===f.members[1].id)).toBe(true);
});

it.each(["body","head","ancestor","caller-restore","ancestor-restore"] as const)("rejects %s changes after original page capture",async(change)=>{
  const f=await fixture(), row=await f.delivery(), release=new DigestReadRelease(f.actor,f.workspaceId);
  expect((await release.capture("NewspaperDelivery",[row])).records).toHaveLength(1);
  if(change==="body") await prisma.newspaperDelivery.update({where:{id:row.id},data:{subject:"Changed"}});
  if(change==="head") await f.rewriteHead("NewspaperDelivery",row.id);
  if(change==="ancestor") await prisma.workspace.update({where:{id:f.workspaceId},data:{name:"Changed ancestor"}});
  if(change==="caller-restore") {
    await prisma.member.update({where:{id:f.members[0].id},data:{isActive:false}});
    await prisma.member.update({where:{id:f.members[0].id},data:{isActive:true}});
  }
  if(change==="ancestor-restore") {
    await prisma.member.update({where:{id:f.members[1].id},data:{isActive:false}});
    await prisma.member.update({where:{id:f.members[1].id},data:{isActive:true}});
  }
  await expect(release.finish(1)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it.each(["head","body","ancestor"] as const)("freshly compares %s mutated during the raw read scope",async(change)=>{
  const f=await fixture(), row=await f.delivery();
  const find=prisma.newspaperDelivery.findMany.bind(prisma.newspaperDelivery); let calls=0;
  vi.spyOn(prisma.newspaperDelivery,"findMany").mockImplementation(async args=>{
    if(++calls===2) {
      if(change==="head") await f.rewriteHead("NewspaperDelivery",row.id);
      if(change==="body") await prisma.newspaperDelivery.update({where:{id:row.id},data:{subject:"Interleaved body"}});
      if(change==="ancestor") await prisma.member.update({where:{id:f.members[0].id},data:{role:"ADMIN"}});
    }
    return find(args);
  });
  expect(await captureReadableNewspaperDeliveryInputs(f.actor,f.workspaceId,[row])).toBeNull();
});

it("falls back for an immutable snapshot hidden under a local derived ancestor",async()=>{
  const f=await fixture();
  const original=await prisma.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.actor.kind==="user"?f.actor.user.id:"",
    title:"Original source",status:"OPEN",isPrivate:false}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"Action",id:original.id},content:original,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const snapshot=await prisma.$transaction(tx=>captureArtifactInputSnapshotProof(f.actor,f.workspaceId,{kind:"Action",id:original.id},tx));
  const derived=await prisma.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.actor.kind==="user"?f.actor.user.id:"",
    title:"Derived ancestor",status:"OPEN",isPrivate:false}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"Action",id:derived.id},content:derived,origin:"DERIVED",inputs:[],inheritedRoots:snapshot}));
  const roots=await captureArtifactInputProof(f.actor,f.workspaceId,[{kind:"Action",id:derived.id}]);
  const row=await f.delivery(f.members[0].id,roots);
  expect(await captureReadableNewspaperDeliveryInputs(f.actor,f.workspaceId,[row])).toBeNull();
  const fallback=await captureReadableDigestInputs({actor:f.actor,workspaceId:f.workspaceId,kind:"NewspaperDelivery",records:[row]});
  expect(fallback.records).toHaveLength(1);
  expect(fallback.roots.some(root=>root.kind==="ArtifactInputSnapshot")).toBe(true);
});

it("denies a private local ancestor without hiding a readable sibling",async()=>{
  const f=await fixture(), visible=await f.delivery();
  const other=await prisma.user.findUniqueOrThrow({where:{id:f.members[1].userId!}});
  const otherActor: AppActor={kind:"user",user:other};
  const privateRow=await prisma.action.create({data:{workspaceId:f.workspaceId,authorUserId:other.id,
    title:"Private local ancestor",status:"DRAFT",isPrivate:true}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:otherActor,workspaceId:f.workspaceId,
    artifact:{kind:"Action",id:privateRow.id},content:privateRow,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const roots=await captureArtifactInputProof(otherActor,f.workspaceId,[{kind:"Action",id:privateRow.id}]);
  const hidden=await recordNewspaperDelivery({workspaceId:f.workspaceId,runKey:randomUUID(),kind:"MEMBER_NEWSPAPER",
    memberId:f.members[0].id,recipientEmail:"synthetic@example.test",subject:"Private ancestor copy",status:"SENT",actor:otherActor,lineageRoots:roots});
  const result=await captureReadableDigestInputs({actor:f.actor,workspaceId:f.workspaceId,kind:"NewspaperDelivery",records:[visible,hidden]});
  expect(result.records.map(row=>row.id)).toEqual([visible.id]);
});

it("confines raw permission metadata to the exact client, workspace and live callback",async()=>{
  const f=await fixture(), input={kind:"Member" as const,id:f.members[0].id};
  const {withArtifactPermissionMetadataRead,loadArtifactPermissionMetadata}=await import("./source-permission-parents");
  const rows=new Map([[JSON.stringify([input.kind,input.id]),f.members[0]]]);
  let release!:()=>void;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  let detached!:Promise<unknown>;
  await withArtifactPermissionMetadataRead(prisma,f.workspaceId,rows,async()=>{
    expect(await loadArtifactPermissionMetadata(prisma,f.workspaceId,input)).toMatchObject({id:input.id});
    await expect(loadArtifactPermissionMetadata(prisma,"foreign-workspace",input)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    await prisma.$transaction(async tx=>{
      await expect(loadArtifactPermissionMetadata(tx,f.workspaceId,input)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    });
    detached=ready.then(()=>loadArtifactPermissionMetadata(prisma,f.workspaceId,input));
  });
  const rejection=expect(detached).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  release();
  await rejection;
});
