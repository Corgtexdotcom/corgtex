import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runFinanceReconciliationPrepAgent(params: {
  workspaceId: string;
  triggerRef: string;
  spendId?: string | null;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "finance-reconciliation-prep",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? (params.spendId ? "EVENT" : "MANUAL"),
    triggerRef: params.triggerRef,
    goal: "Prepare reconciliation notes for paid spends that still need finance review.",
    payload: {
      spendId: params.spendId ?? null,
    },
    plan: ["load-context", "summarize-finance-state"],
    buildContext: (helpers) => helpers.tool("finance.unreconciled-spends", { spendId: params.spendId ?? null }, async () => {
      const spends = await prisma.spendRequest.findMany({
        where: {
          workspaceId: params.workspaceId,
          status: "PAID",
          reconciliationStatus: {
            not: "RECONCILED",
          },
          ...(params.spendId ? { id: params.spendId } : {}),
        },
        include: {
          ledgerAccount: {
            select: {
              id: true,
              name: true,
              currency: true,
            },
          },
          proposalLinks: {
            include: {
              proposal: {
                select: {
                  id: true,
                  title: true,
                  status: true,
                },
              },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
      });

      return {
        spends,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const spends = Array.isArray(context.spends) ? context.spends : [];
      if (spends.length === 0) {
        return {
          resultJson: {
            summary: "No paid unreconciled spends need preparation.",
            spendIds: [],
          },
        };
      }

      const summary = await helpers.tool("model.chat", { spendCount: spends.length }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "SUMMARY",
        messages: [
          {
            role: "system",
            content: "Summarize the reconciliation work needed for these paid spends. Keep the output concise and finance-oriented.",
          },
          {
            role: "user",
            content: JSON.stringify(spends),
          },
        ],
      }));

      return {
        resultJson: {
          summary: summary.content,
          spendIds: spends.map((spend) => spend.id),
        },
      };
    },
  });
}

