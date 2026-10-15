import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { KnowledgeSourceType, Prisma } from "@prisma/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma, type AppActor } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { truncateAllTables } from "../../shared/src/db-test-utils";
import { createArticle } from "../../domain/src/brain";
import { createDocument } from "../../domain/src/documents";
import { lineageContentFingerprint } from "../../domain/src/source-lineage";
import { reindexWorkspace, syncBrainArticleKnowledge, syncDocumentKnowledge } from "./chunks";
import { searchIndexedKnowledge } from "./retrieval";

beforeEach(async () => {
  await truncateAllTables();
  vi.spyOn(defaultModelGateway, "embed").mockImplementation(async ({input}) => ({embeddings: (Array.isArray(input) ? input : [input]).map(() => [1, 0]),
    usage: {provider: "fixture", model: "fixture-embed", inputTokens: 1, outputTokens: 0, latencyMs: 0,
      estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
  vi.spyOn(defaultModelGateway, "rerank").mockImplementation(async ({documents, topK}) => ({results: documents.slice(0, topK).map((document, index) => ({index, score: 1, document})), usage: {provider: "fixture", model: "fixture-rerank", inputTokens: 1, outputTokens: 0, latencyMs: 0, estimatedCostUsd: "0", rawProviderCostUsd: "0", billableCostUsd: "0"}}));
});
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const workspace = await prisma.workspace.create({data: {name: "Synthetic corpus repair", slug: `corpus-${randomUUID()}`}});
  const user = await prisma.user.create({data: {email: `${randomUUID()}@example.test`, passwordHash: "synthetic"}});
  const member = await prisma.member.create({data: {workspaceId: workspace.id, userId: user.id, role: "ADMIN"}});
  const actor: AppActor = {kind: "user", user: {id: user.id, email: user.email, displayName: "Synthetic"}};
  const article = await createArticle(actor, {workspaceId: workspace.id, title: "Readable policy", slug: "readable",
    bodyMd: "Synthetic policy available to the current member", type: "PROJECT", authority: "REFERENCE"});
  return {workspace, actor, member, article};
}
async function oldChunks(workspaceId: string, sourceType: KnowledgeSourceType, sourceId: string, hash: string, count: number) {
  for (let offset = 0; offset < count; offset += 100) await prisma.knowledgeChunk.createMany({data:
    Array.from({length: Math.min(100, count - offset)}, (_, i) => ({id: `!legacy-${sourceType}-${String(offset + i).padStart(6, "0")}`,
      workspaceId, sourceType, sourceId, sourceTitle: "Unproved old chunk", chunkIndex: offset + i,
      content: "Unproved old bytes", embedding: [], tokenCount: 3, metadata: {sourceContentHash: hash}}))});
}

it("search admits its indexed candidate without loading 5001 unrelated canonical parents", async () => {
  const {workspace, actor, article} = await fixture();
  for (let offset = 0; offset < 5001; offset += 100) await prisma.brainArticle.createMany({data:
    Array.from({length: Math.min(100, 5001 - offset)}, (_, i) => ({workspaceId: workspace.id, slug: `unproved-${offset+i}`,
      title: "Unproved unindexed source", bodyMd: "No published chunk", type: "PROJECT"}))});
  await syncBrainArticleKnowledge({workspaceId: workspace.id, articleId: article.id, lineageActor: actor});
  const parents = vi.spyOn(prisma.brainArticle, "findMany");
  const results = await searchIndexedKnowledge({actor, workspaceId: workspace.id, query: "policy", sourceTypes: ["BRAIN_ARTICLE"]});
  expect(results.map(row => row.sourceId)).toEqual([article.id]);
  expect(parents.mock.calls.length).toBeGreaterThan(0);
  for (const [query] of parents.mock.calls) {
    expect(query?.where?.id).toEqual({in: [article.id]});
    expect(query?.take).toBeLessThanOrEqual(500);
  }
});

it("reindexes past 5000 old chunks per type with bounded canonical pages and no adoption of legacy bytes", async () => {
  const started = performance.now();
  const {workspace, actor, article} = await fixture();
  const document = await createDocument(actor, {workspaceId: workspace.id, title: "Current document", textContent: "Synthetic current document",
    source: "manual", mimeType: "text/plain", storageKey: `workspaces/${workspace.id}/uploads/${randomUUID()}/synthetic.txt`});
  await syncBrainArticleKnowledge({workspaceId: workspace.id, articleId: article.id, lineageActor: actor});
  await syncDocumentKnowledge({workspaceId: workspace.id, documentId: document.id, lineageActor: actor});
  await createArticle(actor, {workspaceId: workspace.id, title: "New article", slug: "new", bodyMd: "New independently readable content", type: "PROJECT", authority: "REFERENCE"});
  await createDocument(actor, {workspaceId: workspace.id, title: "New document", textContent: "New independently readable document", source: "manual", mimeType: "text/plain", storageKey: `workspaces/${workspace.id}/uploads/${randomUUID()}/new.txt`});
  await oldChunks(workspace.id, "BRAIN_ARTICLE", article.id, lineageContentFingerprint("BrainArticle", article), 5001);
  await oldChunks(workspace.id, "DOCUMENT", document.id, lineageContentFingerprint("Document", document), 5001);
  const seedMilliseconds = performance.now()-started;
  const queries = vi.spyOn(prisma.knowledgeChunk, "findMany");
  const canonicalReads = vi.spyOn(prisma.knowledgeChunk, "findFirst");
  const headReads = vi.spyOn(prisma.artifactInputLineage, "findFirst");
  const operationStarted = performance.now();
  const result = await reindexWorkspace(workspace.id, actor);
  recordProofMetrics("knowledge-full", {seedMilliseconds, operationMilliseconds: performance.now()-operationStarted,
    chunkPages: queries.mock.calls.length, canonicalReads: canonicalReads.mock.calls.length, headReads: headReads.mock.calls.length});
  expect(result).toEqual({reindexedArticles: 1, reindexedDocuments: 1, errors: []});
  const pages = queries.mock.calls.map(([query]) => query).filter(query => query?.where?.sourceId && typeof query.where.sourceId === "object" && "in" in query.where.sourceId);
  expect(pages.length).toBeGreaterThanOrEqual(102);
  for (const query of pages) expect(query).toMatchObject({take: 100, orderBy: {id: "asc"}});
  const chunks = await prisma.knowledgeChunk.findMany({where: {workspaceId: workspace.id}});
  expect(chunks).toHaveLength(10006);
  expect(chunks.filter(chunk => chunk.id.startsWith("!legacy-"))).toHaveLength(10002);
  expect(chunks.filter(chunk => !chunk.id.startsWith("!legacy-")).every(chunk => !chunk.content.includes("Unproved old bytes"))).toBe(true);
});

it("a membership revoke and restore during later reindex pages rejects the original release before any write", async () => {
  const {workspace, actor, member, article} = await fixture();
  await syncBrainArticleKnowledge({workspaceId: workspace.id, articleId: article.id, lineageActor: actor});
  await oldChunks(workspace.id, "BRAIN_ARTICLE", article.id, lineageContentFingerprint("BrainArticle", article), 201);
  const original = await prisma.knowledgeChunk.findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}});
  const findMany = prisma.knowledgeChunk.findMany.bind(prisma.knowledgeChunk);
  let changed = false;
  vi.spyOn(prisma.knowledgeChunk, "findMany").mockImplementation(((query: Prisma.KnowledgeChunkFindManyArgs = {}) => {
    const work = async () => {
      const rows = await findMany(query);
      if (!changed && query.take === 100 && query.where?.id && typeof query.where.id === "object" && "gt" in query.where.id) {
        changed = true;
        await prisma.member.update({where: {id: member.id}, data: {isActive: false}});
        await prisma.member.update({where: {id: member.id}, data: {isActive: true}});
      }
      return rows;
    };
    return work() as ReturnType<typeof prisma.knowledgeChunk.findMany>;
  }) as typeof prisma.knowledgeChunk.findMany);
  await expect(reindexWorkspace(workspace.id, actor)).rejects.toMatchObject({code: "SOURCE_CHANGED"});
  expect(changed).toBe(true);
  expect(await findMany({where: {workspaceId: workspace.id}, orderBy: {id: "asc"}})).toEqual(original);
});

function recordProofMetrics(name: string, metrics: Record<string, number>) {
  if (process.env.COLLECTION_PROOF_METRICS_DIR) writeFileSync(join(process.env.COLLECTION_PROOF_METRICS_DIR, `${name}.json`), JSON.stringify(metrics));
}

it("rejects missing chunk heads before per-row authorization while retaining the genuine receipt", async () => {
  const {workspace, actor, article} = await fixture();
  await syncBrainArticleKnowledge({workspaceId: workspace.id, articleId: article.id, lineageActor: actor});
  await oldChunks(workspace.id, "BRAIN_ARTICLE", article.id, lineageContentFingerprint("BrainArticle", article), 100);
  const rows = vi.spyOn(prisma.knowledgeChunk, "findFirst");
  const heads = vi.spyOn(prisma.artifactInputLineage, "findFirst");
  const members = vi.spyOn(prisma.member, "findUnique");
  const start = performance.now();
  expect(await reindexWorkspace(workspace.id, actor)).toEqual({reindexedArticles: 0, reindexedDocuments: 0, errors: []});
  recordProofMetrics("knowledge-100", {milliseconds: performance.now()-start, chunkReads: rows.mock.calls.length, headReads: heads.mock.calls.length, memberReads: members.mock.calls.length});
  expect(rows.mock.calls.length).toBeLessThan(20);
});

it("rebuilds rather than adopting a chunk with a matching UNKNOWN head and empty roots", async () => {
  const {workspace, actor, article} = await fixture();
  await oldChunks(workspace.id, "BRAIN_ARTICLE", article.id, lineageContentFingerprint("BrainArticle", article), 1);
  const old = await prisma.knowledgeChunk.findFirstOrThrow({where: {workspaceId: workspace.id}});
  await prisma.artifactInputLineage.create({data: {workspaceId: workspace.id, artifactType: "KnowledgeChunk", artifactId: old.id,
    revision: 1, origin: "UNKNOWN", contentHash: lineageContentFingerprint("KnowledgeChunk", old), inputsJson: [], rootsJson: []}});
  const reads = vi.spyOn(prisma.knowledgeChunk, "findFirst");
  expect(await reindexWorkspace(workspace.id, actor)).toEqual({reindexedArticles: 1, reindexedDocuments: 0, errors: []});
  expect(reads.mock.calls.some(([query]) => query?.where?.id === old.id)).toBe(true);
  expect(await prisma.knowledgeChunk.findUnique({where: {id: old.id}})).toBeNull();
  expect(await prisma.knowledgeChunk.findFirst({where: {workspaceId: workspace.id, content: {contains: "Synthetic policy"}}})).not.toBeNull();
});
