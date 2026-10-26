import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";
import { installSourcePermissionEpochFixture } from "./source-permission-epochs.test-fixture";
const f = vi.hoisted(() => {
  const tables: Record<string, any[]> = {};
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key,value]: [string,any]) => value && typeof value === "object" && !(value instanceof Date) ? value.in ? value.in.includes(row[key]) : true : row[key] === value);
  const db: any = { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 1) };
  for (const name of ["crmAccount","crmContact","crmDeal","crmActivity","crmDealStageTransition","crmConversation","artifactInputLineage","workspace","member","agentCredential","workspaceSupportGrant"]) {
    tables[name] = [];
    db[name] = {
      findFirst: vi.fn(async ({where,orderBy}: any) => {
        const rows = tables[name].filter(row => matches(row,where));
        if (orderBy?.revision === "desc") rows.sort((a,b) => b.revision-a.revision);
        return rows[0] ? structuredClone(rows[0]) : null;
      }),
      findUnique: vi.fn(async ({where}: any) => {const row=tables[name].find(row=>matches(row,where));return row?structuredClone(row):null;}),
      findMany: vi.fn(async ({where, include}: any) => tables[name].filter(row=>matches(row,where)).map(row=>structuredClone({
        ...row, ...(include?.contact ? {contact: tables.crmContact.find(contact=>contact.id===row.contactId) ?? null} : {}),
        ...(include?.account ? {account: tables.crmAccount.find(account=>account.id===row.accountId) ?? null} : {}),
      }))),
      create: vi.fn(async ({data}: any) => {const row={id:`${name}-${tables[name].length}`,recordedAt:new Date(),...data};tables[name].push(row);return structuredClone(row);}),
    };
  }
  const tx: any = new Proxy({}, {get: (_target, key) => Reflect.get(db, key, db)});
  db.$transaction = vi.fn(async run => run(tx));
  return {db,tx,tables,revoked:false};
});
vi.mock("@corgtex/shared", async () => ({...await vi.importActual<typeof import("@corgtex/shared")>("@corgtex/shared"),prisma:f.db}));
vi.mock("./auth", () => ({requireWorkspaceMembership: vi.fn(async ({actor,workspaceId,tx}) => {
  if (tx) expect([f.db, f.tx]).toContain(tx); if(f.revoked || workspaceId!=="ws") throw Object.assign(new Error("revoked"),{code:"NOT_A_MEMBER"});
  return actor.kind === "user" ? {id:"member",role:"MEMBER"} : null;
})}));
vi.mock("./brain-access", () => ({resolveKnowledgeAccessDomains: vi.fn(async()=>["PUBLIC"])}));
// Only canonical lock plumbing is replaced; full SourceLineage and epoch gates are real.
vi.mock("./archive", async importOriginal => ({...await importOriginal<typeof import("./archive")>(),lockWorkspaceArchiveArtifact: vi.fn(async()=>{})}));
import { mcpCredentialVersion, mcpScopesHash, runWithMcpOrigin } from "@corgtex/shared";
import { captureArtifactInputProof, lineageContentFingerprint, recordArtifactInputLineage, withArtifactInputReadCapture } from "./source-lineage";
import { admitCrmDirectOriginalRows, discardCrmDirectReadProjections, isCrmDirectOriginalRow, assertCrmDirectReadCurrent, createCrmDirectReadSession, captureCrmDirectReadContributors, finalizeCrmDirectReadResult, serializeCrmDirectReadResult } from "./crm-direct-original-read";
import { listDeals } from "./crm";
const actor = () => ({kind:"user",user:{id:"author",email:"author@synthetic.test"}} as AppActor);
async function seed(kind = "CrmAccount", data: any = {}) {
  if (kind === "CrmDeal" && data.contactId === undefined) data = {...data, contactId: (await seed("CrmContact")).id};
  const model = `${kind[0].toLowerCase()}${kind.slice(1)}`;
  const row = {id:`${kind}-original`,workspaceId:"ws",name:"Original account",title:"Original title",bodyMd:"Original body",
    archivedAt:new Date("2026-10-12T10:00:00Z"),createdAt:new Date("2026-10-12T09:00:00Z"),updatedAt:new Date("2026-10-12T10:00:00Z"),
    archiveReason:"PRIVATE_REASON_CANARY",archivedByUserId:"private-label-id",...data};
  f.tables[model].push(row);
  await recordArtifactInputLineage({tx:f.db,actor:actor(),workspaceId:"ws",artifact:{kind:kind as any,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
  return structuredClone(row);
}
beforeEach(() => {
  for(const name of Object.keys(f.tables))f.tables[name]=[];
  f.revoked=false;vi.clearAllMocks();
  f.tables.workspace.push({id:"ws"}); f.tables.member.push({id:"member",workspaceId:"ws",userId:"author",isActive:true});
  f.db.$queryRaw.mockReset().mockImplementation(async (query:any) => {
    const sql=query.sql??"", values=new Set(query.values??[]);
    const table=/SELECT id FROM "(CrmAccount|CrmContact|CrmDeal|CrmActivity)"/.exec(sql)?.[1];
    if(table&&sql.includes("FOR SHARE")) {
      const model=`${table[0].toLowerCase()}${table.slice(1)}`;
      return f.tables[model].filter(row=>values.has(row.workspaceId)&&values.has(row.id)).map(row=>({id:row.id}));
    }
    return [];
  });f.db.$executeRaw.mockReset().mockResolvedValue(1);
  installSourcePermissionEpochFixture(f.db);
});
describe("direct archived CRM originals with actual lineage gates",()=>{
  it.each(["CrmAccount","CrmContact","CrmDeal","CrmActivity"])("presents %s original body without admitting an archived source",async kind=>{
    const row=await seed(kind);const user=actor();const session=createCrmDirectReadSession(user,"ws");
    const [view]=await admitCrmDirectOriginalRows(session,kind,[row]);
    expect(view).toMatchObject({id:row.id,archiveReason:null,archivedByUserId:null,account:null,contact:null,deal:null});
    expect(JSON.stringify(view)).not.toContain("PRIVATE_REASON_CANARY");
    await assertCrmDirectReadCurrent(session);
    await expect(captureArtifactInputProof(user,"ws",[{kind:kind as any,id:row.id}])).rejects.toMatchObject({code:"UNKNOWN_LINEAGE"});
  });
  it("delivers the actual original-only listDeals result without an empty source capture", async () => {
    const deal = await seed("CrmDeal"); const user = actor();
    const result = await listDeals(user, "ws", {archiveFilter: "archived"});
    const delivered = JSON.parse(await serializeCrmDirectReadResult(user, result));
    expect(delivered).toMatchObject({total: 1, items: [{id: deal.id, title: "Original title", contact: null, archiveReason: null}]});
    expect(JSON.stringify(delivered)).not.toContain("PRIVATE_REASON_CANARY");
  });
  it("delivers the actual empty listDeals result and retains its final authority fence", async () => {
    const user = actor(); const result = await listDeals(user, "ws", {archiveFilter: "archived"});
    expect(JSON.parse(await serializeCrmDirectReadResult(user, result))).toMatchObject({items: [], total: 0});
    f.revoked = true;
    await expect(serializeCrmDirectReadResult(user, result)).rejects.toMatchObject({code: "NOT_A_MEMBER"});
  });
  it("filters ordinary deals with unreadable contact bodies without an empty input capture", async () => {
    const user = actor(); const source = await seed("CrmAccount", {archivedAt: null});
    const roots = await captureArtifactInputProof(user, "ws", [{kind: "CrmAccount", id: source.id}]);
    const contact = {...source, id: "unknown-contact", email: "unknown@example.test", accountId: null};
    f.tables.crmContact.push(contact); // No original receipt: its body remains unknown.
    const deal = {...source, id: "ordinary-deal", contactId: contact.id, accountId: null, title: "Readable independent derived deal"};
    f.tables.crmDeal.push(deal);
    await recordArtifactInputLineage({tx: f.db, actor: user, workspaceId: "ws", artifact: {kind: "CrmDeal", id: deal.id}, content: deal, origin: "DERIVED", inputs: [], inheritedRoots: roots});
    await expect(captureArtifactInputProof(user, "ws", [{kind: "CrmDeal", id: deal.id}])).resolves.toEqual(expect.arrayContaining([expect.objectContaining({kind: "CrmDeal", id: deal.id})]));
    await expect(captureArtifactInputProof(user, "ws", [{kind: "CrmContact", id: contact.id}])).rejects.toMatchObject({code: "UNKNOWN_LINEAGE"});
    const result = await listDeals(user, "ws", {archiveFilter: "all"});
    expect(JSON.parse(await serializeCrmDirectReadResult(user, result))).toMatchObject({items: [], total: 0});
  });
  it("keeps positively permitted contact predicates fenced even for an unreturned deal", async () => {
    const user = actor(); const source = await seed("CrmAccount", {archivedAt: null});
    const contact = await seed("CrmContact", {archivedAt: null});
    const roots = await captureArtifactInputProof(user, "ws", [{kind: "CrmAccount", id: source.id}]);
    const deal = {...source, id: "ordinary-deal", contactId: contact.id, accountId: null, title: "Readable derived deal"};
    f.tables.crmDeal.push(deal);
    await recordArtifactInputLineage({tx: f.db, actor: user, workspaceId: "ws", artifact: {kind: "CrmDeal", id: deal.id}, content: deal, origin: "DERIVED", inputs: [], inheritedRoots: roots});
    const result = await listDeals(user, "ws", {archiveFilter: "all", take: 0});
    expect(JSON.parse(await serializeCrmDirectReadResult(user, result))).toMatchObject({items: [], total: 1});
    f.tables.crmContact[0].name = "Changed positive predicate";
    await expect(serializeCrmDirectReadResult(user, result)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });
  it("admits an independently original activity with an archived deal as identity only",async()=>{
    const account=await seed();const contact=await seed("CrmContact",{accountId:account.id});
    const deal=await seed("CrmDeal",{accountId:account.id,contactId:contact.id,title:"PRIVATE_PARENT_BODY"});
    const activity=await seed("CrmActivity",{accountId:account.id,contactId:contact.id,dealId:deal.id});
    const [view]=await admitCrmDirectOriginalRows(createCrmDirectReadSession(actor(),"ws"),"CrmActivity",[activity]);
    expect(view.bodyMd).toBe("Original body");expect(view.deal).toBeNull();expect(JSON.stringify(view)).not.toContain("PRIVATE_PARENT_BODY");
  });
  it.each(["DERIVED","UNKNOWN"])("rejects latest %s even when old ORIGINAL has the same content hash",async origin=>{
    const row=await seed();const original=f.tables.artifactInputLineage[0];
    f.tables.artifactInputLineage.push({...original,id:"later",revision:2,origin});
    expect(await admitCrmDirectOriginalRows(createCrmDirectReadSession(actor(),"ws"),"CrmAccount",[row])).toEqual([]);
  });
  it.each(["roots","inputs","epoch","identity","hash"])("rejects malformed original %s evidence",async corruption=>{
    const row=await seed();const manifest=f.tables.artifactInputLineage[0];
    if(corruption==="roots")manifest.rootsJson=null;
    if(corruption==="inputs")manifest.inputsJson=[{kind:"CrmAccount",id:"copied"}];
    if(corruption==="epoch")manifest.epochProofVersion=null;
    if(corruption==="identity")manifest.permissionEpochsJson.entries=manifest.permissionEpochsJson.entries.filter((entry:any)=>entry.kind!=="CrmAccount");
    if(corruption==="hash")manifest.contentHash="0".repeat(64);
    expect(await admitCrmDirectOriginalRows(createCrmDirectReadSession(actor(),"ws"),"CrmAccount",[row])).toEqual([]);
  });
  it("rejects capture synchronously before any query, including a cloned actor and nested capture",async()=>{
    const row=await seed();f.db.crmAccount.findFirst.mockClear();const user=actor();
    await expect(withArtifactInputReadCapture(user,"ws",()=>withArtifactInputReadCapture(actor(),"other",async()=>{
      createCrmDirectReadSession(actor(),"ws");return row;
    }))).rejects.toMatchObject({code:"UNKNOWN_LINEAGE"});
    expect(f.db.crmAccount.findFirst).not.toHaveBeenCalled();
  });
  it("binds ambient OAuth origin including absence before awaits",async()=>{
    const user=actor();const origin={kind:"oauth" as const,id:"token-one",workspaceId:"ws",scopeHash:mcpScopesHash(["relationships:read"]),grantEpoch:"0"};
    const session=await runWithMcpOrigin(origin,async()=>createCrmDirectReadSession(user,"ws"));
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"MCP_AUTHORIZATION_REVOKED"});
    await expect(runWithMcpOrigin({...origin,id:"token-two"},()=>assertCrmDirectReadCurrent(session))).rejects.toMatchObject({code:"MCP_AUTHORIZATION_REVOKED"});
  });
  it("rejects changed latest manifest, bytes and native projected payload at delivery",async()=>{
    const row=await seed();const session=createCrmDirectReadSession(actor(),"ws");
    const [view]=await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);
    view.name="FORGED_BODY";
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    view.name="Original account";
    f.tables.crmAccount[0].name="changed";
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    f.tables.crmAccount[0].name="Original account";
    f.tables.artifactInputLineage.push({...f.tables.artifactInputLineage[0],id:"new-original",revision:2});
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  });
  it("checks current credential family scope/version independently of the saved original author",async()=>{
    const row=await seed();const credential={id:"credential",workspaceId:"ws",isActive:true,tokenHash:"synthetic",scopes:["relationships:read"]};
    f.tables.agentCredential.push(credential);
    const agent={kind:"agent",authProvider:"credential",credentialId:credential.id,credentialVersion:mcpCredentialVersion(credential.tokenHash),scopes:[...credential.scopes],workspaceIds:["ws"]} as AppActor;
    const session=createCrmDirectReadSession(agent,"ws");await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);
    credential.scopes=["actions:read"];
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"AGENT_AUTHORIZATION_REVOKED"});
  });
  it("fences a permitted unreturned contact predicate contributor before canonical delivery", async () => {
    const account = await seed(); const contact = await seed("CrmContact", {archivedAt: null});
    const user = actor(); const session = createCrmDirectReadSession(user, "ws");
    const [view] = await admitCrmDirectOriginalRows(session, "CrmAccount", [account]);
    await captureCrmDirectReadContributors(user, "ws", session, () => captureArtifactInputProof(user, "ws", [{kind: "CrmContact", id: contact.id}]));
    const result = await finalizeCrmDirectReadResult(session, {items: [view], total: 1});
    f.db.$queryRaw.mockClear();
    expect(JSON.parse(await serializeCrmDirectReadResult(user, result)).total).toBe(1);
    const calls = f.db.$queryRaw.mock.calls.map(([query]: any[]) => query.sql);
    const contactLock = calls.findIndex((sql: string) => sql.includes('FROM "CrmContact"') && sql.includes("FOR SHARE"));
    const epochLock = calls.findIndex((sql: string) => sql.includes('FROM "SourcePermissionEpoch"') && sql.includes("FOR SHARE"));
    expect(contactLock).toBeGreaterThanOrEqual(0); expect(epochLock).toBeGreaterThan(contactLock);
    f.tables.crmContact[0].name = "changed unreturned contributor";
    await expect(serializeCrmDirectReadResult(user, result)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  });
  it("checks actual source epoch transitions without refreshing an old delivery vector",async()=>{
    const row=await seed();const session=createCrmDirectReadSession(actor(),"ws");await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);
    const epochs=installSourcePermissionEpochFixture(f.db);epochs.bump("ws","CrmAccount",row.id);
    await expect(assertCrmDirectReadCurrent(session)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(f.tables.artifactInputLineage[0].contentHash).toBe(lineageContentFingerprint("CrmAccount",row));
  });
});

it("cannot finalize a retained discarded alias after its original body is changed",async()=>{
  const row=await seed(),user=actor(),session=createCrmDirectReadSession(user,"ws");
  const [view]=await admitCrmDirectOriginalRows(session,"CrmAccount",[row]);
  discardCrmDirectReadProjections(session,[view]);
  expect(isCrmDirectOriginalRow(view)).toBe(false);
  view.name="Forged discarded body";
  await expect(finalizeCrmDirectReadResult(session,{items:[view]})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
});
