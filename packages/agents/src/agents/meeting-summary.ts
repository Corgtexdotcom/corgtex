import type { AgentTriggerType } from "@prisma/client";
import { prisma, env } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { createConstitutionVersion } from "@corgtex/domain";
import { executeAgentRun, normalizeActionDrafts, normalizeProposalDraft, asString } from "../runtime";

export async function runMeetingSummaryAgent(params: {
  workspaceId: string;
  triggerRef: string;
  meetingId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "meeting-summary",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Summarize meeting content and persist an operator-readable digest.",
    payload: {
      meetingId: params.meetingId,
    },
    plan: ["load-context", "generate-summary", "persist-summary"],
    buildContext: (helpers) => helpers.tool("meeting.load", { meetingId: params.meetingId }, async () => prisma.meeting.findUnique({
      where: { id: params.meetingId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        source: true,
        transcript: true,
        summaryMd: true,
        recordedAt: true,
      },
    }).then((meeting) => ({
      meeting,
    }))),
    execute: async (context, helpers, runId, model) => {
      const meeting = context.meeting as {
        id: string;
        workspaceId: string;
        title: string | null;
        source: string;
        transcript: string | null;
        summaryMd: string | null;
        recordedAt: string | Date;
      } | null;

      if (!meeting || meeting.workspaceId !== params.workspaceId) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_meeting",
          },
        };
      }

      const summary = await helpers.tool("model.chat", { meetingId: meeting.id }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "SUMMARY",
        messages: [
          {
            role: "system",
            content: "Summarize this meeting for an operator dashboard. Keep it concise, factual, and action-oriented.",
          },
          {
            role: "user",
            content: JSON.stringify({
              title: meeting.title,
              source: meeting.source,
              recordedAt: meeting.recordedAt,
              transcript: meeting.transcript,
              currentSummary: meeting.summaryMd,
            }),
          },
        ],
      }));

      await helpers.step("persist-summary", { meetingId: meeting.id }, async () => prisma.meeting.update({
        where: { id: meeting.id },
        data: {
          summaryMd: summary.content,
        },
      }));

      return {
        resultJson: {
          meetingId: meeting.id,
          summary: summary.content,
        },
      };
    },
  });
}

