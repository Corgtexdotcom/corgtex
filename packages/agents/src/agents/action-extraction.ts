import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { executeAgentRun } from "../runtime";

export async function runActionExtractionAgent(params: {
  workspaceId: string;
  triggerRef: string;
  meetingId: string;
  triggerType?: AgentTriggerType;
}) {
  return executeAgentRun({
    agentKey: "action-extraction",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef: params.triggerRef,
    goal: "Keep transcript insights as reviewable drafts until a person approves them.",
    payload: {
      meetingId: params.meetingId,
    },
    plan: ["load-context", "load-insights", "queue-human-review"],
    buildContext: (helpers) => helpers.tool("meeting.load", { meetingId: params.meetingId }, async () => prisma.meeting.findUnique({
      where: { id: params.meetingId },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        transcript: true,
        summaryMd: true,
        insights: {
          where: { status: { in: ["SUGGESTED", "CONFIRMED"] } },
        },
      },
    }).then((meeting) => ({
      meeting,
    }))),
    execute: async (context) => {
      const meeting = context.meeting as {
        id: string;
        workspaceId: string;
        title: string | null;
        transcript: string | null;
        summaryMd: string | null;
        insights?: unknown[];
      } | null;

      if (!meeting || meeting.workspaceId !== params.workspaceId) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_meeting",
          },
        };
      }

      if (!meeting.transcript?.trim()) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_transcript",
            meetingId: meeting.id,
          },
        };
      }

      return {
        resultJson: {
          meetingId: meeting.id,
          reviewRequired: true,
          suggested: meeting.insights?.length ?? 0,
        },
      };
    },
  });
}
