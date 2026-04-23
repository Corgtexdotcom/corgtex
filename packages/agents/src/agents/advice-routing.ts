import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runAdviceRoutingAgent(params: {
  workspaceId: string;
  triggerRef: string;
  proposalId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "advice-routing",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Analyze proposal and recommend relevant advisors based on expertise and historical context.",
    payload: { proposalId: params.proposalId },
    plan: ["load-proposal", "search-knowledge", "query-expertise", "generate-recommendations"],
    buildContext: async (helpers) => {
      const proposal = await prisma.proposal.findUnique({
        where: { id: params.proposalId },
        select: { id: true, title: true, summary: true, bodyMd: true }
      });
      return { proposal };
    },
    execute: async (context, helpers, runId, model) => {
      if (!context.proposal) return { resultJson: { error: "Proposal not found" } };

      const suggestions = await helpers.tool("model.chat", { proposalId: params.proposalId }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          { role: "system", content: "Recommend advisors based on this proposal content. Output JSON with { advisors: [{ memberId, name, reason }] }." },
          { role: "user", content: JSON.stringify(context) },
        ],
      }));
      
      let parsed = { advisors: [] };
      try { parsed = JSON.parse(suggestions.content); } catch (e) {}

      await helpers.step("persist-suggestions", {}, async () => {
        await prisma.adviceProcess.updateMany({
          where: { proposalId: params.proposalId },
          data: { advisorySuggestionsJson: parsed },
        });
      });

      return { resultJson: parsed };
    },
  });
}

