import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runDailyCheckInAgent(params: {
  workspaceId: string;
  triggerRef: string;
  memberId: string;
  triggerType: "SCHEDULE" | "EVENT" | "MANUAL";
}) {
  return executeAgentRun({
    agentKey: "daily-check-in",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType,
    triggerRef: params.triggerRef,
    goal: "Generate contextual check-in questions to monitor sentiment and prevent burnout.",
    payload: { memberId: params.memberId },
    plan: ["load-context", "generate-check-ins", "persist-check-ins"],
    buildContext: async (helpers) => {
      return { memberId: params.memberId };
    },
    execute: async (context, helpers, runId, model) => {
      const result = await helpers.step("persist-check-ins", {}, async () => {
        const { createCheckIn } = await import("@corgtex/domain");
        await createCheckIn(
          { role: "SYSTEM", id: "system" } as any,
          {
            workspaceId: params.workspaceId,
            memberId: params.memberId,
            questionText: "How are you feeling about your assigned tensions today?",
            questionSource: "AI",
          },
        );
        return { created: 1 };
      });
      return { resultJson: result };
    },
  });
}

