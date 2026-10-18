import { generateBrainArticleVariant } from "@corgtex/domain";
import { defaultModelGateway, resolveModel } from "@corgtex/models";

export async function runBrainArticleVariantJob(params: {
  workspaceId: string; jobId: string; expectedAttempt: number; expectedOwner: string;
}) {
  return generateBrainArticleVariant({ ...params,
    generate: async (sources, controls) => {
      const response = await defaultModelGateway.extract({
        ...controls,
        model: resolveModel("fast"), workspaceId: params.workspaceId, workflowJobId: params.jobId,
        instruction: `Write a factual Brain wiki article using only the supplied permitted sources.
Choose a title supported by those sources. Use a neutral wiki style and include only supported claims.
Do not refer to an older article, infer hidden facts, or invent citations. Return a title and Markdown body.`,
        schemaHint: "{ title: string, bodyMd: string }",
        input: JSON.stringify({ sources: sources.map((source) => ({ kind: source.kind, id: source.id, title: source.title,
          ...(source.kind === "BrainSource" ? { sourceType: source.sourceType, tier: source.tier } : {}),
          content: source.content.slice(0, 12_000), ingestionGuidanceMd: source.ingestionGuidanceMd?.slice(0, 4_000) ?? null,
        })) }),
      });
      const output = response.output as { title?: unknown; bodyMd?: unknown } | null;
      return { title: typeof output?.title === "string" ? output.title : "",
        bodyMd: typeof output?.bodyMd === "string" ? output.bodyMd : "" };
    },
  });
}
