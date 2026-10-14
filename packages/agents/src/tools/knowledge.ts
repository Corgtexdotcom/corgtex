import type { KnowledgeAccessDomain, KnowledgeSourceType } from "@prisma/client";
import { authorizeConversationTool, filterConversationKnowledgeDomains } from "../conversation-capabilities";
import { captureConversationInputReceipt, type ConversationInputReceipt, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import type { ModelTool, ModelUsageInput } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { getKnowledgeSearchInputRoots, searchIndexedKnowledge } from "@corgtex/knowledge";

const brainSearchReceipts = new WeakMap<object, ConversationInputReceipt>();
export function getBrainSearchInputReceipt(value: unknown) {
  return value !== null && typeof value === "object" ? brainSearchReceipts.get(value) : undefined;
}

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
  operationScopes?: readonly string[],
): Promise<KnowledgeAccessDomain[]> {
  if (!actor) {
    throw new Error("Authenticated actor is required for knowledge access.");
  }
  await authorizeConversationTool(actor, workspaceId, "search_brain", undefined, operationScopes);
  const domains = await resolveKnowledgeAccessDomains(actor, workspaceId);
  return filterConversationKnowledgeDomains(actor, workspaceId, domains, operationScopes);
}

export async function searchBrain(
  actor: AppActor, workspaceId: string, query: string, limit: number = 5,
  usageContext: Pick<ModelUsageInput, "catalogItemId" | "agentCredentialId"> = {},
  operationScopes?: readonly string[],
) {
  const safeLimit = Math.min(limit || 5, 10);
  const accessDomains = await resolveInteractiveKnowledgeAccessDomains(actor, workspaceId, operationScopes);
  const chunks = await searchIndexedKnowledge({
    actor,
    workspaceId,
    catalogItemId: usageContext.catalogItemId,
    agentCredentialId: usageContext.agentCredentialId,
    query,
    limit: safeLimit,
    sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
    accessDomains,
  });

  const roots = await getKnowledgeSearchInputRoots(actor, workspaceId, chunks);
  const result = chunks.map(c => ({
    chunkId: c.chunkId,
    sourceId: c.sourceId,
    sourceType: c.sourceType,
    title: c.title || "Untitled",
    chunkIndex: c.chunkIndex,
    snippet: c.snippet.substring(0, 500) + (c.snippet.length > 500 ? "..." : ""),
    score: c.score,
  }));
  if (roots.length) brainSearchReceipts.set(result, await captureConversationInputReceipt({ actor, workspaceId, value: result, trustedRoots: roots }));
  return result;
}
