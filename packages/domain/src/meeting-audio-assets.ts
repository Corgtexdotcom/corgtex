import { randomUUID } from "node:crypto";
import type { MeetingAudioAsset, MeetingAudioAssetStatus, MeetingTranscriptSourceProvider, Prisma } from "@prisma/client";
import { defaultModelGateway, type ModelGateway } from "@corgtex/models";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";
import { prisma, toInputJson, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";

export const MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE = "meeting-audio.transcribe";

const MAX_AUDIO_FILE_BYTES = 500 * 1024 * 1024;
const MEETING_AUDIO_SOURCE = "meeting-audio-upload";
const MEETING_AUDIO_TRANSCRIPT_PROVIDER: MeetingTranscriptSourceProvider = "MANUAL_UPLOAD";

type MeetingAudioTranscriber = Pick<ModelGateway, "transcribeAudio">;
type MeetingAudioStorage = Pick<StorageProvider, "put" | "get" | "delete">;

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function systemMeetingAudioActor(workspaceId: string): AppActor {
  return {
    kind: "agent",
    authProvider: "bootstrap",
    label: "meeting-audio-transcription-worker",
    workspaceIds: [workspaceId],
    scopes: ["meetings:write"],
  };
}

function safeFileName(fileName: string) {
  const clean = fileName.trim().replace(/[/\\]/g, "-").replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, " ");
  return clean.length > 0 ? clean.slice(0, 160) : "meeting-audio";
}

function audioStorageKey(workspaceId: string, fileName: string) {
  return `workspaces/${workspaceId}/meeting-audio/${randomUUID()}/${safeFileName(fileName)}`;
}

function workflowDedupeKey(audioAssetId: string) {
  return `meeting-audio:${audioAssetId}:transcribe`;
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function markAudioAssetFailed(params: {
  audioAssetId: string;
  workflowJobId?: string | null;
  code: string;
  message: string;
}) {
  return prisma.meetingAudioAsset.update({
    where: { id: params.audioAssetId },
    data: {
      status: "FAILED",
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: params.code,
      failureMessage: params.message,
    },
  });
}

export async function createMeetingAudioAsset(actor: AppActor, params: {
  workspaceId: string;
  fileName: string;
  mimeType?: string | null;
  fileBuffer: Buffer;
  meetingId?: string | null;
  title?: string | null;
  recordedAt?: Date | null;
  durationSeconds?: number | null;
  participantEmails?: string[] | null;
  storage?: MeetingAudioStorage;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(params.fileBuffer.byteLength > 0, 400, "INVALID_INPUT", "Audio file is required.");
  invariant(params.fileBuffer.byteLength <= MAX_AUDIO_FILE_BYTES, 413, "AUDIO_TOO_LARGE", "Audio file is too large.");
  if (params.recordedAt) {
    invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  }

  if (params.meetingId) {
    const meeting = await prisma.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  }

  const storage = params.storage ?? defaultStorage;
  const storageKey = audioStorageKey(params.workspaceId, params.fileName);
  let stored = false;
  try {
    await storage.put(storageKey, params.fileBuffer, {
      contentType: params.mimeType ?? undefined,
    });
    stored = true;

    return await prisma.$transaction(async (tx) => {
      const audioAsset = await tx.meetingAudioAsset.create({
        data: {
          workspaceId: params.workspaceId,
          meetingId: params.meetingId ?? null,
          uploadedByUserId: actorUserId(actor),
          fileName: safeFileName(params.fileName),
          mimeType: params.mimeType?.trim() || null,
          storageKey,
          sizeBytes: params.fileBuffer.byteLength,
          durationSeconds: params.durationSeconds ?? null,
          title: params.title?.trim() || null,
          recordedAt: params.recordedAt ?? null,
          participantEmails: [...new Set((params.participantEmails ?? []).map((email) => email.trim().toLowerCase()).filter(Boolean))],
          status: "UPLOADED",
        },
      });

      const job = await tx.workflowJob.upsert({
        where: { dedupeKey: workflowDedupeKey(audioAsset.id) },
        update: {},
        create: {
          workspaceId: params.workspaceId,
          type: MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE,
          payload: { audioAssetId: audioAsset.id },
          dedupeKey: workflowDedupeKey(audioAsset.id),
        },
        select: { id: true },
      });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: actorUserId(actor),
          action: "meeting-audio.uploaded",
          entityType: "MeetingAudioAsset",
          entityId: audioAsset.id,
          meta: toInputJson({
            fileName: audioAsset.fileName,
            sizeBytes: audioAsset.sizeBytes,
            meetingId: audioAsset.meetingId,
            workflowJobId: job.id,
          }) as Prisma.InputJsonObject,
        },
      });

      return { audioAsset, workflowJobId: job.id };
    });
  } catch (error) {
    if (stored) {
      await storage.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }
}

export async function runMeetingAudioAssetTranscription(params: {
  workspaceId: string | null;
  audioAssetId: string;
  workflowJobId?: string | null;
  storage?: Pick<StorageProvider, "get">;
  transcriber?: MeetingAudioTranscriber;
}) {
  const audioAsset = await prisma.meetingAudioAsset.findFirst({
    where: {
      id: params.audioAssetId,
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
    },
  });
  invariant(audioAsset, 404, "NOT_FOUND", "Meeting audio asset not found.");
  if (audioAsset.status === "INGESTED") {
    return { status: "skipped" as const, reason: "already_ingested", meetingId: audioAsset.intakeMeetingId };
  }

  try {
    const transcript = await ensureAudioAssetTranscript(audioAsset, {
      workflowJobId: params.workflowJobId,
      storage: params.storage ?? defaultStorage,
      transcriber: params.transcriber ?? defaultModelGateway,
    });

    const result = await intakeMeetingTranscript(systemMeetingAudioActor(audioAsset.workspaceId), {
      workspaceId: audioAsset.workspaceId,
      meetingId: audioAsset.meetingId,
      fileName: audioAsset.fileName,
      title: audioAsset.title,
      recordedAt: audioAsset.recordedAt,
      participantEmails: audioAsset.participantEmails,
      transcript,
      source: MEETING_AUDIO_SOURCE,
      provider: MEETING_AUDIO_TRANSCRIPT_PROVIDER,
      externalId: `meeting-audio:${audioAsset.id}`,
      replaceTranscript: false,
    });

    if (result.status === "needs_clarification") {
      await markAudioAssetFailed({
        audioAssetId: audioAsset.id,
        workflowJobId: params.workflowJobId,
        code: "INTAKE_NEEDS_CLARIFICATION",
        message: result.message,
      });
      return { status: "needs_clarification" as const, requiredFields: result.requiredFields };
    }

    await prisma.meetingAudioAsset.update({
      where: { id: audioAsset.id },
      data: {
        status: "INGESTED",
        intakeMeetingId: result.meeting.id,
        workflowJobId: params.workflowJobId ?? undefined,
        failureCode: null,
        failureMessage: null,
        ingestedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        workspaceId: audioAsset.workspaceId,
        actorUserId: null,
        action: "meeting-audio.ingested",
        entityType: "MeetingAudioAsset",
        entityId: audioAsset.id,
        meta: toInputJson({
          meetingId: result.meeting.id,
          intakeStatus: result.status,
          workflowJobId: params.workflowJobId ?? null,
        }) as Prisma.InputJsonObject,
      },
    });

    return { status: "ingested" as const, meetingId: result.meeting.id };
  } catch (error) {
    await markAudioAssetFailed({
      audioAssetId: audioAsset.id,
      workflowJobId: params.workflowJobId,
      code: error instanceof AppError ? error.code : "TRANSCRIPTION_FAILED",
      message: failureMessage(error),
    }).catch(() => undefined);
    throw error;
  }
}

async function ensureAudioAssetTranscript(
  audioAsset: MeetingAudioAsset,
  params: {
    workflowJobId?: string | null;
    storage: Pick<StorageProvider, "get">;
    transcriber: MeetingAudioTranscriber;
  },
) {
  if (audioAsset.transcriptText?.trim()) {
    return audioAsset.transcriptText.trim();
  }

  await prisma.meetingAudioAsset.update({
    where: { id: audioAsset.id },
    data: {
      status: "TRANSCRIBING" satisfies MeetingAudioAssetStatus,
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: null,
      failureMessage: null,
    },
  });

  const storedAudio = await params.storage.get(audioAsset.storageKey);
  if (!storedAudio) {
    throw new AppError(404, "AUDIO_NOT_FOUND", "Stored meeting audio could not be read.");
  }

  const response = await params.transcriber.transcribeAudio({
    workspaceId: audioAsset.workspaceId,
    workflowJobId: params.workflowJobId ?? undefined,
    fileName: audioAsset.fileName,
    mimeType: storedAudio.contentType ?? audioAsset.mimeType,
    data: storedAudio.data,
    prompt: audioAsset.title ? `Meeting title: ${audioAsset.title}` : null,
  });
  const transcript = response.text.trim();
  invariant(transcript.length > 0, 422, "EMPTY_TRANSCRIPT", "Audio transcription returned no text.");

  await prisma.meetingAudioAsset.update({
    where: { id: audioAsset.id },
    data: {
      status: "TRANSCRIBED",
      transcriptText: transcript,
      transcriptProvider: response.usage.provider,
      transcriptModel: response.usage.model,
      transcriptMetadata: toInputJson({
        outputTokens: response.usage.outputTokens,
        latencyMs: response.usage.latencyMs,
      }),
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: null,
      failureMessage: null,
      transcribedAt: new Date(),
    },
  });

  return transcript;
}
