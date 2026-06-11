import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { executeAgentRun } from "../runtime";
import { prisma, sendEmail } from "@corgtex/shared";
import { recordDripFollowUp } from "@corgtex/domain";

function emailBodyToHtml(body: string) {
  return body
    .split("\n")
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
    )
    .join("<br />");
}

export function buildCrmDripFollowupSystemPrompt(followUpNumber: number) {
  return [
    "You are a founder reaching out to a demo lead who hasn't responded.",
    `Write a short, warm, personalized email (3-5 sentences). This is follow-up #${followUpNumber}.`,
    "Make it conversational and low pressure.",
    "Frame Corgtex as a practical way to adopt AI while preserving human judgment, operating memory, employee trust, and organizational control.",
    "When useful, describe the Corgtex newspaper as a simple daily operating picture, not as a marketing feature list.",
    "Mention employee-owned, self-managed, or mission-driven fit only when the lead context supports it; do not invent those traits.",
    "Output ONLY the email body.",
  ].join(" ");
}

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
        const lead = await prisma.demoLead.findFirst({
          where: {
            id: params.payload.demoLeadId,
            workspaceId: params.workspaceId,
          },
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
            { role: "system", content: buildCrmDripFollowupSystemPrompt(params.payload.followUpNumber) },
            { role: "user", content: `Lead context: ${leadContext}` },
          ],
        });

        return response.content;
      });

      await helpers.step("send-and-record", {}, async () => {
        const lead = context.lead as { email: string };
        await sendEmail({
          to: lead.email,
          subject: "A quick follow-up from Corgtex",
          html: emailBodyToHtml(emailContent),
        });

        await recordDripFollowUp(
          params.workspaceId,
          params.payload.demoLeadId,
          emailContent,
        );
      });

      return {
        resultJson: { emailContent },
      };
    },
  });
}
