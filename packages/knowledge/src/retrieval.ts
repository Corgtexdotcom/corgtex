import { createHash } from "node:crypto";
import { Prisma, type KnowledgeAccessDomain, type KnowledgeSourceType } from "@prisma/client";
import { getCacheJson, getCacheVersion, incrementCacheVersion, prisma, cosineSimilarity, logger, setCacheJson } from "@corgtex/shared";
import { CatalogBudgetError, defaultModelGateway, ModelProviderHttpError, WorkspaceModelBudgetError } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { mergeLineageInputRoot, captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, readableArtifactIds, resolveKnowledgeAccessDomains, type LineageKind, type LineageRoot } from "@corgtex/domain";
import type { SensitivityLabel } from "./sensitivity";
import { getKnowledgeSearchProvider, isAzureKnowledgeSearchConfigured, normalizeKnowledgeAccessDomains, searchAzureKnowledge } from "./azure-search";
import { captureSqlCountCollection, captureSqlCountPageProof, captureSqlCountStamps, isSqlCountLedgerCurrent, retainSqlCountEpochs,
  type SqlCountEpoch, type SqlCountStamp } from "./sql-count-proof";
import { captureArtifactReadHeadObservation, isArtifactInputProofReadableAtObservedHeads, withArtifactCountReleaseSnapshot } from "../../domain/src/source-lineage";
import { isSqlNativeRunInputLocallyCurrent, loadSqlNativeRunInputs } from "../../domain/src/sql-native-input";

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
const KNOWLEDGE_SCAN_LIMIT = 5_000;

function scanLimitExceeded(): never {
  throw Object.assign(new Error("Knowledge permission scan exceeded its safe limit."), { code: "KNOWLEDGE_SCAN_LIMIT", status: 409 });
}
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
  EXTERNAL_CONTENT: "ExternalContentSource",
  EXTERNAL_DATABASE: "SqlNativeRunInput",
};

type RetrievalAccess = {
  actor: AppActor;
  workspaceId: string;
  accessDomains: KnowledgeAccessDomain[];
  maxSensitivity?: SensitivityLabel;
  sourceTypes?: KnowledgeSourceType[];
};

const knowledgeSourceKey = (chunk: {sourceType: KnowledgeSourceType; sourceId: string; metadata?: unknown}) =>
  `${chunk.sourceType}:${chunk.sourceType === "EXTERNAL_DATABASE" ? (chunk.metadata as Record<string, unknown> | null)?.nativeInputId : chunk.sourceId}`;

type ReadableSource = { contentHash: string; kind: LineageKind; record: { id: string; [key: string]: unknown } };
type SearchRun = { results: KnowledgeSearchResult[]; roots: LineageRoot[] };
type ProvenSearchCache = { schema: 2; results: KnowledgeSearchResult[]; inputRoots: LineageRoot[]; inputHeads: [string, string][] };
type SearchProofState = { actorHash: string; workspaceId: string; payloadHash: string; roots: LineageRoot[] };
const searchProofs = new WeakMap<KnowledgeSearchResult[], SearchProofState>();
// Compact selected-input observations survive page boundaries and every later
// ranking/cache/answer check. Denied rows never enter this retained head ledger.
const searchInputHeads = new WeakMap<LineageRoot[], Map<string, string>>();

function restoreSearchInputHeads(roots: LineageRoot[], value: unknown) {
  if (!Array.isArray(value) || !value.every(entry => Array.isArray(entry) && entry.length === 2
    && entry.every(part => typeof part === "string"))) return false;
  searchInputHeads.set(roots, new Map(value as [string, string][]));
  return true;
}

function serializedSearchInputHeads(roots: LineageRoot[]) {
  return [...(searchInputHeads.get(roots) ?? new Map<string, string>())];
}

function fingerprintPayload(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unavailableInput(error: unknown) {
  return error instanceof Error && "code" in error
    && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code));
}

async function currentInputProof(params: RetrievalAccess, roots: LineageRoot[]) {
  if (roots.length === 0) return false;
  try {
    const heads = searchInputHeads.get(roots);
    if (heads?.size) return await isArtifactInputProofReadableAtObservedHeads(params.actor, params.workspaceId, roots, heads);
    const {isSqlKnowledgeInputProofReadable} = await import("../../domain/src/sql-knowledge-read-proof");
    const sql = await isSqlKnowledgeInputProofReadable(params.actor, params.workspaceId, roots);
    return sql ?? await isArtifactInputProofReadable(params.actor, params.workspaceId, roots);
  }
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
  const roots = proof.roots.map((root) => ({ ...root }));
  const heads = searchInputHeads.get(proof.roots);
  if (heads) searchInputHeads.set(roots, heads);
  return roots;
}

function provenRoots(value: unknown): value is LineageRoot[] {
  return Array.isArray(value) && value.every((root) => root && typeof root.kind === "string"
    && typeof root.id === "string" && typeof root.fingerprint === "string");
}

async function captureKnowledgeInputs(params: RetrievalAccess,
  chunks: Array<{ id: string; sourceType: KnowledgeSourceType; sourceId: string; [key: string]: unknown }>,
  sources: Map<string, ReadableSource>) {
  if (chunks.length === 0) return [] as LineageRoot[];
  const {captureSqlKnowledgeInputProof} = await import("../../domain/src/sql-knowledge-read-proof");
  const sql = await captureSqlKnowledgeInputProof(params.actor, params.workspaceId, chunks as unknown as import("@prisma/client").KnowledgeChunk[]);
  if (sql !== undefined) return sql;
  const parentInputs = new Map<string, { kind: LineageKind; id: string; snapshot: Record<string, unknown> }>();
  for (const chunk of chunks) {
    const source = sources.get(knowledgeSourceKey(chunk));
    if (!source) return null;
    parentInputs.set(`${source.kind}:${source.record.id}`, { kind: source.kind, id: source.record.id, snapshot: source.record });
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
  let scanned = 0;
  for (const sourceType of [...new Set(requested)]) {
    const kind = knowledgeLineageKinds[sourceType];
    if (!kind) continue; // No complete input proof exists for this source type.
    const ids = sourceIds?.get(sourceType);
    if (sourceIds && !ids?.length) continue;
    if (sourceType === "EXTERNAL_DATABASE") {
      // Bound source admission by immutable native runs, rather than 10k row
      // namespaces. Only current committed children can introduce a run here.
      const nativeIds = await prisma.$queryRaw<Array<{id: string}>>(Prisma.sql`
        SELECT DISTINCT i.id FROM "SqlNativeRunInput" i
        JOIN "SqlKnowledgePublication" p ON p."nativeInputId" = i.id AND p."workspaceId" = i."workspaceId" AND p.status = 'COMMITTED'
        WHERE i."workspaceId" = ${params.workspaceId} AND EXISTS (
          SELECT 1 FROM "KnowledgeChunk" k WHERE k."workspaceId" = i."workspaceId" AND k."sourceType" = 'EXTERNAL_DATABASE'
          AND k.metadata->>'nativeInputId' = i.id AND k.metadata->>'sqlPublicationId' = p.id
          AND k."accessDomain"::text IN (${Prisma.join(params.accessDomains)})
          ${ids ? Prisma.sql`AND k."sourceId" IN (${Prisma.join(ids)})` : Prisma.empty})
        ORDER BY i.id LIMIT ${KNOWLEDGE_SCAN_LIMIT - scanned + 1}`);
      scanned += nativeIds.length;
      if (scanned > KNOWLEDGE_SCAN_LIMIT) scanLimitExceeded();
      if (!nativeIds.length) continue;
      const records = await loadSqlNativeRunInputs(params.workspaceId, nativeIds.map(row => row.id));
      const readable = await readableArtifactIds(params.actor, params.workspaceId, "SqlNativeRunInput", records);
      for (const record of records) if (readable.has(record.id)) sources.set(`${sourceType}:${record.id}`, {
        kind, record, contentHash: lineageContentFingerprint(kind, record)});
      continue;
    }
    const where = { workspaceId: params.workspaceId, ...(ids ? { id: { in: ids } } : {}), archivedAt: null };
    const scan = { take: ids ? Math.min(ids.length, KNOWLEDGE_SCAN_LIMIT - scanned + 1) : KNOWLEDGE_SCAN_LIMIT - scanned + 1 };
    const records = sourceType === "BRAIN_ARTICLE"
      ? await prisma.brainArticle.findMany({ ...scan, where: { ...where, OR: [{ isPrivate: false }, { variantOfArticleId: { not: null }, isPrivate: true }] } })
      : sourceType === "DOCUMENT"
        ? await prisma.document.findMany({ ...scan, where: { ...where, accessDomain: { in: params.accessDomains } } })
        : sourceType === "MEETING"
          ? await prisma.meeting.findMany({ ...scan, where })
          : sourceType === "EXTERNAL_CONTENT" ? await prisma.externalContentSource.findMany({...scan, where})
            : await prisma.proposal.findMany({ ...scan, where });
    scanned += records.length;
    if (scanned > KNOWLEDGE_SCAN_LIMIT) scanLimitExceeded();
    const readable = await readableArtifactIds(params.actor, params.workspaceId, kind, records);
    for (const record of records) {
      if (readable.has(record.id)) sources.set(`${sourceType}:${record.id}`, {
        contentHash: lineageContentFingerprint(kind, record), kind, record,
      });
    }
  }
  return sources;
}

const chunkProjection = {
  id: true, workspaceId: true, sourceType: true, sourceId: true, sourceTitle: true,
  chunkIndex: true, content: true, metadata: true, accessDomain: true, sensitivity: true, createdAt: true,
  embedding: true, embeddingModel: true, tokenCount: true,
} as const;
type PermissionChunk = Prisma.KnowledgeChunkGetPayload<{ select: typeof chunkProjection }>;

/** The child's own manifest can restrict it further than its readable parent. */
async function admitKnowledgeChunks(params: RetrievalAccess, chunks: PermissionChunk[], sources: Map<string, ReadableSource>,
  retainProof?: (roots: LineageRoot[]) => void) {
  const current = chunks.filter((chunk) => {
    const source = sources.get(knowledgeSourceKey(chunk));
    return !!source && (chunk.metadata as Record<string, unknown> | null)?.sourceContentHash === source.contentHash;
  });
  if (current.length) {
    const {captureSqlKnowledgeInputProof} = await import("../../domain/src/sql-knowledge-read-proof");
    const sql = await captureSqlKnowledgeInputProof(params.actor, params.workspaceId, current);
    if (sql) { retainProof?.(sql); return current; }
    // One withheld child must not hide independent permitted candidates. If
    // the complete fast set cannot be proven, use the ordinary per-child gate.
  }
  const readable = await readableArtifactIds(params.actor, params.workspaceId, "KnowledgeChunk", current);
  const permitted = current.filter((chunk) => readable.has(chunk.id));
  if (retainProof) {
    const proof = await captureKnowledgeInputs(params, permitted, sources);
    if (!proof) throw Object.assign(new Error("Knowledge count inputs changed during admission."), {code: "SOURCE_CHANGED", status: 409});
    retainProof(proof);
  }
  return permitted;
}

/** A paginated aggregate, independent of search's candidate ceiling. Each page
 * uses the same canonical parent, child receipt and current proof gates as search.
 * Retain only original proof metadata for the shared final release fence; no
 * bodies, vectors or successful-authorization cache accumulate across pages. */
export async function countReadableNonSqlKnowledgeChunks(params: RetrievalAccess) {
  let cursor: string | undefined;
  let count = 0;
  const retainedRoots = new Map<string, LineageRoot>();
  const sourceTypes = (params.sourceTypes?.length ? params.sourceTypes : Object.keys(knowledgeLineageKinds) as KnowledgeSourceType[])
    .filter(type => type !== "EXTERNAL_DATABASE");
  if (!sourceTypes.length || !params.accessDomains.length) return {count: 0, roots: [] as LineageRoot[]};
  for (;;) {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { workspaceId: params.workspaceId, accessDomain: { in: params.accessDomains },
        sourceType: { in: sourceTypes }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" }, take: 100, select: chunkProjection,
    });
    if (!chunks.length) return {count, roots: [...retainedRoots.values()]};
    const sourceIds = new Map<KnowledgeSourceType, string[]>();
    for (const chunk of chunks) {
      const ids = sourceIds.get(chunk.sourceType) ?? [];
      if (!ids.includes(chunk.sourceId)) ids.push(chunk.sourceId);
      sourceIds.set(chunk.sourceType, ids);
    }
    const sources = await readableKnowledgeSources({ ...params, sourceTypes }, sourceIds);
    let roots: LineageRoot[] = [];
    const admitted = await admitKnowledgeChunks(params, chunks, sources, proof => { roots = proof; });
    if (roots.length && !await currentInputProof(params, roots)) {
      throw Object.assign(new Error("Knowledge inputs changed before count page release."), {code: "SOURCE_CHANGED", status: 409});
    }
    for (const root of roots) {
      const key = `${root.kind}:${root.id}`;
      retainedRoots.set(key, mergeLineageInputRoot(retainedRoots.get(key), root));
    }
    count += admitted.length;
    if (chunks.length < 100) return {count, roots: [...retainedRoots.values()]};
    cursor = chunks[chunks.length - 1].id;
  }
}

/** Shared count/search admission. Raw rows never set a candidate cap or visible count. */
export async function scanReadableKnowledgeChunks(params: RetrievalAccess, perTypeLimit?: number) {
  const retainedHeads = new Map<string, string>();
  const retainedRoots = new Map<string, LineageRoot>();
  const sourceTypeWindows = params.sourceTypes?.length ? [...new Set(params.sourceTypes)] : [undefined];
  const chunks: PermissionChunk[] = [];
  let scanned = 0;
  for (const sourceType of sourceTypeWindows) {
    let cursor: PermissionChunk | undefined;
    let admitted = 0;
    while (perTypeLimit === undefined || admitted < perTypeLimit) {
      // Search is bounded by readable candidates, not the number of denied
      // siblings before them. Complete count callers retain their own raw cap.
      const take = perTypeLimit === undefined
        ? Math.min(POSTGRES_SEARCH_WINDOW, KNOWLEDGE_SCAN_LIMIT - scanned + 1)
        : POSTGRES_SEARCH_WINDOW;
      const page: PermissionChunk[] = await prisma.knowledgeChunk.findMany({
        where: {
          workspaceId: params.workspaceId, accessDomain: { in: params.accessDomains }, sourceType,
          sensitivity: params.maxSensitivity ? { in: levelsUpTo(params.maxSensitivity) } : undefined,
          ...(cursor ? { AND: [{ OR: [
            { createdAt: { lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, chunkIndex: { gt: cursor.chunkIndex } },
            { createdAt: cursor.createdAt, chunkIndex: cursor.chunkIndex, id: { gt: cursor.id } },
          ] }] } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { chunkIndex: "asc" }, { id: "asc" }], take, select: chunkProjection,
      });
      scanned += page.length;
      if (perTypeLimit === undefined && scanned > KNOWLEDGE_SCAN_LIMIT) scanLimitExceeded();
      const sourceIds = new Map<KnowledgeSourceType, string[]>();
      for (const chunk of page) {
        const ids = sourceIds.get(chunk.sourceType) ?? [];
        if (!ids.includes(chunk.sourceId)) ids.push(chunk.sourceId);
        sourceIds.set(chunk.sourceType, ids);
      }
      // Parent hydration follows this bounded candidate page. Unindexed source
      // records cannot exhaust a search before any chunk is considered.
      const sources = await readableKnowledgeSources(params, sourceIds);
      const permitted = await admitKnowledgeChunks(params, page, sources);
      const selected = perTypeLimit === undefined ? permitted : permitted.slice(0, perTypeLimit - admitted);
      const observed = perTypeLimit === undefined ? {value: await captureKnowledgeInputs(params, selected, sources), heads: new Map<string, string>()}
        : await captureArtifactReadHeadObservation(() => captureKnowledgeInputs(params, selected, sources));
      const proof = observed.value;
      for (const [key, stamp] of observed.heads) {
        if (retainedHeads.has(key) && retainedHeads.get(key) !== stamp) {
          throw Object.assign(new Error("Knowledge lineage changed during admission."), {code: "SOURCE_CHANGED", status: 409});
        }
        retainedHeads.set(key, stamp);
      }
      if (!proof) throw Object.assign(new Error("Knowledge inputs changed during admission."), {code: "SOURCE_CHANGED", status: 409});
      for (const root of proof) {
        const key = `${root.kind}:${root.id}`;
        retainedRoots.set(key, mergeLineageInputRoot(retainedRoots.get(key), root));
      }
      chunks.push(...selected);
      admitted += selected.length;
      if (page.length < take) break;
      cursor = page[page.length - 1];
    }
  }
  chunks.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()
    || left.chunkIndex - right.chunkIndex || left.id.localeCompare(right.id));
  // Every admitted candidate contributes to ranking, including uncited candidates.
  const roots = [...retainedRoots.values()];
  if (perTypeLimit !== undefined) searchInputHeads.set(roots, retainedHeads);
  return { chunks, roots };
}

/** Complete bounded SQL count, independent of search's candidate window. Keep
 * vector/body working memory to one page and retain only exact child identities
 * and hashes across a complete admission pass. Current native/caller proof
 * fences the whole request; no partial count escapes on a changed collection. */
export async function countReadableSqlKnowledgeCollection(params: RetrievalAccess, otherRoots: LineageRoot[] = []) {
  const access = {...params, sourceTypes: ["EXTERNAL_DATABASE" as const]};
  const collection = await captureSqlCountCollection(access.workspaceId, access.accessDomains);
  const sources = await readableKnowledgeSources(access);
  if (!sources.size) {
    await withArtifactCountReleaseSnapshot(access.actor, access.workspaceId, otherRoots,
      async () => undefined, async tx => {
        if (!await isSqlCountLedgerCurrent(access.workspaceId, access.accessDomains, collection, [], [], [], tx)) {
          throw Object.assign(new Error("SQL count collection changed during empty admission."), {code: "SOURCE_CHANGED", status: 409});
        }
      });
    return 0;
  }
  const sourceRoots = await captureArtifactInputProof(access.actor, access.workspaceId,
    [...sources.values()].map(source => ({kind: source.kind, id: String(source.record.id), snapshot: source.record})));
  const ledger = new Map<string, string>();
  let count = 0;
  const epochs = new Map<string, SqlCountEpoch>();
  retainSqlCountEpochs(epochs, [...sourceRoots, ...otherRoots.filter(root =>
    root.kind !== "ArtifactInputSnapshot" || root.permissionEpochs !== undefined)]);
  const COUNT_LIMIT = 100_000;
  let cursor: Pick<PermissionChunk, "id" | "createdAt" | "chunkIndex"> | undefined;
  let scanned = 0;
  while (true) {
    const page = await prisma.knowledgeChunk.findMany({where: {
      workspaceId: access.workspaceId, sourceType: "EXTERNAL_DATABASE", accessDomain: {in: access.accessDomains},
      OR: [...sources.values()].map(source => ({AND: [
        {metadata: {path: ["nativeInputId"], equals: source.record.id}},
        {metadata: {path: ["sourceContentHash"], equals: source.contentHash}},
      ]})),
      ...(cursor ? {AND: [{OR: [
        {createdAt: {lt: cursor.createdAt}},
        {createdAt: cursor.createdAt, chunkIndex: {gt: cursor.chunkIndex}},
        {createdAt: cursor.createdAt, chunkIndex: cursor.chunkIndex, id: {gt: cursor.id}},
      ]}]} : {}),
    }, orderBy: [{createdAt: "desc"}, {chunkIndex: "asc"}, {id: "asc"}],
    take: Math.min(POSTGRES_SEARCH_WINDOW, COUNT_LIMIT - scanned + 1), select: {id: true, createdAt: true, chunkIndex: true}});
    scanned += page.length;
    if (scanned > COUNT_LIMIT) throw Object.assign(new Error("SQL count requires a bounded complete collection."),
      {code: "KNOWLEDGE_COUNT_LIMIT", status: 409});
    const stamps = new Map((await captureSqlCountStamps(access.workspaceId, page.map(row => row.id)))
      .map(row => [row.id, row.stamp]));
    for (const row of page) {
      const stamp = stamps.get(row.id);
      if (!stamp || ledger.has(row.id)) throw Object.assign(new Error("SQL count row changed during admission."), {code: "SOURCE_CHANGED", status: 409});
      ledger.set(row.id, stamp);
    }
    const proof = access.actor.kind === "user" ? await captureSqlCountPageProof(access.workspaceId, page.map(row => row.id), sourceRoots) : undefined;
    if (proof) {retainSqlCountEpochs(epochs, proof); count += proof.length;}
    else {
      const full = await prisma.knowledgeChunk.findMany({where: {workspaceId: access.workspaceId, id: {in: page.map(row => row.id)}}, select: chunkProjection});
      count += (await admitKnowledgeChunks(access, full, sources, roots => retainSqlCountEpochs(epochs, roots))).length;
    }
    if (page.length < POSTGRES_SEARCH_WINDOW) break;
    cursor = page.at(-1);
  }
  await withArtifactCountReleaseSnapshot(access.actor, access.workspaceId, otherRoots, async () => {
    if (!await currentInputProof(access, sourceRoots)) throw Object.assign(new Error("SQL count source permissions changed."),
      {code: "SOURCE_CHANGED", status: 409});
  }, async tx => {
    for (const source of sources.values()) if (!await isSqlNativeRunInputLocallyCurrent(access.actor, access.workspaceId,
      source.record as unknown as import("@prisma/client").SqlNativeRunInput, tx)) {
      throw Object.assign(new Error("SQL count current source authority changed."), {code: "SOURCE_CHANGED", status: 409});
    }
    if (!await isSqlCountLedgerCurrent(access.workspaceId, access.accessDomains, collection,
      [...ledger].map(([id, stamp]): SqlCountStamp => ({id, stamp})), [...epochs.values()],
      [...sources.values()].map(source => ({id: source.record.id, hash: source.contentHash})), tx)) {
      throw Object.assign(new Error("SQL count inputs changed before aggregate release."), {code: "SOURCE_CHANGED", status: 409});
    }
  });
  return count;
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
    select: chunkProjection,
  });
  const sourceIds = new Map<KnowledgeSourceType, string[]>();
  for (const chunk of chunks) sourceIds.set(chunk.sourceType, [...(sourceIds.get(chunk.sourceType) ?? []), chunk.sourceId]);
  const sources = await readableKnowledgeSources({ ...params, accessDomains }, sourceIds);
  const permitted = await admitKnowledgeChunks({ ...params, accessDomains }, chunks, sources);
  const receipts = new Map(permitted.map((chunk) => [chunk.id, chunk]));
  return citations.filter((citation) => {
    const chunk = receipts.get(citation.chunkId);
    if (!chunk || chunk.sourceType !== citation.sourceType || chunk.sourceId !== citation.sourceId
      || chunk.chunkIndex !== citation.chunkIndex || chunk.content.slice(0, 400) !== citation.snippet
      || chunk.sourceTitle !== citation.title) return false;
    const source = sources.get(knowledgeSourceKey(chunk));
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
  if (citations.length !== 1) return null;
  const sources = await readableKnowledgeSources({ actor, workspaceId, accessDomains }, new Map([[chunk.sourceType, [chunk.sourceId]]]));
  const roots = await captureKnowledgeInputs({ actor, workspaceId, accessDomains }, [chunk], sources);
  return roots && await currentInputProof({ actor, workspaceId, accessDomains }, roots) ? chunk : null;
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
    && restoreSearchInputHeads(cached.inputRoots, cached.inputHeads)
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
  await setCacheJson(cacheKey, { schema: 2, results: current.results, inputRoots: current.roots, inputHeads: serializedSearchInputHeads(current.roots) } satisfies ProvenSearchCache, SEARCH_CACHE_TTL_MS);
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

  const { chunks, roots } = await scanReadableKnowledgeChunks(params, POSTGRES_SEARCH_WINDOW);
  if (chunks.length === 0) return { results: [], roots: [] };
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

  // Rank only with the embedding from the exact admitted, captured chunk row.
  // A second projection could silently introduce a different vector revision.
  const authorizedLexicalCandidates = lexicalCandidates;
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
      const semantic = cosineSimilarity(queryEmbedding.embeddings[0] ?? [], asEmbedding(chunk.embedding));
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
    inputHeads: [string, string][];
  }>(cacheKey);
  if (cached?.schema === 2 && Array.isArray(cached.citations) && provenRoots(cached.inputRoots)
    && restoreSearchInputHeads(cached.inputRoots, cached.inputHeads)
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
  await setCacheJson(cacheKey, { ...answer, schema: 2, inputRoots, inputHeads: serializedSearchInputHeads(inputRoots) }, SEARCH_CACHE_TTL_MS);
  if ((await currentKnowledgeCitations({ ...params, accessDomains }, answer.citations)).length !== answer.citations.length
    || !await currentInputProof({ ...params, accessDomains }, inputRoots)) {
    return { answer: "I could not find relevant indexed knowledge for that question.", citations: [] as KnowledgeCitation[] };
  }
  return answer;
}
