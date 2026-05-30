import type { AgentTriggerType } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import {
  AppError,
  applyGuidanceTermCorrections,
  buildMeetingIntelligenceContext,
  MEETING_BLOCK_EXTRACTION_INSTRUCTION,
  MEETING_BLOCK_SCHEMA_HINT,
  MEETING_SUMMARY_SYSTEM_PROMPT,
  normalizeMeetingBlocks,
  normalizeMeetingProductTerminology,
} from "@corgtex/domain";
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
        blocksJson: unknown;
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

      if (!meeting.transcript?.trim()) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_transcript",
            meetingId: meeting.id,
          },
        };
      }

      const blockExtraction = await helpers.tool("model.extract.meeting-blocks", { meetingId: meeting.id }, async () => defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        instruction: MEETING_BLOCK_EXTRACTION_INSTRUCTION,
        input: JSON.stringify({
          title: meeting.title,
          source: meeting.source,
          recordedAt: meeting.recordedAt,
          transcript: meeting.transcript,
          currentSummary: meeting.summaryMd,
          ingestionGuidanceMd: meeting.ingestionGuidanceMd,
          existingRecords: meetingContext?.contextualIntelligenceEnabled ? {
            actions: meetingContext.actions,
            tensions: meetingContext.tensions,
            proposals: meetingContext.proposals,
          } : null,
        }),
        schemaHint: MEETING_BLOCK_SCHEMA_HINT,
      }));
      const meetingBlocks = normalizeMeetingBlocks(blockExtraction.output);

      const summary = await helpers.tool("model.chat", { meetingId: meeting.id }, async () => defaultModelGateway.chat({ model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        taskType: "SUMMARY",
        messages: [
          {
            role: "system",
            content: MEETING_SUMMARY_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify({
              title: meeting.title,
              source: meeting.source,
              recordedAt: meeting.recordedAt,
              transcript: meeting.transcript,
              currentSummary: meeting.summaryMd,
              meetingBlocks,
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

      const summaryMd = normalizeMeetingProductTerminology(
        applyGuidanceTermCorrections(summary.content, meeting.ingestionGuidanceMd),
      );
      const persisted = await helpers.step("persist-summary", { meetingId: meeting.id }, async () => prisma.meeting.updateMany({
        where: { id: meeting.id, workspaceId: params.workspaceId },
        data: {
          summaryMd,
          blocksJson: toInputJson(meetingBlocks),
        },
      }));
      if (persisted.count === 0) {
        return {
          resultJson: {
            skipped: true,
            reason: "missing_meeting",
            meetingId: meeting.id,
          },
        };
      }
      return {
        resultJson: {
          meetingId: meeting.id,
          summary: summaryMd,
          blocks: meetingBlocks.blocks.length,
        },
      };
    },
  });
}
