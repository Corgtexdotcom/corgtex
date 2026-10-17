import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPrismaClient, prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { captureArtifactInputProof, isArtifactInputProofReadable, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { handleEventKnowledgeSync } from "./handlers/event-knowledge-sync";

const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
const local = database.hostname === "127.0.0.1" && database.port === "63976" && database.pathname === "/corgtex_test";
const hosted = process.env.GITHUB_ACTIONS === "true" && database.hostname === "localhost" && database.port === "5432" && database.pathname === "/corgtex_test";
if ((!local && !hosted) || database.searchParams.get("schema") !== "public") throw new Error("Event indexing tests require the assigned disposable fixture.");
beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());

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
