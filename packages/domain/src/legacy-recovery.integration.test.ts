import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma as db, mcpCredentialVersion, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { inspectLegacyRecovery, recoverLegacyArtifact, legacyRecoveryFileBinding } from "./legacy-recovery";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, recordArtifactInputLineage } from "./source-lineage";
import { defaultModelGateway } from "@corgtex/models";
import { readableArtifactIds, isArtifactInputProofPubliclyShareable, isLegacyRecoveryProofWorkspaceShareable } from "./source-lineage";
import { NextRequest } from "next/server";
import { getAction } from "./actions";
import { getConversation } from "./conversations";
const store = vi.hoisted(()=>({stream:vi.fn(), actor:vi.fn()}));
vi.mock("@/lib/auth",()=>({resolveRequestActor:store.actor}));
vi.mock("@corgtex/storage",()=>({defaultStorage:{getStream:store.stream}}));
beforeEach(async()=>{await truncateAllTables();store.stream.mockReset();store.actor.mockReset();});
afterEach(()=>vi.restoreAllMocks());
async function fixture(){
  const workspace=await db.workspace.create({data:{name:"Recovery fixture",plan:"PAYG_AI",slug:`recovery-${randomUUID()}`}});
  const users=await Promise.all(["owner","peer"].map(name=>db.user.create({data:{email:`${name}-${randomUUID()}@recovery.test`,passwordHash:"synthetic"}})));
  await db.member.createMany({data:users.map((user,index)=>({workspaceId:workspace.id,userId:user.id,role:index === 0 ? "ADMIN" : "CONTRIBUTOR"}))});
  const owner:AppActor={kind:"user",user:users[0]},peer:AppActor={kind:"user",user:users[1]};
  const select=(kind:"Action"|"ConversationSession"|"ConversationTurn"|"Document"|"BrainSource",row:{id:string})=>({workspaceId:workspace.id,kind,id:row.id});
  const restore=async(kind:Parameters<typeof select>[0],row:{id:string},actor=owner)=>{
    const choice=await inspectLegacyRecovery(actor,select(kind,row));
    return recoverLegacyArtifact(actor,{...select(kind,row),expectedFingerprint:choice.fingerprint,requestId:randomUUID(),consent:"RESTORE_SELECTED_HISTORY"});
  };
  return{workspace,owner,peer,users,select,restore};
}
describe("selected current legacy recovery",()=>{
  it("restores an ordinary Action without rewriting history and exact retries issue one receipt",async()=>{
    const f=await fixture();
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Preserved legacy Action",bodyMd:"Exact old generated body",status:"OPEN",isPrivate:false}});
    const choice=await inspectLegacyRecovery(f.owner,f.select("Action",action));
    const request={...f.select("Action",action),expectedFingerprint:choice.fingerprint,requestId:randomUUID(),consent:"RESTORE_SELECTED_HISTORY" as const};
    const [result, concurrent]=await Promise.all([recoverLegacyArtifact(f.owner,request),recoverLegacyArtifact(f.owner,request)]);
    expect(concurrent).toEqual(result);
    expect(await recoverLegacyArtifact(f.owner,request)).toEqual(result);
    expect(await db.action.findUniqueOrThrow({where:{id:action.id}})).toEqual(action);
    expect(await getAction(f.peer,{workspaceId:f.workspace.id,actionId:action.id})).toMatchObject({title:action.title,bodyMd:action.bodyMd});
    expect(await db.conversationOperationOutcome.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    const other=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Other old Action",isPrivate:false,status:"OPEN"}});
    await expect(recoverLegacyArtifact(f.owner,{...request,id:other.id,expectedFingerprint:lineageContentFingerprint("Action",other)})).rejects.toMatchObject({code:"RECOVERY_CONFLICT"});
    const manifests=await db.artifactInputLineage.findMany({where:{artifactId:action.id}});
    expect(manifests.map(row=>row.origin)).toEqual(["DERIVED"]);
    await expect(recoverLegacyArtifact(f.owner,{...request,expectedFingerprint:"0".repeat(64)})).rejects.toThrow();
    await expect(db.conversationOperationOutcome.update({where:{id:result.receiptId!},data:{operation:"FORGED"}})).rejects.toThrow("Immutable legacy recovery");
  });
  it("restores a legacy mixed user message and answer only to its owner, without creating prompt inputs",async()=>{
    const f=await fixture();
    const session=await db.conversationSession.create({data:{workspaceId:f.workspace.id,userId:f.users[0].id,topic:"Historical conversation"}});
    const turn=await db.conversationTurn.create({data:{conversationId:session.id,sequenceNumber:1,userMessage:"Uploaded inferred private title\n/workspaces/file\nQuestion",assistantMessage:"Historical generated answer"}});
    await f.restore("ConversationSession",session);
    await f.restore("ConversationTurn",turn);
    const restored=await getConversation(f.owner,f.workspace.id,session.id);
    expect(restored.turns[0]).toMatchObject({userMessage:turn.userMessage,assistantMessage:turn.assistantMessage,assistantContentWithheld:false});
    expect(await db.conversationPromptInput.count()).toBe(0);
    await expect(f.restore("ConversationTurn",turn,f.peer)).rejects.toMatchObject({code:"NOT_FOUND"});
    const proof=await captureArtifactInputProof(f.owner,f.workspace.id,[{kind:"ConversationTurn",id:turn.id}]);
    expect(await isArtifactInputProofReadable(f.peer,f.workspace.id,proof)).toBe(false);
  });
  it("retains known private contributors and never revives old authority after archive restoration",async()=>{
    const f=await fixture();
    const member=await db.member.findFirstOrThrow({where:{workspaceId:f.workspace.id,userId:f.users[0].id}});
    const input=await db.brainArticle.create({data:{workspaceId:f.workspace.id,title:"Private contributor",slug:"private",type:"PROJECT",bodyMd:"private",authority:"DRAFT",isPrivate:true,ownerMemberId:member.id}});
    await db.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.owner,workspaceId:f.workspace.id,artifact:{kind:"BrainArticle",id:input.id},content:input,origin:"HUMAN_ORIGINAL",inputs:[]}));
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Old mixed Action",bodyMd:"Copied private",isPrivate:false,status:"OPEN"}});
    const roots=await captureArtifactInputProof(f.owner,f.workspace.id,[{kind:"BrainArticle",id:input.id}]);
    await db.artifactInputLineage.create({data:{workspaceId:f.workspace.id,artifactType:"Action",artifactId:action.id,revision:1,origin:"UNKNOWN",contentHash:lineageContentFingerprint("Action",action),inputsJson:[],rootsJson:roots as never}});
    await db.artifactInputLineage.createMany({data:Array.from({length:204},(_,index)=>({workspaceId:f.workspace.id,artifactType:"Action",artifactId:action.id,revision:index+2,origin:"UNKNOWN",contentHash:lineageContentFingerprint("Action",action),inputsJson:[],rootsJson:[]}))});
    await f.restore("Action",action);
    const proof=await captureArtifactInputProof(f.owner,f.workspace.id,[{kind:"Action",id:action.id}]);
    expect(await isArtifactInputProofReadable(f.peer,f.workspace.id,proof)).toBe(false);
    await db.brainArticle.update({where:{id:input.id},data:{archivedAt:new Date()}});
    expect(await isArtifactInputProofReadable(f.owner,f.workspace.id,proof)).toBe(false);
    await db.brainArticle.update({where:{id:input.id},data:{archivedAt:null}});
    expect(await isArtifactInputProofReadable(f.owner,f.workspace.id,proof)).toBe(false);
    await expect(f.restore("Action",action)).rejects.toThrow();
  });
  it("verifies original file bytes and rejects a foreign namespace before storage",async()=>{
    const f=await fixture(),bytes=Buffer.from("synthetic original file");
    const key=`workspaces/${f.workspace.id}/uploads/${randomUUID()}/original.txt`;
    const document=await db.document.create({data:{workspaceId:f.workspace.id,title:"Original",source:"upload",storageKey:key,mimeType:"text/plain",metadata:{size:bytes.length}}});
    const source=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"FILE_UPLOAD",tier:1,content:"Extracted original",metadata:{documentId:document.id},fileStorageKey:key,fileSizeBytes:bytes.length,fileMimeType:"text/plain",fileName:"original.txt"}});
    await f.restore("Document",document);
    store.stream.mockImplementation(async()=>({body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})}));
    await f.restore("BrainSource",source);
    store.actor.mockResolvedValue(f.peer);
    const {GET}=await import("../../../apps/web/app/api/workspaces/[workspaceId]/brain/sources/[sourceId]/file/route");
    const request=new Request("http://localhost/file") as never;
    const context={params:Promise.resolve({workspaceId:f.workspace.id,sourceId:source.id})};
    const response=await GET(request,context);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    store.stream.mockImplementationOnce(async()=>({body:new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(bytes.length,120));controller.close();}})}));
    const changed=await GET(request,context);
    expect(changed.status).not.toBe(200);
    expect(await legacyRecoveryFileBinding(f.peer,f.workspace.id,source.id)).toMatchObject({storageKey:key,sizeBytes:bytes.length});
    expect(await db.brainSource.findUniqueOrThrow({where:{id:source.id}})).toEqual(source);
    const foreign=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"CONVERSATION",tier:1,content:"Unknown file",fileStorageKey:"workspaces/ws-other/uploads/foreign.bin",fileSizeBytes:bytes.length}});
    store.stream.mockClear();
    await expect(f.restore("BrainSource",foreign)).rejects.toMatchObject({code:"RECOVERY_STORAGE_UNPROVEN"});
    expect(store.stream).not.toHaveBeenCalled();
  });
  it("keeps complete existing proof as evidence and binds every successful method to the request",async()=>{
    const f=await fixture();
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Proved historical Action",isPrivate:false,status:"OPEN"}});
    await db.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.owner,workspaceId:f.workspace.id,artifact:{kind:"Action",id:action.id},content:action,origin:"HUMAN_ORIGINAL",inputs:[]}));
    const request={...f.select("Action",action),expectedFingerprint:lineageContentFingerprint("Action",action),requestId:randomUUID(),consent:"RESTORE_SELECTED_HISTORY" as const};
    const recovered=await recoverLegacyArtifact(f.owner,request);
    expect(recovered.basis).toBe("EXISTING_EVIDENCE");
    expect(await recoverLegacyArtifact(f.owner,request)).toEqual(recovered);
    expect(await getAction(f.peer,{workspaceId:f.workspace.id,actionId:action.id})).toMatchObject({title:action.title});
    expect(await db.artifactInputSnapshot.count({where:{sourceKind:"Action",sourceId:action.id}})).toBeGreaterThan(0);
    const other=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Unproved alternative",isPrivate:false,status:"OPEN"}});
    await expect(recoverLegacyArtifact(f.owner,{...request,id:other.id,expectedFingerprint:lineageContentFingerprint("Action",other)})).rejects.toMatchObject({code:"RECOVERY_CONFLICT"});
  });
  it("requires the original Document key, tenant, size and digest even inside an allowed namespace",async()=>{
    const f=await fixture(),bytes=Buffer.from("same length bytes"),key=`workspaces/${f.workspace.id}/uploads/${randomUUID()}/file.txt`;
    const doc=await db.document.create({data:{workspaceId:f.workspace.id,title:"Bound document",source:"upload",storageKey:key,mimeType:"text/plain",metadata:{size:bytes.length,fileContentHash:createHash("sha256").update("wrong digest").digest("hex")}}});
    await f.restore("Document",doc);
    const source=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"FILE_UPLOAD",tier:1,content:"Old extraction",metadata:{documentId:doc.id},fileStorageKey:key,fileSizeBytes:bytes.length,fileMimeType:"text/plain"}});
    store.stream.mockImplementation(async()=>({body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})}));
    await expect(f.restore("BrainSource",source)).rejects.toMatchObject({code:"RECOVERY_FILE_CHANGED"});
    const mismatched=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"CONVERSATION",tier:1,content:"Different file",metadata:{documentId:doc.id},fileStorageKey:key+"-different",fileSizeBytes:bytes.length,fileMimeType:"text/plain"}});
    store.stream.mockClear();
    await expect(f.restore("BrainSource",mismatched)).rejects.toMatchObject({code:"RECOVERY_STORAGE_UNPROVEN"});
    expect(store.stream).not.toHaveBeenCalled();
    const foreign=await db.workspace.create({data:{name:"Other tenant",slug:`other-${randomUUID()}`}});
    const foreignDoc=await db.document.create({data:{workspaceId:foreign.id,title:"Foreign",source:"upload",storageKey:key,mimeType:"text/plain"}});
    const foreignSource=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"FILE_UPLOAD",tier:1,content:"Foreign binding",metadata:{documentId:foreignDoc.id},fileStorageKey:key,fileSizeBytes:bytes.length,fileMimeType:"text/plain"}});
    await expect(f.restore("BrainSource",foreignSource)).rejects.toThrow();
    expect(store.stream).not.toHaveBeenCalled();
  });
  it("rechecks caller and policy after storage and rolls back the receipt when authority changes",async()=>{
    const f=await fixture(),bytes=Buffer.from("stored"),key=`workspaces/${f.workspace.id}/uploads/${randomUUID()}/old.txt`;
    const source=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"CONVERSATION",tier:1,content:"Old file",fileStorageKey:key,fileSizeBytes:bytes.length}});
    store.stream.mockImplementation(async()=>{
      await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:false}});
      await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:true}});
      return{body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}})};
    });
    await expect(f.restore("BrainSource",source)).rejects.toMatchObject({code:"RECOVERY_STALE"});
    expect(await db.conversationOperationOutcome.count()).toBe(0);
    expect(await db.brainSource.findUniqueOrThrow({where:{id:source.id}})).toEqual(source);
  });

  it("handles over one hundred empty historical revisions without an impossible partition requirement",async()=>{
    const f=await fixture();
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Long history",isPrivate:false,status:"OPEN"}});
    await db.artifactInputLineage.createMany({data:Array.from({length:205},(_,index)=>({workspaceId:f.workspace.id,artifactType:"Action",artifactId:action.id,revision:index+1,origin:"UNKNOWN",contentHash:lineageContentFingerprint("Action",action),inputsJson:[],rootsJson:[]}))});
    await f.restore("Action",action);
    expect(await getAction(f.peer,{workspaceId:f.workspace.id,actionId:action.id})).toMatchObject({title:action.title});
  });
  it("retains current credential scopes for company Actions but denies private and revoked credentials",async()=>{
    const f=await fixture();
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[0].id,title:"Company history",isPrivate:false,status:"OPEN"}});
    await f.restore("Action",action);
    const credential=await db.agentCredential.create({data:{workspaceId:f.workspace.id,label:"Synthetic scoped reader",tokenHash:randomUUID(),scopes:["actions:read"]}});
    const actor:AppActor={kind:"agent",authProvider:"credential",label:"Synthetic",workspaceIds:[f.workspace.id],credentialId:credential.id,credentialVersion:mcpCredentialVersion(credential.tokenHash),scopes:credential.scopes};
    const proof=await captureArtifactInputProof(actor,f.workspace.id,[{kind:"Action",id:action.id}]);
    expect(await isArtifactInputProofReadable({...actor,scopes:["workspace:read"]},f.workspace.id,proof)).toBe(false);
    const session=await db.conversationSession.create({data:{workspaceId:f.workspace.id,userId:f.users[0].id}});
    await f.restore("ConversationSession",session);
    const privateProof=await captureArtifactInputProof(f.owner,f.workspace.id,[{kind:"ConversationSession",id:session.id}]);
    expect(await isArtifactInputProofReadable(actor,f.workspace.id,privateProof)).toBe(false);
    await db.agentCredential.update({where:{id:credential.id},data:{isActive:false}});
    expect(await isArtifactInputProofReadable(actor,f.workspace.id,proof)).toBe(false);
  });
  it("keeps unrelated admin provenance out of company serving but retains the actual Action author",async()=>{
    const f=await fixture();
    const action=await db.action.create({data:{workspaceId:f.workspace.id,authorUserId:f.users[1].id,title:"Peer authored history",isPrivate:false,status:"OPEN"}});
    await f.restore("Action",action);
    const proof=await captureArtifactInputProof(f.peer,f.workspace.id,[{kind:"Action",id:action.id}]);
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:false}});
    expect(await getAction(f.peer,{workspaceId:f.workspace.id,actionId:action.id})).toMatchObject({title:action.title});
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:true}});
    expect(await isArtifactInputProofReadable(f.peer,f.workspace.id,proof)).toBe(true);
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[1].id},data:{isActive:false}});
    expect(await isArtifactInputProofReadable(f.owner,f.workspace.id,proof)).toBe(false);
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[1].id},data:{isActive:true}});
    expect(await isArtifactInputProofReadable(f.owner,f.workspace.id,proof)).toBe(false);
  });
  it("uses the real HTTP recovery path and authenticated caller for Document and previously absorbed Brain projections",async()=>{
    const f=await fixture();store.actor.mockResolvedValue(f.owner);
    vi.spyOn(defaultModelGateway,"rerank").mockImplementation(async({documents,topK})=>({results:documents.slice(0,topK).map((_,index)=>({index,score:1}))}) as never);
    const embed=vi.spyOn(defaultModelGateway,"embed").mockImplementation(async({input})=>({embeddings:(Array.isArray(input)?input:[input]).map(()=>Array(1536).fill(0.01)),
      usage:{provider:"fixture",model:"fixture-embed",inputTokens:1,outputTokens:0,latencyMs:0,estimatedCostUsd:"0",rawProviderCostUsd:"0",billableCostUsd:"0"}}));
    vi.spyOn(defaultModelGateway,"extract").mockResolvedValue({output:{articleType:"PROCESS",createNew:{title:"Recovered company fact",slug:"recovered-fact"},summary:"Preserved company source"}} as never);
    vi.spyOn(defaultModelGateway,"chat").mockResolvedValue({content:"Fresh proposed company summary from preserved facts."} as never);
    const {GET,POST}=await import("../../../apps/web/app/api/workspaces/[workspaceId]/history-recovery/route");
    async function request(kind:"Document"|"BrainSource",id:string){
      const context={params:Promise.resolve({workspaceId:f.workspace.id})};
      const preview=await GET(new NextRequest(`http://localhost/history-recovery?kind=${kind}&id=${id}`),context);
      expect(preview.status).toBe(200);
      const {fingerprint}=await preview.json();
      const body={kind,id,expectedFingerprint:fingerprint,requestId:randomUUID(),consent:"RESTORE_SELECTED_HISTORY"};
      const post=()=>POST(new NextRequest("http://localhost/history-recovery",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),context);
      const response=await post();expect(response.status).toBe(200);
      return {result:await response.json(),post};
    }
    const document=await db.document.create({data:{workspaceId:f.workspace.id,title:"Old company document",source:"manual",storageKey:`workspaces/${f.workspace.id}/uploads/${randomUUID()}/document.txt`,mimeType:"text/plain",textContent:"Original unproved company text."}});
    const doc=await request("Document",document.id);
    expect(doc.result.projection).toMatchObject({status:"COMPLETED",chunks:expect.any(Number)});
    const docChunks=await db.knowledgeChunk.findMany({where:{workspaceId:f.workspace.id,sourceType:"DOCUMENT",sourceId:document.id}});
    expect(docChunks.length).toBeGreaterThan(0);
    expect(await readableArtifactIds(f.peer,f.workspace.id,"KnowledgeChunk",docChunks)).toEqual(new Set(docChunks.map(chunk=>chunk.id)));
    const source=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"RESEARCH",tier:2,title:"Old source",content:"Preserved company facts.",absorbedAt:new Date("2025-01-01")}});
    const brain=await request("BrainSource",source.id);
    expect(brain.result.projection).toMatchObject({status:"COMPLETED"});
    const articles=await db.brainArticle.findMany({where:{workspaceId:f.workspace.id,sourceIds:{has:source.id}}});
    expect(articles.length).toBeGreaterThan(0);
    expect(await readableArtifactIds(f.peer,f.workspace.id,"BrainArticle",articles)).toEqual(new Set(articles.map(article=>article.id)));
    const articleChunks=await db.knowledgeChunk.findMany({where:{workspaceId:f.workspace.id,sourceId:{in:articles.map(article=>article.id)}}});
    expect(articleChunks.length).toBeGreaterThan(0);
    expect(await readableArtifactIds(f.peer,f.workspace.id,"KnowledgeChunk",articleChunks)).toEqual(new Set(articleChunks.map(chunk=>chunk.id)));
    const sourceProof=await captureArtifactInputProof(f.owner,f.workspace.id,[{kind:"BrainSource",id:source.id}]);
    expect(await isArtifactInputProofPubliclyShareable(f.owner,f.workspace.id,sourceProof)).toBe(false);
    expect(await isLegacyRecoveryProofWorkspaceShareable(f.owner,f.workspace.id,sourceProof)).toBe(true);
    const before=await db.brainArticle.count({where:{workspaceId:f.workspace.id}});
    expect((await (await brain.post()).json()).receiptId).toBe(brain.result.receiptId);
    expect(await db.brainArticle.count({where:{workspaceId:f.workspace.id}})).toBe(before);
    expect(embed).toHaveBeenCalled();
    const currentChunks=await db.knowledgeChunk.findMany({where:{workspaceId:f.workspace.id,sourceId:{in:[document.id,...articles.map(article=>article.id)]}}});
    // Unrelated recovery operator departure does not become a serving governor.
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:false}});
    expect(await readableArtifactIds(f.peer,f.workspace.id,"BrainArticle",articles)).toEqual(new Set(articles.map(article=>article.id)));
    expect(await readableArtifactIds(f.peer,f.workspace.id,"KnowledgeChunk",currentChunks)).toEqual(new Set(currentChunks.map(chunk=>chunk.id)));
    const {searchIndexedKnowledge}=await import("@corgtex/knowledge");
    const search=await searchIndexedKnowledge({actor:f.peer,workspaceId:f.workspace.id,query:"company facts",limit:10});
    expect(search.length).toBeGreaterThan(0);
    await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:true}});
    expect(await readableArtifactIds(f.peer,f.workspace.id,"KnowledgeChunk",currentChunks)).toEqual(new Set(currentChunks.map(chunk=>chunk.id)));

  },120_000);

  it("keeps durable recovery but rolls back projection when its original operator is revoked during embedding",async()=>{
    const f=await fixture();
    const document=await db.document.create({data:{workspaceId:f.workspace.id,title:"Company projection",source:"manual",storageKey:`workspaces/${f.workspace.id}/uploads/${randomUUID()}/doc.txt`,mimeType:"text/plain",textContent:"Original text for projection."}});
    const recovery=await f.restore("Document",document);
    vi.spyOn(defaultModelGateway,"embed").mockImplementation(async({input})=>{
      await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:false}});
      await db.member.updateMany({where:{workspaceId:f.workspace.id,userId:f.users[0].id},data:{isActive:true}});
      return {embeddings:(Array.isArray(input)?input:[input]).map(()=>Array(1536).fill(0.01)),usage:{provider:"fixture",model:"fixture",inputTokens:1,outputTokens:0,latencyMs:0,estimatedCostUsd:"0",rawProviderCostUsd:"0",billableCostUsd:"0"}};
    });
    const {rebuildRecoveredHistory}=await import("../../../apps/web/lib/legacy-recovery-projection");
    expect(await rebuildRecoveredHistory(f.owner,f.workspace.id,recovery)).toMatchObject({status:"FAILED"});
    expect(await db.knowledgeChunk.count({where:{workspaceId:f.workspace.id}})).toBe(0);
    expect(await db.conversationOperationOutcome.count()).toBe(1);
    expect(await readableArtifactIds(f.peer,f.workspace.id,"Document",[document])).toEqual(new Set([document.id]));
  });
  it("reindexes the same saved Brain proposal after partial embedding failure instead of creating another",async()=>{
    const f=await fixture();
    const source=await db.brainSource.create({data:{workspaceId:f.workspace.id,sourceType:"RESEARCH",tier:2,title:"Retry history",content:"Historical company source."}});
    const recovery=await f.restore("BrainSource",source);
    vi.spyOn(defaultModelGateway,"extract").mockResolvedValue({output:{articleType:"PROCESS",createNew:{title:"Retry proposal",slug:"retry-proposal"},summary:"Company source"}} as never);
    vi.spyOn(defaultModelGateway,"chat").mockResolvedValue({content:"Fresh proposal preserving original company facts."} as never);
    const embed=vi.spyOn(defaultModelGateway,"embed").mockRejectedValueOnce(new Error("Synthetic embedding failure"));
    const {rebuildRecoveredHistory}=await import("../../../apps/web/lib/legacy-recovery-projection");
    expect(await rebuildRecoveredHistory(f.owner,f.workspace.id,recovery)).toMatchObject({status:"FAILED"});
    const articles=await db.brainArticle.findMany({where:{workspaceId:f.workspace.id,sourceIds:{has:source.id}}});
    expect(articles).toHaveLength(1);
    embed.mockImplementation(async({input})=>({embeddings:(Array.isArray(input)?input:[input]).map(()=>Array(1536).fill(0.01)),usage:{provider:"fixture",model:"fixture",inputTokens:1,outputTokens:0,latencyMs:0,estimatedCostUsd:"0",rawProviderCostUsd:"0",billableCostUsd:"0"}}));
    expect(await rebuildRecoveredHistory(f.owner,f.workspace.id,recovery)).toMatchObject({status:"COMPLETED",rebuilt:1});
    expect(await db.brainArticle.count({where:{workspaceId:f.workspace.id}})).toBe(1);
    const chunks=await db.knowledgeChunk.findMany({where:{workspaceId:f.workspace.id,sourceId:articles[0].id}});
    expect(chunks.length).toBeGreaterThan(0);
    expect(await readableArtifactIds(f.peer,f.workspace.id,"KnowledgeChunk",chunks)).toEqual(new Set(chunks.map(chunk=>chunk.id)));
  },120_000);

});
