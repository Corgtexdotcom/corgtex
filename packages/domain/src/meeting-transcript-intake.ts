import type { Meeting, MeetingTranscriptSourceProvider } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { createMeeting, uploadMeetingTranscript } from "./meetings";

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

export type MeetingTranscriptSegment = {
  speaker?: string | null;
  startMs?: number | null;
  endMs?: number | null;
  text: string;
};

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

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

export function isPlausibleMeetingRecordedAt(value: Date | null, now = new Date()) {
  if (!value || Number.isNaN(value.valueOf())) return false;
  const earliest = now.getTime() - TEN_YEARS_MS;
  const latest = now.getTime() + NINETY_DAYS_MS;
  return value.getTime() >= earliest && value.getTime() <= latest;
}

function asPlausibleRecordedAt(value: unknown, now = new Date()) {
  const recordedAt = asValidDate(value);
  return isPlausibleMeetingRecordedAt(recordedAt, now) ? recordedAt : null;
}

function recordedAtForCanonicalWrite(params: {
  value: unknown;
  validatePlausibility?: boolean;
  now?: Date;
}) {
  return params.validatePlausibility
    ? asPlausibleRecordedAt(params.value, params.now)
    : asValidDate(params.value);
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
  allowInferredRecordedAt?: boolean;
  validateExplicitRecordedAt?: boolean;
  now?: Date;
}) {
  const explicitTitle = cleanTitle(params.title);
  const explicitRecordedAt = recordedAtForCanonicalWrite({
    value: params.recordedAt,
    validatePlausibility: params.validateExplicitRecordedAt,
    now: params.now,
  });
  const needsModelMetadata = !explicitTitle || !explicitRecordedAt;
  const modelMetadata = needsModelMetadata
    ? await inferMetadataWithModel(params)
    : { title: null, recordedAt: null, participantEmails: [] };
  const combinedText = `${params.userMessage ?? ""}\n${params.fileName ?? ""}\n${params.transcript.slice(0, 4000)}`;
  const inferredRecordedAt = params.allowInferredRecordedAt
    ? asPlausibleRecordedAt(modelMetadata.recordedAt, params.now)
      ?? asPlausibleRecordedAt(parseDateFromText(combinedText), params.now)
    : null;
  const recordedAt = explicitRecordedAt ?? inferredRecordedAt;
  const participantEmails = [
    ...(params.participantEmails ?? []),
    ...modelMetadata.participantEmails,
    ...parseEmails(combinedText),
  ].map((email) => email.trim().toLowerCase()).filter(Boolean);

  return {
    title: explicitTitle ?? cleanTitle(modelMetadata.title) ?? titleFromFileName(params.fileName),
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
  provider?: MeetingTranscriptSourceProvider | string | null;
  externalId?: string | null;
  sourceUpdatedAt?: Date | string | null;
  sourceUrl?: string | null;
  meetingUrl?: string | null;
  calendarExternalId?: string | null;
  segments?: MeetingTranscriptSegment[] | null;
  batchId?: string | null;
  sourceRecordId?: string | null;
  batchMetadata?: Record<string, unknown> | null;
  replaceTranscript?: boolean;
  createNewMeeting?: boolean;
  recordedAt?: Date | string | null;
  summaryMd?: string | null;
  ingestionGuidanceMd?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
  now?: Date;
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
    recordedAt: existingMeeting?.recordedAt ?? params.recordedAt ?? null,
    participantEmails: [...(params.participantEmails ?? []), ...(existingMeeting?.participantEmails ?? [])],
    validateExplicitRecordedAt: Boolean(!(params.provider && params.sourceRecordId) && !existingMeeting),
    now: params.now,
  });

  if (!inferred.recordedAt) {
    return {
      status: "needs_clarification",
      requiredFields: ["recordedAt"],
      inferred,
      message: params.recordedAt && !isPlausibleMeetingRecordedAt(asValidDate(params.recordedAt), params.now) ? "The meeting date/time must be within the last 10 years and no more than 90 days in the future." : "I can save this as a meeting transcript, but I need the meeting date/time first.",
    };
  }

  if (params.createNewMeeting) {
    const meeting = await createMeeting(actor, {
      workspaceId: params.workspaceId,
      title: inferred.title,
      source: inferred.source,
      externalId: params.externalId ?? null,
      calendarExternalId: params.calendarExternalId ?? null,
      meetingUrl: params.meetingUrl ?? null,
      recordedAt: inferred.recordedAt,
      transcript,
      summaryMd: params.summaryMd,
      ingestionGuidanceMd: params.ingestionGuidanceMd,
      participantIds: params.participantIds ?? [],
      participantEmails: inferred.participantEmails,
      sourceRecordId: params.sourceRecordId ?? null,
    });
    return {
      status: "meeting_created",
      meeting,
      inferred,
      message: `Transcript saved as meeting "${meeting.title ?? inferred.title ?? "Untitled meeting"}". Summary and follow-up extraction are queued.`,
    };
  }

  const result = await uploadMeetingTranscript(actor, {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId ?? null,
    title: inferred.title,
    source: inferred.source,
    externalId: params.externalId ?? null,
    calendarExternalId: params.calendarExternalId ?? null,
    meetingUrl: params.meetingUrl ?? null,
    recordedAt: inferred.recordedAt,
    transcript,
    summaryMd: params.summaryMd,
    ingestionGuidanceMd: params.ingestionGuidanceMd,
    participantIds: params.participantIds ?? [],
    participantEmails: inferred.participantEmails,
    sourceRecordId: params.sourceRecordId ?? null,
    replaceTranscript: params.replaceTranscript,
  });

  if (result.status === "needs_selection") {
    const multipleCandidates = result.candidates.length > 1;
    return {
      status: "needs_clarification",
      requiredFields: ["meetingId"],
      inferred,
      candidates: result.candidates,
      message: multipleCandidates
        ? "I found multiple scheduled meetings that could match this transcript. Choose one or create a new meeting to continue."
        : "I found a scheduled meeting that may match this transcript, but it was not confident enough to auto-match. Choose it or create a new meeting to continue.",
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
