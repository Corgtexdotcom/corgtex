import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { autoApplyMeetingInsights } from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
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
    goal: "Auto-apply high-confidence actions, tensions, proposals, decisions, and resolutions extracted from meeting content.",
    payload: {
      meetingId: params.meetingId,
    },
    plan: ["load-context", "load-insights", "auto-apply-high-confidence"],
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
    execute: async (context, helpers, _runId, _model) => {
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

      const actor: AppActor = {
        kind: "agent",
        authProvider: "bootstrap",
        label: "action-extraction",
        workspaceIds: [params.workspaceId],
        scopes: ["meetings:write", "actions:write", "tensions:write", "proposals:write"],
      };

      const result = await helpers.tool("meeting-insights.auto-apply", { meetingId: meeting.id }, () => autoApplyMeetingInsights(actor, {
        workspaceId: params.workspaceId,
        meetingId: meeting.id,
      }));

      return {
        resultJson: {
          meetingId: meeting.id,
          ...result,
        },
      };
    },
  });
}
