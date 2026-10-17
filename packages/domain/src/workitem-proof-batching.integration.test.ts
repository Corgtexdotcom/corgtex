import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma as db, mcpCredentialVersion, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, captureReadableWorkItemInputs, lineageContentFingerprint, recordArtifactInputLineage, withArtifactCountReleaseSnapshot } from "./source-lineage";
import { capturePermissionEpochs, isArtifactPermissionEpochProofCurrent, withArtifactPermissionBatchRead } from "./source-permission-epochs";
import { WorkItemReadRelease } from "./work-item-readable-page";
import { listActions, countActionsByStatus } from "./actions";

beforeEach(truncateAllTables);
async function fixture() {
  const workspace = await db.workspace.create({data:{name:"Batch authority",slug:randomUUID()}});
  const users = await Promise.all(["reader","other"].map(name => db.user.create({data:{email:`${name}-${randomUUID()}@batch.test`,passwordHash:"synthetic"}})));
  const members = await Promise.all(users.map(user => db.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}})));
  const actor: AppActor = {kind:"user",user:users[0]}, other: AppActor = {kind:"user",user:users[1]};
  async function original(title: string, privateInput = false) {
    const row = await db.action.create({data:{workspaceId:workspace.id,authorUserId:privateInput?users[1].id:users[0].id,title,bodyMd:"Exact original",isPrivate:privateInput,status:privateInput?"DRAFT":"OPEN"}});
    await db.$transaction(tx => recordArtifactInputLineage({tx,actor:privateInput?other:actor,workspaceId:workspace.id,artifact:{kind:"Action",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
    return row;
  }
  return {workspaceId:workspace.id,actor,other,members,original};
}
describe("bounded work item proof batches", () => {
  it("uses normal current evaluator for originals, private rows, unknown and derived fallbacks", async () => {
    const f=await fixture(), first=await f.original("Visible"), privateRow=await f.original("Private",true);
    const unknown=await db.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.actor.kind==="user"?f.actor.user.id:"",title:"Unknown",status:"OPEN",isPrivate:false}});
    const derived=await db.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.actor.kind==="user"?f.actor.user.id:"",title:"Derived",status:"OPEN",isPrivate:false}});
    await db.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id:derived.id},content:derived,origin:"DERIVED",inputs:[{kind:"Action",id:first.id}]}));
    const result=await captureReadableWorkItemInputs(f.actor,f.workspaceId,"Action",[first,privateRow,unknown,derived]);
    expect([...result.ids].sort()).toEqual([first.id,derived.id].sort());
    expect(result.heads.size).toBe(1);
    expect(await listActions(f.actor,f.workspaceId,{take:0})).toMatchObject({total:2,items:[]});
    expect(await countActionsByStatus(f.actor,f.workspaceId)).toMatchObject({OPEN:2,ALL:2});
  });
  it.each(["body","head","membership","circle"] as const)("retains original observations across %s changes and restore",async change=>{
    const f=await fixture();
    const circle=await db.circle.create({data:{workspaceId:f.workspaceId,name:"Current circle"}});
    const row=await f.original("Bound original");
    const target=await db.action.update({where:{id:row.id},data:{circleId:circle.id}});
    await db.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id:target.id},content:target,origin:"HUMAN_ORIGINAL",inputs:[]}));
    const release=new WorkItemReadRelease(f.actor,f.workspaceId);
    expect(await release.admit("Action",[target])).toHaveLength(1);
    if(change==="body") await db.action.update({where:{id:target.id},data:{bodyMd:"Changed after observation"}});
    if(change==="head") {
      const latest=await db.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspaceId,artifactType:"Action",artifactId:target.id},orderBy:{revision:"desc"}});
      await db.artifactInputLineage.create({data:{workspaceId:f.workspaceId,artifactType:"Action",artifactId:target.id,revision:latest.revision+1,
        origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint("Action",target),inputsJson:[],rootsJson:[]}});
    }
    if(change==="membership") {
      await db.member.update({where:{id:f.members[0].id},data:{isActive:false}});
      await db.member.update({where:{id:f.members[0].id},data:{isActive:true}});
    }
    if(change==="circle") {
      await db.circle.update({where:{id:circle.id},data:{archivedAt:new Date()}});
      await db.circle.update({where:{id:circle.id},data:{archivedAt:null}});
    }
    await expect(release.finish(1)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("freshly compares epochs after a same-transaction cache hit, including restore",async()=>{
    const f=await fixture(), row=await f.original("Epoch boundary");
    const proof=await db.$transaction(tx=>capturePermissionEpochs(tx,f.workspaceId,[{kind:"Action",id:row.id}]));
    await db.$transaction(async tx=>{
      const readable=await withArtifactPermissionBatchRead(tx,f.workspaceId,[proof],async()=>{
        expect(await isArtifactPermissionEpochProofCurrent(f.workspaceId,proof,tx)).toBe(true);
        await tx.action.update({where:{id:row.id},data:{archivedAt:new Date()}});
        await tx.action.update({where:{id:row.id},data:{archivedAt:null}});
        expect(await isArtifactPermissionEpochProofCurrent(f.workspaceId,proof,tx)).toBe(true);
        return true;
      });
      expect(readable).toBe(false);
    });
  });
  it("uses current scoped credentials and retains credential revoke/restore observations",async()=>{
    const f=await fixture(), row=await f.original("Scoped original"), privateRow=await f.original("Hidden",true);
    const credential=await db.agentCredential.create({data:{workspaceId:f.workspaceId,label:"Synthetic batch reader",tokenHash:randomUUID(),scopes:["actions:read"]}});
    const actor:AppActor={kind:"agent",authProvider:"credential",credentialId:credential.id,credentialVersion:mcpCredentialVersion(credential.tokenHash),
      label:credential.label,workspaceIds:[f.workspaceId],scopes:["actions:read"]};
    const release=new WorkItemReadRelease(actor,f.workspaceId);
    expect((await release.admit("Action",[row,privateRow])).map(value=>value.id)).toEqual([row.id]);
    expect(await listActions(actor,f.workspaceId,{take:0})).toMatchObject({total:1,items:[]});
    await db.agentCredential.update({where:{id:credential.id},data:{isActive:false}});
    await db.agentCredential.update({where:{id:credential.id},data:{isActive:true}});
    await expect(release.finish(1)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect((await captureReadableWorkItemInputs({...actor,scopes:["workspace:read"]},f.workspaceId,"Action",[row])).ids.size).toBe(0);
  });
  it("rejects detached epoch reuse after the pure read scope ends",async()=>{
    const f=await fixture(),row=await f.original("Scope lifetime");
    const proof=await db.$transaction(tx=>capturePermissionEpochs(tx,f.workspaceId,[{kind:"Action",id:row.id}]));
    let resume!:()=>void;
    const gate=new Promise<void>(resolve=>{resume=resolve;});
    let detached!:Promise<boolean>;
    expect(await withArtifactPermissionBatchRead(db,f.workspaceId,[proof],async()=>{
      detached=(async()=>{await gate;return isArtifactPermissionEpochProofCurrent(f.workspaceId,proof,db);})();
      return true;
    })).toBe(true);
    const denied=expect(detached).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    resume();
    await denied;
  });
  it("does not refresh inherited derived authority after native-free fallback",async()=>{
    const f=await fixture(), input=await f.original("Input");
    const derived=await db.action.create({data:{workspaceId:f.workspaceId,authorUserId:f.actor.kind==="user"?f.actor.user.id:"",title:"Derived",status:"OPEN",isPrivate:false}});
    await db.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind:"Action",id:derived.id},content:derived,origin:"DERIVED",inputs:[{kind:"Action",id:input.id}]}));
    const originalProof=await captureArtifactInputProof(f.actor,f.workspaceId,[{kind:"Action",id:derived.id}]);
    await db.action.update({where:{id:input.id},data:{archivedAt:new Date()}});
    await db.action.update({where:{id:input.id},data:{archivedAt:null}});
    const observed=await captureReadableWorkItemInputs(f.actor,f.workspaceId,"Action",[derived]);
    expect(observed.ids.size).toBe(0);
    await expect(withArtifactCountReleaseSnapshot(f.actor,f.workspaceId,originalProof,async()=>{},async()=>1)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
});
