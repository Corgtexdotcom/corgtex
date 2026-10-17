import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { capturePermissionEpochs } from "./source-permission-epochs";
import { lineageContentFingerprint } from "./source-lineage";
import { scanSourceReadableRecords } from "./source-scoped-read";
import { readCrmPage, withCrmReadSnapshot } from "./crm-lineage";
const workspaceIds: string[] = [], userIds: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for(const id of workspaceIds.splice(0)) await prisma.workspace.delete({where:{id}});
  for(const id of userIds.splice(0)) await prisma.user.delete({where:{id}});
});
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic scan snapshot",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`${randomUUID()}@scan.test`,passwordHash:"synthetic"}});
  workspaceIds.push(workspace.id);userIds.push(user.id);
  await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN"}});
  const actor:AppActor={kind:"user",user};
  async function seed(kind:"Document"|"CrmAccount",ids:string[]) {
    if(kind==="Document") await prisma.document.createMany({data:ids.map(id=>({id,workspaceId:workspace.id,title:id,source:"UPLOAD",storageKey:`workspaces/${workspace.id}/uploads/${id}/fixture.txt`,textContent:"Original"}))});
    else await prisma.crmAccount.createMany({data:ids.map(id=>({id,workspaceId:workspace.id,name:id,slug:id}))});
    const rows=kind==="Document"?await prisma.document.findMany({where:{id:{in:ids}}}):await prisma.crmAccount.findMany({where:{id:{in:ids}}});
    await prisma.$transaction(async tx=>{
      const epochs=await capturePermissionEpochs(tx,workspace.id,[{kind:"Workspace",id:workspace.id},{kind:"MemberUserPolicy",id:user.id},{kind:"WorkspaceSupportPolicy",id:user.id},...ids.map(id=>({kind,id}))]);
      await tx.artifactInputLineage.createMany({data:rows.map(row=>({workspaceId:workspace.id,artifactType:kind,artifactId:row.id,
        revision:1,origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint(kind,row),inputsJson:[],rootsJson:[],epochProofVersion:1,
        permissionEpochsJson:{...epochs,entries:epochs.entries.filter(entry=>entry.kind!==kind||entry.id===row.id)}}))});
    });
  }
  return{workspaceId:workspace.id,actor,seed};
}
it("keeps a source enumeration coherent when records are inserted on both sides of its former page cursor",async()=>{
  const f=await fixture(),ids=Array.from({length:150},(_,i)=>`${f.workspaceId}-m-${String(i).padStart(3,"0")}`);
  await f.seed("Document",ids);
  let calls=0;
  const result=await scanSourceReadableRecords({actor:f.actor,workspaceId:f.workspaceId,kind:"Document",load:async(afterId,take)=>{
    const rows=await prisma.document.findMany({where:{workspaceId:f.workspaceId,...(afterId?{id:{gt:afterId}}:{})},orderBy:{id:"asc"},take});
    if(++calls===1) await f.seed("Document",[`${f.workspaceId}-a-new`,`${f.workspaceId}-z-new`]);
    return rows;
  }});
  expect(result.map(row=>row.id)).toEqual(ids);expect(calls).toBe(1);
  expect(await prisma.document.count({where:{workspaceId:f.workspaceId}})).toBe(152);
});
it("keeps CRM exact totals and selected detail in one candidate statement across insertion",async()=>{
  const f=await fixture(),ids=Array.from({length:150},(_,i)=>`${f.workspaceId}-m-${String(i).padStart(3,"0")}`);
  await f.seed("CrmAccount",ids);
  let calls=0;
  const result=await withCrmReadSnapshot(f.actor,f.workspaceId,()=>readCrmPage(f.actor,f.workspaceId,"CrmAccount",async page=>{
    const rows=await prisma.crmAccount.findMany({where:{workspaceId:f.workspaceId},orderBy:{id:"asc"},...page});
    if(++calls===1)await f.seed("CrmAccount",[`${f.workspaceId}-a-new`,`${f.workspaceId}-z-new`]);
    return rows;
  },{take:1,skip:149}));
  expect(result.total).toBe(150);expect(result.items.map(row=>row.id)).toEqual([ids[149]]);expect(calls).toBe(1);
  expect(await prisma.crmAccount.count({where:{workspaceId:f.workspaceId}})).toBe(152);
});
it("rejects raw over-limit unknown source and CRM cohorts without admitting partial exact results",async()=>{
  const f=await fixture();
  await prisma.document.createMany({data:Array.from({length:5001},(_,i)=>({id:`${f.workspaceId}-doc-${i}`,workspaceId:f.workspaceId,title:"Unknown",source:"UPLOAD",storageKey:`workspaces/${f.workspaceId}/uploads/${i}/fixture.txt`}))});
  await prisma.crmAccount.createMany({data:Array.from({length:10001},(_,i)=>({id:`${f.workspaceId}-crm-${i}`,workspaceId:f.workspaceId,name:"Unknown",slug:`unknown-${i}`}))});
  const source=vi.fn(async(after:string|undefined,take:number)=>prisma.document.findMany({where:{workspaceId:f.workspaceId,...(after?{id:{gt:after}}:{})},orderBy:{id:"asc"},take}));
  await expect(scanSourceReadableRecords({actor:f.actor,workspaceId:f.workspaceId,kind:"Document",load:source})).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
  const crm=vi.fn(async(page:{take:number})=>prisma.crmAccount.findMany({where:{workspaceId:f.workspaceId},orderBy:{id:"asc"},...page}));
  await expect(withCrmReadSnapshot(f.actor,f.workspaceId,()=>readCrmPage(f.actor,f.workspaceId,"CrmAccount",crm,{take:1}))).rejects.toMatchObject({code:"SOURCE_READ_SCAN_LIMIT"});
  expect(source).toHaveBeenCalledTimes(1);expect(crm).toHaveBeenCalledTimes(1);
});
