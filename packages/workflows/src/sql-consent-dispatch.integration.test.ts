import { randomUUID } from "node:crypto";
import type { WorkflowJob } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createConversation, createConversationPromptInput, addConversationTurn, captureArtifactInputProof,
  brainExportHash, exportConversationAnswerToBrain, readableArtifactIds } from "@corgtex/domain";
import { dispatchPendingEvents, runPendingJobs } from "./outbox";

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
  // Preserve the real authenticated export event and derive its production jobs.
  // Other synthetic setup permission events are outside this dispatch scenario.
  const event = await prisma.event.findFirstOrThrow({where: {workspaceId: workspace.id, type: "brain-source.created", aggregateId: exported.sourceId}});
  await prisma.event.updateMany({where: {workspaceId: workspace.id, id: {not: event.id}}, data: {availableAt: new Date("2099-01-01")}});
  expect(await dispatchPendingEvents("synthetic-export-worker")).toBe(1);
  expect((await prisma.event.findUniqueOrThrow({where: {id: event.id}})).status).toBe("DISPATCHED");
  const job = await prisma.workflowJob.findFirstOrThrow({where: {workspaceId: workspace.id, type: "agent.brain-absorb", eventId: event.id}});
  expect(job).toMatchObject({status: "PENDING", attempts: 0, lockedBy: null});
  const extract = vi.spyOn(defaultModelGateway, "extract").mockResolvedValue({output: {articleType: "PROCESS",
    createNew: {title: "Confirmed company answer", slug: "confirmed-answer"}, summary: "Confirmed answer"}} as never);
  const chat = vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "Confirmed company answer."} as never);
  const embed = vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => Array(1536).fill(0.01)),
    usage: {provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0, latencyMs: 0,
      estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  return {workspace, owner, reader, exported, promptProof, job, extract, chat, embed};
}
it("dispatches a real authenticated export event through the default outbox and ordinary member reads", async () => {
  const timezone = await prisma.$queryRaw<Array<{TimeZone: string}>>`SHOW TimeZone`;
  console.info("Consent dispatch database timezone:", timezone[0].TimeZone);
  const f = await fixture();
  expect(await runPendingJobs("synthetic-export-worker")).toBe(1);
  const job = await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}});
  expect({status: job.status, error: job.error, attempts: job.attempts}).toEqual({status: "COMPLETED", error: null, attempts: 1});
  expect(f.extract).toHaveBeenCalled();
  expect(f.chat).toHaveBeenCalled();
  expect(f.embed).toHaveBeenCalled();
  expect(JSON.stringify(f.extract.mock.calls)).not.toContain("PRIVATE_PROMPT_CANARY");
  const article = await prisma.brainArticle.findFirstOrThrow({where: {workspaceId: f.workspace.id}});
  expect(await readableArtifactIds(f.reader, f.workspace.id, "BrainArticle", [article])).toEqual(new Set([article.id]));
  const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: f.workspace.id, sourceId: article.id}});
  expect(chunks.length).toBeGreaterThan(0);
  expect(await readableArtifactIds(f.reader, f.workspace.id, "KnowledgeChunk", chunks)).toEqual(new Set(chunks.map(chunk => chunk.id)));
}, 120_000);

it("preserves the replacement claim when consent publication loses its job after model preparation", async () => {
  const f = await fixture();
  let replacement: WorkflowJob | undefined;
  f.chat.mockImplementation(async () => {
    replacement = await prisma.workflowJob.update({where: {id: f.job.id}, data: {attempts: 2,
      lockedBy: "replacement-worker", lockedAt: new Date(), error: "replacement claim marker"}});
    return {content: "Stale output must not publish"} as never;
  });
  expect(await runPendingJobs("synthetic-export-worker")).toBe(1);
  expect(f.chat).toHaveBeenCalled();
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toEqual(replacement!);
  expect(await prisma.brainArticle.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect(await prisma.knowledgeChunk.count({where: {workspaceId: f.workspace.id}})).toBe(0);
  expect((await prisma.brainSource.findUniqueOrThrow({where: {id: f.exported.sourceId}})).absorbedAt).toBeNull();
}, 120_000);

it("keeps a current export lease unclaimed and reclaims only an expired attempt", async () => {
  const f = await fixture();
  const current = await prisma.workflowJob.update({where: {id: f.job.id}, data: {status: "RUNNING", attempts: 1,
    lockedBy: "current-worker", lockedAt: new Date()}});
  expect(await runPendingJobs("next-worker")).toBe(0);
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toEqual(current);
  expect(f.extract).not.toHaveBeenCalled();
  await prisma.workflowJob.update({where: {id: f.job.id}, data: {lockedAt: new Date(Date.now() - 6 * 60_000)}});
  expect(await runPendingJobs("next-worker")).toBe(1);
  expect(await prisma.workflowJob.findUniqueOrThrow({where: {id: f.job.id}})).toMatchObject({status: "COMPLETED", attempts: 2, error: null});
  expect(f.embed).toHaveBeenCalled();
}, 120_000);
