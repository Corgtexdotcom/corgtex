import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import type { Prisma } from "@prisma/client";
import { discoverAmbientSourceAuthority, discoverSourceAuthorityEdges, loadSourceAuthorityRecord, sourceAuthorityPhysicalRow,
  SOURCE_AUTHORITY_REGISTRY, SOURCE_AUTHORITY_TABLES, type SourceAuthorityBudget } from "./source-authority-edges";

const actor: AppActor={kind:"user",user:{id:"owner",email:"owner@example.test",displayName:"Owner"}};
const tables:Record<string,any[]>={};
let db:Prisma.TransactionClient;
const queries: Array<{table:string;where:any;take:number}> = [];
function freshBudget(max=1000):SourceAuthorityBudget {
  const keys=new Set<string>();return {consume(key){if(keys.has(key))return;if(keys.size>=max)throw Object.assign(new Error("Budget"),{code:"SOURCE_LOCK_LIMIT"});keys.add(key);},remaining(){return max-keys.size;}};
}
function context(budget=freshBudget()){return {actor,workspaceId:"ws",db,budget};}
async function edges(kind: keyof typeof SOURCE_AUTHORITY_REGISTRY,content:Record<string,unknown>,budget=freshBudget()){
  return discoverSourceAuthorityEdges(context(budget),{kind,id:"input"},{id:"input",workspaceId:"ws",...content});
}
beforeEach(()=>{
  queries.length=0;
  const store:any={$queryRaw:vi.fn(async()=>[])};
  for(const table of SOURCE_AUTHORITY_TABLES){tables[table]=[];const name=table[0].toLowerCase()+table.slice(1);
    const matches=(row:any,where:any):boolean=>Object.entries(where??{}).every(([key,value]:[string,any])=>{
      const parents:Record<string,string>={role:"Role",circle:"Circle",member:"Member",agentRun:"AgentRun",article:"BrainArticle"};
      if(value&&typeof value==="object"&&parents[key])return matches(tables[parents[key]].find(parent=>parent.id===row[key+"Id"]),value);
      return row?.[key]===value;
    });
    store[name]={findMany:vi.fn(async(args:any)=>{queries.push({table,where:args.where,take:args.take});return tables[table].filter(row=>matches(row,args.where)).slice(0,args.take);}),
      findFirst:vi.fn(async(args:any)=>{const order=Array.isArray(args.orderBy)?args.orderBy:[args.orderBy??{}];
        const found=tables[table].filter(row=>matches(row,args.where)).sort((a,b)=>{for(const field of order){const key=Object.keys(field)[0];if(key&&a[key]!==b[key])return (a[key]>b[key]?1:-1)*(field[key]==="desc"?-1:1);}return 0;});return found[0]??null;})};
  }
  db=store;
});

describe("closed source authority edge registry",()=>{
  it("maps typed projections to their exact physical rows and has no arbitrary table fallback",()=>{
    for(const [kind,table] of [["MeetingTranscript","Meeting"],["MeetingAgenda","Meeting"],["WorkspaceToolLinkCredential","WorkspaceToolLink"],
      ["WorkflowJobInput","WorkflowJob"],["CrmQualificationEmailInput","CrmQualification"],["DemoLeadIntakeInput","DemoLead"],["ModelUsageCost","ModelUsage"]] as const)
      expect(sourceAuthorityPhysicalRow({kind,id:"id"})).toEqual({table,id:"id"});
    expect(sourceAuthorityPhysicalRow({kind:"ExternalMcpConnectionSet",id:"owner"})).toBeNull();
    expect(()=>sourceAuthorityPhysicalRow({kind:"NotARegisteredSource" as any,id:"id"})).toThrow();
    expect(()=>sourceAuthorityPhysicalRow({kind:"__proto__" as any,id:"id"})).toThrow();
  });
  it("uses immutable snapshot source governors without inventing a mutable snapshot epoch",async()=>{
    const result=await edges("ArtifactInputSnapshot",{sourceKind:"Action",sourceId:"old-action",sourceFingerprint:"a".repeat(64)});
    expect(result.artifacts).toEqual([{kind:"Action",id:"old-action"}]);
    expect(result.policies).toEqual([]);
    expect(result.policies.some(policy=>policy.kind==="ArtifactInputSnapshot")).toBe(false);
  });
  it("loads relation-scoped records and native projection fields without a DMMF loader",async()=>{
    tables.Meeting=[{id:"meeting",workspaceId:"ws",transcript:"Exact raw original"}];
    expect(await loadSourceAuthorityRecord(db,"foreign",{kind:"MeetingTranscript",id:"meeting"})).toBeNull();
    expect(await loadSourceAuthorityRecord(db,"ws",{kind:"MeetingTranscript",id:"meeting"})).toMatchObject({id:"meeting"});
    expect((db as any).meeting.findFirst.mock.calls.at(-1)[0].select).toMatchObject({transcript:true,createdAt:true,archivedAt:true});
  });
  it("discovers every JSON variant target/source identity and refuses malformed or unsupported targets",async()=>{
    const result=await edges("GenericDerivedArtifactVariant",{targetsJson:[{kind:"ContextGraphObject",id:"object",manifestId:"manifest",fingerprint:"a".repeat(64)}],
      scopeJson:{sources:[{kind:"Document",id:"doc",fingerprint:"b".repeat(64)}]}});
    expect(result.artifacts).toEqual(expect.arrayContaining([{kind:"ContextGraphObject",id:"object"},{kind:"Document",id:"doc"}]));
    await expect(edges("GenericDerivedArtifactVariant",{targetsJson:[{kind:"Goal",id:"goal",manifestId:"manifest",fingerprint:"a".repeat(64)}],scopeJson:{sources:[{kind:"Document",id:"doc",fingerprint:"b".repeat(64)}]}})).rejects.toMatchObject({code:"SOURCE_LOCK_UNSUPPORTED"});
  });
  it("captures the audio native-input lookup as an absence-sensitive predicate",async()=>{
    tables.NativeTranscriptInput=[{id:"native",workspaceId:"ws",mode:"AUDIO_UPLOAD",meetingAudioAssetId:"input"}];
    const result=await edges("MeetingAudioAsset",{});
    expect(result.artifacts).toContainEqual({kind:"NativeTranscriptInput",id:"native"});
    expect(result.predicates).toContainEqual(expect.objectContaining({key:"audio-native:input",ids:["native"]}));
    tables.NativeTranscriptInput=[];await expect(edges("MeetingAudioAsset",{})).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("covers feedback run, step and original immutable snapshot without recapturing it",async()=>{
    const result=await edges("AgentFeedbackInput",{agentRunId:"run",stepId:"step",priorRunSnapshotId:"old-snapshot"});
    expect(result.artifacts).toEqual(expect.arrayContaining([{kind:"AgentRun",id:"run"},{kind:"AgentStep",id:"step"},{kind:"ArtifactInputSnapshot",id:"old-snapshot"}]));
    await expect(edges("AgentFeedbackInput",{agentRunId:"run",stepId:"step"})).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("covers native Finance upload lookup and every governed batch/source binding",async()=>{
    tables.FinanceReportUploadInput=[{id:"upload",workspaceId:"ws",batchId:"input"}];
    expect((await edges("FinanceImportBatch",{})).artifacts).toContainEqual({kind:"FinanceReportUploadInput",id:"upload"});
    expect((await edges("FinanceReportUploadInput",{batchId:"batch",documentId:"doc",brainSourceId:"source"})).artifacts)
      .toEqual(expect.arrayContaining([{kind:"FinanceImportBatch",id:"batch"},{kind:"Document",id:"doc"},{kind:"BrainSource",id:"source"}]));
  });
  it("locks the live Finance Fact only as control and retains immutable revision parents", async () => {
    tables.FinanceReportFact = [{id: "fact", workspaceId: "ws", kind: "LEAF", reportId: "new-report"}];
    const result = await edges("FinanceReportFactRevision", {factId: "fact", kind: "LEAF", reportId: "original-report", sourceBatchId: "batch", sourceCandidateId: "candidate"});
    expect(result.rows).toContainEqual({table: "FinanceReportFact", id: "fact"});
    expect(result.artifacts).toEqual(expect.arrayContaining([{kind: "FinanceReport", id: "original-report"}, {kind: "FinanceImportBatch", id: "batch"}, {kind: "FinanceImportCandidate", id: "candidate"}]));
    expect(result.artifacts.some(root => root.kind === "FinanceReportFact")).toBe(false);
    expect(result.policies).toContainEqual({kind: "FinanceReportFactLifecycle", id: "fact"});
    tables.FinanceReportFact = [];
    await expect(edges("FinanceReportFactRevision", {factId: "fact", kind: "LEAF", reportId: "original-report", sourceBatchId: "batch", sourceCandidateId: "candidate"})).rejects.toMatchObject({code: "SOURCE_LOCK_INCOMPLETE"});
  });
  it("covers Advice recipients and circle-role predicate including currently absent recipients",async()=>{
    tables.Member=[{id:"member",workspaceId:"ws",userId:"owner"}];tables.Circle=[{id:"circle",workspaceId:"ws"}];
    tables.Role=[{id:"role",circleId:"circle"}];tables.RoleAssignment=[{id:"assignment",memberId:"member",roleId:"role"}];
    const result=await edges("AdviceRequest",{audienceType:"CIRCLE",targetCircleId:"circle"});
    expect(result.artifacts).toContainEqual({kind:"RoleAssignment",id:"assignment"});
    expect(result.predicates).toContainEqual(expect.objectContaining({key:"advice-recipients:input",ids:[]}));
    expect(result.policies).toEqual(expect.arrayContaining([{kind:"AdviceRequestRecipientsPolicy",id:"input"},{kind:"CircleRolePolicy",id:"circle"}]));
  });
  it("covers Slack installation/channel/message/integration and leaves unsupported providers unavailable",async()=>{
    tables.CommunicationInstallation=[{id:"install",workspaceId:"ws"}];tables.CommunicationChannel=[{id:"channel",workspaceId:"ws",installationId:"install",externalChannelId:"C1"}];
    const result=await edges("CommunicationMessageNativeInput",{provider:"SLACK",mode:"AUTHENTICATED_FETCH",installationId:"install",externalChannelId:"C1",communicationMessageId:"message"});
    expect(result.rows).toContainEqual({table:"CommunicationInstallation",id:"install"});
    expect(result.artifacts).toContainEqual({kind:"CommunicationMessage",id:"message"});
    expect(result.policies).toContainEqual({kind:"CommunicationChannelPolicy",id:'["install","C1"]'});
    expect(result.predicates).toContainEqual(expect.objectContaining({key:"integration:SLACK",ids:[]}));
    await expect(edges("CommunicationMessageNativeInput",{provider:"TEAMS",mode:"AUTHENTICATED_FETCH",installationId:"install",externalChannelId:"C1",communicationMessageId:"message"})).rejects.toMatchObject({code:"SOURCE_LOCK_UNSUPPORTED"});
  });
  it("covers Box source/connection/principal and the native connection-set absence policy",async()=>{
    tables.ExternalMcpConnection=[{id:"connection",workspaceId:"ws",userId:"owner"}];tables.Member=[{id:"member",workspaceId:"ws",userId:"owner"}];
    const result=await edges("ExternalProviderFetchInput",{connectionId:"connection",providerKey:"box",localUserId:"owner",externalContentSourceId:"selection"});
    expect(result.rows).toContainEqual({table:"ExternalContentSource",id:"selection",mode:"UPDATE"});
    expect(result.artifacts).toContainEqual({kind:"ExternalContentSource",id:"selection"});expect(result.rows).toContainEqual({table:"ExternalMcpConnection",id:"connection"});
    const set=await discoverSourceAuthorityEdges(context(),{kind:"ExternalMcpConnectionSet",id:"owner"},{id:"owner",workspaceId:"ws",localUserId:"owner"});
    expect(set.policies).toContainEqual({kind:"ExternalMcpConnectionSetPolicy",id:"owner"});
    expect(set.predicates).toContainEqual(expect.objectContaining({key:"external-connection-set:owner",ids:["connection"]}));
  });
  it("discovers a standing public note's historical old snapshot without raw request/body/credential grants",async()=>{
    const {lineageContentFingerprint}=await import("./source-lineage");
    const snapshot={id:"old-action",workspaceId:"ws",sourceKind:"Action",sourceId:"action",sourceFingerprint:"a".repeat(64),
      origin:"HUMAN_ORIGINAL",contentJson:{title:"Stored original"},accessEnvelopeJson:{isPrivate:false},rootsJson:[],epochProofVersion:1,permissionEpochsJson:{}};
    const snapshotFingerprint=lineageContentFingerprint("ArtifactInputSnapshot",snapshot);
    const control={version:1,publicationPolicyVersion:1,audience:"ACTION_READERS",actionId:"action",actionVersion:1,completedAt:"2026-10-13T00:00:00Z",
      assigneeMemberId:"old-assignee",completedVia:"Published note",completedViaHash:"b".repeat(64),controlHash:"c".repeat(64),inputId:"raw-input",inputFingerprint:"d".repeat(64),
      oldActionSnapshotId:snapshot.id,oldActionSnapshotFingerprint:snapshotFingerprint,publishedActionRevision:2,completedActionFingerprint:"e".repeat(64)};
    const note={id:"input",workspaceId:"ws",operation:"ACTION_COMPLETION_PUBLIC_NOTE",actorKind:"public",userId:null,credentialId:null,credentialVersion:null,scopeHash:null,requiredScopes:[],controlJson:control};
    tables.Action=[{id:"action",workspaceId:"ws",status:"OPEN"}];tables.McpToolInput=[{id:"raw-input",workspaceId:"ws",actorKind:"agent",credentialId:"revoked-private-credential",argumentsJson:"PRIVATE ENCRYPTED REQUEST"}];
    tables.ArtifactInputSnapshot=[snapshot];
    tables.ArtifactInputLineage=[{id:"historic-completion",workspaceId:"ws",artifactType:"Action",artifactId:"action",revision:2,origin:"DERIVED",contentHash:control.completedActionFingerprint,
      rootsJson:[{kind:"ConversationOperationOutcome",id:note.id,fingerprint:lineageContentFingerprint("ConversationOperationOutcome",note)},
        {kind:"ArtifactInputSnapshot",id:snapshot.id,fingerprint:snapshotFingerprint}]},
      {id:"later-reopen",workspaceId:"ws",artifactType:"Action",artifactId:"action",revision:3,origin:"DERIVED",rootsJson:[],contentHash:"f".repeat(64)}];
    const result=await edges("ConversationOperationOutcome",note);
    expect(result.consumedArtifacts).toEqual([{kind:"ArtifactInputSnapshot",id:snapshot.id,fingerprint:snapshotFingerprint}]);
    expect(result.rows).toEqual(expect.arrayContaining([{table:"Action",id:"action"},{table:"McpToolInput",id:"raw-input"},
      {table:"ArtifactInputLineage",id:"historic-completion"},{table:"ArtifactInputLineage",id:"later-reopen"}]));
    expect(result.artifacts).toEqual([]);expect(result.rows.some(row=>["AgentCredential","Member"].includes(row.table))).toBe(false);
    control.oldActionSnapshotFingerprint="0".repeat(64);
    await expect(edges("ConversationOperationOutcome",note)).rejects.toMatchObject({code:"SOURCE_LOCK_INCOMPLETE"});
  });
  it("covers ambient OAuth token/client and Finance rows without calling authentication or a provider",async()=>{
    tables.Member=[{id:"member",workspaceId:"ws",userId:"owner"}];tables.User=[{id:"owner"}];
    tables.McpOAuthAccessToken=[{id:"token",workspaceId:"ws",clientId:"client"}];tables.McpOAuthClient=[{id:"client"}];
    const result=await discoverAmbientSourceAuthority(context(),{kind:"oauth",id:"token"});
    expect(result.rows).toEqual(expect.arrayContaining([{table:"McpOAuthAccessToken",id:"token"},{table:"McpOAuthClient",id:"client"}]));
    expect(result.predicates.map(item=>item.key)).toEqual(expect.arrayContaining(["ambient-support:owner","ambient-feature-flags","ambient-module-grants","ambient-role-assignments:member","ambient-circles"]));
    expect(result.policies).toContainEqual({kind:"McpOAuthGrantPolicy",id:"token"});
    expect((db as any).$queryRaw).not.toHaveBeenCalled();
  });
  it("captures archive-history predicates from exact original variant state keys",async()=>{
    const result=await edges("BrainArticle",{variantOfArticleId:"canonical",variantSourceStateJson:{'["MeetingTranscript","meeting"]':"f".repeat(64)}});
    expect(result.artifacts).toContainEqual({kind:"BrainArticle",id:"canonical"});
    expect(result.predicates).toContainEqual(expect.objectContaining({where:{workspaceId:"ws",entityType:"Meeting",entityId:"meeting"},ids:[]}));
  });
  it("budgets predicate expansion and rejects a large native lookup rather than selecting a partial subset",async()=>{
    tables.NativeTranscriptInput=Array.from({length:10},(_,index)=>({id:`native-${index}`,workspaceId:"ws",mode:"AUDIO_UPLOAD",meetingAudioAssetId:"input"}));
    await expect(edges("MeetingAudioAsset",{},freshBudget(2))).rejects.toMatchObject({code:"SOURCE_LOCK_LIMIT"});
    expect(queries.find(query=>query.table==="NativeTranscriptInput")?.take).toBe(3);
  });
  it("keeps unsupported recorder transcript modes explicit",async()=>{
    await expect(edges("NativeTranscriptInput",{mode:"RECORDER",ownerMemberId:"member",submittedByUserId:"owner"})).rejects.toMatchObject({code:"SOURCE_LOCK_UNSUPPORTED"});
  });
});
