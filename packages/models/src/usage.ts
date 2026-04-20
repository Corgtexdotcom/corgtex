import { prisma } from "@corgtex/shared";
import type { ModelUsageInput } from "./contracts";

export async function recordModelUsage(input: ModelUsageInput) {
  await prisma.modelUsage.create({
    data: {
      workspaceId: input.workspaceId,
      workflowJobId: input.workflowJobId,
      agentRunId: input.agentRunId,
      provider: input.provider,
      model: input.model,
      taskType: input.taskType,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      latencyMs: input.latencyMs ?? 0,
      estimatedCostUsd: input.estimatedCostUsd ?? null,
    },
  });
}
