import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, resetLocalCacheStore, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle } from "../../domain/src/brain";
import { lineageContentFingerprint, recordArtifactInputLineage } from "../../domain/src/source-lineage";
import { syncBrainArticleKnowledge } from "./chunks";
import { answerKnowledgeQuestion, searchIndexedKnowledge } from "./retrieval";

const usage = {provider: "fixture", model: "fixture", inputTokens: 1, outputTokens: 0, latencyMs: 0,
  estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"};
beforeEach(async () => {
  await truncateAllTables();
  resetLocalCacheStore();
  vi.stubEnv("KNOWLEDGE_SEARCH_PROVIDER", "postgres");
  vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]), usage}));
  vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({documents, topK}) => ({results: documents.slice(0, topK).map((document, index) => ({index, score: 1 - index * 0.1, document})), usage}));
  vi.spyOn(defaultModelGateway, "chat").mockResolvedValue({content: "Synthetic permitted answer", usage});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(deniedCount = 5001) {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic retrieval window", slug: randomUUID()}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user};
  const articles: Awaited<ReturnType<typeof createArticle>>[] = [];
  for (const slug of ["first", "tail"]) {
    const article = await createArticle(actor, {workspaceId: workspace.id, title: `Readable policy ${slug}`, slug,
      bodyMd: `Synthetic policy ${slug}`, type: "PROJECT", authority: "REFERENCE"});
    await syncBrainArticleKnowledge({workspaceId: workspace.id, articleId: article.id, lineageActor: actor});
    articles.push(article);
  }
  const original = await Promise.all(articles.map(article => prisma.knowledgeChunk.findFirstOrThrow({where: {workspaceId: workspace.id, sourceId: article.id}})));
  const first = await prisma.knowledgeChunk.update({where: {id: original[0].id}, data: {createdAt: new Date("2026-10-15T00:00:00Z")}});
  const tail = await prisma.knowledgeChunk.update({where: {id: original[1].id}, data: {createdAt: new Date("2026-10-13T00:00:00Z")}});
  for (const chunk of [first, tail]) await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor, workspaceId: workspace.id,
    artifact: {kind: "KnowledgeChunk", id: chunk.id}, content: chunk, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: chunk.sourceId}]}));
  for (let offset = 0; offset < deniedCount; offset += 100) await prisma.knowledgeChunk.createMany({data:
    Array.from({length: Math.min(100, deniedCount - offset)}, (_, i) => ({id: `denied-${String(offset + i).padStart(6, "0")}`,
      workspaceId: workspace.id, sourceType: "BRAIN_ARTICLE", sourceId: articles[1].id, sourceTitle: "Unproved child",
      chunkIndex: offset + i, createdAt: new Date("2026-10-14T00:00:00Z"), content: "DENIED_CANARY policy",
      embedding: [1, 0], tokenCount: 3, metadata: {sourceContentHash: lineageContentFingerprint("BrainArticle", articles[1])}}))});
  vi.mocked(defaultModelGateway.embed).mockClear();
  return {workspaceId: workspace.id, member, actor, first, tail};
}

it("rejects incomplete raw search and answer windows before model dispatch", async () => {
  const f = await fixture();
  const reads = vi.spyOn(prisma.knowledgeChunk, "findMany");
  const query = {actor: f.actor, workspaceId: f.workspaceId, query: "policy", limit: 1};
  await expect(searchIndexedKnowledge(query)).rejects.toMatchObject({code: "KNOWLEDGE_SCAN_LIMIT"});
  const pages = reads.mock.calls.map(([args]) => args).filter(args => Array.isArray(args?.orderBy) && args.orderBy.length === 3);
  expect(pages).toHaveLength(11);
  expect(pages.slice(0, -1).every(args => args?.take === 500)).toBe(true);
  expect(pages.at(-1)?.take).toBe(1);
  await expect(answerKnowledgeQuestion({actor: f.actor, workspaceId: f.workspaceId, question: "policy", limit: 1}))
    .rejects.toMatchObject({code: "KNOWLEDGE_SCAN_LIMIT"});
  expect(defaultModelGateway.embed).not.toHaveBeenCalled();
  expect(defaultModelGateway.rerank).not.toHaveBeenCalled();
  expect(defaultModelGateway.chat).not.toHaveBeenCalled();
}, 120_000);

it.each(["body", "head", "caller epoch"] as const)("withholds original candidates when %s changes while replenishing later pages", async mode => {
  const f = await fixture(501);
  const findMany = prisma.knowledgeChunk.findMany.bind(prisma.knowledgeChunk);
  let changed = false;
  vi.spyOn(prisma.knowledgeChunk, "findMany").mockImplementation(((args: Prisma.KnowledgeChunkFindManyArgs = {}) => {
    const work = async () => {
      const rows = await findMany(args);
      if (!changed && args.take === 500 && args.where?.AND && rows.some(row => row.id === f.tail.id)) {
        changed = true;
        if (mode === "body") await prisma.knowledgeChunk.update({where: {id: f.first.id}, data: {content: "Changed original bytes"}});
        if (mode === "head") await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
          artifact: {kind: "KnowledgeChunk", id: f.first.id}, content: f.first, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: f.first.sourceId}]}));
        if (mode === "caller epoch") {
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: false}});
          await prisma.member.update({where: {id: f.member.id}, data: {isActive: true}});
        }
      }
      return rows;
    };
    return work() as ReturnType<typeof prisma.knowledgeChunk.findMany>;
  }) as typeof prisma.knowledgeChunk.findMany);
  const result = await searchIndexedKnowledge({actor: f.actor, workspaceId: f.workspaceId, query: "policy", limit: 1});
  expect(changed).toBe(true);
  expect(result).toEqual([]);
  expect(defaultModelGateway.embed).not.toHaveBeenCalled();
  expect(defaultModelGateway.rerank).not.toHaveBeenCalled();
}, 120_000);

it.each(["rerank", "answer"] as const)("withholds output when an uncited original head changes during %s", async phase => {
  const f = await fixture(0);
  const replaceHead = () => prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "KnowledgeChunk", id: f.tail.id}, content: f.tail, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: f.tail.sourceId}]}));
  if (phase === "rerank") vi.mocked(defaultModelGateway.rerank).mockImplementationOnce(async () => {
    await replaceHead();
    return {results: [{index: 0, score: 1, document: "Synthetic policy first"}], usage};
  });
  else vi.mocked(defaultModelGateway.chat).mockImplementationOnce(async () => {
    await replaceHead();
    return {content: "WITHHELD_HEAD_CANARY", usage};
  });
  if (phase === "rerank") expect(await searchIndexedKnowledge({actor: f.actor, workspaceId: f.workspaceId, query: "policy", limit: 1})).toEqual([]);
  else expect(await answerKnowledgeQuestion({actor: f.actor, workspaceId: f.workspaceId, question: "policy", limit: 1}))
    .toEqual({answer: "I could not find relevant indexed knowledge for that question.", citations: []});
});

it("rebuilds both persisted caches after an uncited original head is replaced", async () => {
  const f = await fixture(0);
  const query = {actor: f.actor, workspaceId: f.workspaceId, question: "policy", limit: 1};
  const answer = await answerKnowledgeQuestion(query);
  expect(answer.citations.map(row => row.chunkId)).toEqual([f.first.id]);
  expect(await answerKnowledgeQuestion(query)).toEqual(answer);
  expect(defaultModelGateway.chat).toHaveBeenCalledOnce();
  expect(defaultModelGateway.rerank).toHaveBeenCalledOnce();
  await prisma.$transaction(tx => recordArtifactInputLineage({tx, actor: f.actor, workspaceId: f.workspaceId,
    artifact: {kind: "KnowledgeChunk", id: f.tail.id}, content: f.tail, origin: "DERIVED", inputs: [{kind: "BrainArticle", id: f.tail.sourceId}]}));
  expect(await answerKnowledgeQuestion(query)).toEqual(answer);
  expect(defaultModelGateway.chat).toHaveBeenCalledTimes(2);
  expect(defaultModelGateway.rerank).toHaveBeenCalledTimes(2);
});
