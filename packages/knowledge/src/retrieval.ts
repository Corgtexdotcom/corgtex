import { createHash } from "node:crypto";
import type { KnowledgeAccessDomain, KnowledgeSourceType, Prisma } from "@prisma/client";
import { getCacheJson, getCacheVersion, incrementCacheVersion, prisma, cosineSimilarity, logger, setCacheJson } from "@corgtex/shared";
import { CatalogBudgetError, defaultModelGateway, ModelProviderHttpError, WorkspaceModelBudgetError } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, readableArtifactIds, resolveKnowledgeAccessDomains, type LineageKind, type LineageRoot } from "@corgtex/domain";
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
  actor: AppActor;
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
    "knowledge-search-lineage-v2",
    createHash("sha256").update(JSON.stringify(params.actor)).digest("hex"),
    params.provider ?? "postgres",
    params.indexName ?? "",
    params.workspaceId,
    params.cacheVersion,
    params.query.trim().toLowerCase(),
    String(params.limit ?? DEFAULT_SEARCH_LIMIT),
    [...(params.sourceTypes ?? [])].sort().join(","),
    params.maxSensitivity ?? "ANY",
    params.accessDomains.join(","),
  ].join("::");
}

function answerCacheKey(params: {
  workspaceId: string;
  actor: AppActor;
  cacheVersion: string;
  question: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  accessDomains: KnowledgeAccessDomain[];
  provider?: string;
  indexName?: string;
}) {
  return [
    "knowledge-answer-lineage-v2",
    createHash("sha256").update(JSON.stringify(params.actor)).digest("hex"),
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

const knowledgeLineageKinds: Partial<Record<KnowledgeSourceType, LineageKind>> = {
  BRAIN_ARTICLE: "BrainArticle",
  DOCUMENT: "Document",
  MEETING: "Meeting",
  PROPOSAL: "Proposal",
};

type RetrievalAccess = {
  actor: AppActor;
  workspaceId: string;
  accessDomains: KnowledgeAccessDomain[];
  maxSensitivity?: SensitivityLabel;
  sourceTypes?: KnowledgeSourceType[];
};

type ReadableSource = { contentHash: string; kind: LineageKind; record: { id: string; [key: string]: unknown } };
type SearchRun = { results: KnowledgeSearchResult[]; roots: LineageRoot[] };
type ProvenSearchCache = { schema: 2; results: KnowledgeSearchResult[]; inputRoots: LineageRoot[] };
type SearchProofState = { actorHash: string; workspaceId: string; payloadHash: string; roots: LineageRoot[] };
const searchProofs = new WeakMap<KnowledgeSearchResult[], SearchProofState>();

function fingerprintPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailableInput(error: unknown) {
  return error instanceof Error && "code" in error
    && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code));
}

async function currentInputProof(params: RetrievalAccess, roots: LineageRoot[]) {
  if (roots.length === 0) return false;
  try { return await isArtifactInputProofReadable(params.actor, params.workspaceId, roots); }
  catch (error) {
    if (unavailableInput(error)) return false;
    throw error;
  }
}

function rememberSearchProof(params: RetrievalAccess, run: SearchRun) {
  if (!params.actor) return run.results;
  searchProofs.set(run.results, { actorHash: fingerprintPayload(params.actor), workspaceId: params.workspaceId,
    payloadHash: fingerprintPayload(run.results), roots: run.roots });
  return run.results;
}

/** Server-created search proof includes ranking inputs omitted from display citations. */
export async function getKnowledgeSearchInputRoots(actor: AppActor, workspaceId: string, results: KnowledgeSearchResult[]) {
  const proof = searchProofs.get(results);
  if (!proof || proof.actorHash !== fingerprintPayload(actor) || proof.workspaceId !== workspaceId
    || proof.payloadHash !== fingerprintPayload(results)) throw new Error("Knowledge search input receipt is unavailable.");
  if (results.length === 0 && proof.roots.length === 0) return [] as LineageRoot[];
  if (!await currentInputProof({ actor, workspaceId, accessDomains: [] }, proof.roots)) {
    throw new Error("Knowledge search inputs changed. Please retry.");
  }
  if (proof.payloadHash !== fingerprintPayload(results) || proof.actorHash !== fingerprintPayload(actor)) {
    throw new Error("Knowledge search input changed during receipt validation.");
  }
  return proof.roots.map((root) => ({ ...root }));
}

function provenRoots(value: unknown): value is LineageRoot[] {
  return Array.isArray(value) && value.every((root) => root && typeof root.kind === "string"
    && typeof root.id === "string" && typeof root.fingerprint === "string");
}

async function captureKnowledgeInputs(params: RetrievalAccess,
  chunks: Array<{ id: string; sourceType: KnowledgeSourceType; sourceId: string; [key: string]: unknown }>,
  sources: Map<string, ReadableSource>) {
  if (chunks.length === 0) return [] as LineageRoot[];
  const parentInputs = new Map<string, { kind: LineageKind; id: string; snapshot: Record<string, unknown> }>();
  for (const chunk of chunks) {
    const source = sources.get(`${chunk.sourceType}:${chunk.sourceId}`);
    if (!source) return null;
    parentInputs.set(`${chunk.sourceType}:${chunk.sourceId}`, { kind: source.kind, id: source.record.id, snapshot: source.record });
  }
  try {
    return await captureArtifactInputProof(params.actor, params.workspaceId, [
      ...chunks.map((chunk) => ({ kind: "KnowledgeChunk" as const, id: chunk.id, snapshot: chunk })),
      ...parentInputs.values(),
    ]);
  } catch (error) {
    if (unavailableInput(error)) return null;
    throw error;
  }
}

async function currentAccessDomains(actor: AppActor, workspaceId: string, requested?: KnowledgeAccessDomain[]) {
  // Missing actor in an old caller cannot turn a domain hint into authorization.
  if (!actor) return [] as KnowledgeAccessDomain[];
  const current = await resolveKnowledgeAccessDomains(actor, workspaceId);
  return normalizeKnowledgeAccessDomains(requested).filter((domain) => current.includes(domain));
}

/** Full source rows are needed to verify the content fingerprint, including uncited prompt inputs. */
async function readableKnowledgeSources(params: RetrievalAccess, sourceIds?: Map<KnowledgeSourceType, string[]>) {
  const sources = new Map<string, ReadableSource>();
  const requested = params.sourceTypes?.length ? params.sourceTypes : Object.keys(knowledgeLineageKinds) as KnowledgeSourceType[];
  for (const sourceType of [...new Set(requested)]) {
    const kind = knowledgeLineageKinds[sourceType];
    if (!kind) continue; // No complete input proof exists for this source type.
    const ids = sourceIds?.get(sourceType);
    if (sourceIds && !ids?.length) continue;
    const where = { workspaceId: params.workspaceId, ...(ids ? { id: { in: ids } } : {}), archivedAt: null };
    const records = sourceType === "BRAIN_ARTICLE"
      ? await prisma.brainArticle.findMany({ where: { ...where, OR: [{ isPrivate: false }, { variantOfArticleId: { not: null }, isPrivate: true }] } })
      : sourceType === "DOCUMENT"
        ? await prisma.document.findMany({ where: { ...where, accessDomain: { in: params.accessDomains } } })
        : sourceType === "MEETING"
          ? await prisma.meeting.findMany({ where })
          : await prisma.proposal.findMany({ where });
    const readable = await readableArtifactIds(params.actor, params.workspaceId, kind, records);
    for (const record of records) {
      if (readable.has(record.id)) sources.set(`${sourceType}:${record.id}`, {
        contentHash: lineageContentFingerprint(kind, record), kind, record,
      });
    }
  }
  return sources;
}

// SQL receipts and live source inputs are authoritative over cached/Azure text.
async function currentKnowledgeCitations<T extends KnowledgeCitation>(params: RetrievalAccess, citations: T[]): Promise<T[]> {
  const accessDomains = await currentAccessDomains(params.actor, params.workspaceId, params.accessDomains);
  if (citations.length === 0 || accessDomains.length === 0) return [];
  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      id: { in: citations.map((citation) => citation.chunkId) },
      workspaceId: params.workspaceId,
      accessDomain: { in: accessDomains },
      sourceType: params.sourceTypes?.length ? { in: params.sourceTypes } : undefined,
      sensitivity: params.maxSensitivity ? { in: levelsUpTo(params.maxSensitivity) } : undefined,
    },
    select: { id: true, sourceType: true, sourceId: true, sourceTitle: true, chunkIndex: true, content: true, metadata: true },
  });
  const sourceIds = new Map<KnowledgeSourceType, string[]>();
  for (const chunk of chunks) sourceIds.set(chunk.sourceType, [...(sourceIds.get(chunk.sourceType) ?? []), chunk.sourceId]);
  const sources = await readableKnowledgeSources({ ...params, accessDomains }, sourceIds);
  const receipts = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return citations.filter((citation) => {
    const chunk = receipts.get(citation.chunkId);
    if (!chunk || chunk.sourceType !== citation.sourceType || chunk.sourceId !== citation.sourceId
      || chunk.chunkIndex !== citation.chunkIndex || chunk.content.slice(0, 400) !== citation.snippet
      || chunk.sourceTitle !== citation.title) return false;
    const source = sources.get(`${chunk.sourceType}:${chunk.sourceId}`);
    return !!source && (chunk.metadata as Record<string, unknown> | null)?.sourceContentHash === source.contentHash;
  });
}

/** Fetching a previously returned id uses the same live proof as search/cache reads. */
export async function fetchReadableKnowledgeChunk(actor: AppActor, workspaceId: string, chunkId: string) {
  if (!actor) return null;
  const accessDomains = normalizeKnowledgeAccessDomains(await resolveKnowledgeAccessDomains(actor, workspaceId));
  if (accessDomains.length === 0) return null;
  const chunk = await prisma.knowledgeChunk.findFirst({
    where: { id: chunkId, workspaceId, accessDomain: { in: accessDomains } },
  });
  if (!chunk) return null;
  const citations = await currentKnowledgeCitations({ actor, workspaceId, accessDomains }, [{
    chunkId: chunk.id,
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    title: chunk.sourceTitle,
    chunkIndex: chunk.chunkIndex,
    snippet: chunk.content.slice(0, 400),
  }]);
  return citations.length === 1 ? chunk : null;
}

async function currentSearchResults(
  params: Parameters<typeof searchIndexedKnowledgePostgres>[0],
  run: SearchRun,
): Promise<SearchRun> {
  if (run.roots.length && !await currentInputProof(params, run.roots)) return { results: [], roots: [] };
  const current = await currentKnowledgeCitations(params, run.results);
  return current.length === run.results.length ? { results: current, roots: run.roots } : { results: [], roots: [] };
}

export async function invalidateKnowledgeCache(workspaceId?: string, transaction?: Prisma.TransactionClient) {
  if (!workspaceId) {
    await incrementCacheVersion("knowledge:all", transaction);
    return;
  }

  await incrementCacheVersion(`knowledge:${workspaceId}`, transaction);
}


export async function searchIndexedKnowledge(params: {
  actor: AppActor;
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains?: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
}) {
  const query = params.query.trim();
  if (!query) {
    return rememberSearchProof({ ...params, accessDomains: [] }, { results: [], roots: [] });
  }
  const accessDomains = await currentAccessDomains(params.actor, params.workspaceId, params.accessDomains);
  if (accessDomains.length === 0) {
    return rememberSearchProof({ ...params, accessDomains: [] }, { results: [], roots: [] });
  }

  const configuredProvider = getKnowledgeSearchProvider();
  const effectiveProvider = configuredProvider === "postgres" || isAzureKnowledgeSearchConfigured("query")
    ? configuredProvider
    : "postgres";

  const cacheVersion = await knowledgeCacheVersion(params.workspaceId);
  const cacheKey = searchCacheKey({
    actor: params.actor,
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
  const access = { ...params, query, accessDomains };
  const cached = await getCacheJson<ProvenSearchCache>(cacheKey);
  if (cached?.schema === 2 && Array.isArray(cached.results) && provenRoots(cached.inputRoots)
    && await currentInputProof(access, cached.inputRoots)) {
    const current = await currentKnowledgeCitations(access, cached.results);
    if (current.length === cached.results.length && await currentInputProof(access, cached.inputRoots)) {
      return rememberSearchProof(access, { results: current, roots: cached.inputRoots });
    }
  }

  // A stale or legacy cache rebuilds rankings from current SQL inputs; old
  // provider scores are never retained and a second Azure call is unnecessary.
  const run = cached ? await searchIndexedKnowledgePostgres(access)
    : await executeKnowledgeSearch({ ...access, provider: effectiveProvider, configuredProvider });
  const current = await currentSearchResults(access, run);
  if (!current.roots.length || !await currentInputProof(access, current.roots)) return rememberSearchProof(access, { results: [], roots: [] });
  await setCacheJson(cacheKey, { schema: 2, results: current.results, inputRoots: current.roots } satisfies ProvenSearchCache, SEARCH_CACHE_TTL_MS);
  if (!await currentInputProof(access, current.roots)) return rememberSearchProof(access, { results: [], roots: [] });
  const released = await currentKnowledgeCitations(access, current.results);
  return rememberSearchProof(access, released.length === current.results.length && await currentInputProof(access, current.roots)
    ? { results: released, roots: current.roots } : { results: [], roots: [] });
}

async function executeKnowledgeSearch(params: {
  actor: AppActor;
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
  provider: "postgres" | "azure" | "dual_compare";
  configuredProvider: "postgres" | "azure" | "dual_compare";
}) {
  if (params.provider === "postgres") {
    return searchIndexedKnowledgePostgres(params);
  }

  let queryVector: number[];
  try {
    const queryEmbedding = await defaultModelGateway.embed({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      catalogItemId: params.catalogItemId,
      agentCredentialId: params.agentCredentialId,
      input: params.query,
    });
    queryVector = queryEmbedding.embeddings[0] ?? [];
    await searchAzureKnowledge({
      workspaceId: params.workspaceId,
      query: params.query,
      queryEmbedding: queryVector,
      limit: params.limit,
      sourceTypes: params.sourceTypes,
      maxSensitivity: params.maxSensitivity,
      accessDomains: params.accessDomains,
    });
  } catch (error) {
    if (error instanceof CatalogBudgetError || error instanceof WorkspaceModelBudgetError) throw error;
    logger.warn("Azure Search retrieval failed; falling back to Postgres knowledge retrieval", {
      workspaceId: params.workspaceId,
      configuredProvider: params.configuredProvider,
      sourceTypes: params.sourceTypes,
      accessDomains: params.accessDomains,
      error: error instanceof Error ? error.message : String(error),
    });
    return searchIndexedKnowledgePostgres(params);
  }

  // Azure hit membership, order and scores can depend on unseen private inputs.
  // Its suggestions cannot determine the candidate cap or any displayed rank.
  // Recompute from the canonical permitted SQL pool, reusing the charged query
  // embedding; all local candidates are captured before scoring and reranking.
  return searchIndexedKnowledgePostgres(params, queryVector);
}

async function searchIndexedKnowledgePostgres(params: {
  actor: AppActor;
  workspaceId: string;
  query: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  maxSensitivity?: SensitivityLabel;
  accessDomains: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
  catalogItemId?: string;
  agentCredentialId?: string;
}, queryEmbeddingOverride?: number[]): Promise<SearchRun> {
  const query = params.query;

  const sources = await readableKnowledgeSources(params);
  const sourceTypeWindows = params.sourceTypes?.length
    ? [...new Set(params.sourceTypes)]
    : [undefined];
  const chunkWindows = await Promise.all(sourceTypeWindows.map((sourceType) => prisma.knowledgeChunk.findMany({
    where: {
      workspaceId: params.workspaceId,
      accessDomain: { in: params.accessDomains },
      sourceType,
      OR: [...sources].filter(([key]) => !sourceType || key.startsWith(`${sourceType}:`)).map(([key, source]) => {
        const separator = key.indexOf(":");
        return {
          sourceType: key.slice(0, separator) as KnowledgeSourceType,
          sourceId: key.slice(separator + 1),
          metadata: { path: ["sourceContentHash"], equals: source.contentHash },
        };
      }),
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
      metadata: true,
      accessDomain: true,
      sensitivity: true,
      createdAt: true,
    },
  })));
  const chunks = chunkWindows.flat().filter((chunk) => {
    const source = sources.get(`${chunk.sourceType}:${chunk.sourceId}`);
    return !!source && (chunk.metadata as Record<string, unknown> | null)?.sourceContentHash === source.contentHash;
  }).sort((left, right) =>
    (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0)
    || left.chunkIndex - right.chunkIndex);

  if (chunks.length === 0) {
    return { results: [], roots: [] };
  }

  // Every inspected candidate can influence selection, even if it is omitted
  // from the rerank prompt or final citations. Capture exact chunks and parents.
  const roots = await captureKnowledgeInputs(params, chunks, sources);
  if (!roots) return { results: [], roots: [] };
  if (!await currentInputProof(params, roots)) return { results: [], roots };

  // Pre-filter with lexical score
  const lexicalCandidates = chunks
    .map((chunk) => {
      const lexical = lexicalScore(query, chunk.content, chunk.sourceTitle);
      return { chunk, lexical };
    })
    .sort((a, b) => b.lexical - a.lexical)
    .slice(0, Math.max(30, (params.limit ?? 5) * 6));

  if (lexicalCandidates.length === 0) {
    return { results: [], roots };
  }

  // Load embeddings only for the top lexical candidates
  const chunkEmbeddings = await prisma.knowledgeChunk.findMany({
    where: {
      id: { in: lexicalCandidates.map((c) => c.chunk.id) },
      workspaceId: params.workspaceId,
      accessDomain: { in: params.accessDomains },
      sourceType: params.sourceTypes?.length ? { in: params.sourceTypes } : undefined,
      sensitivity: params.maxSensitivity
        ? { in: levelsUpTo(params.maxSensitivity) }
        : undefined,
    },
    select: { id: true, embedding: true },
  });

  const embeddingMap = new Map(chunkEmbeddings.map((c) => [c.id, c.embedding]));
  const authorizedLexicalCandidates = lexicalCandidates.filter((candidate) => embeddingMap.has(candidate.chunk.id));
  const resultLimit = Math.max(1, params.limit ?? DEFAULT_SEARCH_LIMIT);
  const toResult = (chunk: typeof chunks[number], score: number): KnowledgeSearchResult => ({
    chunkId: chunk.id,
    sourceType: chunk.sourceType,
    sourceId: chunk.sourceId,
    title: chunk.sourceTitle,
    chunkIndex: chunk.chunkIndex,
    snippet: chunk.content.slice(0, 400),
    score: Number(score.toFixed(6)),
  });
  let queryEmbedding;
  try {
    queryEmbedding = queryEmbeddingOverride
      ? { embeddings: [queryEmbeddingOverride] }
      : await defaultModelGateway.embed({
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId,
        agentRunId: params.agentRunId,
        catalogItemId: params.catalogItemId,
        agentCredentialId: params.agentCredentialId,
        input: query,
        failFastOnRateLimit: true,
      });
  } catch (error) {
    if (!(error instanceof ModelProviderHttpError) || error.status !== 429) throw error;
    logger.warn("Knowledge search using lexical ranking after provider rate limit", {
      workspaceId: params.workspaceId,
      stage: "query_embedding",
      httpStatus: error.status,
    });
    return await currentInputProof(params, roots) ? { roots, results: authorizedLexicalCandidates
      .filter(({ lexical }) => lexical > 0)
      .slice(0, resultLimit)
      .map(({ chunk, lexical }) => toResult(chunk, lexical)) } : { results: [], roots };
  }

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
    return { results: [], roots };
  }

  if (!await currentInputProof(params, roots)) return { results: [], roots };
  try {
    const reranked = await defaultModelGateway.rerank({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      agentRunId: params.agentRunId,
      catalogItemId: params.catalogItemId,
      agentCredentialId: params.agentCredentialId,
      query,
      documents: scored.map((entry) => `${entry.chunk.sourceTitle ?? ""}\n${entry.chunk.content}`.trim()),
      topK: resultLimit,
      failFastOnRateLimit: true,
    });
    return await currentInputProof(params, roots) ? { roots, results: reranked.results.map((result) => toResult(scored[result.index].chunk, result.score)) } : { results: [], roots };
  } catch (error) {
    if (!(error instanceof ModelProviderHttpError) || error.status !== 429) throw error;
    logger.warn("Knowledge search using combined ranking after provider rate limit", {
      workspaceId: params.workspaceId,
      stage: "rerank",
      httpStatus: error.status,
    });
    return await currentInputProof(params, roots) ? { roots, results: scored.slice(0, resultLimit).map(({ chunk, score }) => toResult(chunk, score)) } : { results: [], roots };
  }
}

export async function answerKnowledgeQuestion(params: {
  actor: AppActor;
  workspaceId: string;
  question: string;
  limit?: number;
  sourceTypes?: KnowledgeSourceType[];
  accessDomains?: KnowledgeAccessDomain[];
  workflowJobId?: string;
  agentRunId?: string;
}) {
  const accessDomains = await currentAccessDomains(params.actor, params.workspaceId, params.accessDomains);
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
    schema: 2;
    inputRoots: LineageRoot[];
  }>(cacheKey);
  if (cached?.schema === 2 && Array.isArray(cached.citations) && provenRoots(cached.inputRoots)
    && await currentInputProof({ ...params, accessDomains }, cached.inputRoots)) {
    const currentCitations = await currentKnowledgeCitations({ ...params, accessDomains }, cached.citations);
    if (currentCitations.length === cached.citations.length && await currentInputProof({ ...params, accessDomains }, cached.inputRoots)) {
      return { answer: cached.answer, citations: currentCitations };
    }
  }

  const citations = await searchIndexedKnowledge({
    actor: params.actor,
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
    return empty;
  }

  const inputRoots = await getKnowledgeSearchInputRoots(params.actor, params.workspaceId, citations);
  if (!await currentInputProof({ ...params, accessDomains }, inputRoots)) {
    return { answer: "I could not find relevant indexed knowledge for that question.", citations: [] as KnowledgeCitation[] };
  }

  const snippets = citations
    .map((citation, index) => `[${index + 1}] ${citation.title ?? citation.sourceId} (${citation.sourceType})\n${citation.snippet}`)
    .join("\n\n");

  const { resolveModel } = await import("@corgtex/models");
  if (!await currentInputProof({ ...params, accessDomains }, inputRoots)) {
    return { answer: "I could not find relevant indexed knowledge for that question.", citations: [] as KnowledgeCitation[] };
  }
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
  const currentCitations = await currentKnowledgeCitations({ ...params, accessDomains }, answer.citations);
  if (currentCitations.length !== answer.citations.length || !await currentInputProof({ ...params, accessDomains }, inputRoots)) {
    return { answer: "I could not find relevant indexed knowledge for that question.", citations: [] as KnowledgeCitation[] };
  }
  await setCacheJson(cacheKey, { ...answer, schema: 2, inputRoots }, SEARCH_CACHE_TTL_MS);
  if ((await currentKnowledgeCitations({ ...params, accessDomains }, answer.citations)).length !== answer.citations.length
    || !await currentInputProof({ ...params, accessDomains }, inputRoots)) {
    return { answer: "I could not find relevant indexed knowledge for that question.", citations: [] as KnowledgeCitation[] };
  }
  return answer;
}
