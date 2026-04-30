import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { executeAgentRun } from "../runtime";
import { prisma } from "@corgtex/shared";
import { recordDripFollowUp } from "@corgtex/domain";

export async function runCrmDripFollowupAgent(params: {
  workspaceId: string;
  triggerRef: string;
  triggerType?: AgentTriggerType;
  payload: {
    demoLeadId: string;
    followUpNumber: number;
  };
}) {
  return executeAgentRun({
    agentKey: "crm-drip-followup",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "SCHEDULE",
    triggerRef: params.triggerRef,
    goal: "Draft and send a personalized follow-up email to a demo lead who hasn't responded.",
    payload: params.payload,
    plan: ["load-lead-context", "generate-email", "send-and-record"],
    buildContext: async (helpers) => {
      return helpers.step("load-lead-context", {}, async () => {
        const lead = await prisma.demoLead.findUnique({
          where: { id: params.payload.demoLeadId },
          include: { crmQualifications: true, workspace: true },
        });

        if (!lead) {
          throw new Error("DemoLead not found.");
        }

        return { lead };
      });
    },
    execute: async (context, helpers, runId, model) => {
      const emailContent = await helpers.tool("model.generate", {}, async () => {
        const leadContext = JSON.stringify({
          email: (context.lead as any).email,
          companyHint: (context.lead as any).companyHint,
          source: (context.lead as any).source,
          utmSource: (context.lead as any).utmSource,
          followUpNumber: params.payload.followUpNumber,
        });

        const response = await defaultModelGateway.chat({
          model,
          workspaceId: params.workspaceId,
          agentRunId: runId,
          taskType: "AGENT",
          messages: [
            { role: "system", content: `You are a founder reaching out to a demo lead who hasn't responded. Write a short, warm, personalized email (3-5 sentences). This is follow-up #${params.payload.followUpNumber}. Make it conversational and low pressure. Output ONLY the email body.` },
            { role: "user", content: `Lead context: ${leadContext}` }
          ],
        });
        
        return response.content;
      });

      await helpers.step("send-and-record", {}, async () => {
        // In a real implementation, we would send the email via Resend here.
        // e.g. await sendEmail({ to: lead.email, text: emailContent })
        
        await recordDripFollowUp(
          params.workspaceId,
          params.payload.demoLeadId,
          emailContent
        );
      });

      return {
        resultJson: { emailContent },
      };
    },
  });
}
