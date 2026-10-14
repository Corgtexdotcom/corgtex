import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
const f = vi.hoisted(() => {
  const tables = new Map<string, Map<string, any>>(), delegates = new Map<string, any>(), epochs = new Map<string, bigint>();
  const memberships = new Set<string>();
  let serial = 0;
  const put = (table: string, row: any) => { if (!tables.has(table)) tables.set(table, new Map());
    const value={createdAt:new Date("2026-10-13T10:00:00Z"), ...row};tables.get(table)!.set(value.id,value);return value; };
  const matches = (row:any,where:any):boolean=>Object.entries(where??{}).every(([key,value]:[string,any])=>
    value && typeof value==="object" && "in" in value ? value.in.includes(row[key]) : row[key]===value);
  const base:any={$transaction:vi.fn(async(work:any)=>work(db)), $executeRaw:vi.fn(async()=>1),$queryRaw:vi.fn(async(query:any)=>{
    if (!query.sql?.includes('"SourcePermissionEpoch"')) return [];
    const values=query.values, workspaceId=values[0], result=[];
    for(let index=1;index<values.length;index+=2) result.push({sourceKind:values[index],sourceId:values[index+1],
      epoch:epochs.get(JSON.stringify([workspaceId,values[index],values[index+1]]))??0n});
    return result;
  })};
  const db:any=new Proxy(base,{get(target,key){if(key in target)return target[key];const table=String(key);
    if(!delegates.has(table))delegates.set(table,{
      findFirst:vi.fn(async({where,orderBy}:any)=>{const rows=[...(tables.get(table)?.values()??[])].filter(row=>matches(row,where));
        if(orderBy?.revision==="desc")rows.sort((a,b)=>b.revision-a.revision);return structuredClone(rows[0]??null);}),
      findUnique:vi.fn(async({where}:any)=>structuredClone([...(tables.get(table)?.values()??[])].find(row=>matches(row,where))??null)),
      findMany:vi.fn(async({where}:any)=>[...(tables.get(table)?.values()??[])].filter(row=>matches(row,where)).sort((a,b)=>(b.revision??0)-(a.revision??0)).map(row=>structuredClone(row))),
      create:vi.fn(async({data}:any)=>structuredClone(put(table,{id:`${table}-${++serial}`,...data}))),
    });return delegates.get(table);
  }});
  const client={auth:{test:vi.fn()},conversations:{info:vi.fn(),history:vi.fn(),replies:vi.fn()}};
  const authorize=vi.fn(async({actor,workspaceId}:any)=>{
    if(actor.kind!=="user"||!memberships.has(`${workspaceId}:${actor.user.id}`))throw new Error("Synthetic membership denied");
    return {id:`member-${actor.user.id}`,role:"MEMBER"};
  });
  return {tables,epochs,memberships,put,db,client,authorize};
});
vi.mock("@corgtex/shared",async original=>({...await original<typeof import("@corgtex/shared")>(),prisma:f.db,
  decryptSecret:(value:string)=>value.replace(/^enc:/,""),encryptSecret:(value:string)=>`enc:${value}`}));
vi.mock("../../shared/src/env",()=>({env:{ENCRYPTION_KEY:"a".repeat(64)}}));
vi.mock("./auth",()=>({requireWorkspaceMembership:f.authorize}));
vi.mock("./brain-access",()=>({resolveKnowledgeAccessDomains:vi.fn(async()=>["WORKSPACE"])}));
vi.mock("@slack/web-api",()=>({WebClient:class{auth=f.client.auth;conversations=f.client.conversations;}}));
import { captureSlackNativeMessageFetch } from "./communication-native-authority";
import { communicationCanonicalJson, communicationNativeHash } from "./communication-native-ingress";
import { artifactPermissionEpochIdentities, capturePermissionEpochs } from "./source-permission-epochs";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, preserveUnknownArtifactInputSnapshot,
  readableArtifactIds, recordArtifactInputLineage } from "./source-lineage";
const user=(id:string):AppActor=>({kind:"user",user:{id,email:`${id}@example.test`,displayName:id}});
const a=user("a"), b=user("b");
const target={workspaceId:"ws-a",installationId:"install-a",channelId:"C1",messageTs:"1700000000.000001"};
let remote:any;
beforeEach(()=>{
  vi.clearAllMocks();f.tables.clear();f.epochs.clear();f.memberships.clear();
  f.memberships.add("ws-a:a");f.memberships.add("ws-a:b");f.memberships.add("ws-b:b");
  remote={type:"message",ts:target.messageTs,user:"U_A",text:"SYNTHETIC original"};
  f.put("communicationInstallation",{id:"install-a",workspaceId:"ws-a",provider:"SLACK",externalWorkspaceId:"T1",appId:"A1",
    botUserId:"U_BOT",botTokenEnc:"enc:token",scopes:["channels:read","channels:history"],optionalScopes:[],settings:{},status:"ACTIVE",disconnectedAt:null});
  f.put("communicationChannel",{id:"channel-a",workspaceId:"ws-a",installationId:"install-a",provider:"SLACK",externalChannelId:"C1",kind:"PUBLIC",isIngestEnabled:true,isArchived:false});
  f.client.auth.test.mockResolvedValue({ok:true,team_id:"T1",user_id:"U_BOT"});
  f.client.conversations.info.mockResolvedValue({ok:true,channel:{id:"C1",is_private:false,is_member:true,is_archived:false}});
  f.client.conversations.history.mockImplementation(async()=>({ok:true,messages:[remote]}));
});
async function provenMessage(){
  const receipt=await captureSlackNativeMessageFetch(target);
  const message=f.put("communicationMessage",{id:"message-a",workspaceId:"ws-a",installationId:"install-a",provider:"SLACK",
    externalChannelId:"C1",externalMessageId:target.messageTs,externalUserId:"U_A",threadExternalId:null,text:remote.text,raw:receipt.projected,
    messageTs:new Date(Number(target.messageTs)*1000),receivedAt:new Date(Number(target.messageTs)*1000),updatedAt:new Date(),
    expiresRawAt:new Date(Date.now()+60000),isBot:false,isDeleted:false,isHidden:false,textRedactedAt:null,permalink:null});
  const epochs=await capturePermissionEpochs(f.db,"ws-a",artifactPermissionEpochIdentities("CommunicationMessage",message));
  const native=f.put("communicationMessageNativeInput",{id:"native-a",workspaceId:"ws-a",installationId:"install-a",communicationMessageId:message.id,
    provider:"SLACK",externalWorkspaceId:"T1",appId:"A1",providerPrincipalId:"U_BOT",externalChannelId:"C1",externalMessageId:target.messageTs,
    externalUserId:"U_A",threadExternalId:null,mode:"AUTHENTICATED_FETCH",ingressInputId:null,
    requestJson:{...receipt.request,messageContentFingerprint:lineageContentFingerprint("CommunicationMessage",message)},
    encryptedPayloadJson:`enc:${communicationCanonicalJson(receipt.payload)}`,projectedContentJson:receipt.projected,
    projectionHash:communicationNativeHash(communicationCanonicalJson(receipt.projected)),installationGrantHash:receipt.installationGrantHash,
    channelGrantHash:receipt.channelGrantHash,permissionEpochsJson:epochs,epochProofVersion:1,expiresRawAt:message.expiresRawAt,fetchedAt:new Date()});
  await recordArtifactInputLineage({tx:f.db,actor:a,workspaceId:"ws-a",artifact:{kind:"CommunicationMessage",id:message.id},content:message,
    origin:"DERIVED",inputs:[{kind:"CommunicationMessageNativeInput",id:native.id}]});
  const derived=f.put("contextGraphObject",{id:"graph-a",workspaceId:"ws-a",title:"SYNTHETIC copied",properties:{body:remote.text},archivedAt:null,updatedAt:new Date()});
  await recordArtifactInputLineage({tx:f.db,actor:a,workspaceId:"ws-a",artifact:{kind:"ContextGraphObject",id:derived.id},content:derived,
    origin:"DERIVED",inputs:[{kind:"CommunicationMessage",id:message.id}]});
  return {message,native,derived};
}
describe("real source helper Slack native lineage",()=>{
  it("withholds raw legacy messages and UNKNOWN preserved originals without consulting the provider",async()=>{
    const unknown=f.put("communicationMessage",{id:"legacy",workspaceId:"ws-a",installationId:"install-a",provider:"SLACK",externalChannelId:"C1",
      externalMessageId:target.messageTs,text:"UNKNOWN original",updatedAt:new Date()});
    expect(await readableArtifactIds(a,"ws-a","CommunicationMessage",[unknown],f.db)).toEqual(new Set());
    const snapshot=await preserveUnknownArtifactInputSnapshot(f.db,"ws-a",{kind:"CommunicationMessage",id:unknown.id},unknown);
    expect(snapshot.contentJson).toMatchObject({text:"UNKNOWN original"});
    expect(await isArtifactInputProofReadable(a,"ws-a",[{kind:"ArtifactInputSnapshot",id:snapshot.id,
      fingerprint:lineageContentFingerprint("ArtifactInputSnapshot",snapshot)}],f.db)).toBe(false);
    expect(f.client.auth.test).not.toHaveBeenCalled();
  });
  it("proves configured public inputs for two current users while withholding foreign workspace and unknown crowding",async()=>{
    const {message,derived}=await provenMessage();
    const unknown=f.put("communicationMessage",{...message,id:"legacy-top",text:"UNKNOWN crowding"});
    expect(await readableArtifactIds(b,"ws-a","CommunicationMessage",[unknown,message],f.db)).toEqual(new Set([message.id]));
    expect(await readableArtifactIds(b,"ws-a","ContextGraphObject",[derived],f.db)).toEqual(new Set([derived.id]));
    expect(await readableArtifactIds(b,"ws-b","CommunicationMessage",[message],f.db)).toEqual(new Set());
    const roots=await captureArtifactInputProof(a,"ws-a",[{kind:"CommunicationMessage",id:message.id}],f.db);
    f.memberships.delete("ws-a:a");await expect(isArtifactInputProofReadable(a,"ws-a",roots,f.db)).rejects.toThrow("Synthetic membership denied");
  });
  it.each(["provider-edit","metadata-edit","retention","private-restore"])("invalidates Message and descendants after %s",async(reason)=>{
    const {message,derived}=await provenMessage();
    if(reason==="provider-edit")remote={...remote,text:"SYNTHETIC edited"};
    if(reason==="metadata-edit")message.permalink="https://private.example.test/unproved";
    if(reason==="retention")message.expiresRawAt=new Date(Date.now()-1);
    if(reason==="private-restore"){
      const channel=f.tables.get("communicationChannel")!.get("channel-a");channel.kind="PRIVATE";
      f.epochs.set(JSON.stringify(["ws-a","CommunicationChannelPolicy",JSON.stringify(["install-a","C1"])]),1n);
      channel.kind="PUBLIC";
    }
    expect(await readableArtifactIds(a,"ws-a","CommunicationMessage",[message],f.db)).toEqual(new Set());
    expect(await readableArtifactIds(b,"ws-a","ContextGraphObject",[derived],f.db)).toEqual(new Set());
  });
});
