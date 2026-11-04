import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { createEventKnowledgeSyncLease } from "./handlers/event-knowledge-sync-lease";
import { handleEventKnowledgeSync } from "./handlers/event-knowledge-sync";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const local = database.hostname === "127.0.0.1" && ((database.port === "63976" && database.pathname === "/corgtex_test") || (database.port === "63973" && database.pathname === "/child_read_test"));
const hosted = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!local && !hosted) || database.searchParams.get("schema") !== "public") throw new Error("Event indexing tests require the assigned disposable fixture.");
beforeEach(truncateAllTables);
afterEach(() => {vi.restoreAllMocks();vi.useRealTimers();});

async function fixture() {
  const workspace = await prisma.workspace.create({ data: { name: "Synthetic event routing", slug: randomUUID() } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic" } });
  await prisma.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" } });
  const actor: AppActor = { kind: "user", user };
  const proposal = await prisma.proposal.create({ data: { workspaceId: workspace.id, authorUserId: user.id,
    title: "Canonical policy", bodyMd: "Current proven cobalt policy." } });
  await prisma.$transaction(tx => recordArtifactInputLineage({ tx, actor, workspaceId: workspace.id,
    artifact: { kind: "Proposal", id: proposal.id }, content: proposal, origin: "HUMAN_ORIGINAL", inputs: [] }));
  const event = await prisma.event.create({ data: { workspaceId: workspace.id, type: "proposal.submitted", aggregateType: "Proposal",
    aggregateId: proposal.id, payload: { secretCanary: "UNTRUSTED_EVENT_PAYLOAD" } } });
  const job = await prisma.workflowJob.create({ data: { workspaceId: workspace.id, type: "knowledge.sync.event", payload: { eventId: event.id },
    status: "RUNNING", lockedBy: "synthetic-event-worker", lockedAt: new Date(), startedAt: new Date(), attempts: 1 } });
  const legacy = await prisma.knowledgeChunk.create({ data: { workspaceId: workspace.id, sourceType: "EVENT", sourceId: event.id, content: "UNTRUSTED_EVENT_PAYLOAD" } });
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async request => {
    await request.authorizeAttempt!({ signal: request.signal! });
    return { embeddings: (Array.isArray(request.input) ? request.input : [request.input]).map(() => Array(1536).fill(0.01)),
      usage: { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, latencyMs: 0,
        estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0" } };
  });
  const run = () => handleEventKnowledgeSync(job.id, { eventId: event.id }, workspace.id, structuredClone(job));
  return { workspace, actor, proposal, event, job, legacy, embed, run };
}

it("retires event payload copies and publishes only the readable canonical proposal", async () => {
  const f = await fixture();
  expect(await f.run()).toMatchObject({ canonical: "Proposal", indexed: 1 });
  const chunks = await prisma.knowledgeChunk.findMany({ where: { workspaceId: f.workspace.id } });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ sourceType: "PROPOSAL", sourceId: f.proposal.id });
  expect(JSON.stringify(chunks)).not.toContain("UNTRUSTED_EVENT_PAYLOAD");
  const proof = await captureArtifactInputProof(f.actor, f.workspace.id, [{ kind: "KnowledgeChunk", id: chunks[0].id, snapshot: chunks[0] }]);
  expect(await isArtifactInputProofReadable(f.actor, f.workspace.id, proof)).toBe(true);
});

it("retires the exact legacy event copy when the canonical aggregate was archived", async () => {
  const f = await fixture();
  await prisma.proposal.update({ where: { id: f.proposal.id }, data: { archivedAt: new Date() } });
  expect(await f.run()).toEqual({ retiredEventCopies: true, canonical: "UNAVAILABLE" });
  expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
  expect(f.embed).not.toHaveBeenCalled();
});

it("rejects takeover before the atomic legacy-copy deletion", async () => {
  const f = await fixture();
  const client = getPrismaClient(); const original = client.$transaction.bind(client);
  let changed = false;
  vi.spyOn(client, "$transaction").mockImplementation((async (work: any, options: any) => {
    if (!changed) {
      changed = true;
      await prisma.workflowJob.update({ where: { id: f.job.id }, data: { attempts: 2, lockedBy: "replacement" } });
    }
    return original(work, options);
  }) as typeof client.$transaction);
  await expect(f.run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(changed).toBe(true);
  expect(await prisma.knowledgeChunk.findUnique({ where: { id: f.legacy.id } })).not.toBeNull();
  expect(f.embed).not.toHaveBeenCalled();
});

it("rejects claim takeover at embedding credentials even if the adapter swallows the guard", async () => {
  const f = await fixture(); let sent = 0; let denial: unknown;
  f.embed.mockImplementationOnce(async request => {
    await prisma.workflowJob.update({ where: { id: f.job.id }, data: { attempts: 2, lockedBy: "replacement" } });
    try { await request.authorizeAttempt!({ signal: request.signal! }); sent++; } catch (error) { denial = error; }
    return { embeddings: [Array(1536).fill(0.01)], usage: { provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0,
      latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0" } };
  });
  await expect(f.run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(denial).toMatchObject({ code: "SOURCE_CHANGED" }); expect(sent).toBe(0);
  expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});

it("does not resolve a cross-workspace approval flow into a proposal", async () => {
  const f = await fixture();
  const other = await prisma.workspace.create({ data: { name: "Other synthetic", slug: randomUUID() } });
  const flow = await prisma.approvalFlow.create({ data: { workspaceId: other.id, subjectType: "PROPOSAL", subjectId: f.proposal.id, mode: "SINGLE" } });
  await prisma.event.update({ where: { id: f.event.id }, data: { type: "approval.finalized", aggregateType: "ApprovalFlow", aggregateId: flow.id } });
  await expect(f.run()).rejects.toMatchObject({ code: "EVENT_KNOWLEDGE_TARGET_UNSUPPORTED" });
  expect(f.embed).not.toHaveBeenCalled();
  expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});

it("does not acknowledge an unproved canonical aggregate as a zero-count success", async () => {
  const f = await fixture();
  await prisma.artifactInputLineage.deleteMany({ where: { workspaceId: f.workspace.id, artifactType: "Proposal", artifactId: f.proposal.id } });
  await expect(f.run()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  expect(f.embed).not.toHaveBeenCalled();
  expect(await prisma.knowledgeChunk.count({ where: { workspaceId: f.workspace.id } })).toBe(0);
});

it("renews the exact claim across a seven-minute provider wait and settles only the acknowledged stamp", async () => {
  const f=await fixture();
  vi.useFakeTimers({toFake:["Date","setInterval","clearInterval"]});
  const lease=createEventKnowledgeSyncLease(f.job);
  const model=f.embed.getMockImplementation()!;
  f.embed.mockImplementationOnce(async request => {
    for(let minute=0;minute<7;minute++){await vi.advanceTimersByTimeAsync(60_000);await lease.readGuard(async()=>{});}
    return model(request);
  });
  try {
    await expect(lease.run(f.run)).resolves.toMatchObject({indexed:1});
    const renewed=await prisma.workflowJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect(renewed.lockedAt!.getTime()).toBeGreaterThanOrEqual(f.job.lockedAt!.getTime()+7*60_000);
    expect(renewed).toMatchObject({attempts:f.job.attempts,lockedBy:f.job.lockedBy,payload:f.job.payload,startedAt:f.job.startedAt});
    await lease.stopAndDrain();
    expect(await lease.settle({status:"COMPLETED",lockedAt:null,lockedBy:null})).toEqual({count:1});
    await vi.advanceTimersByTimeAsync(2*60_000);
    expect(await prisma.workflowJob.findUnique({where:{id:f.job.id}})).toMatchObject({status:"COMPLETED",lockedAt:null,lockedBy:null});
    expect(vi.getTimerCount()).toBe(0);
    expect(await prisma.knowledgeChunk.count({where:{workspaceId:f.workspace.id,sourceType:"PROPOSAL"}})).toBe(1);
  } finally {await lease.dispose();}
});

it("does not renew or settle a reclaimed Event job", async () => {
  const f=await fixture();vi.useFakeTimers({toFake:["Date","setInterval","clearInterval"]});
  const lease=createEventKnowledgeSyncLease(f.job);
  const replacement=await prisma.workflowJob.update({where:{id:f.job.id},data:{attempts:2,lockedBy:"replacement",lockedAt:new Date(Date.now()+1)}});
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(lease.readGuard(async()=>{})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(await lease.settle({status:"FAILED",lockedAt:null,lockedBy:null})).toEqual({count:0});
    expect(await prisma.workflowJob.findUnique({where:{id:f.job.id}})).toEqual(replacement);
  } finally {await lease.dispose();}
});

it("never revives an expired original Event attempt", async () => {
  const f=await fixture();
  const expired=await prisma.workflowJob.update({where:{id:f.job.id},data:{lockedAt:new Date(Date.now()-300_001)}});
  const lease=createEventKnowledgeSyncLease(expired);
  try {
    await expect(lease.run(async()=>{})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(await lease.settle({status:"FAILED"})).toEqual({count:0});
    expect(await prisma.workflowJob.findUnique({where:{id:f.job.id}})).toEqual(expired);
  } finally {await lease.dispose();}
});

it("serializes heartbeat behind the complete source transaction and drains it before settlement", async () => {
  const f=await fixture();vi.useFakeTimers({toFake:["Date","setInterval","clearInterval"]});
  const lease=createEventKnowledgeSyncLease(f.job);
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
  const source=lease.sourceTransactionGuard(()=>prisma.$transaction(async tx=>{
    lease.assertTransactionOwner();
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id=${f.job.id} FOR SHARE`;
    enter();await barrier;
    lease.assertCurrentRow(await tx.workflowJob.findUnique({where:{id:f.job.id}}));
  }));
  try {
    await entered;await vi.advanceTimersByTimeAsync(60_000);
    expect((await prisma.workflowJob.findUniqueOrThrow({where:{id:f.job.id}})).lockedAt).toEqual(f.job.lockedAt);
    release();await source;await lease.readGuard(async()=>{});
    const renewed=await prisma.workflowJob.findUniqueOrThrow({where:{id:f.job.id}});
    expect(renewed.lockedAt!.getTime()).toBeGreaterThan(f.job.lockedAt!.getTime());
    await lease.stopAndDrain();expect(await lease.settle({status:"COMPLETED",lockedAt:null,lockedBy:null})).toEqual({count:1});
    await vi.advanceTimersByTimeAsync(120_000);expect(vi.getTimerCount()).toBe(0);
    expect(await prisma.workflowJob.findUnique({where:{id:f.job.id}})).toMatchObject({status:"COMPLETED",lockedAt:null});
  } finally {release();await source;await lease.dispose();}
});

it("does not renew after a database row-lock wait consumes the remaining lease", async () => {
  const f=await fixture();vi.useFakeTimers({toFake:["Date","setInterval","clearInterval"]});
  const lease=createEventKnowledgeSyncLease(f.job);
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
  const client=getPrismaClient();
  const blocker=client.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "WorkflowJob" WHERE id=${f.job.id} FOR UPDATE`;
    enter();await barrier;
  });
  try {
    await entered;
    const transactions=vi.spyOn(client,"$transaction");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transactions).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date(f.job.lockedAt!.getTime()+300_001));
    release();await blocker;
    await expect(lease.readGuard(async()=>{})).rejects.toMatchObject({code:"SOURCE_CHANGED"});
    expect(await lease.settle({status:"FAILED"})).toEqual({count:0});
    expect(await prisma.workflowJob.findUnique({where:{id:f.job.id}})).toEqual(f.job);
  } finally {release();await blocker;await lease.dispose();}
});
