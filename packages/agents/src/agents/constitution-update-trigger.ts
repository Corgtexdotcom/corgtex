import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runConstitutionUpdateTriggerAgent(params: {
  workspaceId: string;
  triggerRef: string;
  proposalId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "constitution-update-trigger",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Review whether an approved proposal should trigger constitution or policy follow-up.",
    payload: {
      proposalId: params.proposalId,
    },
    plan: ["load-context", "summarize-impact", "approval-checkpoint"],
    buildContext: (helpers) => helpers.tool("proposal.load", { proposalId: params.proposalId }, async () => {
      const [proposal, policyCorpus] = await Promise.all([
        prisma.proposal.findUnique({
          where: { id: params.proposalId },
          select: {
            id: true,
            workspaceId: true,
            title: true,
            summary: true,
            bodyMd: true,
            status: true,
          },
        }),
        prisma.policyCorpus.findUnique({
          where: { proposalId: params.proposalId },
          select: {
            id: true,
            title: true,
            bodyMd: true,
            acceptedAt: true,
          },
        }),
      ]);

      return {
        proposal,
        policyCorpus,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const proposal = context.proposal as {
        id: string;
        workspaceId: string;
        title: string;
        summary: string | null;
        bodyMd: string;
        status: string;
      } | null;

      if (!proposal || proposal.workspaceId !== params.workspaceId) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_proposal",
          },
        };
      }

      const impact = await helpers.tool("model.chat", { proposalId: proposal.id }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "AGENT",
        messages: [
          {
            role: "system",
            content: "Assess whether this approved proposal should trigger constitution or policy follow-up. Keep the output concise and operational.",
          },
          {
            role: "user",
            content: JSON.stringify({
              proposal,
              policyCorpus: context.policyCorpus ?? null,
            }),
          },
        ],
      }));

      return {
        resultJson: {
          proposalId: proposal.id,
          impactSummary: impact.content,
        },
        approvalCheckpoint: {
          summary: "Review the suggested constitution or policy follow-up before taking protected action.",
          detail: {
            proposalId: proposal.id,
            impactSummary: impact.content,
          },
        },
      };
    },
  });
}

