import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { AppError, MAX_AUDIO_FILE_BYTES, createMeetingAudioAsset, isPlausibleMeetingRecordedAt, readableArtifactIds, captureReadableDigestInputs, captureArtifactReadHeadObservation, mergeArtifactInputProofs, withArtifactCountReleaseSnapshot, requireWorkspaceMembership, type LineageRoot } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const DEFAULT_LIST_TAKE = 25;
const MAX_LIST_TAKE = 50;
const LIST_SCAN_PAGE = 100;

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

// The complete scalar row is required to validate the exact saved manifest.
// Extra fields remain server-side and are never passed to the serializer.
const audioAssetProofSelect = { ...audioAssetSelect, uploadedByUserId: true,
  storageKey: true, transcriptText: true, transcriptMetadata: true } as const;

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
  if (file.size > MAX_AUDIO_FILE_BYTES) throw new AppError(413, "AUDIO_TOO_LARGE", "Audio file is too large.");
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
          error: audioAsset.workflowJob.error ? "Audio processing failed." : null,
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
    const authorizedWorkspaceId = workspaceId;
    if (!authorizedWorkspaceId) throw new AppError(400, "INVALID_INPUT", "Workspace is required.");
    if (actor.kind !== "user") throw new AppError(403, "SOURCE_RESTRICTED", "Audio uploads require their human owner.");
    const ownerUserId = actor.user.id;
    await requireWorkspaceMembership({ actor, workspaceId: authorizedWorkspaceId });
    const requestedTake = clampTake(request.nextUrl.searchParams.get("take"));
    const admitted: MeetingAudioAssetSummary[] = [];
    let roots: LineageRoot[] = [];
    const heads = new Map<string, string>();
    let after: { id: string; createdAt: Date } | undefined;
    while (admitted.length < requestedTake) {
      const page = await prisma.meetingAudioAsset.findMany({
        where: { workspaceId: authorizedWorkspaceId, uploadedByUserId: ownerUserId,
          ...(after ? { OR: [{createdAt: {lt: after.createdAt}}, {createdAt: after.createdAt, id: {lt: after.id}}] } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIST_SCAN_PAGE,
        select: audioAssetProofSelect,
      });
      if (!page.length) break;
      if (after && page.some(asset => asset.createdAt > after!.createdAt ||
        (asset.createdAt.getTime() === after!.createdAt.getTime() && asset.id >= after!.id))) {
        throw new AppError(409, "SOURCE_CHANGED", "Audio history changed during pagination.");
      }
      // Batched discovery skips unknown/revoked history cheaply. Selected rows
      // still receive original proofs and fresh final admission before release.
      const readable = await readableArtifactIds(actor, authorizedWorkspaceId, "MeetingAudioAsset", page);
      const candidates = page.filter(asset => readable.has(asset.id));
      const observed = await captureArtifactReadHeadObservation(() => captureReadableDigestInputs({
        actor, workspaceId: authorizedWorkspaceId, kind: "MeetingAudioAsset", records: candidates,
      }));
      for (const [key, stamp] of observed.heads) {
        if (heads.has(key) && heads.get(key) !== stamp) throw new AppError(409, "SOURCE_CHANGED", "Audio source changed during collection.");
        heads.set(key, stamp);
      }
      const selected = observed.value.records.slice(0, requestedTake - admitted.length);
      admitted.push(...selected);
      roots = mergeArtifactInputProofs(roots, ...selected.map(asset => observed.value.proofs.get(asset.id)!));
      after = {id: page[page.length - 1].id, createdAt: page[page.length - 1].createdAt};
      if (page.length < LIST_SCAN_PAGE) break;
    }
    const audioAssets = await withArtifactCountReleaseSnapshot(actor, authorizedWorkspaceId, roots, async () => {}, async tx => {
      const currentMembership = await requireWorkspaceMembership({ actor, workspaceId: authorizedWorkspaceId, tx });
      if (!currentMembership || currentMembership.id === "global-operator" || currentMembership.userId !== ownerUserId) {
        throw new AppError(403, "SOURCE_RESTRICTED", "Audio uploads require their active human owner.");
      }
      return admitted;
    }, heads);

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
    if (actor.kind !== "user") throw new AppError(403, "SOURCE_RESTRICTED", "Audio uploads require their human owner.");
    await requireWorkspaceMembership({ actor, workspaceId });
    const formData = await request.formData();
    const file = requireAudioFile(formData.get("file"));
    const meetingId = formString(formData, "meetingId");
    // Capture form values before the asynchronous file read; the domain layer
    // keeps one isolated storage copy; native capture hashes without another copy.
    const upload = {
      workspaceId,
      fileName: file.name,
      mimeType: file.type || null,
      meetingId,
      title: formString(formData, "title"),
      recordedAt: meetingId ? null : parseRecordedAt(formString(formData, "recordedAt"), true),
      durationSeconds: parseDurationSeconds(formString(formData, "durationSeconds")),
      participantEmails: formStringList(formData, "participantEmails"),
    };
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const result = await createMeetingAudioAsset(actor, {
      ...upload,
      fileBuffer,
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
