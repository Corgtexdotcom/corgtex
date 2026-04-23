import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runSpendSubmissionAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
  amountCents: number;
  currency: string;
  category: string;
  description: string;
  vendor?: string | null;
  requesterEmail?: string | null;
}) {
  return executeAgentRun({
    agentKey: "spend-submission",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Create and submit a spend request.",
    payload: {
      amountCents: params.amountCents,
      currency: params.currency,
      category: params.category,
      description: params.description,
      vendor: params.vendor ?? null,
      requesterEmail: params.requesterEmail ?? null,
    },
    plan: ["submit-spend"],
    buildContext: async () => ({}),
    execute: async (_context, helpers, _runId, _model) => {
      const result = await helpers.step("submit-spend", params, async () => {
        const { createSpend, submitSpend } = await import("@corgtex/domain");
        const actor = { kind: "agent" as const, agentSettings: { workspaceId: params.workspaceId } } as any;

        const spend = await createSpend(actor, {
          workspaceId: params.workspaceId,
          amountCents: params.amountCents,
          currency: params.currency,
          category: params.category,
          description: params.description,
          vendor: params.vendor,
          requesterEmail: params.requesterEmail,
        });

        const submitted = await submitSpend(actor, {
          workspaceId: params.workspaceId,
          spendId: spend.id,
        });

        return submitted;
      });

      return { resultJson: { spendId: result.spendId } };
    },
  });
}

