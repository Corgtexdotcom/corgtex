import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => {
  const sources: any[] = [];
  const receipts: any[] = [];
  const domains = new Map<string, string[]>();
  const membership = new Set<string>();
  const sourceInputs = new Map<string, { domain: string; current: boolean }[]>();
  const hash = (kind: string, row: any) => JSON.stringify([kind, row.title, row.bodyMd ?? row.textContent, row.archivedAt, row.accessDomain]);
  const rows = (args: any, type: string) => sources.filter((row) => row.type === type && row.workspaceId === args.where.workspaceId
    && (!args.where.id || args.where.id.in.includes(row.id)) && row.archivedAt === null
    && (!args.where.accessDomain || args.where.accessDomain.in.includes(row.accessDomain)));
  const prisma = {
    brainArticle: { findMany: vi.fn(async (args) => rows(args, "BRAIN_ARTICLE")) },
    document: { findMany: vi.fn(async (args) => rows(args, "DOCUMENT")) },
    meeting: { findMany: vi.fn(async (args) => rows(args, "MEETING")) },
    proposal: { findMany: vi.fn(async (args) => rows(args, "PROPOSAL")) },
    knowledgeChunk: { findFirst: vi.fn(async (args) => receipts.find((row) => row.id === args.where.id && row.workspaceId === args.where.workspaceId && args.where.accessDomain.in.includes(row.accessDomain)) ?? null), findMany: vi.fn(async (args) => receipts.filter((row) => row.workspaceId === args.where.workspaceId
      && args.where.accessDomain.in.includes(row.accessDomain)
      && (!args.where.id || args.where.id.in.includes(row.id))
      && (!args.where.sourceType || (typeof args.where.sourceType === "string" ? args.where.sourceType === row.sourceType : args.where.sourceType.in.includes(row.sourceType)))
      && (!args.where.sourceId || args.where.sourceId.in.includes(row.sourceId))
      && (!args.where.OR || args.where.OR.some((condition: any) => condition.sourceType === row.sourceType && (typeof condition.sourceId === "string" ? condition.sourceId === row.sourceId : condition.sourceId.in.includes(row.sourceId))))
    ).slice(0, args.take ?? Infinity)) },
  };
  const resolveDomains = vi.fn(async (actor: any, workspaceId: string) => {
    const key = `${actor.user.id}:${workspaceId}`;
    if (!membership.has(key)) throw new Error("FORBIDDEN");
    return domains.get(key) ?? ["WORKSPACE"];
  });
  const readable = vi.fn(async (actor: any, workspaceId: string, _kind: string, records: any[]) => {
    const currentDomains = await resolveDomains(actor, workspaceId);
    return new Set(records.filter((record) => {
      const inputs = sourceInputs.get(`${workspaceId}:${record.id}`);
      return inputs && inputs.every((input) => input.current && currentDomains.includes(input.domain));
    }).map((record) => record.id));
  });
  const afterCacheWrite = vi.fn();
  return { sources, receipts, domains, membership, sourceInputs, hash, prisma, resolveDomains, readable, afterCacheWrite,
    gateway: { embed: vi.fn(async () => ({ embeddings: [[1, 0]], usage: { model: "test" } })),
      rerank: vi.fn(async ({ documents, topK }) => ({ results: documents.slice(0, topK).map((_: string, index: number) => ({ index, score: 1 - index * 0.1 })) })),
      chat: vi.fn(async () => ({ content: "SYNTHETIC derived answer" })) } };
});

vi.mock("@corgtex/domain", () => ({ readableArtifactIds: f.readable, resolveKnowledgeAccessDomains: f.resolveDomains, lineageContentFingerprint: f.hash }));
vi.mock("@corgtex/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@corgtex/shared")>();
  return { ...actual, prisma: f.prisma, setCacheJson: async (...args: Parameters<typeof actual.setCacheJson>) => {
    const result = await actual.setCacheJson(...args);
    f.afterCacheWrite(args[0]);
    return result;
  } };
});
vi.mock("@corgtex/models", async () => ({ ...await import("../../models/src/provider-errors"), defaultModelGateway: f.gateway, resolveModel: () => "test" }));

import { resetLocalCacheStore } from "@corgtex/shared";
import { answerKnowledgeQuestion, fetchReadableKnowledgeChunk, searchIndexedKnowledge } from "./retrieval";

const alice: AppActor = { kind: "user", user: { id: "alice", email: "alice@example.test", displayName: "Alice" } };
const bob: AppActor = { kind: "user", user: { id: "bob", email: "bob@example.test", displayName: "Bob" } };
function article(id: string, inputs: { domain: string; current: boolean }[] | null, workspaceId = "ws-1") {
  const row = { id, workspaceId, type: "BRAIN_ARTICLE", title: `SYNTHETIC ${id}`, bodyMd: `Synthetic policy ${id}`, archivedAt: null, isPrivate: false };
  f.sources.push(row);
  if (inputs) f.sourceInputs.set(`${workspaceId}:${id}`, inputs.map((input) => ({ ...input })));
  f.receipts.push({ id: `chunk-${id}`, workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: id, sourceTitle: row.title,
    chunkIndex: 0, content: row.bodyMd, accessDomain: "WORKSPACE", metadata: { sourceContentHash: f.hash("BrainArticle", row) }, embedding: [1, 0], createdAt: new Date() });
  return row;
}
const publicInput = { domain: "WORKSPACE", current: true };
const financeInput = { domain: "FINANCE", current: true };

beforeEach(() => {
  resetLocalCacheStore();
  vi.clearAllMocks();
  f.afterCacheWrite.mockReset();
  f.sources.length = 0;
  f.receipts.length = 0;
  f.sourceInputs.clear();
  f.domains.clear();
  f.membership.clear();
  for (const user of ["alice", "bob"]) for (const workspace of ["ws-1", "ws-2"]) f.membership.add(`${user}:${workspace}`);
  f.domains.set("alice:ws-1", ["WORKSPACE", "FINANCE"]);
  f.domains.set("bob:ws-1", ["WORKSPACE"]);
  delete process.env.KNOWLEDGE_SEARCH_PROVIDER;
  delete process.env.AZURE_SEARCH_ENDPOINT;
  delete process.env.AZURE_SEARCH_INDEX_NAME;
  delete process.env.AZURE_SEARCH_QUERY_KEY;
  delete process.env.AZURE_SEARCH_VECTOR_DIMENSIONS;
  vi.unstubAllGlobals();
});

describe("actor-aware knowledge lineage", () => {
  it("filters complete input proofs before SQL candidate windows and model ranking", async () => {
    article("finance", [publicInput, financeInput]);
    article("unknown", null);
    article("public", [publicInput]);
    article("other-tenant", [publicInput], "ws-2");
    const results = await searchIndexedKnowledge({ actor: bob, workspaceId: "ws-1", query: "policy", limit: 1, accessDomains: ["FINANCE", "WORKSPACE"] });
    expect(results.map((result) => result.sourceId)).toEqual(["public"]);
    expect(f.prisma.knowledgeChunk.findMany.mock.calls[0][0]).toMatchObject({ where: {
      accessDomain: { in: ["WORKSPACE"] }, OR: [expect.objectContaining({ sourceType: "BRAIN_ARTICLE", sourceId: "public", metadata: { path: ["sourceContentHash"], equals: f.hash("BrainArticle", f.sources[2]) } })],
    }, take: 500 });
    expect(f.gateway.rerank.mock.calls[0][0].documents.join(" ")).not.toMatch(/finance|unknown|other-tenant/);
    expect(f.readable).toHaveBeenCalledWith(bob, "ws-1", "BrainArticle", expect.arrayContaining([expect.objectContaining({ bodyMd: "Synthetic policy finance" })]));
  });

  it("rechecks uncited finance inputs on cache hits and rejects the entire old answer", async () => {
    article("multi-input", [publicInput, financeInput]);
    const params = { actor: alice, workspaceId: "ws-1", question: "policy" };
    expect((await answerKnowledgeQuestion(params)).citations).toHaveLength(1);
    f.sourceInputs.get("ws-1:multi-input")![1].current = false;
    expect(await answerKnowledgeQuestion(params)).toEqual({ answer: "I could not find relevant indexed knowledge for that question.", citations: [] });
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy" })).toEqual([]);
    expect(f.gateway.chat).toHaveBeenCalledTimes(1);
  });

  it("withholds changed-source receipts even when a new lineage manifest is valid", async () => {
    const row = article("changed", [publicInput]);
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy" })).toHaveLength(1);
    row.bodyMd = "Updated policy from newly certified inputs";
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy" })).toEqual([]);
  });

  it("re-resolves membership before cached answers and keeps actor and tenant caches distinct", async () => {
    article("restricted", [publicInput, financeInput]);
    expect((await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy" })).citations).toHaveLength(1);
    expect((await answerKnowledgeQuestion({ actor: bob, workspaceId: "ws-1", question: "policy" })).citations).toEqual([]);
    expect((await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-2", question: "policy" })).citations).toEqual([]);
    f.membership.delete("alice:ws-1");
    await expect(answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy" })).rejects.toThrow("FORBIDDEN");
  });

  it("uses current native document permissions even for a certified human original", async () => {
    const document = { id: "finance-document", workspaceId: "ws-1", type: "DOCUMENT", title: "Synthetic report",
      textContent: "Synthetic finance policy", accessDomain: "FINANCE", archivedAt: null };
    f.sources.push(document);
    f.sourceInputs.set("ws-1:finance-document", []);
    f.receipts.push({ id: "finance-document-chunk", workspaceId: "ws-1", sourceType: "DOCUMENT", sourceId: document.id,
      sourceTitle: document.title, content: document.textContent, chunkIndex: 0, accessDomain: "FINANCE", embedding: [1, 0],
      metadata: { sourceContentHash: f.hash("Document", document) }, createdAt: new Date() });
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", accessDomains: ["FINANCE"] })).toHaveLength(1);
    expect(await fetchReadableKnowledgeChunk(alice, "ws-1", "finance-document-chunk")).toMatchObject({ sourceId: document.id });
    expect(await searchIndexedKnowledge({ actor: bob, workspaceId: "ws-1", query: "policy", accessDomains: ["FINANCE", "WORKSPACE"] })).toEqual([]);
    expect(await fetchReadableKnowledgeChunk(bob, "ws-1", "finance-document-chunk")).toBeNull();
    f.domains.set("alice:ws-1", ["WORKSPACE"]);
    expect(await fetchReadableKnowledgeChunk(alice, "ws-1", "finance-document-chunk")).toBeNull();
  });

  it("fails closed for an actor-less caller and for unsupported source lineage", async () => {
    article("known", [publicInput]);
    expect(await searchIndexedKnowledge({ workspaceId: "ws-1", query: "policy" } as any)).toEqual([]);
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", sourceTypes: ["EXTERNAL_CONTENT"] })).toEqual([]);
  });

  it("accepts certified human originals while withholding unknown receipt revisions", async () => {
    article("human-original", []);
    article("legacy-receipt", [publicInput]);
    f.receipts[1].metadata = {};
    const results = await searchIndexedKnowledge({ actor: bob, workspaceId: "ws-1", query: "policy" });
    expect(results.map((result) => result.sourceId)).toEqual(["human-original"]);
  });

  it("rechecks Azure hits against SQL content and all current source inputs", async () => {
    article("finance-azure", [publicInput, financeInput]);
    article("public-azure", [publicInput]);
    process.env.KNOWLEDGE_SEARCH_PROVIDER = "azure";
    process.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "synthetic-index";
    process.env.AZURE_SEARCH_QUERY_KEY = "synthetic-test-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: f.receipts.map((receipt) => ({
      ...receipt, sourceTitle: receipt.sourceTitle, "@search.score": 1,
      content: receipt.sourceId === "public-azure" ? "Forged stale Azure snippet" : receipt.content,
    })) }), { status: 200 })));
    const result = await searchIndexedKnowledge({ actor: bob, workspaceId: "ws-1", query: "policy", limit: 1 });
    expect(result).toEqual([expect.objectContaining({ sourceId: "public-azure", snippet: "Synthetic policy public-azure" })]);
    expect(JSON.stringify(result)).not.toMatch(/finance-azure|Forged/);
  });

  it("rechecks a directly fetched chunk id after a previously authorized search", async () => {
    article("direct-fetch", [publicInput, financeInput]);
    const result = await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy" });
    expect(await fetchReadableKnowledgeChunk(alice, "ws-1", result[0].chunkId)).toMatchObject({ content: "Synthetic policy direct-fetch" });
    expect(await fetchReadableKnowledgeChunk(bob, "ws-1", result[0].chunkId)).toBeNull();
    expect(await fetchReadableKnowledgeChunk(alice, "ws-2", result[0].chunkId)).toBeNull();
    f.sourceInputs.get("ws-1:direct-fetch")![1].current = false;
    expect(await fetchReadableKnowledgeChunk(alice, "ws-1", result[0].chunkId)).toBeNull();
  });

  it.each(["search", "answer"] as const)("rejects revocation while an asynchronous %s cache fill commits", async (kind) => {
    article("cache-race", [publicInput, financeInput]);
    f.afterCacheWrite.mockImplementation((key: string) => {
      if (key.startsWith(kind === "search" ? "knowledge-search" : "knowledge-answer")) {
        f.sourceInputs.get("ws-1:cache-race")![1].current = false;
      }
    });
    if (kind === "search") {
      expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy" })).toEqual([]);
    } else {
      expect(await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy" })).toEqual({
        answer: "I could not find relevant indexed knowledge for that question.", citations: [],
      });
    }
  });

  it("rejects revoked inputs when model answering finishes after revocation", async () => {
    article("during-model", [publicInput, financeInput]);
    f.gateway.chat.mockImplementationOnce(async () => {
      f.sourceInputs.get("ws-1:during-model")![1].current = false;
      return { content: "SYNTHETIC forbidden answer" };
    });
    expect(await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy" })).toEqual({
      answer: "I could not find relevant indexed knowledge for that question.", citations: [],
    });
  });
});
