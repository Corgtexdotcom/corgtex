import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { AppError, createMeetingAudioAsset, isPlausibleMeetingRecordedAt, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const DEFAULT_LIST_TAKE = 25;
const MAX_LIST_TAKE = 50;

const audioAssetSelect = {
  id: true,
  meetingId: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  durationSeconds: true,
  title: true,
  recordedAt: true,
  participantEmails: true,
  status: true,
  transcriptProvider: true,
  transcriptModel: true,
  workflowJobId: true,
  intakeMeetingId: true,
  failureCode: true,
  failureMessage: true,
  transcribedAt: true,
  ingestedAt: true,
  createdAt: true,
  updatedAt: true,
  workflowJob: {
    select: {
      id: true,
      status: true,
      attempts: true,
      error: true,
      runAfter: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.MeetingAudioAssetSelect;

type MeetingAudioAssetSummary = Prisma.MeetingAudioAssetGetPayload<{ select: typeof audioAssetSelect }>;

function clampTake(value: string | null) {
  const parsed = Number.parseInt(value ?? `${DEFAULT_LIST_TAKE}`, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_TAKE;
  return Math.min(Math.max(parsed, 1), MAX_LIST_TAKE);
}

function dateJson(value: Date | null) {
  return value ? value.toISOString() : null;
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formStringList(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .flatMap((value) => (typeof value === "string" ? value.split(",") : []))
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseRecordedAt(value: string | null, required: boolean) {
  if (!value) {
    if (required) throw new AppError(400, "INVALID_INPUT", "recordedAt is required.");
    return null;
  }
  const recordedAt = new Date(value);
  if (Number.isNaN(recordedAt.valueOf())) {
    throw new AppError(400, "INVALID_INPUT", "recordedAt must be a valid date.");
  }
  if (!isPlausibleMeetingRecordedAt(recordedAt)) {
    throw new AppError(400, "INVALID_INPUT", "recordedAt must be within the last 10 years and no more than 90 days in the future.");
  }
  return recordedAt;
}

function parseDurationSeconds(value: string | null) {
  if (!value) return null;
  const durationSeconds = Number.parseInt(value, 10);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new AppError(400, "INVALID_INPUT", "durationSeconds must be a positive integer.");
  }
  return durationSeconds;
}

function requireMultipart(request: NextRequest) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("multipart/form-data")) {
    throw new AppError(400, "INVALID_INPUT", "Must use multipart/form-data.");
  }
}

function requireAudioFile(file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError(400, "INVALID_INPUT", "file is required.");
  }
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType && !mimeType.startsWith("audio/")) {
    throw new AppError(400, "INVALID_AUDIO_FILE", "Audio file must use an audio MIME type.");
  }
  return file;
}

function serializeAudioAsset(audioAsset: MeetingAudioAssetSummary) {
  return {
    id: audioAsset.id,
    meetingId: audioAsset.meetingId,
    fileName: audioAsset.fileName,
    mimeType: audioAsset.mimeType,
    sizeBytes: audioAsset.sizeBytes,
    durationSeconds: audioAsset.durationSeconds,
    title: audioAsset.title,
    recordedAt: dateJson(audioAsset.recordedAt),
    participantEmails: audioAsset.participantEmails,
    status: audioAsset.status,
    transcriptProvider: audioAsset.transcriptProvider,
    transcriptModel: audioAsset.transcriptModel,
    workflowJobId: audioAsset.workflowJobId,
    intakeMeetingId: audioAsset.intakeMeetingId,
    failureCode: audioAsset.failureCode,
    failureMessage: audioAsset.failureMessage,
    transcribedAt: dateJson(audioAsset.transcribedAt),
    ingestedAt: dateJson(audioAsset.ingestedAt),
    createdAt: audioAsset.createdAt.toISOString(),
    updatedAt: audioAsset.updatedAt.toISOString(),
    workflowJob: audioAsset.workflowJob
      ? {
          id: audioAsset.workflowJob.id,
          status: audioAsset.workflowJob.status,
          attempts: audioAsset.workflowJob.attempts,
          error: audioAsset.workflowJob.error,
          runAfter: audioAsset.workflowJob.runAfter.toISOString(),
          updatedAt: audioAsset.workflowJob.updatedAt.toISOString(),
        }
      : null,
  };
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  let workspaceId: string | undefined;
  try {
    const actor = await resolveRequestActor(request);
    ({ workspaceId } = await params);
    await requireWorkspaceMembership({ actor, workspaceId });

    const audioAssets = await prisma.meetingAudioAsset.findMany({
      where: { workspaceId },
      orderBy: [{ createdAt: "desc" }],
      take: clampTake(request.nextUrl.searchParams.get("take")),
      select: audioAssetSelect,
    });

    return NextResponse.json({ audioAssets: audioAssets.map(serializeAudioAsset) });
  } catch (error) {
    return handleRouteError(error, { request, surface: "meeting_audio_assets", workspaceId });
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  let workspaceId: string | undefined;
  try {
    requireMultipart(request);
    const actor = await resolveRequestActor(request);
    ({ workspaceId } = await params);
    const formData = await request.formData();
    const file = requireAudioFile(formData.get("file"));
    const meetingId = formString(formData, "meetingId");

    const result = await createMeetingAudioAsset(actor, {
      workspaceId,
      fileName: file.name,
      mimeType: file.type || null,
      fileBuffer: Buffer.from(await file.arrayBuffer()),
      meetingId,
      title: formString(formData, "title"),
      recordedAt: meetingId ? null : parseRecordedAt(formString(formData, "recordedAt"), true),
      durationSeconds: parseDurationSeconds(formString(formData, "durationSeconds")),
      participantEmails: formStringList(formData, "participantEmails"),
    });

    return NextResponse.json(
      {
        audioAsset: serializeAudioAsset({ ...result.audioAsset, workflowJobId: result.workflowJobId, workflowJob: null }),
        workflowJobId: result.workflowJobId,
      },
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error, { request, surface: "meeting_audio_assets", workspaceId });
  }
}
