import type { KnowledgeAccessDomain, KnowledgeSourceType } from "@prisma/client";
import { resolveKnowledgeAccessDomains } from "@corgtex/domain";
import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { searchIndexedKnowledge } from "@corgtex/knowledge";

export const INTERACTIVE_KNOWLEDGE_SOURCE_TYPES = [
  "BRAIN_ARTICLE",
  "DOCUMENT",
  "MEETING",
] satisfies KnowledgeSourceType[];

export const searchBrainTool: ModelTool = {
  type: "function",
  function: {
    name: "search_brain",
    description: "Search accessible indexed Brain articles, documents, and meetings. Use this for semantic search and finding context about specific topics.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to embed and look up" },
        limit: { type: "number", description: "Max number of chunks to return (default: 5, max: 10)" },
      },
      required: ["query"],
    },
  },
};

export async function resolveInteractiveKnowledgeAccessDomains(
  actor: AppActor | undefined,
  workspaceId: string,
): Promise<KnowledgeAccessDomain[]> {
  if (!actor) {
    return ["WORKSPACE"];
  }
  return resolveKnowledgeAccessDomains(actor, workspaceId);
}

export async function searchBrain(actor: AppActor, workspaceId: string, query: string, limit: number = 5) {
  const safeLimit = Math.min(limit || 5, 10);
  const accessDomains = await resolveInteractiveKnowledgeAccessDomains(actor, workspaceId);
  const chunks = await searchIndexedKnowledge({
    workspaceId,
    query,
    limit: safeLimit,
    sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
    accessDomains,
  });

  return chunks.map(c => ({
    chunkId: c.chunkId,
    sourceId: c.sourceId,
    sourceType: c.sourceType,
    title: c.title || "Untitled",
    chunkIndex: c.chunkIndex,
    snippet: c.snippet.substring(0, 500) + (c.snippet.length > 500 ? "..." : ""),
    score: c.score,
  }));
}
