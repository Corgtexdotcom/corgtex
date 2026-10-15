import { currentArtifactInputRootsBatch } from "../../domain/src/source-lineage";
import { DigestReadRelease } from "../../domain/src/digest-lineage";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { KnowledgeAccessDomain, KnowledgeSourceType, Prisma } from "@prisma/client";
import { getSharedStateBackend, prisma, type AppActor } from "@corgtex/shared";
import { assertArtifactInputWriteFence, captureArtifactInputProof, captureImmutableArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, prepareArtifactCommitPreflight, readableArtifactIds, recordArtifactInputLineage, requireWorkspaceMembership, scanSourceReadableRecords, withArtifactCommitPreflight, type LineageKind, type LineageRoot } from "@corgtex/domain";
import { defaultModelGateway } from "@corgtex/models";
import { invalidateKnowledgeCache } from "./retrieval";
import { getKnowledgeSearchProvider, isAzureKnowledgeSearchConfigured, logAzureKnowledgeIndexingWarning, syncAzureKnowledgeSource } from "./azure-search";
import { classifyChunkSensitivity } from "./sensitivity";
import { countReadableKnowledgeChunks } from "./counts";

function normalizeText(input: string | null | undefined) {
  return (input ?? "").trim();
}

export function chunkText(input: string, maxLength = 1200, overlapSize = 150) {
  const normalized = normalizeText(input);
  if (!normalized) return [];

  const actualOverlap = Math.min(overlapSize, Math.floor(maxLength * 0.2)); // Cap overlap to 20% of max length
  const separators = ["\n\n", "\n", ". ", "? ", "! ", " "];

  function doSplit(text: string, seps: string[]): string[] {
    if (text.length <= maxLength) return [text];
    
    if (seps.length === 0) {
      const chunks: string[] = [];
      const step = Math.max(1, maxLength - actualOverlap);
      for (let i = 0; i < text.length; i += step) {
        chunks.push(text.slice(i, i + maxLength));
      }
      return chunks;
    }

    const sep = seps[0];
    const splits = text.split(sep);
    if (splits.length === 1) return doSplit(text, seps.slice(1));

    const chunks: string[] = [];
    let currentChunk = "";

    for (let i = 0; i < splits.length; i++) {
      const part = splits[i] + (i < splits.length - 1 ? sep : "");
      
      if (!currentChunk) {
        currentChunk = part;
      } else if (currentChunk.length + part.length <= maxLength) {
        currentChunk += part;
      } else {
        chunks.push(currentChunk.trim());
        let overlap = currentChunk.slice(-actualOverlap);
        const spaceIdx = overlap.indexOf(" ");
        if (spaceIdx >= 0 && spaceIdx < overlap.length - 1) {
          overlap = overlap.slice(spaceIdx + 1);
        }
        currentChunk = overlap + part;
      }
    }
    
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    const finalChunks: string[] = [];
    for (const chunk of chunks) {
      if (chunk.length > maxLength) {
        finalChunks.push(...doSplit(chunk, seps.slice(1)));
      } else if (chunk.trim()) {
        finalChunks.push(chunk.trim());
      }
    }
    
    return finalChunks;
  }

  return doSplit(normalized, separators);
}

type SourceSnapshot = { kind: LineageKind; contentHash: string; content: string; rawContent: string | null; title: string | null; record: Record<string, unknown> };

async function knowledgeSourceSnapshot(params: { workspaceId: string; sourceType: KnowledgeSourceType; sourceId: string },
  db: typeof prisma | Prisma.TransactionClient = prisma): Promise<SourceSnapshot | null> {
  const where = { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null };
  const row = params.sourceType === "BRAIN_ARTICLE" ? await db.brainArticle.findFirst({ where: { ...where, OR: [{ isPrivate: false }, { variantOfArticleId: { not: null }, isPrivate: true }] } })
    : params.sourceType === "DOCUMENT" ? await db.document.findFirst({ where })
      : params.sourceType === "MEETING" ? await db.meeting.findFirst({ where })
        : params.sourceType === "PROPOSAL" ? await db.proposal.findFirst({ where })
          : params.sourceType === "EXTERNAL_CONTENT" ? await db.externalContentSource.findFirst({ where }) : null;
  if (!row) return null;
  const kind: LineageKind = params.sourceType === "BRAIN_ARTICLE" ? "BrainArticle"
    : params.sourceType === "DOCUMENT" ? "Document" : params.sourceType === "MEETING" ? "Meeting"
      : params.sourceType === "EXTERNAL_CONTENT" ? "ExternalContentSource" : "Proposal";
  const source = row as unknown as Record<string, unknown>;
  const fields = kind === "BrainArticle" ? [source.bodyMd]
    : kind === "Document" ? [source.title, source.textContent]
      : kind === "ExternalContentSource" ? [(source.metadata as Record<string, unknown> | null)?.materializedContent]
      : kind === "Meeting" ? [source.title, source.summaryMd, source.transcript]
        : [source.title, source.summary, source.bodyMd];
  return {
    kind, record: source,
    contentHash: lineageContentFingerprint(kind, row),
    content: fields.filter(Boolean).join("\n\n"),
    rawContent: kind === "Document" && typeof source.textContent === "string" ? source.textContent : null,
    title: typeof source.title === "string" ? source.title : null,
  };
}

export async function syncKnowledgeForSource(params: {
  workspaceId: string;
  sourceType: KnowledgeSourceType;
  accessDomain: KnowledgeAccessDomain;
  sourceId: string;
  sourceTitle?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  workflowJobId?: string;
  agentRunId?: string;
  sourceUpdatedAt?: Date;
  lineageActor?: AppActor;
}) {
  // Only these canonical renderers have complete, current source proof.
  if (!["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT"].includes(params.sourceType)) return 0;
  params = { ...params, metadata: params.metadata ? structuredClone(params.metadata) : undefined,
    sourceUpdatedAt: params.sourceUpdatedAt ? new Date(params.sourceUpdatedAt) : undefined };
  const chunks = chunkText(params.content);
  // Provider cleanup needs an independently authorized archive path; arbitrary empty payloads cannot delete copies.
  if (params.sourceType === "EXTERNAL_CONTENT" && !chunks.length) return 0;
  if (chunks.length === 0) {
    const retired = await prisma.$transaction(async (tx) => {
      if (params.sourceType === "BRAIN_ARTICLE") {
        await tx.$queryRaw`SELECT "id" FROM "BrainArticle" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${params.sourceId}`}, 0))`;
        const current = await tx.brainArticle.findFirst({
          where: { id: params.sourceId, workspaceId: params.workspaceId,
            ...(params.sourceUpdatedAt ? { updatedAt: params.sourceUpdatedAt } : { archivedAt: null, isPrivate: false }) },
          select: { id: true },
        });
        if (params.sourceUpdatedAt ? !current : current) return false;
      }
      const storageKey = params.sourceType === "DOCUMENT" ? params.metadata?.storageKey : null;
      if (typeof storageKey === "string") {
        await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document_index:${params.workspaceId}:${params.sourceId}`}, 0))`;
        const document = await tx.document.findFirst({
          where: { id: params.sourceId, workspaceId: params.workspaceId, storageKey,
            ...(params.sourceUpdatedAt ? { updatedAt: params.sourceUpdatedAt } : { archivedAt: null }) },
          select: { id: true },
        });
        if (!document) return false;
      }
      await tx.knowledgeChunk.deleteMany({
        where: {
          workspaceId: params.workspaceId,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
        },
      });
      if (getSharedStateBackend() === "postgres") await invalidateKnowledgeCache(params.workspaceId, tx);
      return true;
    });
    if (!retired) return 0;
    await syncAzureSourceBestEffort({
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      chunks: [],
    });
    await invalidateKnowledgeCache(params.workspaceId);
    return 0;
  }

  const snapshot = await knowledgeSourceSnapshot(params);
  if (["BRAIN_ARTICLE", "DOCUMENT", "MEETING", "PROPOSAL", "EXTERNAL_CONTENT"].includes(params.sourceType)
    && (!snapshot || (snapshot.content !== params.content && snapshot.rawContent !== params.content)
      || snapshot.title !== (params.sourceTitle?.trim() || null))) return 0;

  if (!snapshot || (params.sourceType === "DOCUMENT" ? snapshot.record.accessDomain !== params.accessDomain : params.accessDomain !== "WORKSPACE")) return 0;
  if (params.sourceUpdatedAt && (!(snapshot.record.updatedAt instanceof Date)
    || snapshot.record.updatedAt.getTime() !== params.sourceUpdatedAt.getTime())) return 0;
  const sourceActor: AppActor = params.lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "knowledge-source-sync", workspaceIds: [params.workspaceId] };
  let sourceProof: LineageRoot[];
  let sourceRoots: LineageRoot[];
  try {
    sourceProof = await captureArtifactInputProof(sourceActor, params.workspaceId,
      [{ kind: snapshot.kind, id: params.sourceId, snapshot: snapshot.record }]);
    // Freeze the generation-time permission vector as well as every source body.
    // A revoke/restore episode cannot certify an already running embedding job.
    const freezePreflight = await prepareArtifactCommitPreflight(sourceActor, params.workspaceId, sourceProof);
    sourceRoots = await prisma.$transaction(async tx => {
      await assertArtifactInputWriteFence(tx);
      return withArtifactCommitPreflight(sourceActor, params.workspaceId, tx, sourceProof, freezePreflight,
        () => captureImmutableArtifactInputProof(sourceActor, params.workspaceId, sourceProof, tx));
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code))) return 0;
    throw error;
  }
  if (!await isArtifactInputProofReadable(sourceActor, params.workspaceId, sourceRoots)) return 0;
  const storedMetadata = snapshot.record.metadata && typeof snapshot.record.metadata === "object" && !Array.isArray(snapshot.record.metadata)
    ? structuredClone(snapshot.record.metadata as Record<string, unknown>) : {};
  const nativeAnnotations = snapshot.kind === "BrainArticle" ? { type: snapshot.record.type, authority: snapshot.record.authority, slug: snapshot.record.slug }
    : snapshot.kind === "Document" ? { source: snapshot.record.source, mimeType: snapshot.record.mimeType, storageKey: snapshot.record.storageKey }
      : snapshot.kind === "Meeting" ? { source: snapshot.record.source,
        recordedAt: snapshot.record.recordedAt instanceof Date ? snapshot.record.recordedAt.toISOString() : null,
        hasIngestionGuidance: Boolean(snapshot.record.ingestionGuidanceMd) }
        : snapshot.kind === "Proposal" ? { status: snapshot.record.status } : {};
  const sourceMetadata: Record<string, unknown> = { ...storedMetadata, ...Object.fromEntries(Object.entries(nativeAnnotations).filter(([, value]) => value !== undefined)),
    ...(params.workflowJobId ? { workflowJobId: params.workflowJobId } : {}) };
  // External annotations are deliberately replaced by the proven provider parent.
  // Other writers reject unproved caller annotations rather than certify them.
  if (snapshot.kind !== "ExternalContentSource" && Object.entries(params.metadata ?? {}).filter(([, value]) => value !== undefined).some(([key, value]) =>
    !Object.hasOwn(sourceMetadata, key) || JSON.stringify(value) !== JSON.stringify(sourceMetadata[key]))) return 0;
  params = { ...params, metadata: snapshot.kind === "ExternalContentSource" ? storedMetadata : sourceMetadata };

  const embeddingResponse = await defaultModelGateway.embed({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    input: chunks,
  });

  const createdAt = new Date();
  const chunkRows = chunks.map((content, index) => {
    const sensitivity = classifyChunkSensitivity(content);
    return {
      id: randomUUID(),
      createdAt,
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      accessDomain: params.accessDomain,
      sourceId: params.sourceId,
      sourceTitle: params.sourceTitle?.trim() || null,
      chunkIndex: index,
      content,
      embedding: embeddingResponse.embeddings[index] ?? null,
      metadata: {
        ...(params.metadata ?? {}),
        sourceContentHash: snapshot?.contentHash ?? null,
        chunkIndex: index,
        sourceType: params.sourceType,
        sensitivityPatterns: sensitivity.matchedPatterns,
      },
      tokenCount: content.length,
      embeddingModel: embeddingResponse.usage.model,
      sensitivity: sensitivity.label,
    };
  });

  // The worker lease remains a live commit authority, while the output keeps
  // the frozen job receipt so completion does not invalidate indexed content.
  const commitRoots = [...sourceRoots, ...sourceProof.filter(root => root.kind === "WorkflowJobInput")];
  let commitPreflight: Awaited<ReturnType<typeof prepareArtifactCommitPreflight>>;
  try {
    commitPreflight = await prepareArtifactCommitPreflight(sourceActor, params.workspaceId, commitRoots);
  } catch (error) {
    // Regular source reindexing skips stale work. The external sync owner must
    // receive the error so it can mark its provider copy as stale.
    if (snapshot.kind !== "ExternalContentSource" && error && typeof error === "object" && "code" in error
      && ["UNKNOWN_LINEAGE", "SOURCE_CHANGED", "SOURCE_RESTRICTED"].includes(String(error.code))) return 0;
    throw error;
  }
  const persisted = await prisma.$transaction(async tx => {
    await assertArtifactInputWriteFence(tx);
    // Privacy/archive writes take the source row before their epoch trigger.
    // Match that order before the local proof takes shared epoch locks.
    if (snapshot.kind === "Meeting") await tx.$queryRaw`SELECT "id" FROM "Meeting" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    if (snapshot.kind === "Proposal") await tx.$queryRaw`SELECT "id" FROM "Proposal" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    if (snapshot.kind === "BrainArticle") await tx.$queryRaw`SELECT "id" FROM "BrainArticle" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    if (snapshot.kind === "Document") await tx.$queryRaw`SELECT "id" FROM "Document" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    return withArtifactCommitPreflight(sourceActor, params.workspaceId, tx, commitRoots, commitPreflight, async () => {
    // Compare the exact revision captured before embedding inside the complete
    // source scope. Restoration is a new permission revision.
    if (params.sourceType === "BRAIN_ARTICLE") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${params.sourceId}`}, 0))`;
      const article = await tx.brainArticle.findFirst({
        where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null, OR: [{ isPrivate: false }, { variantOfArticleId: { not: null }, isPrivate: true }], bodyMd: params.content,
          ...(params.sourceUpdatedAt ? { updatedAt: params.sourceUpdatedAt } : {}) },
        select: { id: true },
      });
      if (!article) return false;
    }
    const storageKey = params.sourceType === "DOCUMENT" ? params.metadata?.storageKey : null;
    if (typeof storageKey === "string") {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document_index:${params.workspaceId}:${params.sourceId}`}, 0))`;
      const document = await tx.document.findFirst({
        where: { id: params.sourceId, workspaceId: params.workspaceId, storageKey,
            ...(params.sourceUpdatedAt ? { updatedAt: params.sourceUpdatedAt } : { archivedAt: null }) },
        select: { id: true },
      });
      if (!document) return false;
    }
    if (snapshot?.kind === "ExternalContentSource") {
      await tx.$queryRaw`SELECT "id" FROM "ExternalContentSource" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
    }
    if (snapshot) {
      const current = await knowledgeSourceSnapshot(params, tx);
      if (!current || current.contentHash !== snapshot.contentHash) return false;
    }
    await assertArtifactInputWriteFence(tx);
    if (!await isArtifactInputProofReadable(sourceActor, params.workspaceId, sourceRoots, tx)) return false;
    await tx.knowledgeChunk.deleteMany({
      where: {
        workspaceId: params.workspaceId,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
      },
    });
    await tx.knowledgeChunk.createMany({ data: chunkRows });
    // JSONB normalizes object key order. Attest the persisted full rows rather
    // than the pre-insert projection, while rejecting any changed output bytes.
    const insertedRows = await tx.knowledgeChunk.findMany({ where: {
      workspaceId: params.workspaceId, id: { in: chunkRows.map(row => row.id) },
    } });
    const intendedRows = new Map<string, typeof chunkRows[number]>(chunkRows.map(row => [row.id, row]));
    if (insertedRows.length !== chunkRows.length || insertedRows.some(row =>
      !isDeepStrictEqual(row, intendedRows.get(row.id)))) {
      throw Object.assign(new Error("Persisted knowledge output differs from the generated chunks."), { code: "SOURCE_CHANGED" });
    }
    for (const row of insertedRows) {
      await recordArtifactInputLineage({ tx, actor: sourceActor, workspaceId: params.workspaceId,
        artifact: { kind: "KnowledgeChunk", id: row.id }, content: row, origin: "DERIVED", inputs: [], inheritedRoots: sourceRoots });
    }
    await assertArtifactInputWriteFence(tx);
    if (!await isArtifactInputProofReadable(sourceActor, params.workspaceId, sourceRoots, tx)) {
      throw Object.assign(new Error("Knowledge inputs changed before receipt commit."), { code: "SOURCE_CHANGED" });
    }
    // PostgreSQL cache invalidation commits with its source rows. A failure must
    // roll both back instead of leaving cached results after a committed change.
    if (getSharedStateBackend() === "postgres") await invalidateKnowledgeCache(params.workspaceId, tx);
    return captureArtifactInputProof(sourceActor, params.workspaceId, insertedRows.map(row => ({ kind: "KnowledgeChunk" as const, id: row.id, snapshot: row })), tx);
    });
  });
  if (!persisted) return 0;

  if (!await isArtifactInputProofReadable(sourceActor, params.workspaceId, persisted)) return 0;
  await syncAzureSourceBestEffort({
    workspaceId: params.workspaceId,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    chunks: chunkRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      sourceType: row.sourceType,
      accessDomain: row.accessDomain,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      chunkIndex: row.chunkIndex,
      content: row.content,
      embedding: row.embedding ?? [],
      metadata: row.metadata,
      sensitivity: row.sensitivity,
    })),
  }, { actor: sourceActor, roots: persisted });

  await invalidateKnowledgeCache(params.workspaceId);
  if (!await isArtifactInputProofReadable(sourceActor, params.workspaceId, persisted)) return 0;
  return chunks.length;
}

async function syncAzureSourceBestEffort(params: Parameters<typeof syncAzureKnowledgeSource>[0], sourceProof?: { actor: AppActor; roots: LineageRoot[] }) {
  if (getKnowledgeSearchProvider() === "azure" && !isAzureKnowledgeSearchConfigured("admin")) {
    throw new Error("Azure Search indexing is enabled but not configured for writes.");
  }
  try {
    let desired = params;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (desired.chunks.length && (!sourceProof
        || !await isArtifactInputProofReadable(sourceProof.actor, params.workspaceId, sourceProof.roots))) {
        throw new Error("Document inputs changed before Azure indexing; retry from a current source receipt.");
      }
      const result = await syncAzureKnowledgeSource(desired);
      if (result.skipped) return;

      // Another worker may commit a newer SQL revision while this Azure call
      // is in flight. Repair from SQL before declaring the older job complete.
      const current = await prisma.knowledgeChunk.findMany({
        where: { workspaceId: params.workspaceId, sourceType: params.sourceType, sourceId: params.sourceId },
        orderBy: { chunkIndex: "asc" },
      });
      const currentIds = current.map((chunk) => chunk.id).sort();
      const attemptedIds = desired.chunks.map((chunk) => chunk.id).sort();
      if (currentIds.length === attemptedIds.length && currentIds.every((id, index) => id === attemptedIds[index])) return;
      if (params.sourceType === "DOCUMENT" || params.sourceType === "EXTERNAL_CONTENT") {
        if (!sourceProof || !await isArtifactInputProofReadable(sourceProof.actor, params.workspaceId, sourceProof.roots)) {
          throw new Error("Document inputs changed during Azure indexing; its newer SQL rows require a fresh receipt.");
        }
        const ids = await readableArtifactIds(sourceProof.actor, params.workspaceId, "KnowledgeChunk", current);
        if (ids.size !== current.length) throw new Error("Document chunk inputs cannot be proved for Azure replay.");
        sourceProof = { actor: sourceProof.actor, roots: await captureArtifactInputProof(sourceProof.actor, params.workspaceId,
          current.map(chunk => ({ kind: "KnowledgeChunk" as const, id: chunk.id, snapshot: chunk }))) };
      }
      desired = {
        ...params,
        chunks: current.map((chunk) => ({
          id: chunk.id,
          workspaceId: chunk.workspaceId,
          sourceType: chunk.sourceType,
          accessDomain: chunk.accessDomain,
          sourceId: chunk.sourceId,
          sourceTitle: chunk.sourceTitle,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          embedding: Array.isArray(chunk.embedding) ? chunk.embedding.filter((value): value is number => typeof value === "number") : [],
          metadata: chunk.metadata,
          sensitivity: chunk.sensitivity,
          createdAt: chunk.createdAt,
        })),
      };
    }
    throw new Error("Knowledge source changed during Azure indexing; retry to reconcile the latest SQL revision.");
  } catch (error) {
    if (getKnowledgeSearchProvider() === "azure") {
      throw error;
    }
    logAzureKnowledgeIndexingWarning(error, {
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
    });
  }
}

export async function syncBrainArticleKnowledge(params: {
  workspaceId: string;
  articleId: string;
  lineageActor?: AppActor;
}) {
  const article = await prisma.brainArticle.findUnique({
    where: { id: params.articleId },
  });
  if (!article || article.workspaceId !== params.workspaceId) return 0;
  return syncKnowledgeForSource({
    workspaceId: params.workspaceId, sourceType: "BRAIN_ARTICLE", accessDomain: "WORKSPACE",
    sourceId: article.id, sourceTitle: article.title, lineageActor: params.lineageActor,
    content: article.archivedAt || (article.isPrivate && !article.variantOfArticleId) ? "" : article.bodyMd,
    sourceUpdatedAt: article.updatedAt,
    metadata: { type: article.type, authority: article.authority, slug: article.slug },
  });
}

export async function syncDocumentKnowledge(params: { workspaceId: string; documentId: string; workflowJobId?: string; lineageActor?: AppActor }) {
  const document = await prisma.document.findUnique({ where: { id: params.documentId } });
  if (!document || document.workspaceId !== params.workspaceId) return 0;
  return syncKnowledgeForSource({
    workspaceId: params.workspaceId, sourceType: "DOCUMENT", accessDomain: document.accessDomain,
    lineageActor: params.lineageActor,
    sourceId: document.id, sourceTitle: document.title,
    content: document.archivedAt ? "" : [document.title, document.textContent].filter(Boolean).join("\n\n"),
    sourceUpdatedAt: document.updatedAt,
    metadata: { source: document.source, mimeType: document.mimeType, storageKey: document.storageKey,
      ...(params.workflowJobId ? { workflowJobId: params.workflowJobId } : {}) },
    workflowJobId: params.workflowJobId,
  });
}

export type WorkspaceIndexingHealth = {
  status: "healthy" | "degraded" | "unhealthy";
  metrics: {
    totalArticles: number;
    totalSources: number;
    totalDocuments: number;
    totalChunks: number;
  };
  unchunkedArticles: Array<{ id: string; title: string; slug: string }>;
  recentErrors: string[];
};

export async function getWorkspaceIndexingHealth(workspaceId: string, lineageActor?: AppActor): Promise<WorkspaceIndexingHealth> {
  const actor: AppActor = lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "document-index-health", workspaceIds: [workspaceId] };
  await requireWorkspaceMembership({ actor, workspaceId });
  const [articles, sources, documents, chunks, errors] = await Promise.all([
    scanSourceReadableRecords({ actor, workspaceId, kind: "BrainArticle", load: (afterId, take) => prisma.brainArticle.findMany({
      where: { workspaceId, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) }),
    scanSourceReadableRecords({ actor, workspaceId, kind: "BrainSource", load: (afterId, take) => prisma.brainSource.findMany({
      where: { workspaceId, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) }),
    scanSourceReadableRecords({ actor, workspaceId, kind: "Document", load: (afterId, take) => prisma.document.findMany({
      where: { workspaceId, textContent: { not: null }, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) }),
    countReadableKnowledgeChunks(actor, workspaceId),
    scanSourceReadableRecords({ actor, workspaceId, kind: "WorkflowJobInput", load: (afterId, take) => prisma.workflowJob.findMany({
      where: { workspaceId, type: { startsWith: "knowledge.sync." }, status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" }, take,
      // Provider errors have no content receipt. Never release their raw text.
      select: { id: true, workspaceId: true, eventId: true, type: true, payload: true, createdAt: true },
    }) }),
  ]);

  const articleIds = articles.map((a) => a.id);
  const articleChunks = await scanSourceReadableRecords({ actor, workspaceId, kind: "KnowledgeChunk",
    load: (afterId, take) => prisma.knowledgeChunk.findMany({
      where: { workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: { in: articleIds }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" }, take,
    }) });
  const proofs = await captureArtifactInputProof(actor, workspaceId, [
    ...articles.map((row) => ({ kind: "BrainArticle" as const, id: row.id, snapshot: row })),
    ...sources.map((row) => ({ kind: "BrainSource" as const, id: row.id, snapshot: row })),
    ...documents.map((row) => ({ kind: "Document" as const, id: row.id, snapshot: row })),
    ...articleChunks.map((row) => ({ kind: "KnowledgeChunk" as const, id: row.id, snapshot: row })),
    ...errors.map((row) => ({ kind: "WorkflowJobInput" as const, id: row.id, snapshot: row })),
  ]);
  if (!await isArtifactInputProofReadable(actor, workspaceId, proofs)) {
    throw Object.assign(new Error("Indexing health inputs changed before release."), { code: "SOURCE_CHANGED", status: 409 });
  }

  const chunkedArticleIds = new Set(articleChunks.map((c) => c.sourceId));
  const unchunkedArticles = articles.filter((a) => !chunkedArticleIds.has(a.id));

  let status: WorkspaceIndexingHealth["status"] = "healthy";
  if (articles.length > 0 && unchunkedArticles.length === articles.length) {
    status = "unhealthy";
  } else if (unchunkedArticles.length > 0) {
    status = "degraded";
  }

  return {
    status,
    metrics: {
      totalArticles: articles.length,
      totalSources: sources.length,
      totalDocuments: documents.length,
      totalChunks: chunks,
    },
    unchunkedArticles: unchunkedArticles.map(({ id, title, slug }) => ({ id, title, slug })),
    recentErrors: errors.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, 10).map((e) => `[${e.createdAt.toISOString()}] ${e.type}: Indexing failed.`),
  };
}

export async function reindexWorkspace(workspaceId: string, lineageActor?: AppActor) {
  const actor: AppActor = lineageActor ?? { kind: "agent", authProvider: "bootstrap", label: "document-reindex", workspaceIds: [workspaceId] };
  await requireWorkspaceMembership({ actor, workspaceId });
  const release = new DigestReadRelease(actor, workspaceId);
  const [articles, documents] = await Promise.all([
    scanSourceReadableRecords({ actor, workspaceId, release, kind: "BrainArticle", load: (afterId, take) => prisma.brainArticle.findMany({
      where: { workspaceId, isPrivate: false, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) }),
    scanSourceReadableRecords({ actor, workspaceId, release, kind: "Document", load: (afterId, take) => prisma.document.findMany({
      where: { workspaceId, textContent: { not: null }, archivedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take,
    }) }),
  ]);

  // Only compact admitted identities survive each canonical chunk page. The
  // original source and chunk observations share one final release snapshot.
  const chunkedIds = async (sourceType: "BRAIN_ARTICLE" | "DOCUMENT", hashes: Map<string, string>) => {
    const found = new Set<string>();
    if (!hashes.size) return found;
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.knowledgeChunk.findMany({
        where: {workspaceId, sourceType, sourceId: {in: [...hashes.keys()]}, ...(cursor ? {id: {gt: cursor}} : {})},
        orderBy: {id: "asc"}, take: 100,
      });
      const matching = page.filter(chunk => (chunk.metadata as Record<string, unknown> | null)?.sourceContentHash === hashes.get(chunk.sourceId));
      // These ordinary chunk kinds require a current manifest. This is only
      // negative discovery; a matching head never replaces full authorization.
      const heads = await currentArtifactInputRootsBatch(prisma, workspaceId, "KnowledgeChunk", matching);
      const admitted = await release.capture("KnowledgeChunk", matching.filter(chunk => heads.get(chunk.id) != null));
      for (const chunk of admitted.records) found.add(chunk.sourceId);
      if (page.length < 100) return found;
      cursor = page[page.length - 1].id;
    }
  };
  const chunkedArticleIds = await chunkedIds("BRAIN_ARTICLE", new Map(articles.map(article => [article.id, lineageContentFingerprint("BrainArticle", article)])));
  const chunkedDocumentIds = await chunkedIds("DOCUMENT", new Map(documents.map(document => [document.id, lineageContentFingerprint("Document", document)])));
  await release.finish(undefined);

  const articlesToReindex = articles.filter((a) => !chunkedArticleIds.has(a.id));
  const documentsToReindex = documents.filter((d) => !chunkedDocumentIds.has(d.id));

  const errors: string[] = [];
  let reindexedArticles = 0;
  let reindexedDocuments = 0;

  for (const article of articlesToReindex) {
    try {
      // Re-read under the article index lock: this list may predate an archive.
      if (await syncBrainArticleKnowledge({ workspaceId, articleId: article.id, lineageActor: actor })) reindexedArticles++;
    } catch (err) {
      errors.push(`Failed to reindex article ${article.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const doc of documentsToReindex) {
    try {
      if (await syncDocumentKnowledge({ workspaceId, documentId: doc.id, lineageActor: actor })) reindexedDocuments++;
    } catch (err) {
      errors.push(`Failed to reindex document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (reindexedArticles > 0 || reindexedDocuments > 0) {
    await invalidateKnowledgeCache(workspaceId);
  }

  return {
    reindexedArticles,
    reindexedDocuments,
    errors,
  };
}
