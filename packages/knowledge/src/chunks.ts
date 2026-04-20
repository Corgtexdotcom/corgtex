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

  const chunks = chunkText(params.content);
  if (chunks.length === 0) {
    invalidateKnowledgeCache(params.workspaceId);
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

  invalidateKnowledgeCache(params.workspaceId);
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
