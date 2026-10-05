import { generateBrainSourceRemovalCandidate } from "@corgtex/domain";
import { defaultModelGateway, resolveModel } from "@corgtex/models";

export async function runBrainSourceRegenerationJob(params: { workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string }) {
  return generateBrainSourceRemovalCandidate({
    ...params,
    generate: async (article, sources) => {
      const response = await defaultModelGateway.chat({
        model: resolveModel("fast"),
        workspaceId: params.workspaceId,
        workflowJobId: params.jobId,
        taskType: "AGENT",
        messages: [
          { role: "system", content: `Regenerate a factual Brain wiki article using only the provided remaining sources.
Do not reuse unsupported claims from an older article or invent sources. Keep a neutral wiki style.
Return only the proposed Markdown article body. A human will review it before publication.` },
          { role: "user", content: JSON.stringify({
            articleTitle: article.title,
            sources: sources.map((source) => ({ id: source.id, title: source.title, content: source.content.slice(0, 12_000) })),
          }) },
        ],
      });
      return response.content;
    },
  });
}
