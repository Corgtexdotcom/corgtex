import type { KnowledgeAccessDomain, KnowledgeSourceType, Prisma } from "@prisma/client";
import { getCacheJson, getCacheVersion, incrementCacheVersion, prisma, cosineSimilarity, logger, setCacheJson } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import type { SensitivityLabel } from "./sensitivity";
import { getKnowledgeSearchProvider, isAzureKnowledgeSearchConfigured, normalizeKnowledgeAccessDomains, searchAzureKnowledge } from "./azure-search";

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
const POSTGRES_SEARCH_WINDOW = 500;
const DEFAULT_LEXICAL_WEIGHT = 0.35;
const DEFAULT_SEMANTIC_WEIGHT = 0.65;

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
  cacheVersion: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains: KnowledgeAccessDomain[];
  provider?: string;
  indexName?: string;
}) {
  return [
    "knowledge-search",
    params.provider ?? "postgres",
    params.indexName ?? "",
    params.workspaceId,
    params.cacheVersion,
    params.query.trim().toLowerCase(),
    String(params.limit ?? DEFAULT_SEARCH_LIMIT),
    [...(params.sourceTypes ?? [])].sort().join(","),
    params.maxSensitivity ?? "PUBLIC",
    params.accessDomains.join(","),
  ].join("::");
}

function answerCacheKey(params: {
  workspaceId: string;
  cacheVersion: string;
  question: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  accessDomains: KnowledgeAccessDomain[];
  provider?: string;
  indexName?: string;
}) {
  return [
    "knowledge-answer",
    params.provider ?? "postgres",
    params.indexName ?? "",
    params.workspaceId,
    params.cacheVersion,
    params.question.trim().toLowerCase(),
    String(params.limit ?? DEFAULT_ANSWER_LIMIT),
    [...(params.sourceTypes ?? [])].sort().join(","),
    params.accessDomains.join(","),
  ].join("::");
}

async function knowledgeCacheVersion(workspaceId: string) {
  const [globalVersion, workspaceVersion] = await Promise.all([
    getCacheVersion("knowledge:all"),
    getCacheVersion(`knowledge:${workspaceId}`),
  ]);
  return `${globalVersion}:${workspaceVersion}`;
}

export async function invalidateKnowledgeCache(workspaceId?: string) {
  if (!workspaceId) {
    await incrementCacheVersion("knowledge:all");
    return;
  }

  await incrementCacheVersion(`knowledge:${workspaceId}`);
}


export async function searchIndexedKnowledge(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains?: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
}) {
  const query = params.query.trim();
  if (!query) {
    return [] as KnowledgeSearchResult[];
  }
  const accessDomains = normalizeKnowledgeAccessDomains(params.accessDomains);
  if (accessDomains.length === 0) {
    return [] as KnowledgeSearchResult[];
  }

  const configuredProvider = getKnowledgeSearchProvider();
  const effectiveProvider = configuredProvider === "postgres" || isAzureKnowledgeSearchConfigured("query")
    ? configuredProvider
    : "postgres";

  const cacheVersion = await knowledgeCacheVersion(params.workspaceId);
  const cacheKey = searchCacheKey({
    workspaceId: params.workspaceId,
    cacheVersion,
    query,
    limit: params.limit,
    sourceTypes: params.sourceTypes,
    maxSensitivity: params.maxSensitivity,
    accessDomains,
    provider: effectiveProvider,
    indexName: effectiveProvider === "postgres" ? undefined : process.env.AZURE_SEARCH_INDEX_NAME,
  });
  const cached = await getCacheJson<KnowledgeSearchResult[]>(cacheKey);
  if (cached) {
    return cached;
  }

  const results = await executeKnowledgeSearch({
    ...params,
    query,
    accessDomains,
    provider: effectiveProvider,
    configuredProvider,
  });

  await setCacheJson(cacheKey, results, SEARCH_CACHE_TTL_MS);
  return results;
}

async function executeKnowledgeSearch(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
  provider: "postgres" | "azure" | "dual_compare";
  configuredProvider: "postgres" | "azure" | "dual_compare";
}) {
  if (params.provider === "postgres") {
    return searchIndexedKnowledgePostgres(params);
  }

  try {
    const queryEmbedding = await defaultModelGateway.embed({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      input: params.query,
    });
    const azureResults = await searchAzureKnowledge({
      workspaceId: params.workspaceId,
      query: params.query,
      queryEmbedding: queryEmbedding.embeddings[0] ?? [],
      limit: params.limit,
      sourceTypes: params.sourceTypes,
      maxSensitivity: params.maxSensitivity,
      accessDomains: params.accessDomains,
    });

    if (params.provider === "dual_compare") {
      const postgresResults = await searchIndexedKnowledgePostgres(params, queryEmbedding.embeddings[0] ?? []);
      logDualCompare(params, azureResults, postgresResults);
      return azureResults.length > 0 ? azureResults : postgresResults;
    }

    return azureResults;
  } catch (error) {
    logger.warn("Azure Search retrieval failed; falling back to Postgres knowledge retrieval", {
      workspaceId: params.workspaceId,
      configuredProvider: params.configuredProvider,
      sourceTypes: params.sourceTypes,
      accessDomains: params.accessDomains,
      error: error instanceof Error ? error.message : String(error),
    });
    return searchIndexedKnowledgePostgres(params);
  }
}

function logDualCompare(
  params: { workspaceId: string; sourceTypes?: KnowledgeSourceType[]; accessDomains: KnowledgeAccessDomain[] },
  azureResults: KnowledgeSearchResult[],
  postgresResults: KnowledgeSearchResult[],
) {
  const azureIds = new Set(azureResults.map((result) => result.chunkId));
  const overlap = postgresResults.filter((result) => azureIds.has(result.chunkId)).length;
  logger.info("Knowledge search dual compare", {
    workspaceId: params.workspaceId,
    sourceTypes: params.sourceTypes,
    accessDomains: params.accessDomains,
    azureHitCount: azureResults.length,
    postgresHitCount: postgresResults.length,
    overlap,
  });
}

async function searchIndexedKnowledgePostgres(params: {
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
}, queryEmbeddingOverride?: number[]) {
  const query = params.query;

  const sourceTypeWindows = params.sourceTypes?.length
    ? [...new Set(params.sourceTypes)]
    : [undefined];
  const chunkWindows = await Promise.all(sourceTypeWindows.map((sourceType) => prisma.knowledgeChunk.findMany({
    where: {
      workspaceId: params.workspaceId,
      accessDomain: { in: params.accessDomains },
      sourceType,
      sensitivity: params.maxSensitivity
        ? { in: levelsUpTo(params.maxSensitivity) }
        : undefined,
    },
    orderBy: [{ createdAt: "desc" }, { chunkIndex: "asc" }],
    take: POSTGRES_SEARCH_WINDOW,
    select: {
      id: true,
      sourceType: true,
      sourceId: true,
      sourceTitle: true,
      chunkIndex: true,
      content: true,
      createdAt: true,
    },
  })));
  const chunks = chunkWindows.flat().sort((left, right) =>
    (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0)
    || left.chunkIndex - right.chunkIndex);

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
    where: {
      id: { in: lexicalCandidates.map((c) => c.chunk.id) },
      workspaceId: params.workspaceId,
      accessDomain: { in: params.accessDomains },
    },
    select: { id: true, embedding: true },
  });

  const embeddingMap = new Map(chunkEmbeddings.map((c) => [c.id, c.embedding]));
  const authorizedLexicalCandidates = lexicalCandidates.filter((candidate) => embeddingMap.has(candidate.chunk.id));
  const queryEmbedding = queryEmbeddingOverride
    ? { embeddings: [queryEmbeddingOverride] }
    : await defaultModelGateway.embed({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      input: query,
    });

  const scored = authorizedLexicalCandidates
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

  return results;
}

export async function answerKnowledgeQuestion(params: {
  workspaceId: string;
  question: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  accessDomains?: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
}) {
  const accessDomains = normalizeKnowledgeAccessDomains(params.accessDomains);
  if (accessDomains.length === 0) {
    return {
      answer: "I could not find relevant indexed knowledge for that question.",
      citations: [] as KnowledgeCitation[],
    };
  }
  const cacheVersion = await knowledgeCacheVersion(params.workspaceId);
  const provider = getKnowledgeSearchProvider();
  const effectiveProvider = provider === "postgres" || isAzureKnowledgeSearchConfigured("query") ? provider : "postgres";
  const cacheKey = answerCacheKey({
    ...params,
    accessDomains,
    cacheVersion,
    provider: effectiveProvider,
    indexName: effectiveProvider === "postgres" ? undefined : process.env.AZURE_SEARCH_INDEX_NAME,
  });
  const cached = await getCacheJson<{
    answer: string;
    citations: KnowledgeCitation[];
  }>(cacheKey);
  if (cached) {
    return cached;
  }

  const citations = await searchIndexedKnowledge({
    workspaceId: params.workspaceId,
    query: params.question,
    limit: params.limit ?? DEFAULT_ANSWER_LIMIT,
    sourceTypes: params.sourceTypes,
    accessDomains,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
  });

  if (citations.length === 0) {
    const empty = {
      answer: "I could not find relevant indexed knowledge for that question.",
      citations: [] as KnowledgeCitation[],
    };
    await setCacheJson(cacheKey, empty, SEARCH_CACHE_TTL_MS);
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
  await setCacheJson(cacheKey, answer, SEARCH_CACHE_TTL_MS);
  return answer;
}
