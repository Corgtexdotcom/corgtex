import type { AgentTriggerType } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import { defaultModelGateway } from "@corgtex/models";
import {
  AppError,
  applyGuidanceTermCorrections,
  buildMeetingIntelligenceContext,
  buildMeetingTranscriptChunks,
  agendaSectionTitles,
  type MeetingBlocksJson,
  type MeetingTranscriptChunk,
  normalizeMeetingBlocks,
  normalizeMeetingProductTerminology,
  recordMeetingTranscriptProcessingStage,
} from "@corgtex/domain";
import { executeAgentRun } from "../runtime";

function isMissingMeetingError(error: unknown) {
  return error instanceof AppError && error.status === 404 && error.code === "NOT_FOUND";
}

const MAX_DIRECT_SUMMARY_TRANSCRIPT_CHARS = 35_000;

const MEETING_BLOCK_SCHEMA_HINT = `{
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
}`;

function directTranscriptChunk(transcript: string): MeetingTranscriptChunk {
  return {
    chunkIndex: 1,
    chunkCount: 1,
    startChar: 0,
    endChar: transcript.length,
    text: transcript,
  };
}

function transcriptChunksForSummary(transcript: string) {
  return transcript.length > MAX_DIRECT_SUMMARY_TRANSCRIPT_CHARS
    ? buildMeetingTranscriptChunks(transcript)
    : [directTranscriptChunk(transcript)];
}

function normalizeBlockDedupeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function mergeMeetingBlockOutputs(outputs: MeetingBlocksJson[]): MeetingBlocksJson {
  const seen = new Set<string>();
  const blocks = outputs.flatMap((output) => output.blocks).flatMap((block) => {
    const key = [
      normalizeBlockDedupeText(block.kind),
      normalizeBlockDedupeText(block.title),
      normalizeBlockDedupeText(block.summaryMd).slice(0, 240),
    ].join("|");
    if (seen.has(key)) return [];
    seen.add(key);
    return [block];
  });

  return {
    version: 1,
    blocks: blocks.map((block, index) => ({
      ...block,
      sequence: index + 1,
    })),
  };
}

function transcriptForSummaryChat(transcript: string, chunks: MeetingTranscriptChunk[]) {
  if (chunks.length === 1) return transcript;

  return [
    `The full transcript is ${transcript.length} characters and was processed in ${chunks.length} full-coverage chunks for block extraction.`,
    "Use meetingBlocks as the transcript evidence for this long meeting. Do not treat this processing note as meeting content.",
  ].join(" ");
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
        agendaJson: unknown;
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
      const transcriptChunks = transcriptChunksForSummary(transcript);
      const transcriptChunkedForSummary = transcriptChunks.length > 1;
      const blockOutputs: MeetingBlocksJson[] = [];

      for (const chunk of transcriptChunks) {
        await recordMeetingTranscriptProcessingStage({
          workspaceId: params.workspaceId,
          meetingId: meeting.id,
          stage: "SUMMARIZING",
          status: "ACTIVE",
          workflowJobId: params.triggerRef,
          workflowJobType: "agent.meeting-summary",
          workflowJobStatus: "RUNNING",
          attempts: null,
          chunkIndex: transcriptChunkedForSummary ? chunk.chunkIndex : null,
          chunkCount: transcriptChunkedForSummary ? chunk.chunkCount : null,
        });
        const blockExtraction = await helpers.tool("model.extract.meeting-blocks", {
          meetingId: meeting.id,
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunk.chunkCount,
        }, async () => defaultModelGateway.extract({
          model,
          workspaceId: params.workspaceId,
          agentRunId: runId,
          instruction: [
            "Identify the meeting's actual discussion blocks from transcript evidence.",
            "Do not force a fixed template. Use natural blocks from the conversation, including custom/ad-hoc topics.",
            "A block can be a check-in, update, tension, proposal discussion, decision, planning segment, or custom topic.",
            "Preserve scorecard, round-robin, department, team-update, and status update segments as update blocks even when they are not decisions.",
            "For owner-backed commitments inside updates, make the commitment visible in the block summary so downstream extraction can create action items.",
            "Tie proposal discussions and decisions to supplied existing proposal, tension, or action records only when the transcript and context support it.",
            "If agenda section titles are supplied, use them as helpful hints for likely meeting structure, but preserve the actual transcript flow when the meeting diverges.",
            "Personal check-ins can be blocks, but they are not governance records unless explicit work follows.",
            "Correct meeting transcript drift where Cortex means Corgtex. Use Corgtex in block titles, block summaries, and source quotes.",
            "Return ordered blocks only. Do not invent transcript content.",
          ].join(" "),
          input: JSON.stringify({
            title: meeting.title,
            source: meeting.source,
            recordedAt: meeting.recordedAt,
            transcript: chunk.text,
            transcriptLength: transcript.length,
            transcriptChunkedForSummary,
            transcriptCondensedForSummary: false,
            transcriptChunk: {
              chunkIndex: chunk.chunkIndex,
              chunkCount: chunk.chunkCount,
              startChar: chunk.startChar,
              endChar: chunk.endChar,
            },
            currentSummary: meeting.summaryMd,
            agendaSectionTitles: agendaSectionTitles(meeting.agendaJson),
            ingestionGuidanceMd: meeting.ingestionGuidanceMd,
            existingRecords: meetingContext?.contextualIntelligenceEnabled ? {
              actions: meetingContext.actions,
              tensions: meetingContext.tensions,
              proposals: meetingContext.proposals,
            } : null,
          }),
          schemaHint: MEETING_BLOCK_SCHEMA_HINT,
        }));
        blockOutputs.push(normalizeMeetingBlocks(blockExtraction.output));
      }
      const meetingBlocks = mergeMeetingBlockOutputs(blockOutputs);
      const summaryTranscript = transcriptForSummaryChat(transcript, transcriptChunks);

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
              "When an agenda is supplied, treat it as useful context for the intended flow, not proof that every section happened.",
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
              transcript: summaryTranscript,
              transcriptLength: transcript.length,
              transcriptChunkedForSummary,
              transcriptCondensedForSummary: false,
              transcriptChunks: transcriptChunkedForSummary
                ? transcriptChunks.map((chunk) => ({
                  chunkIndex: chunk.chunkIndex,
                  chunkCount: chunk.chunkCount,
                  startChar: chunk.startChar,
                  endChar: chunk.endChar,
                }))
                : null,
              currentSummary: meeting.summaryMd,
              meetingBlocks,
              agendaSectionTitles: agendaSectionTitles(meeting.agendaJson),
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
        where: {
          id: meeting.id,
          workspaceId: params.workspaceId,
          summaryMd: meeting.summaryMd,
          transcript: meeting.transcript,
          ingestionGuidanceMd: meeting.ingestionGuidanceMd,
        },
        data: {
          summaryMd,
          blocksJson: toInputJson(meetingBlocks),
        },
      }));
      if (persisted.count === 0) {
        const currentMeeting = await prisma.meeting.findUnique({
          where: { id: meeting.id },
          select: {
            id: true,
            workspaceId: true,
            summaryMd: true,
            transcript: true,
            ingestionGuidanceMd: true,
          },
        });
        if (currentMeeting?.workspaceId === params.workspaceId && currentMeeting.summaryMd !== meeting.summaryMd) {
          return {
            resultJson: {
              skipped: true,
              reason: "summary_changed",
              meetingId: meeting.id,
            },
          };
        }
        if (
          currentMeeting?.workspaceId === params.workspaceId
          && (
            currentMeeting.transcript !== meeting.transcript
            || currentMeeting.ingestionGuidanceMd !== meeting.ingestionGuidanceMd
          )
        ) {
          return {
            resultJson: {
              skipped: true,
              reason: "source_changed",
              meetingId: meeting.id,
            },
          };
        }
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
