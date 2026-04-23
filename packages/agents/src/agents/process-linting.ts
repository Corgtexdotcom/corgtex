import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runProcessLintingAgent(params: {
  workspaceId: string;
  triggerRef: string;
  processId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "process-linting",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Check if the proposal author gathered sufficient advice before execution.",
    payload: { processId: params.processId },
    plan: ["load-process-records", "evaluate-compliance", "persist-linting"],
    buildContext: async (helpers) => {
      const process = await prisma.adviceProcess.findUnique({
        where: { id: params.processId },
        include: { records: true }
      });
      return { process };
    },
    execute: async (context, helpers, runId, model) => {
      if (!context.process) return { resultJson: { error: "Process not found" } };

      const linting = await helpers.tool("model.chat", { processId: params.processId }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          { role: "system", content: "Evaluate advice process compliance. Were adequate experts consulted? Output JSON with { complianceScore: number, warnings: string[] }." },
          { role: "user", content: JSON.stringify(context) },
        ],
      }));

      let parsed = { complianceScore: 100, warnings: [] };
      try { parsed = JSON.parse(linting.content); } catch (e) {}

      await helpers.step("persist-linting", {}, async () => {
        await prisma.adviceProcess.update({
          where: { id: params.processId },
          data: { processLintJson: parsed },
        });
      });

      return { resultJson: parsed };
    },
  });
}

