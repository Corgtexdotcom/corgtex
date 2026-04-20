import type { ModelTool } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";

export const searchBrainTool: ModelTool = {
  type: "function",
  function: {
    name: "search_brain",
    description: "Search the Brain (vector database) for knowledge across documents, policies, meetings, and operational entities (tensions, actions, etc.). Use this for semantic search and finding context about specific topics.",
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

export async function searchBrain(workspaceId: string, query: string, limit: number = 5) {
  const safeLimit = Math.min(limit || 5, 10);
  const chunks = await searchIndexedKnowledge({
    workspaceId,
    query,
    limit: safeLimit,
  });

  return chunks.map(c => ({
    sourceType: c.sourceType,
    title: c.title || "Untitled",
    contentSnippet: c.snippet.substring(0, 500) + (c.snippet.length > 500 ? "..." : ""),
  }));
}
