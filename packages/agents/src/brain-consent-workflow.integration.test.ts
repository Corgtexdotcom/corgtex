import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput, addConversationTurn, captureArtifactInputProof,
  brainExportHash, exportConversationAnswerToBrain, isArtifactInputProofReadable, isArtifactInputProofPubliclyShareable,
  isBrainExportProofWorkspaceShareable, withBrainExportWorker, readableArtifactIds } from "@corgtex/domain";
import { runAgentWorkflowJob } from "../../workflows/src/handlers/agent-dispatch";

beforeEach(truncateAllTables);
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data: {slug: `consent-worker-${randomUUID()}`, name: "Synthetic confirmed export", plan: "PAYG_AI"}});
  const users = await Promise.all(["owner", "reader"].map(name => prisma.user.create({data: {email: `${name}-${randomUUID()}@example.test`, passwordHash: "synthetic"}})));
  await prisma.member.createMany({data: users.map(user => ({workspaceId: workspace.id, userId: user.id, role: "ADMIN"}))});
  const owner: AppActor = {kind: "user", user: users[0]}, reader: AppActor = {kind: "user", user: users[1]};
  const session = await createConversation(owner, {workspaceId: workspace.id});
  const prompt = await createConversationPromptInput(owner, {workspaceId: workspace.id, conversationId: session.id, content: "PRIVATE_PROMPT_CANARY"});
  const promptProof = await captureArtifactInputProof(owner, workspace.id, [{kind: "ConversationPromptInput", id: prompt.id}]);
  const turn = await addConversationTurn(owner, {workspaceId: workspace.id, conversationId: session.id, promptInputId: prompt.id,
    userMessage: prompt.content, assistantMessage: "Confirmed company answer.", lineageRoots: promptProof});
  const exported = await exportConversationAnswerToBrain(owner, {workspaceId: workspace.id, conversationId: session.id, outputTurnId: turn.id,
    expectedOutputHash: brainExportHash(turn.assistantMessage), title: "Confirmed answer", transcriptMode: "NONE", selectedTurns: [], requestId: randomUUID()});
  const job = await prisma.workflowJob.create({data: {workspaceId: workspace.id, type: "agent.brain-absorb", payload: {sourceId: exported.sourceId},
    status: "RUNNING", attempts: 1, lockedBy: "synthetic-export-worker", lockedAt: new Date()}});
  const claim = {workspaceId: workspace.id, sourceId: exported.sourceId, jobId: job.id, owner: job.lockedBy!, attempt: job.attempts};
  const extract = vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({output: {articleType: "PROCESS",
    createNew: {title: "Confirmed company answer", slug: "confirmed-answer"}, summary: "Confirmed answer"}} as never);
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "Confirmed company answer."} as never);
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => Array(1536).fill(0.01)),
    usage: {provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0, latencyMs: 0,
      estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  return {workspace, owner, reader, exported, promptProof, job, claim, extract, chat, embed};
}
it("runs a real claimed consent job through absorption and ordinary article/chunk reads without exposing private prompts", async () => {
  const f = await fixture();
  const roots = await captureArtifactInputProof(f.owner, f.workspace.id, [{kind: "BrainSource", id: f.exported.sourceId}]);
  const bootstrap: AppActor = {kind: "agent", authProvider: "bootstrap", label: "confirmed-brain-export", workspaceIds: [f.workspace.id]};
  expect(await isArtifactInputProofReadable(bootstrap, f.workspace.id, roots)).toBe(false);
  await withBrainExportWorker(f.claim, async actor => {
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, roots)).toBe(true);
    expect(await isArtifactInputProofReadable({...actor}, f.workspace.id, roots)).toBe(false);
    expect(await isArtifactInputProofReadable(actor, f.workspace.id, f.promptProof)).toBe(false);
    expect(await isArtifactInputProofPubliclyShareable(actor, f.workspace.id, roots)).toBe(false);
    expect(await isBrainExportProofWorkspaceShareable(actor, f.workspace.id, roots)).toBe(true);
  });
  const result = await runAgentWorkflowJob(f.job, f.job.lockedBy!);
  expect(result).toMatchObject({status: "COMPLETED"});
  expect(f.extract).toHaveBeenCalled(); expect(f.chat).toHaveBeenCalled(); expect(f.embed).toHaveBeenCalled();
  expect(JSON.stringify(f.extract.mock.calls)).not.toContain("PRIVATE_PROMPT_CANARY");
  const article = await prisma.brainArticle.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  expect(article.bodyMd).toBe("Confirmed company answer.");
  expect(await readableArtifactIds(f.reader, f.workspace.id, "BrainArticle", [article])).toEqual(new Set([article.id]));
  const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id, sourceId: article.id}});
  expect(chunks.length).toBeGreaterThan(0);
  expect(await readableArtifactIds(f.reader, f.workspace.id, "KnowledgeChunk", chunks)).toEqual(new Set(chunks.map(chunk => chunk.id)));
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "COMPLETED"}});
  await expect(withBrainExportWorker(f.claim, async () => true)).rejects.toMatchObject({code: "BRAIN_EXPORT_JOB_LOST"});
  expect(await readableArtifactIds(f.reader, f.workspace.id, "BrainArticle", [article])).toEqual(new Set([article.id]));
  await prisma.brainSource.update({where: {id: f.exported.sourceId}, data: {archivedAt: new Date()}});
  await prisma.brainSource.update({where: {id: f.exported.sourceId}, data: {archivedAt: null}});
  expect(await readableArtifactIds(f.reader, f.workspace.id, "BrainArticle", [article])).toEqual(new Set());
  expect((await prisma.brainArticle.findUniqueOrThrow({where: {id: article.id}})).bodyMd).toBe(article.bodyMd);
}, 120_000);
it.each(["reclaim", "source-policy", "owner-membership"])("withholds publication when %s changes after model preparation", async boundary => {
  const f = await fixture();
  f.chat.mockImplementation(async () => {
    if (boundary === "reclaim") await prisma.workflowJob.update({where: {id: f.job.id}, data: {attempts: 2, lockedBy: "replacement-worker"}});
    else if (boundary === "source-policy") {
      await prisma.brainSource.update({where: {id: f.exported.sourceId}, data: {informationCategory: "CHANGED"}});
      await prisma.brainSource.update({where: {id: f.exported.sourceId}, data: {informationCategory: "GENERAL"}});
    } else {
      const member = await prisma.member.findFirstOrThrow({where: {workspaceId: f.workspace.id, userId: f.owner.kind === "user" ? f.owner.user.id : ""}});
      await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
      await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
    }
    return {content: "Stale model output must not publish"} as never;
  });
  await runAgentWorkflowJob(f.job, f.job.lockedBy!).catch(() => undefined);
  expect(f.chat).toHaveBeenCalled();
  expect(await prisma.brainArticle.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect((await prisma.brainSource.findUniqueOrThrow({where: {id: f.exported.sourceId}})).absorbedAt).toBeNull();
}, 120_000);
it("rejects wrong claim identity, source, workspace and completed claims before model work", async () => {
  const f = await fixture();
  for (const change of [{owner: "other"}, {attempt: 2}, {sourceId: randomUUID()}, {workspaceId: randomUUID()}]) {
    await expect(withBrainExportWorker({...f.claim, ...change}, async () => true)).rejects.toThrow();
  }
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "COMPLETED"}});
  await expect(withBrainExportWorker(f.claim, async () => true)).rejects.toMatchObject({code: "BRAIN_EXPORT_JOB_LOST"});
  expect(f.extract).not.toHaveBeenCalled();
});
