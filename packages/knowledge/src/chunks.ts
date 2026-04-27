import type { KnowledgeSourceType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { invalidateKnowledgeCache } from "./retrieval";
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
  sourceId: string;
  sourceTitle?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
  workflowJobId?: string;
  agentRunId?: string;
}) {
  await prisma.knowledgeChunk.deleteMany({
    where: {
      workspaceId: params.workspaceId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
    },
  });
  await invalidateKnowledgeCache(params.workspaceId);

  const chunks = chunkText(params.content);
  if (chunks.length === 0) {
    return 0;
  }

  const embeddingResponse = await defaultModelGateway.embed({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    input: chunks,
  });

  await prisma.knowledgeChunk.createMany({
    data: chunks.map((content, index) => {
      const sensitivity = classifyChunkSensitivity(content);
      return {
        workspaceId: params.workspaceId,
        sourceType: params.sourceType,
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
    }),
  });

  await invalidateKnowledgeCache(params.workspaceId);
  return chunks.length;
}

export async function syncBrainArticleKnowledge(params: {
  workspaceId: string;
  articleId: string;
}) {
  const article = await prisma.brainArticle.findUnique({
    where: { id: params.articleId },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      slug: true,
      type: true,
      authority: true,
      bodyMd: true,
      isPrivate: true,
    },
  });

  if (!article || article.workspaceId !== params.workspaceId || article.isPrivate) {
    return 0;
  }

  return syncKnowledgeForSource({
    workspaceId: params.workspaceId,
    sourceType: "BRAIN_ARTICLE",
    sourceId: article.id,
    sourceTitle: article.title,
    content: article.bodyMd,
    metadata: {
      type: article.type,
      authority: article.authority,
      slug: article.slug,
    },
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
      select: { id: true, title: true, bodyMd: true, slug: true, type: true, authority: true },
    }),
    prisma.document.findMany({
      where: { workspaceId, textContent: { not: null }, archivedAt: null },
      select: { id: true, title: true, textContent: true, source: true, mimeType: true, storageKey: true },
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
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "BRAIN_ARTICLE",
        sourceId: article.id,
        sourceTitle: article.title,
        content: article.bodyMd,
        metadata: {
          type: article.type,
          authority: article.authority,
          slug: article.slug,
        },
      });
      reindexedArticles++;
    } catch (err) {
      errors.push(`Failed to reindex article ${article.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const doc of documentsToReindex) {
    if (!doc.textContent) continue;
    try {
      await syncKnowledgeForSource({
        workspaceId,
        sourceType: "DOCUMENT",
        sourceId: doc.id,
        sourceTitle: doc.title,
        content: [doc.title, doc.textContent].filter(Boolean).join("\n\n"),
        metadata: {
          source: doc.source,
          mimeType: doc.mimeType,
          storageKey: doc.storageKey,
        },
      });
      reindexedDocuments++;
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
