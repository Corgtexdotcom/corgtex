import type { KnowledgeSourceType, Prisma } from "@prisma/client";
import { prisma, cosineSimilarity } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import type { SensitivityLabel } from "./sensitivity";

const sensitivityOrder: SensitivityLabel[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "PII"];

function levelsUpTo(maxLevel: SensitivityLabel): SensitivityLabel[] {
  const index = sensitivityOrder.indexOf(maxLevel);
  if (index === -1) return ["PUBLIC"];
  return sensitivityOrder.slice(0, index + 1);
}

export type KnowledgeCitation = {
  chunkId: string;
  sourceType: KnowledgeSourceType;
  sourceId: string;
  title: string | null;
  chunkIndex: number;
  snippet: string;
};

export type KnowledgeSearchResult = KnowledgeCitation & {
  score: number;
};

const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_ANSWER_LIMIT = 8;
const DEFAULT_LEXICAL_WEIGHT = 0.35;
const DEFAULT_SEMANTIC_WEIGHT = 0.65;
const searchCache = new Map<string, { expiresAt: number; value: KnowledgeSearchResult[] }>();
const answerCache = new Map<string, {
  expiresAt: number;
  value: {
    answer: string;
    citations: KnowledgeCitation[];
  };
}>();

function parseWeight(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const LEXICAL_WEIGHT = parseWeight(process.env.RAG_LEXICAL_WEIGHT, DEFAULT_LEXICAL_WEIGHT);
const SEMANTIC_WEIGHT = parseWeight(process.env.RAG_SEMANTIC_WEIGHT, DEFAULT_SEMANTIC_WEIGHT);

function asEmbedding(value: Prisma.JsonValue | null): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => typeof entry === "number" ? entry : Number(entry))
    .filter((entry) => Number.isFinite(entry));
}

function tokenize(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 2);
}

function lexicalScore(query: string, content: string, title?: string | null) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return 0;
  }

  const haystack = `${title ?? ""} ${content}`.toLowerCase();
  let matches = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) {
      matches += 1;
    }
  }

  return matches / queryTerms.length;
}


function searchCacheKey(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
}) {
  return [
    params.workspaceId,
    params.query.trim().toLowerCase(),
    String(params.limit ?? DEFAULT_SEARCH_LIMIT),
    [...(params.sourceTypes ?? [])].sort().join(","),
    params.maxSensitivity ?? "PUBLIC",
  ].join("::");
}

function answerCacheKey(params: {
  workspaceId: string;
  question: string;
  limit?: number;
}) {
  return [
    params.workspaceId,
    params.question.trim().toLowerCase(),
    String(params.limit ?? DEFAULT_ANSWER_LIMIT),
  ].join("::");
}

function getCachedValue<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string) {
  const hit = cache.get(key);
  if (!hit) {
    return null;
  }

  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return hit.value;
}

function setCachedValue<T>(cache: Map<string, { expiresAt: number; value: T }>, key: string, value: T) {
  if (cache.size > 200) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
       cache.delete(oldestKey);
    }
  }

  cache.set(key, {
    expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
    value,
  });
}

export function invalidateKnowledgeCache(workspaceId?: string) {
  if (!workspaceId) {
    searchCache.clear();
    answerCache.clear();
    return;
  }

  for (const key of searchCache.keys()) {
    if (key.startsWith(`${workspaceId}::`)) {
      searchCache.delete(key);
    }
  }

  for (const key of answerCache.keys()) {
    if (key.startsWith(`${workspaceId}::`)) {
      answerCache.delete(key);
    }
  }
}


export async function searchIndexedKnowledge(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  workflowJobId?: string;
  agentRunId?: string;
}) {
  const query = params.query.trim();
  if (!query) {
    return [] as KnowledgeSearchResult[];
  }

  const cacheKey = searchCacheKey({
    workspaceId: params.workspaceId,
    query,
    limit: params.limit,
    sourceTypes: params.sourceTypes,
    maxSensitivity: params.maxSensitivity,
  });
  const cached = getCachedValue(searchCache, cacheKey);
  if (cached) {
    return cached;
  }

  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      workspaceId: params.workspaceId,
      sourceType: params.sourceTypes?.length ? { in: params.sourceTypes } : undefined,
      sensitivity: params.maxSensitivity
        ? { in: levelsUpTo(params.maxSensitivity) }
        : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { chunkIndex: "asc" }],
    take: params.sourceTypes ? 250 : 500,
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceTitle: true,
      chunkIndex: true,
      content: true,
    },
  });

  if (chunks.length === 0) {
    return [] as KnowledgeSearchResult[];
  }

  // Pre-filter with lexical score
  const lexicalCandidates = chunks
    .map((chunk) => {
      const lexical = lexicalScore(query, chunk.content, chunk.sourceTitle);
      return { chunk, lexical };
    })
    .sort((a, b) => b.lexical - a.lexical)
    .slice(0, Math.max(30, (params.limit ?? 5) * 6));

  if (lexicalCandidates.length === 0) {
    return [] as KnowledgeSearchResult[];
  }

  // Load embeddings only for the top lexical candidates
  const chunkEmbeddings = await prisma.knowledgeChunk.findMany({
    where: { id: { in: lexicalCandidates.map((c) => c.chunk.id) } },
    select: { id: true, embedding: true },
  });

  const embeddingMap = new Map(chunkEmbeddings.map((c) => [c.id, c.embedding]));
  const queryEmbedding = await defaultModelGateway.embed({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    input: query,
  });

  const scored = lexicalCandidates
    .map(({ chunk, lexical }) => {
      const embedding = embeddingMap.get(chunk.id) ?? null;
      const semantic = cosineSimilarity(queryEmbedding.embeddings[0] ?? [], asEmbedding(embedding));
      const score = Number((lexical * LEXICAL_WEIGHT + semantic * SEMANTIC_WEIGHT).toFixed(6));

      return {
        chunk,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(DEFAULT_SEARCH_LIMIT, params.limit ?? DEFAULT_SEARCH_LIMIT) * 3);

  if (scored.length === 0) {
    return [] as KnowledgeSearchResult[];
  }

  const reranked = await defaultModelGateway.rerank({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    query,
    documents: scored.map((entry) => `${entry.chunk.sourceTitle ?? ""}\n${entry.chunk.content}`.trim()),
    topK: Math.max(1, params.limit ?? DEFAULT_SEARCH_LIMIT),
  });

  const results = reranked.results.map((result) => {
    const candidate = scored[result.index];
    return {
      chunkId: candidate.chunk.id,
      sourceType: candidate.chunk.sourceType,
      sourceId: candidate.chunk.sourceId,
      title: candidate.chunk.sourceTitle,
      chunkIndex: candidate.chunk.chunkIndex,
      snippet: candidate.chunk.content.slice(0, 400),
      score: Number(result.score.toFixed(6)),
    };
  });

  setCachedValue(searchCache, cacheKey, results);
  return results;
}

export async function answerKnowledgeQuestion(params: {
  workspaceId: string;
  question: string;
  limit?: number;
  workflowJobId?: string;
  agentRunId?: string;
}) {
  const cacheKey = answerCacheKey(params);
  const cached = getCachedValue(answerCache, cacheKey);
  if (cached) {
    return cached;
  }

  const citations = await searchIndexedKnowledge({
    workspaceId: params.workspaceId,
    query: params.question,
    limit: params.limit ?? DEFAULT_ANSWER_LIMIT,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
  });

  if (citations.length === 0) {
    const empty = {
      answer: "I could not find relevant indexed knowledge for that question.",
      citations: [] as KnowledgeCitation[],
    };
    setCachedValue(answerCache, cacheKey, empty);
    return empty;
  }

  const snippets = citations
    .map((citation, index) => `[${index + 1}] ${citation.title ?? citation.sourceId} (${citation.sourceType})\n${citation.snippet}`)
    .join("\n\n");

  const { resolveModel } = await import("@corgtex/models");
  const response = await defaultModelGateway.chat({
    model: resolveModel("quality"),
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    taskType: "CHAT",
    messages: [
      {
        role: "system",
        content: "You are a grounded question answering assistant. Answer only from the provided indexed knowledge snippets. Cite supporting snippets inline using [1], [2], etc. If the snippets conflict or contain multiple correct answers, synthesize them clearly. If the snippets are insufficient or do not contain the answer, say 'I don't know' plainly without guessing.",
      },
      {
        role: "user",
        content: `QUESTION:\n${params.question}\n\nSNIPPETS:\n${snippets}`,
      },
    ],
  });

  const answer = {
    answer: response.content,
    citations: citations.map(({ score, ...citation }) => citation),
  };
  setCachedValue(answerCache, cacheKey, answer);
  return answer;
}
