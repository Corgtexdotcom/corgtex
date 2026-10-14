import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppActor } from "@corgtex/shared";

const f = vi.hoisted(() => {
  const sources: any[] = [];
  const receipts: any[] = [];
  const domains = new Map<string, string[]>();
  const membership = new Set<string>();
  const chunkInputs = new Map<string, { domain: string; current: boolean }[]>();
  const sourceInputs = new Map<string, { domain: string; current: boolean }[]>();
  const hash = (kind: string, row: any) => kind === "KnowledgeChunk"
    ? JSON.stringify([kind, row.sourceType, row.sourceId, row.sourceTitle, row.chunkIndex, row.content, row.accessDomain, row.metadata, row.sensitivity, row.embedding, row.embeddingModel, row.tokenCount])
    : JSON.stringify([kind, row.title, row.bodyMd ?? row.textContent, row.archivedAt, row.accessDomain, row.isPrivate, row.ownerMemberId]);
  const rows = (args: any, type: string) => sources.filter((row) => row.type === type && row.workspaceId === args.where.workspaceId
    && (!args.where.id || args.where.id.in.includes(row.id)) && row.archivedAt === null
    && (!args.where.accessDomain || args.where.accessDomain.in.includes(row.accessDomain)));
  let sqlCollectionCurrent = true;
  const prisma = {
    $queryRaw: vi.fn(async (query: {sql: string}) => query.sql.includes("AS stamp") ? [{stamp: "empty-native-collection"}]
      : query.sql.includes("AS current") ? [{current: sqlCollectionCurrent}] : []),
    brainArticle: { findMany: vi.fn(async (args) => rows(args, "BRAIN_ARTICLE")) },
    document: { findMany: vi.fn(async (args) => rows(args, "DOCUMENT")) },
    meeting: { findMany: vi.fn(async (args) => rows(args, "MEETING")) },
    proposal: { findMany: vi.fn(async (args) => rows(args, "PROPOSAL")) },
    externalContentSource: { findMany: vi.fn(async (args) => rows(args, "EXTERNAL_CONTENT")) },
    sqlNativeRunInput: { findMany: vi.fn(async () => []) },
    knowledgeChunk: { findFirst: vi.fn(async (args) => receipts.find((row) => row.id === args.where.id && row.workspaceId === args.where.workspaceId && args.where.accessDomain.in.includes(row.accessDomain)) ?? null), findMany: vi.fn(async (args) => receipts.filter((row) => row.workspaceId === args.where.workspaceId
      && args.where.accessDomain.in.includes(row.accessDomain)
      && (!args.where.id || args.where.id.in.includes(row.id))
      && (!args.where.sourceType || (typeof args.where.sourceType === "string" ? args.where.sourceType === row.sourceType : args.where.sourceType.in.includes(row.sourceType)))
      && (!args.where.sourceId || args.where.sourceId.in.includes(row.sourceId))
      && (!args.where.OR || args.where.OR.some((condition: any) => condition.sourceType === row.sourceType && (typeof condition.sourceId === "string" ? condition.sourceId === row.sourceId : condition.sourceId.in.includes(row.sourceId))))
      && (!args.where.AND || args.where.AND[0].OR.some((condition: any) =>
        condition.createdAt?.lt ? row.createdAt < condition.createdAt.lt : row.createdAt.getTime() === condition.createdAt.getTime()
          && (condition.chunkIndex?.gt !== undefined ? row.chunkIndex > condition.chunkIndex.gt
            : row.chunkIndex === condition.chunkIndex && row.id > condition.id.gt)))
    ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.chunkIndex - b.chunkIndex || a.id.localeCompare(b.id))
      .slice(0, args.take ?? Infinity)) },
  };
  const resolveDomains = vi.fn(async (actor: any, workspaceId: string) => {
    const key = `${actor.user.id}:${workspaceId}`;
    if (!membership.has(key)) throw new Error("FORBIDDEN");
    return domains.get(key) ?? ["WORKSPACE"];
  });
  const readable = vi.fn(async (actor: any, workspaceId: string, _kind: string, records: any[]) => {
    const currentDomains = await resolveDomains(actor, workspaceId);
    return new Set(records.filter((record) => {
      const inputs = _kind === "KnowledgeChunk" ? chunkInputs.get(`${workspaceId}:${record.id}`) ?? [] : sourceInputs.get(`${workspaceId}:${record.id}`);
      return (!record.isPrivate || record.ownerMemberId === actor.user.id) && inputs && inputs.every((input) => input.current && currentDomains.includes(input.domain));
    }).map((record) => record.id));
  });
  const capture = vi.fn(async (actor: any, workspaceId: string, inputs: any[]) => {
    const currentDomains = await resolveDomains(actor, workspaceId);
    const roots: any[] = [];
    for (const input of inputs) {
      const row = (input.kind === "KnowledgeChunk" ? receipts : sources).find((entry) => entry.id === input.id && entry.workspaceId === workspaceId);
      if (!row || input.snapshot && hash(input.kind, input.snapshot) !== hash(input.kind, row)) {
        throw Object.assign(new Error("Changed input"), { code: "SOURCE_CHANGED" });
      }
      if (input.kind === "KnowledgeChunk") {
        if (!currentDomains.includes(row.accessDomain) || !(await readable(actor, workspaceId, input.kind, [row])).has(row.id))
          throw Object.assign(new Error("Restricted chunk"), { code: "SOURCE_RESTRICTED" });
        for (const [index, ancestor] of (chunkInputs.get(`${workspaceId}:${row.id}`) ?? []).entries()) {
          roots.push({kind: "Document", id: `${row.id}:child-input:${index}`, fingerprint: JSON.stringify(ancestor)});
        }
      } else {
        if (!(await readable(actor, workspaceId, input.kind, [row])).has(row.id)) throw Object.assign(new Error("Unknown source"), { code: "UNKNOWN_LINEAGE" });
        for (const [index, ancestor] of sourceInputs.get(`${workspaceId}:${row.id}`)!.entries()) {
          roots.push({ kind: "Document", id: `${row.id}:input:${index}`, fingerprint: JSON.stringify(ancestor) });
        }
      }
      roots.push({ kind: input.kind, id: input.id, fingerprint: hash(input.kind, row) });
    }
    return roots;
  });
  const currentProof = vi.fn(async (actor: any, workspaceId: string, roots: any[]) => {
    const currentDomains = await resolveDomains(actor, workspaceId);
    for (const root of roots) {
      if (root.id.includes(":child-input:")) {
        const [chunkId, index] = root.id.split(":child-input:");
        const ancestor = chunkInputs.get(`${workspaceId}:${chunkId}`)?.[Number(index)];
        if (!ancestor || !ancestor.current || !currentDomains.includes(ancestor.domain) || JSON.stringify(ancestor) !== root.fingerprint) return false;
      } else if (root.id.includes(":input:")) {
        const [sourceId, index] = root.id.split(":input:");
        const ancestor = sourceInputs.get(`${workspaceId}:${sourceId}`)?.[Number(index)];
        if (!ancestor || !ancestor.current || !currentDomains.includes(ancestor.domain) || JSON.stringify(ancestor) !== root.fingerprint) return false;
      } else {
        const row = (root.kind === "KnowledgeChunk" ? receipts : sources).find((entry) => entry.id === root.id && entry.workspaceId === workspaceId);
        if (!row || hash(root.kind, row) !== root.fingerprint) return false;
        if (root.kind === "KnowledgeChunk") {
          if (!currentDomains.includes(row.accessDomain) || !(await readable(actor, workspaceId, root.kind, [row])).has(row.id)) return false;
        } else if (!(await readable(actor, workspaceId, root.kind, [row])).has(row.id)) return false;
      }
    }
    return roots.length > 0;
  });
  const afterCacheWrite = vi.fn(), beforeCountSnapshot = vi.fn();
  // Model the existing final snapshot port; this unit fixture has no SQL native
  // runs, while the real-PG suite covers actual shared-snapshot/epoch behavior.
  const countRelease = vi.fn(async (actor: AppActor, workspaceId: string, roots: any[],
    remote: () => Promise<void>, finish: (tx: unknown) => Promise<unknown>) => {
    if (roots.length && !await currentProof(actor, workspaceId, roots)) throw Object.assign(new Error("Changed count inputs"), {code: "SOURCE_CHANGED"});
    await remote(); await beforeCountSnapshot();
    if (roots.length && !await currentProof(actor, workspaceId, roots)) throw Object.assign(new Error("Changed count snapshot"), {code: "SOURCE_CHANGED"});
    return finish(prisma);
  });
  return { sources, receipts, domains, membership, sourceInputs, chunkInputs, hash, prisma, resolveDomains, readable, capture, currentProof, afterCacheWrite,
    beforeCountSnapshot, countRelease, resetSqlCollection: () => {sqlCollectionCurrent = true;}, changeSqlCollection: () => {sqlCollectionCurrent = false;},
    gateway: { embed: vi.fn(async () => ({ embeddings: [[1, 0]], usage: { model: "test" } })),
      rerank: vi.fn(async ({ documents, topK }) => ({ results: documents.slice(0, topK).map((_: string, index: number) => ({ index, score: 1 - index * 0.1 })) })),
      chat: vi.fn(async () => ({ content: "SYNTHETIC derived answer" })) } };
});

vi.mock("../../domain/src/source-lineage", () => ({withArtifactCountReleaseSnapshot: f.countRelease}));
vi.mock("@corgtex/domain", () => ({ readableArtifactIds: f.readable, resolveKnowledgeAccessDomains: f.resolveDomains, lineageContentFingerprint: f.hash, captureArtifactInputProof: f.capture, isArtifactInputProofReadable: f.currentProof }));
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
import { answerKnowledgeQuestion, fetchReadableKnowledgeChunk, getKnowledgeSearchInputRoots, searchIndexedKnowledge } from "./retrieval";

const alice: AppActor = { kind: "user", user: { id: "alice", email: "alice@example.test", displayName: "Alice" } };
const bob: AppActor = { kind: "user", user: { id: "bob", email: "bob@example.test", displayName: "Bob" } };
function article(id: string, inputs: { domain: string; current: boolean }[] | null, workspaceId = "ws-1") {
  const row = { id, workspaceId, type: "BRAIN_ARTICLE", title: `SYNTHETIC ${id}`, bodyMd: `Synthetic policy ${id}`, archivedAt: null, isPrivate: false };
  f.sources.push(row);
  if (inputs) f.sourceInputs.set(`${workspaceId}:${id}`, inputs.map((input) => ({ ...input })));
  f.receipts.push({ id: `chunk-${id}`, workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: id, sourceTitle: row.title,
    chunkIndex: 0, content: row.bodyMd, accessDomain: "WORKSPACE", metadata: { sourceContentHash: f.hash("BrainArticle", row) }, embedding: [1, 0], createdAt: new Date(Date.UTC(2026, 9, 13) - f.receipts.length) });
  return row;
}
const publicInput = { domain: "WORKSPACE", current: true };
const financeInput = { domain: "FINANCE", current: true };

beforeEach(() => {
  resetLocalCacheStore();
  vi.clearAllMocks();
  f.afterCacheWrite.mockReset();
  f.beforeCountSnapshot.mockReset(); f.resetSqlCollection();
  f.sources.length = 0;
  f.receipts.length = 0;
  f.sourceInputs.clear();
  f.chunkInputs.clear();
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
    expect(f.prisma.knowledgeChunk.findMany.mock.calls.filter(([query]) => query.take === 500)[0][0]).toMatchObject({ where: {
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

  it.each(["azure", "dual_compare"])("ignores unproven %s hit membership, scores and snippets when ranking", async (provider) => {
    article("winner", [publicInput]);
    article("uncited", [publicInput]);
    article("restricted", [financeInput]);
    process.env.KNOWLEDGE_SEARCH_PROVIDER = provider;
    process.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "synthetic-index";
    process.env.AZURE_SEARCH_QUERY_KEY = "synthetic-test-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [{
      ...f.receipts[2], content: "PRIVATE forged provider body", "@search.score": 999,
    }] }), { status: 200 })));
    const results = await searchIndexedKnowledge({ actor: bob, workspaceId: "ws-1", query: "policy", limit: 1 });
    expect(results).toEqual([expect.objectContaining({ sourceId: "winner", score: 1, snippet: "Synthetic policy winner" })]);
    expect(f.gateway.embed).toHaveBeenCalledOnce();
    expect(f.gateway.rerank).toHaveBeenCalledOnce();
    expect(f.gateway.rerank.mock.calls[0][0].documents).toHaveLength(2);
    expect(JSON.stringify(results)).not.toMatch(/PRIVATE|restricted|999/);
    const roots = await getKnowledgeSearchInputRoots(bob, "ws-1", results);
    expect(roots).toContainEqual(expect.objectContaining({ kind: "KnowledgeChunk", id: "chunk-uncited" }));
    expect(roots.some((root) => root.id.includes("restricted"))).toBe(false);
  });

  it.each(["azure", "dual_compare"])("withholds %s output when an uncited canonical ranking input is revoked", async (provider) => {
    article("winner", [publicInput]);
    article("uncited", [financeInput]);
    process.env.KNOWLEDGE_SEARCH_PROVIDER = provider;
    process.env.AZURE_SEARCH_ENDPOINT = "https://synthetic.search.windows.net";
    process.env.AZURE_SEARCH_INDEX_NAME = "synthetic-index";
    process.env.AZURE_SEARCH_QUERY_KEY = "synthetic-test-key";
    process.env.AZURE_SEARCH_VECTOR_DIMENSIONS = "2";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: [{
      ...f.receipts[0], "@search.score": 999,
    }] }), { status: 200 })));
    f.gateway.rerank.mockImplementationOnce(async ({ documents }) => {
      expect(documents).toHaveLength(2);
      f.domains.set("alice:ws-1", ["WORKSPACE"]);
      return { results: [{ index: 0, score: 1 }] };
    });
    const results = await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 });
    expect(results).toEqual([]);
    expect(await getKnowledgeSearchInputRoots(alice, "ws-1", results)).toEqual([]);
    expect(f.afterCacheWrite).not.toHaveBeenCalled();
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

  it("caches every ranking ancestor and rebuilds after an uncited source grant is revoked", async () => {
    article("winner", [publicInput]);
    article("uncited-finance", [publicInput, financeInput]);
    let searchKey = "";
    f.afterCacheWrite.mockImplementation((key: string) => { if (key.startsWith("knowledge-search")) searchKey = key; });
    f.gateway.rerank.mockImplementationOnce(async () => ({ results: [{ index: 0, score: 0.42 }] }));
    const params = { actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 };
    const first = await searchIndexedKnowledge(params);
    expect(first).toEqual([expect.objectContaining({ sourceId: "winner", score: 0.42 })]);
    expect(f.gateway.rerank.mock.calls[0][0].documents).toHaveLength(2);
    const roots = await getKnowledgeSearchInputRoots(alice, "ws-1", first);
    expect(roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "KnowledgeChunk", id: "chunk-uncited-finance" }),
      expect.objectContaining({ kind: "BrainArticle", id: "uncited-finance" }),
      expect.objectContaining({ kind: "Document", id: "uncited-finance:input:1" }),
    ]));
    const { getCacheJson } = await import("@corgtex/shared");
    const cached = await getCacheJson<{ schema: number; inputRoots: unknown[]; results: unknown[] }>(searchKey);
    expect(cached).toMatchObject({ schema: 2, inputRoots: roots, results: first });
    expect(JSON.stringify(first)).not.toContain("uncited-finance");
    f.domains.set("alice:ws-1", ["WORKSPACE"]);
    await expect(getKnowledgeSearchInputRoots(alice, "ws-1", first)).rejects.toThrow("inputs changed");
    const rebuilt = await searchIndexedKnowledge(params);
    expect(rebuilt).toEqual([expect.objectContaining({ sourceId: "winner", score: 1 })]);
    expect(f.gateway.rerank).toHaveBeenCalledTimes(2);
    expect(f.gateway.rerank.mock.calls[1][0].documents).toHaveLength(1);
  });

  it("rebuilds the complete old answer when an uncited ranking candidate becomes private", async () => {
    article("answer-winner", [publicInput]);
    const uncited = article("answer-uncited", [publicInput]);
    const params = { actor: alice, workspaceId: "ws-1", question: "policy", limit: 1 };
    expect((await answerKnowledgeQuestion(params)).citations.map((row) => row.sourceId)).toEqual(["answer-winner"]);
    uncited.isPrivate = true;
    Object.assign(uncited, { ownerMemberId: "bob" });
    f.gateway.chat.mockImplementationOnce(async () => ({ content: "SYNTHETIC refreshed permitted answer" }));
    expect((await answerKnowledgeQuestion(params)).answer).toBe("SYNTHETIC refreshed permitted answer");
    expect(f.gateway.chat).toHaveBeenCalledTimes(2);
    expect(f.gateway.rerank).toHaveBeenCalledTimes(2);
    expect(f.gateway.rerank.mock.calls[1][0].documents).toHaveLength(1);
  });

  it("invalidates ranking proofs when uncited full chunk text changes beyond the displayed snippet", async () => {
    article("stable-winner", [publicInput]);
    article("long-uncited", [publicInput]);
    const chunk = f.receipts[1];
    chunk.content = "Synthetic policy ".repeat(30) + "Old tail";
    const params = { actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 };
    const first = await searchIndexedKnowledge(params);
    const prefix = chunk.content.slice(0, 400);
    chunk.content = "Synthetic policy ".repeat(30) + "Changed tail";
    expect(chunk.content.slice(0, 400)).toBe(prefix);
    await expect(getKnowledgeSearchInputRoots(alice, "ws-1", first)).rejects.toThrow("inputs changed");
    await searchIndexedKnowledge(params);
    expect(f.gateway.rerank).toHaveBeenCalledTimes(2);
    expect(f.gateway.rerank.mock.calls[1][0].documents.join(" ")).toContain("Changed tail");
  });

  it("withholds the entire ranking when an uncited model input is revoked during reranking", async () => {
    article("race-winner", [publicInput]);
    article("race-uncited", [publicInput, financeInput]);
    f.gateway.rerank.mockImplementationOnce(async () => {
      f.sourceInputs.get("ws-1:race-uncited")![1].current = false;
      return { results: [{ index: 0, score: 1 }] };
    });
    expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 })).toEqual([]);
    expect(f.afterCacheWrite).not.toHaveBeenCalled();
  });

  it.each(["search", "answer"] as const)("withholds %s when an uncited ranking input is revoked during cache persistence", async (kind) => {
    article("fill-winner", [publicInput]);
    article("fill-uncited", [publicInput, financeInput]);
    f.afterCacheWrite.mockImplementation((key: string) => {
      if (key.startsWith(kind === "search" ? "knowledge-search" : "knowledge-answer")) f.sourceInputs.get("ws-1:fill-uncited")![1].current = false;
    });
    if (kind === "search") expect(await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 })).toEqual([]);
    else expect(await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy", limit: 1 })).toEqual({ answer: "I could not find relevant indexed knowledge for that question.", citations: [] });
  });

  it("withholds answering if an uncited ranking input is revoked while the answer model runs", async () => {
    article("chat-winner", [publicInput]);
    article("chat-uncited", [publicInput, financeInput]);
    f.gateway.chat.mockImplementationOnce(async () => {
      f.sourceInputs.get("ws-1:chat-uncited")![1].current = false;
      return { content: "SYNTHETIC forbidden ranking-dependent answer" };
    });
    expect(await answerKnowledgeQuestion({ actor: alice, workspaceId: "ws-1", question: "policy", limit: 1 })).toEqual({ answer: "I could not find relevant indexed knowledge for that question.", citations: [] });
  });

  it("binds complete search proofs to the original actor, workspace and unchanged result payload", async () => {
    article("receipt-winner", [publicInput]);
    article("receipt-uncited", [publicInput]);
    const result = await searchIndexedKnowledge({ actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 });
    await expect(getKnowledgeSearchInputRoots(bob, "ws-1", result)).rejects.toThrow("unavailable");
    await expect(getKnowledgeSearchInputRoots(alice, "ws-2", result)).rejects.toThrow("unavailable");
    await expect(getKnowledgeSearchInputRoots(alice, "ws-1", [...result])).rejects.toThrow("unavailable");
    result[0].snippet = "Forged model context";
    await expect(getKnowledgeSearchInputRoots(alice, "ws-1", result)).rejects.toThrow("unavailable");
  });

  it.each(["parent", "uncited child", "SQL collection"] as const)("withholds count when %s changes at the final snapshot", async target => {
    f.domains.set("bob:ws-1", ["WORKSPACE"]);
    const chunks = crowdedChildren("ws-1");
    f.beforeCountSnapshot.mockImplementationOnce(() => {
      if (target === "parent") f.sourceInputs.get("ws-1:safe-parent-ws-1")![0].current = false;
      else if (target === "uncited child") f.chunkInputs.set(`ws-1:${chunks[501].id}`, [{domain: "WORKSPACE", current: false}]);
      else f.changeSqlCollection();
    });
    const {countReadableKnowledgeChunks} = await import("./counts");
    await expect(countReadableKnowledgeChunks(bob, "ws-1")).rejects.toMatchObject({code: "SOURCE_CHANGED"});
    expect(f.countRelease).toHaveBeenCalledOnce(); expect(f.beforeCountSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["search", "answer"] as const)("rebuilds a legacy unproven %s cache blob", async (kind) => {
    article("legacy-winner", [publicInput]);
    article("legacy-uncited", [publicInput]);
    const keys = new Map<string, string>();
    f.afterCacheWrite.mockImplementation((key: string) => keys.set(key.startsWith("knowledge-search") ? "search" : "answer", key));
    const searchParams = { actor: alice, workspaceId: "ws-1", query: "policy", limit: 1 };
    const answerParams = { actor: alice, workspaceId: "ws-1", question: "policy", limit: 1 };
    if (kind === "search") await searchIndexedKnowledge(searchParams);
    else await answerKnowledgeQuestion(answerParams);
    const { getCacheJson, setCacheJson } = await import("@corgtex/shared");
    const key = keys.get(kind)!;
    const cache = await getCacheJson<any>(key);
    await setCacheJson(key, kind === "search" ? cache.results.map((row: any) => ({ ...row, score: -100 })) : { answer: "LEGACY forbidden reply", citations: cache.citations }, 120_000);
    if (kind === "search") {
      expect((await searchIndexedKnowledge(searchParams))[0].score).toBe(1);
      expect(f.gateway.rerank).toHaveBeenCalledTimes(2);
    } else {
      expect((await answerKnowledgeQuestion(answerParams)).answer).not.toBe("LEGACY forbidden reply");
      expect(f.gateway.chat).toHaveBeenCalledTimes(2);
    }
  });

});

function crowdedChildren(workspaceId: string, hiddenCount = 500) {
  article(`safe-parent-${workspaceId}`, [publicInput], workspaceId);
  const base = f.receipts.pop();
  const chunks = Array.from({length: hiddenCount + 2}, (_, index) => ({...base,
    id: `${workspaceId}-child-${String(index).padStart(5, "0")}`, chunkIndex: index,
    createdAt: new Date("2026-10-13T00:00:00Z"),
    content: index < hiddenCount ? "PRIVATE policy from a restricted child ancestor" : `Permitted policy ${index}`,
  }));
  f.receipts.push(...chunks);
  for (const chunk of chunks.slice(0, hiddenCount)) f.chunkInputs.set(`${workspaceId}:${chunk.id}`, [{...financeInput}]);
  return chunks;
}

describe("child lineage admission before retrieval windows", () => {
  it.each([alice, bob].flatMap(actor => ["ws-1", "ws-2"].map(workspaceId => [actor, workspaceId] as const)))
    ("replenishes search and answer caches for %j in %s past 500 restricted children", async (actor, workspaceId) => {
      f.domains.set(`${actor.user.id}:${workspaceId}`, ["WORKSPACE"]);
      const chunks = crowdedChildren(workspaceId);
      const params = {actor, workspaceId, query: "policy", limit: 1};
      const first = await searchIndexedKnowledge(params);
      expect(first.map(row => row.chunkId)).toEqual([chunks[500].id]);
      const roots = await getKnowledgeSearchInputRoots(actor, workspaceId, first);
      expect(roots.filter(root => root.kind === "KnowledgeChunk").map(root => root.id)).toEqual(chunks.slice(500).map(row => row.id));
      expect(f.prisma.knowledgeChunk.findMany.mock.calls.filter(([query]) => query.take === 500)).toHaveLength(2);
      expect(f.prisma.knowledgeChunk.findMany.mock.calls.filter(([query]) => query.take === 500)[1][0]).toMatchObject({where: {workspaceId,
        AND: [{OR: expect.arrayContaining([{createdAt: chunks[499].createdAt, chunkIndex: 499, id: {gt: chunks[499].id}}])}]},
        orderBy: [{createdAt: "desc"}, {chunkIndex: "asc"}, {id: "asc"}]});
      expect(await searchIndexedKnowledge(params)).toEqual(first);
      expect(f.gateway.rerank).toHaveBeenCalledTimes(1);
      const answer = await answerKnowledgeQuestion({actor, workspaceId, question: "policy", limit: 1});
      expect(answer.citations.map(row => row.chunkId)).toEqual([chunks[500].id]);
      expect(await answerKnowledgeQuestion({actor, workspaceId, question: "policy", limit: 1})).toEqual(answer);
      expect(f.gateway.chat).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.gateway.rerank.mock.calls)).not.toContain("PRIVATE");
      expect(JSON.stringify(f.gateway.chat.mock.calls)).not.toContain("PRIVATE");
      expect(await fetchReadableKnowledgeChunk(actor, workspaceId, chunks[0].id)).toBeNull();
      expect(await fetchReadableKnowledgeChunk(actor, workspaceId, chunks[500].id)).toMatchObject({id: chunks[500].id});
      const {countReadableKnowledgeChunks} = await import("./counts");
      expect(await countReadableKnowledgeChunks(actor, workspaceId)).toBe(2);
      expect(f.countRelease).toHaveBeenCalledOnce();
      expect(f.countRelease.mock.calls[0].slice(0, 2)).toEqual([actor, workspaceId]);
      const countRoots = f.countRelease.mock.calls[0][2];
      expect(countRoots.filter(root => root.kind === "KnowledgeChunk").map(root => root.id)).toEqual(chunks.slice(500).map(row => row.id));
      expect(countRoots).toContainEqual(expect.objectContaining({kind: "BrainArticle", id: `safe-parent-${workspaceId}`}));
      expect(f.prisma.$queryRaw.mock.calls.filter(([query]) => query.sql.includes("AS current"))).toHaveLength(1);
    });

  it.each(["search", "answer"] as const)("rebuilds %s after an uncited child's own ancestor is revoked", async kind => {
    f.domains.set("bob:ws-1", ["WORKSPACE"]);
    const chunks = crowdedChildren("ws-1", 501);
    f.chunkInputs.set(`ws-1:${chunks[502].id}`, [{...publicInput}]);
    const execute = () => kind === "search" ? searchIndexedKnowledge({actor: bob, workspaceId: "ws-1", query: "policy", limit: 1})
      : answerKnowledgeQuestion({actor: bob, workspaceId: "ws-1", question: "policy", limit: 1});
    await execute();
    f.chunkInputs.get(`ws-1:${chunks[502].id}`)![0].current = false;
    const rebuilt = await execute();
    expect(kind === "search" ? (rebuilt as any[])[0].chunkId : (rebuilt as any).citations[0].chunkId).toBe(chunks[501].id);
    expect(f.gateway.rerank).toHaveBeenCalledTimes(2);
    expect(f.gateway.rerank.mock.calls[1][0].documents).toHaveLength(1);
  });

  it.each(["rerank", "answer", "cache"] as const)("withholds output when admitted child ancestry changes during %s", async phase => {
    f.domains.set("bob:ws-1", ["WORKSPACE"]);
    const chunks = crowdedChildren("ws-1");
    const revoke = () => f.chunkInputs.set(`ws-1:${chunks[501].id}`, [{domain: "WORKSPACE", current: false}]);
    if (phase === "rerank") f.gateway.rerank.mockImplementationOnce(async () => {revoke(); return {results: [{index: 0, score: 1}]};});
    if (phase === "answer") f.gateway.chat.mockImplementationOnce(async () => {revoke(); return {content: "Must be withheld"};});
    if (phase === "cache") f.afterCacheWrite.mockImplementation(revoke);
    if (phase === "answer") expect(await answerKnowledgeQuestion({actor: bob, workspaceId: "ws-1", question: "policy", limit: 1})).toEqual({answer: "I could not find relevant indexed knowledge for that question.", citations: []});
    else expect(await searchIndexedKnowledge({actor: bob, workspaceId: "ws-1", query: "policy", limit: 1})).toEqual([]);
  });

  it("fails explicitly on parent scan overflow before querying or scoring child bodies", async () => {
    for (let index = 0; index < 5001; index++) article(`parent-${index}`, [publicInput]);
    await expect(searchIndexedKnowledge({actor: bob, workspaceId: "ws-1", query: "policy"})).rejects.toMatchObject({code: "KNOWLEDGE_SCAN_LIMIT"});
    expect(f.prisma.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(f.gateway.embed).not.toHaveBeenCalled();
    expect(f.afterCacheWrite).not.toHaveBeenCalled();
  });

  it("fails explicitly at the raw scan bound before models, counts, or caches release partial results", async () => {
    f.domains.set("bob:ws-1", ["WORKSPACE"]);
    crowdedChildren("ws-1", 5001);
    await expect(searchIndexedKnowledge({actor: bob, workspaceId: "ws-1", query: "policy"})).rejects.toMatchObject({code: "KNOWLEDGE_SCAN_LIMIT"});
    const {countReadableKnowledgeChunks} = await import("./counts");
    await expect(countReadableKnowledgeChunks(bob, "ws-1")).rejects.toMatchObject({code: "KNOWLEDGE_SCAN_LIMIT"});
    expect(f.gateway.embed).not.toHaveBeenCalled();
    expect(f.gateway.rerank).not.toHaveBeenCalled();
    expect(f.afterCacheWrite).not.toHaveBeenCalled();
  });
});
