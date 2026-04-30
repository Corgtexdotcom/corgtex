import type { Meeting } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { uploadMeetingTranscript } from "./meetings";

type IntakeStatus = "meeting_created" | "meeting_matched" | "needs_clarification";

export type MeetingTranscriptIntakeResult =
  | {
      status: "meeting_created" | "meeting_matched";
      meeting: Meeting;
      message: string;
      inferred: MeetingTranscriptMetadata;
    }
  | {
      status: "needs_clarification";
      requiredFields: Array<"recordedAt" | "meetingId">;
      message: string;
      inferred: MeetingTranscriptMetadata;
      candidates?: Array<{
        meetingId: string;
        title: string | null;
        recordedAt: Date;
        score: number;
        reason: string;
      }>;
    };

export type MeetingTranscriptMetadata = {
  title: string | null;
  recordedAt: Date | null;
  participantEmails: string[];
  source: string;
};

function cleanTitle(value: string | null | undefined) {
  const title = value?.trim().replace(/\.[A-Za-z0-9]+$/, "").replace(/[-_]+/g, " ");
  return title && title.length > 0 ? title : null;
}

function titleFromFileName(fileName?: string | null) {
  const title = cleanTitle(fileName);
  if (!title) return null;
  return title.replace(/\b(transcript|meeting|notes|minutes)\b/gi, "").replace(/\s+/g, " ").trim() || title;
}

function parseEmails(input: string) {
  return [...new Set((input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((email) => email.toLowerCase()))];
}

function asValidDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return null;
}

function parseDateFromText(input: string) {
  const iso = input.match(/\b20\d{2}-\d{2}-\d{2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/);
  if (iso) return asValidDate(iso[0]);

  const slash = input.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/);
  if (slash) return asValidDate(`${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`);

  const month = input.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+([0-3]?\d),?\s+(20\d{2})\b/i);
  if (month) return asValidDate(`${month[1]} ${month[2]}, ${month[3]}`);

  return null;
}

export function classifyUploadedTextForMeeting(params: {
  fileName?: string | null;
  mimeType?: string | null;
  textContent: string | null | undefined;
  userMessage?: string | null;
}) {
  const text = params.textContent?.trim() ?? "";
  const lower = `${params.fileName ?? ""}\n${params.userMessage ?? ""}\n${text.slice(0, 6000)}`.toLowerCase();
  const speakerLines = text.split(/\r?\n/).filter((line) => /^[A-Z][A-Za-z0-9 ._-]{1,40}:\s+/.test(line.trim())).length;
  const transcriptWords = ["transcript", "meeting", "minutes", "attendees", "action item", "follow up", "agenda", "checkpoint", "standup"];
  const keywordHits = transcriptWords.filter((word) => lower.includes(word)).length;
  const classification = speakerLines >= 4 || keywordHits >= 2 ? "meeting_transcript" : "document";
  const confidence = Math.min(0.95, 0.25 + speakerLines * 0.08 + keywordHits * 0.12);

  return {
    classification,
    confidence,
    reason: classification === "meeting_transcript" ? "Transcript-like structure or meeting keywords detected." : "No strong meeting transcript signals detected.",
  };
}

async function inferMetadataWithModel(params: {
  workspaceId: string;
  transcript: string;
  fileName?: string | null;
  userMessage?: string | null;
}) {
  try {
    const extraction = await defaultModelGateway.extract({
      workspaceId: params.workspaceId,
      instruction: "Extract meeting metadata from this uploaded meeting transcript. Return null for fields that are not explicitly present or strongly implied.",
      schemaHint: "{ title: string | null, recordedAt: string | null, participantEmails: string[] }",
      input: JSON.stringify({
        fileName: params.fileName ?? null,
        userMessage: params.userMessage ?? null,
        transcriptPreview: params.transcript.slice(0, 12000),
      }),
    });
    const output = extraction.output as Record<string, unknown>;
    return {
      title: typeof output.title === "string" ? output.title : null,
      recordedAt: typeof output.recordedAt === "string" ? asValidDate(output.recordedAt) : null,
      participantEmails: Array.isArray(output.participantEmails)
        ? output.participantEmails.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : [],
    };
  } catch {
    return { title: null, recordedAt: null, participantEmails: [] };
  }
}

export async function inferMeetingTranscriptMetadata(params: {
  workspaceId: string;
  transcript: string;
  fileName?: string | null;
  userMessage?: string | null;
  title?: string | null;
  source?: string | null;
  recordedAt?: Date | string | null;
  participantEmails?: string[] | null;
}) {
  const modelMetadata = await inferMetadataWithModel(params);
  const combinedText = `${params.userMessage ?? ""}\n${params.fileName ?? ""}\n${params.transcript.slice(0, 4000)}`;
  const recordedAt = asValidDate(params.recordedAt) ?? modelMetadata.recordedAt ?? parseDateFromText(combinedText);
  const participantEmails = [
    ...(params.participantEmails ?? []),
    ...modelMetadata.participantEmails,
    ...parseEmails(combinedText),
  ].map((email) => email.trim().toLowerCase()).filter(Boolean);

  return {
    title: cleanTitle(params.title) ?? cleanTitle(modelMetadata.title) ?? titleFromFileName(params.fileName),
    recordedAt,
    participantEmails: [...new Set(participantEmails)],
    source: params.source?.trim() || "chat-transcript-upload",
  };
}

export async function intakeMeetingTranscript(actor: AppActor, params: {
  workspaceId: string;
  transcript: string;
  fileName?: string | null;
  userMessage?: string | null;
  meetingId?: string | null;
  title?: string | null;
  source?: string | null;
  recordedAt?: Date | string | null;
  summaryMd?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
}): Promise<MeetingTranscriptIntakeResult> {
  const transcript = params.transcript.trim();
  const existingMeeting = params.meetingId
    ? await prisma.meeting.findFirst({
        where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
        select: { recordedAt: true, title: true, participantEmails: true },
      })
    : null;
  const inferred = await inferMeetingTranscriptMetadata({
    workspaceId: params.workspaceId,
    transcript,
    fileName: params.fileName,
    userMessage: params.userMessage,
    title: params.title ?? existingMeeting?.title ?? null,
    source: params.source,
    recordedAt: params.recordedAt ?? existingMeeting?.recordedAt ?? null,
    participantEmails: [...(params.participantEmails ?? []), ...(existingMeeting?.participantEmails ?? [])],
  });

  if (!inferred.recordedAt) {
    return {
      status: "needs_clarification",
      requiredFields: ["recordedAt"],
      inferred,
      message: "I can save this as a meeting transcript, but I need the meeting date/time first.",
    };
  }

  const result = await uploadMeetingTranscript(actor, {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId ?? null,
    title: inferred.title,
    source: inferred.source,
    recordedAt: inferred.recordedAt,
    transcript,
    summaryMd: params.summaryMd,
    participantIds: params.participantIds ?? [],
    participantEmails: inferred.participantEmails,
  });

  if (result.status === "needs_selection") {
    return {
      status: "needs_clarification",
      requiredFields: ["meetingId"],
      inferred,
      candidates: result.candidates,
      message: "I found multiple scheduled meetings that could match this transcript. Choose one and upload again.",
    };
  }

  const status: IntakeStatus = result.status === "matched" ? "meeting_matched" : "meeting_created";
  return {
    status,
    meeting: result.meeting,
    inferred,
    message: `Transcript saved as meeting "${result.meeting.title ?? inferred.title ?? "Untitled meeting"}". Summary and follow-up extraction are queued.`,
  };
}
