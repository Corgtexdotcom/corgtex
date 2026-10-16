import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
const transactionProbe=vi.hoisted(()=>({after:undefined as undefined|(()=>Promise<void>)}));
vi.mock("@corgtex/shared",async importOriginal=>{
  const actual=await importOriginal<typeof import("@corgtex/shared")>();
  return {...actual,prisma:new Proxy(actual.prisma,{get(target,key){
    if(key!=="$transaction")return Reflect.get(target,key,target);
    return async(...args:any[])=>{
      const result=await (target.$transaction.bind(target) as (...args:any[])=>Promise<any>)(...args);
      await transactionProbe.after?.();return result;
    };
  }})};
});
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { capturePermissionEpochs } from "./source-permission-epochs";
import { captureArtifactInputProof, captureReadableWorkItemInputs, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import { serializeCrmDirectReadResult } from "./crm-direct-original-read";
import { readCrmSample, withCrmReadSnapshot } from "./crm-lineage";
import { createCrmAccount, createContact, createDeal, createActivity, getCrmAccount, getContact,
  listCrmAccounts, listContacts, listDeals, listCrmActivities } from "./crm";

beforeEach(truncateAllTables);
afterEach(()=>{transactionProbe.after=undefined;vi.restoreAllMocks();});
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"CRM page fixture",slug:randomUUID()}});
  const user=await prisma.user.create({data:{email:`crm-page-${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"CONTRIBUTOR"}});
  const actor:AppActor={kind:"user",user};
  return {workspaceId:workspace.id,actor,user,member};
}

// This functional case creates two 5,001-row cohorts and exercises multiple
// complete permission ledgers; allow hosted-runner variance without reducing assertions.
it("returns exact permission-aware totals and a deep page across5001 persisted readable accounts",async()=>{
  const f=await fixture(),now=new Date("2026-01-01T00:00:00Z");
  // Native synthetic originals use real epoch rows and content fingerprints;
  // batch fixture insertion avoids testing thousands of unrelated audit writes.
  for(let offset=0;offset<5001;offset+=100) {
    const ids=Array.from({length:Math.min(100,5001-offset)},(_,index)=>`account-${String(offset+index).padStart(6,"0")}`);
    await prisma.crmAccount.createMany({data:ids.map(id=>({id,workspaceId:f.workspaceId,name:id,slug:id,
      descriptionMd:"Synthetic account body ".repeat(100),updatedAt:now}))});
    const rows=await prisma.crmAccount.findMany({where:{id:{in:ids}}});
    await prisma.$transaction(async tx=>{
      const epochs=await capturePermissionEpochs(tx,f.workspaceId,[{kind:"Workspace",id:f.workspaceId},
        {kind:"MemberUserPolicy",id:f.user.id},{kind:"WorkspaceSupportPolicy",id:f.user.id},...ids.map(id=>({kind:"CrmAccount",id}))]);
      await tx.artifactInputLineage.createMany({data:rows.map(row=>({workspaceId:f.workspaceId,artifactType:"CrmAccount",artifactId:row.id,
        revision:1,origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint("CrmAccount",row),inputsJson:[],rootsJson:[],epochProofVersion:1,
        permissionEpochsJson:{...epochs,entries:epochs.entries.filter(entry=>entry.kind!=="CrmAccount"||entry.id===row.id)}}))});
    });
  }
  await prisma.crmAccount.create({data:{id:"zz-unknown-tail",workspaceId:f.workspaceId,name:"Unproven tail",slug:"unknown-tail",updatedAt:now}});
  const find=prisma.crmAccount.findMany.bind(prisma.crmAccount),sizes:number[]=[];
  vi.spyOn(prisma.crmAccount,"findMany").mockImplementation((async(args:Parameters<typeof find>[0])=>{
    const rows=await find(args);sizes.push(rows.length);return rows;
  }) as typeof prisma.crmAccount.findMany);
  const page=await listCrmAccounts(f.actor,f.workspaceId,{take:1,skip:5000});
  expect(page.total).toBe(5001);expect(page.items.map(row=>row.id)).toEqual(["account-005000"]);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  expect(page.items[0]._count).toEqual({contacts:0,deals:0,activities:0,crmConversations:0});
  const direct=await listCrmAccounts(f.actor,f.workspaceId,{take:1,skip:5000,archiveFilter:"all"});
  expect(direct.total).toBe(5001);expect(JSON.parse(await serializeCrmDirectReadResult(f.actor,direct)).total).toBe(5001);
  expect((await listCrmAccounts(f.actor,f.workspaceId,{take:0,archiveFilter:"all"})).items).toEqual([]);
  for(let offset=0;offset<5001;offset+=100) {
    const ids=Array.from({length:Math.min(100,5001-offset)},(_,index)=>`contact-${String(offset+index).padStart(6,"0")}`);
    await prisma.crmContact.createMany({data:ids.map(id=>({id,workspaceId:f.workspaceId,accountId:"account-000000",email:`${id}@example.test`}))});
    const rows=await prisma.crmContact.findMany({where:{id:{in:ids}}});
    await prisma.$transaction(async tx=>{
      const epochs=await capturePermissionEpochs(tx,f.workspaceId,[{kind:"Workspace",id:f.workspaceId},{kind:"CrmAccount",id:"account-000000"},
        {kind:"MemberUserPolicy",id:f.user.id},{kind:"WorkspaceSupportPolicy",id:f.user.id},...ids.map(id=>({kind:"CrmContact",id}))]);
      await tx.artifactInputLineage.createMany({data:rows.map(row=>({workspaceId:f.workspaceId,artifactType:"CrmContact",artifactId:row.id,
        revision:1,origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint("CrmContact",row),inputsJson:[],rootsJson:[],epochProofVersion:1,
        permissionEpochsJson:{...epochs,entries:epochs.entries.filter(entry=>entry.kind!=="CrmContact"||entry.id===row.id)}}))});
    });
  }
  const linked=await listContacts(f.actor,f.workspaceId,{take:1,skip:5000,accountId:"account-000000"});
  expect(linked.total).toBe(5001);expect(linked.items).toHaveLength(1);

},120000);

it.each(["body","head","revoke-restore"] as const)("retains off-page count observations across %s changes",async change=>{
  const f=await fixture();
  const accounts:Awaited<ReturnType<typeof createCrmAccount>>[]=[];
  for(let index=0;index<3;index++) accounts.push(await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:`Account ${index}`}));
  await expect(withCrmReadSnapshot(f.actor,f.workspaceId,async()=>{
    const page=await listCrmAccounts(f.actor,f.workspaceId,{take:1});
    const omitted=accounts.find(row=>row.id!==page.items[0].id)!;
    if(change==="body")await prisma.crmAccount.update({where:{id:omitted.id},data:{descriptionMd:"Changed count contributor"}});
    if(change==="head") {
      const head=await prisma.artifactInputLineage.findFirstOrThrow({where:{artifactType:"CrmAccount",artifactId:omitted.id},orderBy:{revision:"desc"}});
      await prisma.artifactInputLineage.create({data:{workspaceId:f.workspaceId,artifactType:"CrmAccount",artifactId:omitted.id,
        revision:head.revision+1,origin:"HUMAN_ORIGINAL",contentHash:head.contentHash,inputsJson:[],rootsJson:[],
        epochProofVersion:head.epochProofVersion,permissionEpochsJson:head.permissionEpochsJson as never}});
    }
    if(change==="revoke-restore") {
      await prisma.member.update({where:{id:f.member.id},data:{isActive:false}});
      await prisma.member.update({where:{id:f.member.id},data:{isActive:true}});
    }
    return page;
  })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it("shares account/contact detail receipts with linked counts, labels and selected tasks",async()=>{
  const f=await fixture(),account=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Linked account"});
  const contact=await createContact(f.actor,{workspaceId:f.workspaceId,accountId:account.id,email:"contact@example.test"});
  const deal=await createDeal(f.actor,{workspaceId:f.workspaceId,contactId:contact.id,title:"Linked deal"});
  const task=await createActivity(f.actor,{workspaceId:f.workspaceId,accountId:account.id,contactId:contact.id,dealId:deal.id,type:"TASK",title:"Next task"});
  expect((await getCrmAccount(f.actor,{workspaceId:f.workspaceId,accountId:account.id})).contacts.map(row=>row.id)).toEqual([contact.id]);
  expect((await getContact(f.actor,{workspaceId:f.workspaceId,contactId:contact.id})).deals.map(row=>row.id)).toEqual([deal.id]);
  expect((await listContacts(f.actor,f.workspaceId)).items[0]._count).toEqual({deals:1,activities:1});
  expect((await listDeals(f.actor,f.workspaceId)).items[0].activities.map(row=>row.id)).toEqual([task.id]);
  await expect(withCrmReadSnapshot(f.actor,f.workspaceId,async()=>{
    const detail=await getContact(f.actor,{workspaceId:f.workspaceId,contactId:contact.id});
    await prisma.crmAccount.update({where:{id:account.id},data:{name:"Changed label after nested reads"}});
    return detail;
  })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it("omits private derived and foreign records before counts and preserves deep page replenishment",async()=>{
  const f=await fixture();
  const other=await prisma.user.create({data:{email:`private-${randomUUID()}@example.test`,passwordHash:"synthetic"}});
  await prisma.member.create({data:{workspaceId:f.workspaceId,userId:other.id,role:"CONTRIBUTOR"}});
  const otherActor:AppActor={kind:"user",user:other};
  const action=await prisma.action.create({data:{workspaceId:f.workspaceId,authorUserId:other.id,title:"Private input",status:"DRAFT",isPrivate:true}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:otherActor,workspaceId:f.workspaceId,
    artifact:{kind:"Action",id:action.id},content:action,origin:"HUMAN_ORIGINAL",inputs:[]}));
  await createCrmAccount(otherActor,{workspaceId:f.workspaceId,name:"Private derived account",lineageInputs:[{kind:"Action",id:action.id}]});
  const visible=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Visible account"});
  const foreign=await prisma.workspace.create({data:{name:"Foreign",slug:randomUUID()}});
  await prisma.crmAccount.create({data:{workspaceId:foreign.id,name:"Foreign body",slug:"foreign"}});
  const page=await listCrmAccounts(f.actor,f.workspaceId,{take:1});
  expect(page.total).toBe(1);expect(page.items[0].id).toBe(visible.id);
  expect((await listCrmActivities(f.actor,f.workspaceId,{take:0})).total).toBe(0);
});

it("matches ordinary captured permission vectors for the complete local CRM parent closure",async()=>{
  const f=await fixture(),account=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Account"});
  const contact=await createContact(f.actor,{workspaceId:f.workspaceId,accountId:account.id,email:"proof@example.test"});
  const deal=await createDeal(f.actor,{workspaceId:f.workspaceId,contactId:contact.id,title:"Deal"});
  const activity=await createActivity(f.actor,{workspaceId:f.workspaceId,dealId:deal.id,type:"TASK",title:"Activity"});
  for(const [kind,record] of [["CrmContact",contact],["CrmDeal",deal],["CrmActivity",activity]] as const)
    await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,artifact:{kind,id:record.id},content:record,origin:"HUMAN_ORIGINAL",inputs:[]}));
  for(const [kind,record] of [["CrmContact",contact],["CrmDeal",deal],["CrmActivity",activity]] as const) {
    const captured=await captureReadableWorkItemInputs(f.actor,f.workspaceId,kind,[record]);
    const ordinary=await captureArtifactInputProof(f.actor,f.workspaceId,[{kind,id:record.id,snapshot:record}]);
    expect(captured.roots).toEqual(ordinary);
    expect(captured.heads.has(JSON.stringify(["CrmAccount",account.id]))).toBe(true);
  }
});

it.each(["body","head","archive-restore"] as const)("retains linked ancestor observations across %s changes",async change=>{
  const f=await fixture(),account=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Parent"});
  await createContact(f.actor,{workspaceId:f.workspaceId,accountId:account.id,email:"ancestor@example.test"});
  await expect(withCrmReadSnapshot(f.actor,f.workspaceId,async()=>{
    const result=await listContacts(f.actor,f.workspaceId,{take:0});
    expect(result.total).toBe(1);
    if(change==="body")await prisma.crmAccount.update({where:{id:account.id},data:{name:"Changed parent"}});
    if(change==="head") {
      const {id:_,recordedAt:__,...head}=await prisma.artifactInputLineage.findFirstOrThrow({where:{artifactType:"CrmAccount",artifactId:account.id},orderBy:{revision:"desc"}});
      await prisma.artifactInputLineage.create({data:{...head,revision:head.revision+1,inputsJson:head.inputsJson as never,rootsJson:head.rootsJson as never,permissionEpochsJson:head.permissionEpochsJson as never}});
    }
    if(change==="archive-restore") {
      await prisma.crmAccount.update({where:{id:account.id},data:{archivedAt:new Date()}});
      await prisma.crmAccount.update({where:{id:account.id},data:{archivedAt:null}});
    }
    return result;
  })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it.each(["body","head","projection"] as const)("checks original count contributors and presentation again at serialization after %s changes",async change=>{
  const f=await fixture();
  const first=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"First"});
  const second=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Second"});
  const result=await listCrmAccounts(f.actor,f.workspaceId,{archiveFilter:"all",take:1});
  expect(result.total).toBe(2);expect(JSON.parse(await serializeCrmDirectReadResult(f.actor,result)).total).toBe(2);
  const omitted=result.items[0].id===first.id?second:first;
  if(change==="body")await prisma.crmAccount.update({where:{id:omitted.id},data:{name:"Changed offpage body"}});
  if(change==="head") {
    const {id:_,recordedAt:__,...head}=await prisma.artifactInputLineage.findFirstOrThrow({where:{artifactType:"CrmAccount",artifactId:omitted.id},orderBy:{revision:"desc"}});
    await prisma.artifactInputLineage.create({data:{...head,revision:head.revision+1,inputsJson:head.inputsJson as never,rootsJson:head.rootsJson as never,permissionEpochsJson:head.permissionEpochsJson as never}});
  }
  if(change==="projection")result.items[0].name="Forged body";
  await expect(serializeCrmDirectReadResult(f.actor,result)).rejects.toMatchObject({code:change==="projection"?"UNKNOWN_LINEAGE":"SOURCE_CHANGED"});
});

it("matches fresh ordinary admission when original target or permission-parent head epochs are historical",async()=>{
  const f=await fixture(),account=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Parent"});
  const first=await createContact(f.actor,{workspaceId:f.workspaceId,accountId:account.id,email:"first@example.test"});
  const second=await createContact(f.actor,{workspaceId:f.workspaceId,email:"second@example.test"});
  for(const record of [first,second]) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"CrmContact",id:record.id},content:record,origin:"HUMAN_ORIGINAL",inputs:[]}));
  await prisma.crmContact.update({where:{id:first.id},data:{archivedAt:new Date()}});
  await prisma.crmContact.update({where:{id:first.id},data:{archivedAt:null,updatedAt:first.updatedAt}});
  await prisma.crmAccount.update({where:{id:account.id},data:{archivedAt:new Date()}});
  await prisma.crmAccount.update({where:{id:account.id},data:{archivedAt:null,updatedAt:account.updatedAt}});
  const rows=await prisma.crmContact.findMany({where:{id:{in:[first.id,second.id]}}});
  const captured=await captureReadableWorkItemInputs(f.actor,f.workspaceId,"CrmContact",rows);
  const ordinary=await captureArtifactInputProof(f.actor,f.workspaceId,rows.map(row=>({kind:"CrmContact",id:row.id,snapshot:row})));
  expect(captured.roots).toEqual(ordinary);expect(captured.ids.size).toBe(2);
  await prisma.crmAccount.update({where:{id:account.id},data:{archivedAt:new Date()}});
  const page=await listContacts(f.actor,f.workspaceId,{take:1});
  expect(page.total).toBe(1);expect(page.items[0].id).toBe(second.id);
});

it("rejects a selected sample that loses permission between discovery and proof capture",async()=>{
  const f=await fixture();
  const contact=await createContact(f.actor,{workspaceId:f.workspaceId,email:"sample@example.test",accountId:null});
  const find=prisma.crmContact.findMany.bind(prisma.crmContact);
  vi.spyOn(prisma.crmContact,"findMany").mockImplementationOnce((async(args:Parameters<typeof find>[0])=>{
    await prisma.crmContact.update({where:{id:contact.id},data:{archivedAt:new Date()}});
    return find(args);
  }) as typeof prisma.crmContact.findMany);
  await expect(withCrmReadSnapshot(f.actor,f.workspaceId,()=>readCrmSample(f.actor,f.workspaceId,"CrmContact",async()=>[contact],1)))
    .rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it("retains actual linked ancestor fences on direct original presentations",async()=>{
  const f=await fixture(),account=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Direct parent"});
  const activity=await prisma.crmActivity.create({data:{workspaceId:f.workspaceId,accountId:account.id,type:"NOTE",title:"Independent original"}});
  await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspaceId,
    artifact:{kind:"CrmActivity",id:activity.id},content:activity,origin:"HUMAN_ORIGINAL",inputs:[]}));
  const result=await listCrmActivities(f.actor,f.workspaceId,{archiveFilter:"all"});
  expect(result.total).toBe(1);
  await prisma.crmAccount.update({where:{id:account.id},data:{name:"Changed linked parent"}});
  await expect(serializeCrmDirectReadResult(f.actor,result)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});

it("does not overwrite an original head observed before a derived fallback reads it",async()=>{
  const f=await fixture(),original=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Original"});
  const roots=await captureArtifactInputProof(f.actor,f.workspaceId,[{kind:"CrmAccount",id:original.id}]);
  const derived=await createCrmAccount(f.actor,{workspaceId:f.workspaceId,name:"Derived",lineageRoots:roots});
  let completed=0;
  transactionProbe.after=async()=>{
    if(++completed===2) {
      const {id:_,recordedAt:__,...head}=await prisma.artifactInputLineage.findFirstOrThrow({where:{artifactType:"CrmAccount",artifactId:original.id},orderBy:{revision:"desc"}});
      await prisma.artifactInputLineage.create({data:{...head,revision:head.revision+1,inputsJson:head.inputsJson as never,rootsJson:head.rootsJson as never,permissionEpochsJson:head.permissionEpochsJson as never}});
    }
  };
  await expect(captureReadableWorkItemInputs(f.actor,f.workspaceId,"CrmAccount",[original,derived])).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
