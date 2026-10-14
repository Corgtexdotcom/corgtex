import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, encryptSecret, runWithMcpOrigin, captureMcpOAuthGrantEpoch, mcpScopesHash, type AppActor } from "@corgtex/shared";
const remote = vi.hoisted(() => ({response: {structuredContent: {results: [{id: "synthetic", title: "Native CRM source"}]}} as unknown, read: vi.fn(), inTransaction: 0}));
vi.mock("@corgtex/shared", async importOriginal => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  const instrumented = new Proxy(actual.prisma, {get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key, target);
    return async (...args: any[]) => {
      const original = target.$transaction.bind(target) as (...args: any[]) => Promise<any>;
      if (typeof args[0] !== "function") return original(...args);
      return original(async (tx: any) => {remote.inTransaction++; try {return await args[0](tx);} finally {remote.inTransaction--;}} , ...args.slice(1));
    };
  }});
  return {...actual, prisma: instrumented};
});
vi.mock("./external-mcp", async importOriginal => ({...await importOriginal<typeof import("./external-mcp")>(), readExternalMcpNativeToolResult: remote.read}));
import { captureExternalMcpResponseInput } from "./external-mcp-response-input";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { archiveCrmAccount, createCrmAccount, listCrmAccounts, listCrmActivities } from "./crm";
import { restoreWorkspaceArtifact, archiveWorkspaceArtifact } from "./archive";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage, withArtifactInputReadCapture } from "./source-lineage";
import { admitCrmDirectOriginalRows, assertCrmDirectReadCurrent, createCrmDirectReadSession, serializeCrmDirectReadResult } from "./crm-direct-original-read";
const url = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/corgtex_test" || url.searchParams.get("schema") !== "public") throw new Error("Disposable loopback test database required.");
async function fixture() {
  const workspace=await prisma.workspace.create({data:{name:"Synthetic direct CRM",slug:`crm-original-${randomUUID()}`}});
  const user=await prisma.user.create({data:{email:`crm-original-${randomUUID()}@example.test`,displayName:"Synthetic original author",passwordHash:"synthetic"}});
  const member=await prisma.member.create({data:{workspaceId:workspace.id,userId:user.id,role:"ADMIN",kind:"HUMAN"}});
  const actor: AppActor={kind:"user",user:{id:user.id,email:user.email,displayName:user.displayName}};
  const account=await createCrmAccount(actor,{workspaceId:workspace.id,name:"GENUINE_ORIGINAL_BODY",descriptionMd:"Independent human original"});
  return {workspace,user,member,actor,account};
}
beforeEach(async()=>{
  await truncateAllTables(); remote.inTransaction = 0; remote.read.mockReset();
  remote.response = {structuredContent: {results: [{id: "synthetic", title: "Native CRM source"}]}};
  remote.read.mockImplementation(async () => {expect(remote.inTransaction).toBe(0); return structuredClone(remote.response);});
});
describe("direct native archived originals on migrated PostgreSQL",()=>{
  it("returns the actual constructed original, omits archive text, and keeps model/source capture denied",async()=>{
    const f=await fixture();
    const before=await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"CrmAccount",id:f.account.id}]);
    await archiveWorkspaceArtifact(f.actor,{workspaceId:f.workspace.id,entityType:"CrmAccount",entityId:f.account.id,reason:"PRIVATE_ARCHIVE_REASON"});
    const result=await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"});
    expect(result.total).toBe(1);expect(result.items[0]).toMatchObject({name:"GENUINE_ORIGINAL_BODY",descriptionMd:"Independent human original",archiveReason:null,archivedByUserId:null,_count:null});
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ARCHIVE_REASON");
    expect(await isArtifactInputProofReadable(f.actor,f.workspace.id,before)).toBe(false);
    await expect(captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"CrmAccount",id:f.account.id}])).rejects.toMatchObject({code:"UNKNOWN_LINEAGE"});
    await expect(withArtifactInputReadCapture(f.actor,f.workspace.id,()=>listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"}))).rejects.toMatchObject({code:"UNKNOWN_LINEAGE"});
  });
  it("preserves independent activity original with archived linked deal, without copying parent bodies",async()=>{
    const f=await fixture();
    const contact=await prisma.crmContact.create({data:{workspaceId:f.workspace.id,accountId:f.account.id,email:"independent@example.test"}});
    const deal=await prisma.crmDeal.create({data:{workspaceId:f.workspace.id,accountId:f.account.id,contactId:contact.id,title:"PARENT_BODY_CANARY"}});
    const activity=await prisma.crmActivity.create({data:{workspaceId:f.workspace.id,accountId:f.account.id,contactId:contact.id,dealId:deal.id,title:"Independent activity",bodyMd:"Genuine fresh manual activity"}});
    // Explicit new independent human fixture inputs, not copied legacy rows.
    for(const [kind,row] of [["CrmContact",contact],["CrmDeal",deal],["CrmActivity",activity]] as const) await prisma.$transaction(tx=>recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]}));
    await archiveWorkspaceArtifact(f.actor,{workspaceId:f.workspace.id,entityType:"CrmDeal",entityId:deal.id});
    await archiveWorkspaceArtifact(f.actor,{workspaceId:f.workspace.id,entityType:"CrmActivity",entityId:activity.id});
    const result=await listCrmActivities(f.actor,f.workspace.id,{archiveFilter:"all"});
    expect(result.items.map(row=>row.id)).toContain(activity.id);
    expect(result.items[0]).toMatchObject({title:"Independent activity",bodyMd:"Genuine fresh manual activity",deal:null,contact:null,account:null});
    expect(JSON.stringify(result)).not.toContain("PARENT_BODY_CANARY");
  });
  it("filters archived derived and unknown rows before totals/page, with no old original same-hash fallback",async()=>{
    const f=await fixture();
    const roots=await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"CrmAccount",id:f.account.id}]);
    const derived=await createCrmAccount(f.actor,{workspaceId:f.workspace.id,name:"DERIVED_BODY_CANARY",lineageRoots:roots});
    await archiveCrmAccount(f.actor,{workspaceId:f.workspace.id,accountId:derived.id});
    const unknown=await prisma.crmAccount.create({data:{workspaceId:f.workspace.id,name:"UNKNOWN_BODY_CANARY",slug:"unknown",archivedAt:new Date()}});
    await archiveCrmAccount(f.actor,{workspaceId:f.workspace.id,accountId:f.account.id});
    const all=await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all",take:1});
    expect(all.total).toBe(1);expect(all.items[0].id).toBe(f.account.id);
    expect(JSON.stringify(all)).not.toMatch(/DERIVED_BODY_CANARY|UNKNOWN_BODY_CANARY/);
    const latest=await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspace.id,artifactType:"CrmAccount",artifactId:f.account.id},orderBy:{revision:"desc"}});
    await prisma.artifactInputLineage.create({data:{workspaceId:f.workspace.id,artifactType:"CrmAccount",artifactId:f.account.id,revision:latest.revision+1,origin:"UNKNOWN",contentHash:latest.contentHash,inputsJson:[],rootsJson:[]}});
    expect((await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"})).items).toEqual([]);
    expect(await prisma.crmAccount.findUnique({where:{id:unknown.id}})).not.toBeNull();
  });
  it("does not redeem a paused direct delivery after membership revoke/restore, while a fresh authorized view works",async()=>{
    const f=await fixture();await archiveCrmAccount(f.actor,{workspaceId:f.workspace.id,accountId:f.account.id});
    const row=await prisma.crmAccount.findUniqueOrThrow({where:{id:f.account.id}});const session=createCrmDirectReadSession(f.actor,f.workspace.id);
    await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);
    await prisma.member.update({where:{id:f.member.id},data:{isActive:false}});
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({status:403});
    await prisma.member.update({where:{id:f.member.id},data:{isActive:true}});
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect((await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"})).items[0].id).toBe(row.id);
    await restoreWorkspaceArtifact(f.actor,{workspaceId:f.workspace.id,entityType:"CrmAccount",entityId:row.id});
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("checks the exact latest receipt again at canonical JSON delivery, including after a prior delivery",async()=>{
    const f=await fixture();await archiveCrmAccount(f.actor,{workspaceId:f.workspace.id,accountId:f.account.id});
    const result=await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"});
    const emitted=await serializeCrmDirectReadResult(f.actor,result);
    expect(JSON.parse(emitted).items[0].name).toBe("GENUINE_ORIGINAL_BODY");
    const latest=await prisma.artifactInputLineage.findFirstOrThrow({where:{workspaceId:f.workspace.id,artifactType:"CrmAccount",artifactId:f.account.id},orderBy:{revision:"desc"}});
    await prisma.artifactInputLineage.create({data:{workspaceId:f.workspace.id,artifactType:"CrmAccount",artifactId:f.account.id,revision:latest.revision+1,origin:"UNKNOWN",contentHash:latest.contentHash,inputsJson:[],rootsJson:[]}});
    await expect(serializeCrmDirectReadResult(f.actor,result)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    // The earlier canonical payload was delivered before append; no later cached reuse is authorized.
    expect(JSON.parse(emitted).items).toHaveLength(1);
    const next=await listCrmAccounts(f.actor,f.workspace.id,{archiveFilter:"all"});
    expect(JSON.parse(await serializeCrmDirectReadResult(f.actor,next)).items).toEqual([]);
  });
  it("presents ordinary native-provider derived CRM beside an archived original, with no SDK in the delivery transaction", async () => {
    const f = await fixture(); await archiveCrmAccount(f.actor, {workspaceId: f.workspace.id, accountId: f.account.id});
    const connection = await prisma.externalMcpConnection.create({data: {workspaceId: f.workspace.id, userId: f.user.id,
      providerKey: "notion", displayName: "Synthetic native provider", serverUrl: "https://mcp.notion.com/mcp",
      accessTokenEnc: encryptSecret("synthetic-only-token"), scopes: ["read"], status: "ACTIVE"}});
    const native = await captureExternalMcpResponseInput(f.actor, {workspaceId: f.workspace.id, connectionId: connection.id, mode: "SEARCH", query: "synthetic CRM", limit: 1});
    const roots = await captureArtifactInputProof(f.actor, f.workspace.id, [{kind: "ExternalMcpResponseInput", id: native.input.id}]);
    const preflight = await prepareArtifactCommitPreflight(f.actor, f.workspace.id, roots);
    const derived = await prisma.$transaction(tx => withArtifactCommitPreflight(f.actor, f.workspace.id, tx, roots, preflight, async () => {
      const row = await tx.crmAccount.create({data: {workspaceId: f.workspace.id, slug: "native-derived", name: "Native CRM source", descriptionMd: "Exact synthetic provider result"}});
      await recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspace.id, artifact: {kind: "CrmAccount", id: row.id}, content: row, origin: "DERIVED", inputs: [], inheritedRoots: roots});
      return row;
    }));
    remote.read.mockClear();
    const result = await listCrmAccounts(f.actor, f.workspace.id, {archiveFilter: "all"});
    const output = JSON.parse(await serializeCrmDirectReadResult(f.actor, result));
    expect(output.total).toBe(2); expect(output.items.map((row: any) => row.id)).toEqual(expect.arrayContaining([f.account.id, derived.id]));
    expect(remote.read).toHaveBeenCalled(); expect(remote.inTransaction).toBe(0);
    remote.response = {structuredContent: {results: [{id: "changed", title: "Changed native bytes"}]}};
    await expect(serializeCrmDirectReadResult(f.actor, result)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    remote.response = native.payload;
    await prisma.externalMcpConnection.update({where: {id: connection.id}, data: {status: "DISCONNECTED"}});
    await expect(serializeCrmDirectReadResult(f.actor, result)).rejects.toMatchObject({code: expect.stringMatching(/SOURCE_CHANGED|UNKNOWN_LINEAGE/)});
  });
  it("binds actual OAuth token identity and changed family consent independently of the human member",async()=>{
    const f=await fixture();await archiveCrmAccount(f.actor,{workspaceId:f.workspace.id,accountId:f.account.id});
    const client=await prisma.mcpOAuthClient.create({data:{clientId:`crm-native-${randomUUID()}`,name:"Synthetic native client",redirectUris:["https://synthetic.example.test"],scopes:["relationships:read"]}});
    const token=await prisma.mcpOAuthAccessToken.create({data:{workspaceId:f.workspace.id,userId:f.user.id,clientId:client.id,instanceSlug:"selfserve",tokenHash:`synthetic-${randomUUID()}`,scopes:["relationships:read"],expiresAt:new Date(Date.now()+60000),refreshExpiresAt:new Date(Date.now()+3600000)}});
    const grantEpoch=await prisma.$transaction(tx=>captureMcpOAuthGrantEpoch(tx,f.workspace.id,token.id));
    const origin={kind:"oauth" as const,id:token.id,workspaceId:f.workspace.id,scopeHash:mcpScopesHash(token.scopes),grantEpoch};
    const row=await prisma.crmAccount.findUniqueOrThrow({where:{id:f.account.id}});
    const session=await runWithMcpOrigin(origin,async()=>{const session=createCrmDirectReadSession(f.actor,f.workspace.id);await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);return session;});
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"MCP_AUTHORIZATION_REVOKED"});
    await prisma.mcpOAuthAccessToken.update({where:{id:token.id},data:{scopes:["actions:read"]}});
    await expect(runWithMcpOrigin(origin,()=>assertCrmDirectReadCurrent(session))).rejects.toThrow("MCP_AUTHORIZATION_REVOKED");
  });
});
