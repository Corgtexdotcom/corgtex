import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { executeAgentRun } from "../runtime";
import { prisma } from "@corgtex/shared";
import { applyExtractionResult } from "@corgtex/domain";

export async function runCrmEmailExtractionAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
  payload: {
    eventId: string;
    aggregateId: string;
    qualificationId: string;
  };
}) {
  return executeAgentRun({
    agentKey: "crm-email-extraction",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Extract structured qualification fields from the raw email reply.",
    payload: params.payload,
    plan: ["load-context", "extract-fields", "update-qualification"],
    buildContext: async (helpers) => {
      return helpers.step("load-context", {}, async () => {
        const qualification = await prisma.crmQualification.findUnique({
          where: { id: params.payload.qualificationId },
        });

        if (!qualification || !qualification.rawEmailReply) {
          throw new Error("Qualification not found or missing rawEmailReply.");
        }

        return { rawEmailReply: qualification.rawEmailReply };
      });
    },
    execute: async (context, helpers, runId, model) => {
      const extracted = await helpers.tool("model.extract", {}, async () => {
        return defaultModelGateway.extract({
          model,
          workspaceId: params.workspaceId,
          agentRunId: runId,
          instruction: "Extract companyName, website, aiExperience, and helpNeeded from the following raw email reply.",
          input: context.rawEmailReply as string,
          schemaHint: JSON.stringify({
            companyName: "string | null",
            website: "string | null",
            aiExperience: "string | null",
            helpNeeded: "string | null",
          }),
        });
      });

      await helpers.step("update-qualification", {}, async () => {
        await applyExtractionResult(
          params.workspaceId,
          params.payload.qualificationId,
          extracted.output
        );
      });

      return {
        resultJson: extracted.output as any,
      };
    },
  });
}
