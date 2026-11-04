import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, getPrismaClient, type AppActor } from "@corgtex/shared";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { collectWorkItemReadSnapshot, lineageContentFingerprint, captureArtifactInputProof, recordArtifactInputLineage } from "./source-lineage";
import { beginOAuthKnowledgeSync } from "./oauth-provider-native";
import { withOAuthKnowledgeSyncLease } from "./oauth-knowledge-sync-lease";
import { capturePermissionEpochs } from "./source-permission-epochs";
import { prepareArtifactCommitPreflight, withArtifactCommitPreflight } from "./artifact-commit-preflight";
import { listActions } from "./actions";
import { listProposals } from "./proposals";
import { listTensions } from "./tensions";

type Kind = "Action" | "Proposal" | "Tension";
beforeEach(truncateAllTables);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(kind: Kind, count = 101) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic list snapshot", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@snapshot.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const delegate: "action" | "proposal" | "tension" = kind === "Action" ? "action" : kind === "Proposal" ? "proposal" : "tension";
  const transaction = prisma.$transaction.bind(prisma);
  const seed = async (tx: Prisma.TransactionClient, id: string, title: string, proven = true) => {
    const data = {id, title, workspaceId: workspace.id, authorUserId: user.id, bodyMd: "Synthetic body", status: "OPEN" as const, isPrivate: false};
    const row = kind === "Action" ? await tx.action.create({data}) : kind === "Proposal" ? await tx.proposal.create({data}) : await tx.tension.create({data});
    if (proven) await recordArtifactInputLineage({tx, actor, workspaceId: workspace.id, artifact: {kind, id}, content: row, origin: "HUMAN_ORIGINAL", inputs: []});
    return row;
  };
  await transaction(async tx => {
    for (let index = 0; index < count; index++) await seed(tx, `row-${String(index).padStart(3,"0")}`, `Item ${String(index).padStart(3,"0")}`);
    await seed(tx,"row-denied","Item 050 denied",false);
  }, {timeout: 30_000});
  const list = (ranked = false, take = 105) => kind === "Action" ? listActions(actor,workspace.id,{sort:"alpha",take})
    : kind === "Proposal" ? listProposals(actor,workspace.id,{sort:"alpha",take})
    : listTensions(actor,workspace.id,{...(ranked ? {} : {sort:"alpha" as const}),take});
  // Initialize any first-use epoch keys before installing the concurrent writer.
  // The writer barrier then measures one successful collection attempt.
  if (count) await list(false,105);
  return {workspace,member,actor,delegate,transaction,seed,list};
}

/** Intercept the actual candidate query in both the historical global-client
 * reader and the new transaction-client reader, without changing query results. */
function afterCandidatePage(f: Awaited<ReturnType<typeof fixture>>, page: number, mutate: () => Promise<void>) {
  let pages = 0, mutations = 0;
  const writer = new AsyncResource("independent-work-item-writer");
  const after = async (args: any, rows: any[]) => {
    if (args.take === 100 && args.orderBy && ++pages === page) {mutations++; await writer.runInAsyncScope(mutate);}
    return rows;
  };
  const originalFind = (prisma[f.delegate].findMany as any).bind(prisma[f.delegate]);
  vi.spyOn(prisma[f.delegate], "findMany").mockImplementation(((args: any) => originalFind(args).then((rows: any[]) => after(args,rows))) as any);
  vi.spyOn(getPrismaClient(),"$transaction").mockImplementation(((operation: any, options: any) => f.transaction(async tx => operation(new Proxy(tx, {
    get(target, property) {
      if (property === f.delegate) return new Proxy(target[f.delegate], {get(model, method) {
        if (method === "findMany") return (args: any) => (model.findMany as any)(args).then((rows: any[]) => after(args,rows));
        const value = Reflect.get(model,method); return typeof value === "function" ? value.bind(model) : value;
      }});
      const value = Reflect.get(target,property); return typeof value === "function" ? value.bind(target) : value;
    },
  })), options)) as typeof prisma.$transaction);
  return () => ({pages, mutations});
}

it.each(["Action","Proposal","Tension"] as const)("keeps %s page and exact total in one snapshot across an atomic ahead-and-behind insertion", async kind => {
  const f = await fixture(kind);
  const observed = afterCandidatePage(f,1,() => f.transaction(async tx => {
    await f.seed(tx,"row--new","AAA inserted ahead"); await f.seed(tx,"row-zznew","ZZZ inserted behind");
  }));
  const result = await f.list();
  expect(observed().mutations).toBe(1);
  expect(result.total).toBe(101);
  expect(result.items).toHaveLength(101);
  expect(result.items.some(row => ["row--new","row-zznew","row-denied"].includes(row.id))).toBe(false);
  expect(await (prisma[f.delegate].count as any)({where:{workspaceId:f.workspace.id}})).toBe(104);
}, 60_000);

it("keeps tension rank passes in the same snapshot across inserted vote-rank candidates", async () => {
  const f = await fixture("Tension");
  const observed = afterCandidatePage(f,1,() => f.transaction(async tx => {
    await f.seed(tx,"row--new","Ahead"); await f.seed(tx,"row-zznew","Behind");
  }));
  const result = await f.list(true);
  expect(observed().mutations).toBe(1);
  expect(result.total).toBe(101);
  expect(result.items).toHaveLength(101);
  expect(new Set(result.items.map(row => row.id)).size).toBe(101);
  expect(result.items.some(row => ["row--new","row-zznew","row-denied"].includes(row.id))).toBe(false);
}, 60_000);

it.each(["Action","Proposal","Tension"] as const)("fails the original %s proof instead of silently omitting a row moved ahead of the cursor", async kind => {
  const f = await fixture(kind);
  const observed = afterCandidatePage(f,1,() => f.transaction(async tx => {
    const row = await (tx[f.delegate].update as any)({where:{id:"row-100"},data:{title:"AAA moved ahead"}});
    await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind,id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
  }));
  await expect(f.list()).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(observed().mutations).toBe(1);
  expect((await (prisma[f.delegate].findUniqueOrThrow as any)({where:{id:"row-100"}})).title).toBe("AAA moved ahead");
}, 60_000);

it.each(["head","caller-aba"] as const)("keeps original off-page %s authority through the final release", async mode => {
  const f = await fixture("Action");
  const observed = afterCandidatePage(f,2,() => f.transaction(async tx => {
    if (mode === "caller-aba") {
      await tx.member.update({where:{id:f.member.id},data:{isActive:false}});
      await tx.member.update({where:{id:f.member.id},data:{isActive:true}});
    } else {
      const row = await tx.action.findUniqueOrThrow({where:{id:"row-000"}});
      await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"Action",id:row.id},content:row,origin:"HUMAN_ORIGINAL",inputs:[]});
    }
  }));
  await expect(f.list(false,0)).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(observed().mutations).toBe(1);
  if (mode === "head") expect(await prisma.artifactInputLineage.count({where:{workspaceId:f.workspace.id,artifactType:"Action",artifactId:"row-000"}})).toBe(2);
  else expect((await prisma.member.findUniqueOrThrow({where:{id:f.member.id}})).isActive).toBe(true);
}, 60_000);


it.each([false,true])("replays original native provider inputs outside both list transactions (late loss: %s)", async revoke => {
  const f = await fixture("Action",0);
  const connection = await prisma.oAuthConnection.create({data:{workspaceId:f.workspace.id,userId:f.actor.user.id,
    provider:"GOOGLE",providerAccountId:"snapshot-account",accessToken:"synthetic-token",expiresAt:new Date(Date.now()+3600_000),
    scopes:["https://www.googleapis.com/auth/drive.file"],syncSettings:{documents:{enabled:true,selectedDriveIds:["snapshot-doc"]}}}});
  const job = await prisma.workflowJob.create({data:{workspaceId:f.workspace.id,type:"oauth.documents.sync",payload:{connectionId:connection.id},
    status:"RUNNING",lockedBy:"snapshot-worker",lockedAt:new Date(),startedAt:new Date(),attempts:1}});
  let listing = false, inTransaction = false, replays = 0, revoked = false;
  vi.stubGlobal("fetch",vi.fn(async (input: string | URL | Request) => {
    if (listing) {
      expect(inTransaction).toBe(false);
      replays++;
      if (revoke && !revoked) {
        revoked = true;
        await prisma.oAuthConnection.update({where:{id:connection.id},data:{syncSettings:{documents:{enabled:false}}}});
        await prisma.oAuthConnection.update({where:{id:connection.id},data:{syncSettings:connection.syncSettings as Prisma.InputJsonValue}});
      }
    }
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo") return Response.json({id:"snapshot-account"});
    if (url.startsWith("https://www.googleapis.com/drive/v3/files/snapshot-doc?fields=")) return Response.json({id:"snapshot-doc",name:"Synthetic input",mimeType:"text/plain"});
    if (url === "https://www.googleapis.com/drive/v3/files/snapshot-doc?alt=media") return new Response("Original synthetic provider body");
    throw new Error("Unexpected synthetic provider endpoint");
  }));
  const capture = await withOAuthKnowledgeSyncLease(job,() => beginOAuthKnowledgeSync({workspaceId:f.workspace.id,connectionId:connection.id,
    workflowJobId:job.id,kind:"documents",expectedClaim:job}));
  const document = capture.documents[0];
  const roots = await captureArtifactInputProof(f.actor,f.workspace.id,[{kind:"Document",id:document.id,snapshot:document}]);
  const preflight = await prepareArtifactCommitPreflight(f.actor,f.workspace.id,roots);
  await f.transaction(tx => withArtifactCommitPreflight(f.actor,f.workspace.id,tx,roots,preflight,async () => {
    const action = await f.seed(tx,"row-provider","Provider-derived action",false);
    await recordArtifactInputLineage({tx,actor:f.actor,workspaceId:f.workspace.id,artifact:{kind:"Action",id:action.id},
      content:action,origin:"DERIVED",inputs:[],inheritedRoots:roots});
  }));
  await prisma.workflowJob.update({where:{id:job.id},data:{status:"COMPLETED",lockedBy:null,lockedAt:null}});
  vi.spyOn(getPrismaClient(),"$transaction").mockImplementation(((operation: any,options: any) => f.transaction(async tx => {
    inTransaction = true;
    try { return await operation(tx); } finally { inTransaction = false; }
  },options)) as typeof prisma.$transaction);
  listing = true;
  if (revoke) await expect(f.list()).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  else {
    const result = await f.list();
    expect(result.total).toBe(1);
    expect(result.items.map(row => row.id)).toEqual(["row-provider"]);
  }
  expect(replays).toBeGreaterThan(0);
  expect(revoked).toBe(revoke);
},60_000);


it("discards first-use epoch initialization and collects from a fresh read-only snapshot", async () => {
  const f = await fixture("Action",0);
  let attempts = 0;
  const result = await collectWorkItemReadSnapshot(f.workspace.id,async tx => {
    attempts++;
    const proof = await capturePermissionEpochs(tx,f.workspace.id,[{kind:"WorkItemSnapshotFixture",id:"first-use"}]);
    const rows = await tx.$queryRaw<Array<{read_only:string}>>`SELECT current_setting('transaction_read_only') AS read_only`;
    return {proof,readOnly:rows[0].read_only,attempt:attempts};
  });
  expect(result).toMatchObject({attempt:2,readOnly:"on",proof:{entries:[{kind:"WorkItemSnapshotFixture",id:"first-use",epoch:"0"}]}});
  expect(await prisma.sourcePermissionEpoch.count({where:{workspaceId:f.workspace.id,sourceKind:"WorkItemSnapshotFixture"}})).toBe(1);
});

it("bounds repeated epoch disappearance even when new keys are interleaved", async () => {
  const f = await fixture("Action",0);
  let attempts = 0;
  const writer = new AsyncResource("independent-epoch-removal");
  await expect(collectWorkItemReadSnapshot(f.workspace.id,async tx => {
    attempts++;
    await writer.runInAsyncScope(() => prisma.sourcePermissionEpoch.deleteMany({where:{workspaceId:f.workspace.id,sourceKind:"WorkItemSnapshotFixture",sourceId:"same-key"}}));
    return capturePermissionEpochs(tx,f.workspace.id,[{kind:"WorkItemSnapshotFixture",id:"same-key"},{kind:"WorkItemSnapshotFixture",id:`missing-${attempts}`}]);
  })).rejects.toMatchObject({code:"SOURCE_CHANGED"});
  expect(attempts).toBe(4);
  expect(await prisma.sourcePermissionEpoch.count({where:{workspaceId:f.workspace.id,sourceKind:"WorkItemSnapshotFixture"}})).toBe(3);
});


it("returns the first request for 401 pre-epoch human originals without a warm-up", async () => {
  const f = await fixture("Action",0);
  await prisma.action.createMany({data:Array.from({length:401},(_,index) => ({id:`legacy-${String(index).padStart(3,"0")}`,
    workspaceId:f.workspace.id,authorUserId:f.actor.user.id,title:`Legacy ${String(index).padStart(3,"0")}`,isPrivate:false,status:"OPEN"}))});
  const rows = await prisma.action.findMany({where:{workspaceId:f.workspace.id,id:{startsWith:"legacy-"}}});
  await prisma.artifactInputLineage.createMany({data:rows.map(row => ({workspaceId:f.workspace.id,artifactType:"Action",artifactId:row.id,
    revision:1,origin:"HUMAN_ORIGINAL",contentHash:lineageContentFingerprint("Action",row),inputsJson:[],rootsJson:[]}))});
  // Faithful pre-migration state: valid independent human manifests, no epoch vector or own counters.
  await prisma.sourcePermissionEpoch.deleteMany({where:{workspaceId:f.workspace.id,sourceKind:"Action"}});
  expect(await prisma.sourcePermissionEpoch.count({where:{workspaceId:f.workspace.id,sourceKind:"Action"}})).toBe(0);
  expect(await f.list(false,3)).toMatchObject({total:401,items:[{id:"legacy-000"},{id:"legacy-001"},{id:"legacy-002"}]});
  expect(await prisma.sourcePermissionEpoch.count({where:{workspaceId:f.workspace.id,sourceKind:"Action"}})).toBe(401);
},60_000);
