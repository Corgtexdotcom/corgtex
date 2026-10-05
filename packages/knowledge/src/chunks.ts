import { randomUUID } from "node:crypto";
import type { KnowledgeAccessDomain, KnowledgeSourceType } from "@prisma/client";
import { getSharedStateBackend, prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { invalidateKnowledgeCache } from "./retrieval";
import { getKnowledgeSearchProvider, isAzureKnowledgeSearchConfigured, logAzureKnowledgeIndexingWarning, syncAzureKnowledgeSource } from "./azure-search";
import { classifyChunkSensitivity } from "./sensitivity";

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
}) {
  const chunks = chunkText(params.content);
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

  const embeddingResponse = await defaultModelGateway.embed({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    input: chunks,
  });

  const chunkRows = chunks.map((content, index) => {
    const sensitivity = classifyChunkSensitivity(content);
    return {
      id: randomUUID(),
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
        chunkIndex: index,
        sourceType: params.sourceType,
        sensitivityPatterns: sensitivity.matchedPatterns,
      },
      tokenCount: content.length,
      embeddingModel: embeddingResponse.usage.model,
      sensitivity: sensitivity.label,
    };
  });

  const persisted = await prisma.$transaction(async (tx) => {
    if (params.sourceType === "BRAIN_ARTICLE") {
      await tx.$queryRaw`SELECT "id" FROM "BrainArticle" WHERE "id" = ${params.sourceId} AND "workspaceId" = ${params.workspaceId} FOR SHARE`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`brain_article_index:${params.workspaceId}:${params.sourceId}`}, 0))`;
      const article = await tx.brainArticle.findFirst({
        where: { id: params.sourceId, workspaceId: params.workspaceId, archivedAt: null, isPrivate: false, bodyMd: params.content,
          ...(params.sourceUpdatedAt ? { updatedAt: params.sourceUpdatedAt } : {}) },
        select: { id: true },
      });
      if (!article) return false;
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
    await tx.knowledgeChunk.createMany({ data: chunkRows });
    // PostgreSQL cache invalidation commits with its source rows. A failure must
    // roll both back instead of leaving cached results after a committed change.
    if (getSharedStateBackend() === "postgres") await invalidateKnowledgeCache(params.workspaceId, tx);
    return true;
  });
  if (!persisted) return 0;

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
  });

  await invalidateKnowledgeCache(params.workspaceId);
  return chunks.length;
}

async function syncAzureSourceBestEffort(params: Parameters<typeof syncAzureKnowledgeSource>[0]) {
  if (getKnowledgeSearchProvider() === "azure" && !isAzureKnowledgeSearchConfigured("admin")) {
    throw new Error("Azure Search indexing is enabled but not configured for writes.");
  }
  try {
    let desired = params;
    for (let attempt = 0; attempt < 3; attempt++) {
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
}) {
  const article = await prisma.brainArticle.findUnique({
    where: { id: params.articleId },
    select: { id: true, workspaceId: true, title: true, slug: true, type: true,
      authority: true, bodyMd: true, isPrivate: true, archivedAt: true, updatedAt: true },
  });
  if (!article || article.workspaceId !== params.workspaceId) return 0;
  return syncKnowledgeForSource({
    workspaceId: params.workspaceId, sourceType: "BRAIN_ARTICLE", accessDomain: "WORKSPACE",
    sourceId: article.id, sourceTitle: article.title,
    content: article.archivedAt || article.isPrivate ? "" : article.bodyMd,
    sourceUpdatedAt: article.updatedAt,
    metadata: { type: article.type, authority: article.authority, slug: article.slug },
  });
}

export async function syncDocumentKnowledge(params: { workspaceId: string; documentId: string; workflowJobId?: string }) {
  const document = await prisma.document.findUnique({ where: { id: params.documentId }, select: {
    id: true, workspaceId: true, title: true, source: true, mimeType: true, storageKey: true,
    textContent: true, accessDomain: true, archivedAt: true, updatedAt: true,
  } });
  if (!document || document.workspaceId !== params.workspaceId) return 0;
  return syncKnowledgeForSource({
    workspaceId: params.workspaceId, sourceType: "DOCUMENT", accessDomain: document.accessDomain,
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

export async function getWorkspaceIndexingHealth(workspaceId: string): Promise<WorkspaceIndexingHealth> {
  const [articles, sources, documents, chunks, errors] = await Promise.all([
    prisma.brainArticle.findMany({
      where: { workspaceId, isPrivate: false, archivedAt: null },
      select: { id: true, title: true, slug: true },
    }),
    prisma.brainSource.count({
      where: { workspaceId, archivedAt: null },
    }),
    prisma.document.count({
      where: { workspaceId, textContent: { not: null }, archivedAt: null },
    }),
    prisma.knowledgeChunk.count({
      where: { workspaceId },
    }),
    prisma.workflowJob.findMany({
      where: {
        workspaceId,
        type: { startsWith: "knowledge.sync." },
        status: "FAILED",
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { type: true, error: true, createdAt: true },
    }),
  ]);

  const articleIds = articles.map((a) => a.id);
  const articleChunks = await prisma.knowledgeChunk.findMany({
    where: { workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: { in: articleIds } },
    select: { sourceId: true },
    distinct: ["sourceId"],
  });

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
      totalSources: sources,
      totalDocuments: documents,
      totalChunks: chunks,
    },
    unchunkedArticles,
    recentErrors: errors.map((e) => `[${e.createdAt.toISOString()}] ${e.type}: ${e.error}`),
  };
}

export async function reindexWorkspace(workspaceId: string) {
  const [articles, documents] = await Promise.all([
    prisma.brainArticle.findMany({
      where: { workspaceId, isPrivate: false, archivedAt: null },
      select: { id: true },
    }),
    prisma.document.findMany({
      where: { workspaceId, textContent: { not: null }, archivedAt: null },
      select: { id: true },
    }),
  ]);

  const existingArticleChunks = await prisma.knowledgeChunk.findMany({
    where: { workspaceId, sourceType: "BRAIN_ARTICLE", sourceId: { in: articles.map((a) => a.id) } },
    select: { sourceId: true },
    distinct: ["sourceId"],
  });

  const existingDocumentChunks = await prisma.knowledgeChunk.findMany({
    where: { workspaceId, sourceType: "DOCUMENT", sourceId: { in: documents.map((d) => d.id) } },
    select: { sourceId: true },
    distinct: ["sourceId"],
  });

  const chunkedArticleIds = new Set(existingArticleChunks.map((c) => c.sourceId));
  const chunkedDocumentIds = new Set(existingDocumentChunks.map((c) => c.sourceId));

  const articlesToReindex = articles.filter((a) => !chunkedArticleIds.has(a.id));
  const documentsToReindex = documents.filter((d) => !chunkedDocumentIds.has(d.id));

  const errors: string[] = [];
  let reindexedArticles = 0;
  let reindexedDocuments = 0;

  for (const article of articlesToReindex) {
    try {
      // Re-read under the article index lock: this list may predate an archive.
      if (await syncBrainArticleKnowledge({ workspaceId, articleId: article.id })) reindexedArticles++;
    } catch (err) {
      errors.push(`Failed to reindex article ${article.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const doc of documentsToReindex) {
    try {
      if (await syncDocumentKnowledge({ workspaceId, documentId: doc.id })) reindexedDocuments++;
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
