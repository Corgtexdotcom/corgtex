import type { AgentTriggerType } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import {
  AppError,
  applyGuidanceTermCorrections,
  buildMeetingIntelligenceContext,
  normalizeMeetingBlocks,
  normalizeMeetingProductTerminology,
} from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

function isMissingMeetingError(error: unknown) {
  return error instanceof AppError && error.status === 404 && error.code === "NOT_FOUND";
}

const MAX_DIRECT_SUMMARY_TRANSCRIPT_CHARS = 35_000;
const SUMMARY_TRANSCRIPT_EXCERPT_CHARS = 8_000;

function excerptLongMeetingTranscript(transcript: string) {
  if (transcript.length <= MAX_DIRECT_SUMMARY_TRANSCRIPT_CHARS) {
    return transcript;
  }

  const middleStart = Math.max(
    SUMMARY_TRANSCRIPT_EXCERPT_CHARS,
    Math.floor(transcript.length / 2) - Math.floor(SUMMARY_TRANSCRIPT_EXCERPT_CHARS / 2),
  );
  const middleEnd = Math.min(
    transcript.length - SUMMARY_TRANSCRIPT_EXCERPT_CHARS,
    middleStart + SUMMARY_TRANSCRIPT_EXCERPT_CHARS,
  );

  return [
    `The full transcript is ${transcript.length} characters and was shortened for summary generation to avoid model timeouts. Use these beginning, middle, and ending excerpts as transcript evidence. Do not treat this shortening note as meeting content.`,
    `BEGINNING EXCERPT:\n${transcript.slice(0, SUMMARY_TRANSCRIPT_EXCERPT_CHARS)}`,
    `MIDDLE EXCERPT:\n${transcript.slice(middleStart, middleEnd)}`,
    `ENDING EXCERPT:\n${transcript.slice(-SUMMARY_TRANSCRIPT_EXCERPT_CHARS)}`,
  ].join("\n\n---\n\n");
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

      const transcript = meeting.transcript.trim();
      const transcriptForModel = excerptLongMeetingTranscript(transcript);
      const transcriptCondensedForSummary = transcriptForModel !== transcript;

      const blockExtraction = await helpers.tool("model.extract.meeting-blocks", { meetingId: meeting.id }, async () => defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        agentRunId: runId,
        instruction: [
          "Identify the meeting's actual discussion blocks from transcript evidence.",
          "Do not force a fixed template. Use natural blocks from the conversation, including custom/ad-hoc topics.",
          "A block can be a check-in, update, tension, proposal discussion, decision, planning segment, or custom topic.",
          "Tie proposal discussions and decisions to supplied existing proposal, tension, or action records only when the transcript and context support it.",
          "Personal check-ins can be blocks, but they are not governance records unless explicit work follows.",
          "Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in block titles, block summaries, and source quotes.",
          "Return ordered blocks only. Do not invent transcript content.",
        ].join(" "),
        input: JSON.stringify({
          title: meeting.title,
          source: meeting.source,
          recordedAt: meeting.recordedAt,
          transcript: transcriptForModel,
          transcriptLength: transcript.length,
          transcriptCondensedForSummary,
          currentSummary: meeting.summaryMd,
          ingestionGuidanceMd: meeting.ingestionGuidanceMd,
          existingRecords: meetingContext?.contextualIntelligenceEnabled ? {
            actions: meetingContext.actions,
            tensions: meetingContext.tensions,
            proposals: meetingContext.proposals,
          } : null,
        }),
        schemaHint: `{
          "version": 1,
          "blocks": [
            {
              "sequence": "number",
              "title": "string",
              "kind": "check_in | update | tension | proposal_discussion | decision | planning | custom",
              "summaryMd": "string",
              "sourceQuote": "string",
              "relatedRecords": [
                { "entityType": "Action | Tension | Proposal", "entityId": "string", "title": "string" }
              ]
            }
          ]
        }`,
      }));
      const meetingBlocks = normalizeMeetingBlocks(blockExtraction.output);

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
              "Write a fuller narrative summary organized around the supplied dynamic meeting blocks, with roughly twice the useful context of a terse recap and no repetition.",
              "Use the block titles as the main story spine. Preserve the meeting flow instead of forcing a fixed agenda template.",
              "For each block, explain what happened, why it mattered, the outcome or open question, and how it connects to decisions, proposals, tensions, actions, or follow-ups when evidence supports it.",
              "Explicitly tie decisions to the proposal, tension, or topic they belong to. If no clear decision was made, say what remained open.",
              "Do not leave owner-backed commitments only in the summary. Make action-oriented language explicit enough for downstream extraction to create separate action items.",
              "Use bullets for scannability. Include owners and dates only when the transcript supports them.",
              "Use user-provided ingestion guidance to decide what to emphasize or preserve, but do not invent facts unsupported by the transcript.",
              "Treat ingestion guidance as trusted operator context for spelling, name, and terminology corrections. If guidance corrects transcript wording, use the corrected wording in the summary and do not preserve conflicting text from currentSummary.",
              "Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in the human-facing summary.",
              "When contextual intelligence is enabled, use the supplied Corgtex context to explain continuity from previous recurring meetings and to refer to active proposals, tensions, actions, deliberation, and relevant knowledge by title. Do not claim those records changed unless the transcript supports it.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              title: meeting.title,
              source: meeting.source,
              recordedAt: meeting.recordedAt,
              transcript: transcriptForModel,
              transcriptLength: transcript.length,
              transcriptCondensedForSummary,
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
