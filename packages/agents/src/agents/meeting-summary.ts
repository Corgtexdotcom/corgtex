import type { AgentTriggerType } from "@prisma/client";
import { prisma } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import { AppError, applyGuidanceTermCorrections, buildMeetingIntelligenceContext } from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

function isMissingMeetingError(error: unknown) {
  return error instanceof AppError && error.status === 404 && error.code === "NOT_FOUND";
}

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
    buildContext: (helpers) => helpers.tool("meeting-context.load", { meetingId: params.meetingId }, async () => {
      try {
        return {
          meetingContext: await buildMeetingIntelligenceContext({
            workspaceId: params.workspaceId,
            meetingId: params.meetingId,
            mode: "summary",
          }),
        };
      } catch (error) {
        if (isMissingMeetingError(error)) {
          return { meetingContext: null };
        }
        throw error;
      }
    }),
    execute: async (context, helpers, runId, model) => {
      const meetingContext = context.meetingContext as Awaited<ReturnType<typeof buildMeetingIntelligenceContext>> | null;
      const meeting = meetingContext?.meeting as {
        id: string;
        workspaceId: string;
        title: string | null;
        source: string;
        transcript: string | null;
        summaryMd: string | null;
        ingestionGuidanceMd: string | null;
        recordedAt: string | Date;
      } | null | undefined;

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
            content: [
              "Summarize this meeting for an operator dashboard.",
              "Return clean Markdown only, with no preamble or closing disclaimer.",
              "Use concise sections in this order when evidence exists: Overview, Decisions, Action Items, Tensions / Open Questions, Proposals, Next Steps.",
              "Use bullets for scannability. Include owners and dates only when the transcript supports them.",
              "Use user-provided ingestion guidance to decide what to emphasize or preserve, but do not invent facts unsupported by the transcript.",
              "Treat ingestion guidance as trusted operator context for spelling, name, and terminology corrections. If guidance corrects transcript wording, use the corrected wording in the summary and do not preserve conflicting text from currentSummary.",
              "When contextual intelligence is enabled, use the supplied Corgtex context to explain continuity from previous recurring meetings and to refer to active proposals, tensions, actions, deliberation, and relevant knowledge by title. Do not claim those records changed unless the transcript supports it.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              title: meeting.title,
              source: meeting.source,
              recordedAt: meeting.recordedAt,
              transcript: meeting.transcript,
              currentSummary: meeting.summaryMd,
              ingestionGuidanceMd: meeting.ingestionGuidanceMd,
              corgtexContext: meetingContext?.contextualIntelligenceEnabled ? {
                previousMeetings: meetingContext.previousMeetings,
                openActions: meetingContext.actions,
                openTensions: meetingContext.tensions,
                openProposals: meetingContext.proposals,
                recentDeliberation: meetingContext.deliberationEntries,
                followUps: meetingContext.followUps,
                knowledge: meetingContext.knowledge,
              } : null,
            }),
          },
        ],
      }));

      const summaryMd = applyGuidanceTermCorrections(summary.content, meeting.ingestionGuidanceMd);
      await helpers.step("persist-summary", { meetingId: meeting.id }, async () => prisma.meeting.update({
        where: { id: meeting.id },
        data: {
          summaryMd,
        },
      }));
      return {
        resultJson: {
          meetingId: meeting.id,
          summary: summaryMd,
        },
      };
    },
  });
}
