import { executeAgentRun } from "../runtime";

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
    goal: "Generate optional company-understanding questions that fill Brain evidence gaps.",
    payload: { memberId: params.memberId },
    plan: ["load-member-gaps", "dedupe-daily-questions", "persist-company-understanding-questions"],
    buildContext: async () => {
      return { memberId: params.memberId };
    },
    execute: async (_context, helpers, _runId, _model) => {
      const result = await helpers.step("persist-check-ins", {}, async () => {
        const { createDailyCompanyUnderstandingQuestions } = await import("@corgtex/domain");
        return createDailyCompanyUnderstandingQuestions(
          {
            kind: "agent",
            authProvider: "bootstrap",
            label: "daily-check-in",
            workspaceIds: [params.workspaceId],
          },
          {
            workspaceId: params.workspaceId,
            memberId: params.memberId,
          },
        );
      });
      return { resultJson: result };
    },
  });
}
