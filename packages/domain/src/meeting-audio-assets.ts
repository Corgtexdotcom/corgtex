import { startAudioTranscriptHeartbeat } from "./audio-transcript-heartbeat";
import { MAX_AUDIO_FILE_BYTES } from "./meeting-audio-limits";
export { MAX_AUDIO_FILE_BYTES } from "./meeting-audio-limits";
import { createHash, randomUUID } from "node:crypto";
import type { MeetingAudioAsset, MeetingAudioAssetStatus, MeetingTranscriptSourceProvider, Prisma } from "@prisma/client";
import { defaultModelGateway, type ModelGateway } from "@corgtex/models";
import { defaultStorage, type StorageProvider } from "@corgtex/storage";
import { prisma, toInputJson, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { intakeMeetingTranscript } from "./meeting-transcript-intake";
import { getMeeting } from "./meetings";
import { captureAudioTranscriptIntakeReceipt, captureAudioUploadInput,
  createAudioTranscriptWorkerActor, revokeAudioTranscriptWorkerActor } from "./native-transcript-input";
import { captureArtifactInputProof, isArtifactInputProofReadable, readableArtifactIds, recordArtifactInputLineage,
  withArtifactInputWriteFence,
  type LineageRoot } from "./source-lineage";
import { meetingTranscriptInputProjection } from "./meeting-intelligence-context";

export const MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE = "meeting-audio.transcribe";

const MEETING_AUDIO_SOURCE = "meeting-audio-upload";
const MEETING_AUDIO_TRANSCRIPT_PROVIDER: MeetingTranscriptSourceProvider = "MANUAL_UPLOAD";

type MeetingAudioTranscriber = Pick<ModelGateway, "transcribeAudio">;
type MeetingAudioStorage = Pick<StorageProvider, "put" | "get" | "delete">;

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

type AudioLease = { attempts: number; lockedBy: string; lockedAt: Date };
type AudioWriteAuthority = {
  actor: AppActor; workspaceId: string; audioAssetId: string;
  workflowJobId: string; expectedLease: AudioLease; roots: readonly LineageRoot[];
  heartbeat: ReturnType<typeof startAudioTranscriptHeartbeat>;
};

async function assertAudioWriteAuthority(tx: Prisma.TransactionClient, authority: AudioWriteAuthority) {
  authority.heartbeat.assertActive();
  await tx.$queryRaw`SELECT "id" FROM "WorkflowJob" WHERE "id" = ${authority.workflowJobId}
    AND "workspaceId" = ${authority.workspaceId} FOR SHARE`;
  const job = await tx.workflowJob.findFirst({ where: { id: authority.workflowJobId,
    workspaceId: authority.workspaceId } });
  invariant(job?.type === MEETING_AUDIO_TRANSCRIPTION_JOB_TYPE && job.status === "RUNNING"
    && job.attempts === authority.expectedLease.attempts
    && job.lockedBy === authority.expectedLease.lockedBy
    && job.startedAt && job.lockedAt && job.lockedAt.getTime() > Date.now() - 5 * 60_000
    && (job.payload as { audioAssetId?: string })?.audioAssetId === authority.audioAssetId,
  409, "SOURCE_CHANGED", "Audio transcription lease changed.");
  await tx.$queryRaw`SELECT "id" FROM "MeetingAudioAsset" WHERE "id" = ${authority.audioAssetId}
    AND "workspaceId" = ${authority.workspaceId} FOR UPDATE`;
  invariant(await isArtifactInputProofReadable(authority.actor, authority.workspaceId, authority.roots, tx),
    409, "SOURCE_CHANGED", "Audio source authorization changed.");
  authority.heartbeat.assertActive();
}

async function authorizedAudioUpdate(authority: AudioWriteAuthority, data: Prisma.MeetingAudioAssetUncheckedUpdateInput,
  inputs: Array<{ kind: "MeetingTranscript"; id: string }> = []) {
  return prisma.$transaction(async tx => {
    await assertAudioWriteAuthority(tx, authority);
    const updated = await tx.meetingAudioAsset.update({ where: { id: authority.audioAssetId }, data });
    await recordArtifactInputLineage({ tx, actor: authority.actor, workspaceId: authority.workspaceId,
      artifact: { kind: "MeetingAudioAsset", id: updated.id }, content: updated,
      origin: "DERIVED", inputs, inheritedRoots: [...authority.roots] });
    return updated;
  });
}

async function markAudioAssetFailed(params: {
  audioAssetId: string;
  workflowJobId?: string | null;
  authority: AudioWriteAuthority;
  code: string;
  message: string;
}) {
  return authorizedAudioUpdate(params.authority, {
      status: "FAILED",
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: params.code,
      failureMessage: params.message,
  });
}

/** Consume a dedicated upload backing store before the first await, detaching
 * retained aliases. Pooled, sliced, shared or nontransferable bytes need one copy. */
function takeAudioUploadBytes(source: Buffer): Buffer {
  if (source.buffer instanceof ArrayBuffer && source.byteOffset === 0 && source.byteLength === source.buffer.byteLength) {
    try {
      return Buffer.from(structuredClone(source.buffer, { transfer: [source.buffer] }));
    } catch {
      // Node marks pooled/untransferable backing stores as nontransferable.
    }
  }
  return Buffer.from(source);
}

export async function createMeetingAudioAsset(actor: AppActor, params: {
  workspaceId: string;
  fileName: string;
  mimeType?: string | null;
  /** Dedicated backing stores are consumed; callers must relinquish these bytes. */
  fileBuffer: Buffer;
  meetingId?: string | null;
  title?: string | null;
  recordedAt?: Date | null;
  durationSeconds?: number | null;
  participantEmails?: string[] | null;
  storage?: MeetingAudioStorage;
}) {
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "Audio upload requires a human workspace member.");
  const originalUserId = actor.user.id;
  invariant(params.fileBuffer.byteLength > 0, 400, "INVALID_INPUT", "Audio file is required.");
  invariant(params.fileBuffer.byteLength <= MAX_AUDIO_FILE_BYTES, 413, "AUDIO_TOO_LARGE", "Audio file is too large.");
  params = { ...params, fileBuffer: takeAudioUploadBytes(params.fileBuffer),
    recordedAt: params.recordedAt ? new Date(params.recordedAt) : null,
    participantEmails: params.participantEmails ? [...params.participantEmails] : null };
  const originalFileHash = createHash("sha256").update(params.fileBuffer).digest("hex");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  invariant(actor.kind === "user" && actor.user.id === originalUserId, 409, "SOURCE_CHANGED", "Audio uploader changed.");
  if (params.recordedAt) {
    invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  }

  if (params.meetingId) {
    const meeting = await getMeeting(actor, params.workspaceId, params.meetingId);
    invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");
  }
  invariant(actor.kind === "user" && actor.user.id === originalUserId,
    409, "SOURCE_CHANGED", "Audio uploader changed.");

  const storage = params.storage ?? defaultStorage;
  const storageKey = audioStorageKey(params.workspaceId, params.fileName);
  let stored = false;
  try {
    await storage.put(storageKey, params.fileBuffer, {
      contentType: params.mimeType ?? undefined,
    });
    stored = true;
    invariant(actor.kind === "user" && actor.user.id === originalUserId,
      409, "SOURCE_CHANGED", "Audio uploader changed.");

    return await prisma.$transaction(async (tx) => {
      const audioAsset = await tx.meetingAudioAsset.create({
        data: {
          workspaceId: params.workspaceId,
          meetingId: params.meetingId ?? null,
          uploadedByUserId: originalUserId,
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

      const nativeInput = await captureAudioUploadInput(actor, { workspaceId: params.workspaceId, asset: audioAsset,
        fileBuffer: params.fileBuffer, tx });
      invariant(nativeInput.input.fileHash === originalFileHash, 409, "SOURCE_CHANGED", "Audio bytes changed during storage.");

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

      const queuedAsset = await tx.meetingAudioAsset.update({
        where: { id: audioAsset.id }, data: { workflowJobId: job.id },
      });

      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "MeetingAudioAsset", id: audioAsset.id }, content: queuedAsset,
        origin: "DERIVED", inputs: [], inheritedRoots: nativeInput.roots });

      await tx.auditLog.create({
        data: {
          workspaceId: params.workspaceId,
          actorUserId: originalUserId,
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

      return { audioAsset: queuedAsset, workflowJobId: job.id };
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
  expectedLease: AudioLease;
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

  invariant(params.workflowJobId, 409, "SOURCE_RESTRICTED", "Audio transcription needs its exact leased job.");
  const worker = await createAudioTranscriptWorkerActor({ workspaceId: audioAsset.workspaceId,
    audioAssetId: audioAsset.id, workflowJobId: params.workflowJobId, expectedLease: params.expectedLease });
  const heartbeat = startAudioTranscriptHeartbeat(worker.renewLease);
  const authority: AudioWriteAuthority = { actor: worker.actor, workspaceId: worker.asset.workspaceId,
    audioAssetId: worker.asset.id, workflowJobId: params.workflowJobId,
    expectedLease: params.expectedLease, roots: worker.roots, heartbeat };
  try {
      if (worker.asset.status === "INGESTED") {
        invariant((await readableArtifactIds(worker.actor, worker.asset.workspaceId,
          "MeetingAudioAsset", [worker.asset])).has(worker.asset.id),
        409, "UNKNOWN_LINEAGE", "Completed audio has no current receipt.");
        return { status: "skipped" as const, reason: "already_ingested", meetingId: worker.asset.intakeMeetingId };
      }
      const transcript = await ensureAudioAssetTranscript(worker.asset, {
        workflowJobId: params.workflowJobId,
        storage: params.storage ?? defaultStorage,
        transcriber: params.transcriber ?? defaultModelGateway,
        actor: worker.actor, roots: worker.roots, sourceInputId: worker.input.id,
        fileHash: worker.input.fileHash!,
        authority,
      });
      const recoveredMeetingId = await recoverCompletedAudioIntake(worker.actor,
        worker.asset, worker.input.id, transcript, authority);
      if (recoveredMeetingId) return { status: "ingested" as const, meetingId: recoveredMeetingId };
      const submission = {
        workspaceId: worker.asset.workspaceId,
        meetingId: worker.asset.meetingId,
        fileName: worker.asset.fileName,
        title: worker.asset.title,
        recordedAt: worker.asset.recordedAt,
        participantEmails: worker.asset.participantEmails,
        transcript,
        source: MEETING_AUDIO_SOURCE,
        provider: MEETING_AUDIO_TRANSCRIPT_PROVIDER,
        externalId: `meeting-audio:${worker.asset.id}`,
      };
      const nativeReceipt = await captureAudioTranscriptIntakeReceipt(worker.actor,
        worker.asset.workspaceId, submission, worker.input.id, worker.roots);
      const result = await withArtifactInputWriteFence(tx => assertAudioWriteAuthority(tx, authority),
        () => intakeMeetingTranscript(worker.actor, { ...submission, nativeReceipt }));

      if (result.status === "needs_clarification") {
        await markAudioAssetFailed({
          audioAssetId: audioAsset.id,
          workflowJobId: params.workflowJobId,
          authority,
          code: "INTAKE_NEEDS_CLARIFICATION",
          message: "Meeting transcript needs clarification.",
        });
        return { status: "needs_clarification" as const, requiredFields: result.requiredFields };
      }

      await prisma.$transaction(async tx => {
        await assertAudioWriteAuthority(tx, authority);
        const updated = await tx.meetingAudioAsset.update({ where: { id: audioAsset.id }, data: {
        status: "INGESTED",
        intakeMeetingId: result.meeting.id,
        workflowJobId: params.workflowJobId ?? undefined,
        failureCode: null,
        failureMessage: null,
        ingestedAt: new Date(),
        } });
        await recordArtifactInputLineage({ tx, actor: worker.actor, workspaceId: audioAsset.workspaceId,
          artifact: { kind: "MeetingAudioAsset", id: audioAsset.id }, content: updated,
          origin: "DERIVED", inputs: [{ kind: "MeetingTranscript", id: result.meeting.id }],
          inheritedRoots: [...worker.roots] });
        await tx.auditLog.create({ data: {
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
        } });
      });

      return { status: "ingested" as const, meetingId: result.meeting.id };
  } catch (error) {
    // A stale cached model output must keep its old, unreadable receipt. A
    // failure transition carrying today's root would certify those old bytes.
    if (!(error instanceof AppError && ["SOURCE_CHANGED", "UNKNOWN_LINEAGE", "PERMISSION_CHANGED"].includes(error.code))) {
      await markAudioAssetFailed({ audioAssetId: audioAsset.id, workflowJobId: params.workflowJobId,
        authority, code: error instanceof AppError ? error.code : "TRANSCRIPTION_FAILED",
        message: "Audio transcription failed." }).catch(() => undefined);
    }
    throw error;
  } finally {
    try { await heartbeat.stop(); } finally { revokeAudioTranscriptWorkerActor(worker.actor); }
  }
}

/** A crashed worker can finish only a previously committed transcript whose
 * current receipt still contains this exact audio original. */
async function recoverCompletedAudioIntake(actor: AppActor, asset: MeetingAudioAsset,
  inputId: string, transcript: string, authority: AudioWriteAuthority) {
  return prisma.$transaction(async tx => {
    await assertAudioWriteAuthority(tx, authority);
    const currentAsset = await tx.meetingAudioAsset.findFirst({ where: { id: asset.id, workspaceId: asset.workspaceId } });
    if (!currentAsset || currentAsset.status === "INGESTED") return currentAsset?.intakeMeetingId ?? null;
    const meeting = await tx.meeting.findFirst({ where: { workspaceId: asset.workspaceId, archivedAt: null,
      OR: [
        ...(asset.meetingId ? [{ id: asset.meetingId }] : []),
        { externalId: `workspace:${asset.workspaceId}:meeting-audio:${asset.id}` },
      ] } });
    if (!meeting || meeting.transcript?.trim() !== transcript) return null;
    const roots = await captureArtifactInputProof(actor, asset.workspaceId,
      [{ kind: "MeetingTranscript", id: meeting.id, snapshot: meetingTranscriptInputProjection(meeting) }], tx)
      .catch(() => []);
    if (!roots.some(root => root.kind === "NativeTranscriptInput" && root.id === inputId)) return null;
    const updated = await tx.meetingAudioAsset.update({ where: { id: asset.id }, data: {
      status: "INGESTED", intakeMeetingId: meeting.id, failureCode: null,
      failureMessage: null, ingestedAt: new Date(),
    } });
    await recordArtifactInputLineage({ tx, actor, workspaceId: asset.workspaceId,
      artifact: { kind: "MeetingAudioAsset", id: asset.id }, content: updated,
      origin: "DERIVED", inputs: [{ kind: "MeetingTranscript", id: meeting.id }],
      inheritedRoots: [...authority.roots] });
    return meeting.id;
  });
}

async function ensureAudioAssetTranscript(
  audioAsset: MeetingAudioAsset,
  params: {
    workflowJobId?: string | null;
    storage: Pick<StorageProvider, "get">;
    transcriber: MeetingAudioTranscriber;
    actor: AppActor;
    roots: readonly LineageRoot[];
    sourceInputId: string;
    fileHash: string;
    authority: AudioWriteAuthority;
  },
) {
  if (audioAsset.transcriptText?.trim()) {
    invariant((await readableArtifactIds(params.actor, audioAsset.workspaceId,
      "MeetingAudioAsset", [audioAsset])).has(audioAsset.id),
    409, "UNKNOWN_LINEAGE", "Cached audio transcription has no current artifact receipt.");
    const metadata = audioAsset.transcriptMetadata && typeof audioAsset.transcriptMetadata === "object"
      && !Array.isArray(audioAsset.transcriptMetadata) ? audioAsset.transcriptMetadata : null;
    const preModelRoots = metadata && Array.isArray(metadata.preModelRoots)
      ? metadata.preModelRoots as LineageRoot[] : null;
    invariant(metadata && preModelRoots?.length
      && preModelRoots.every(root => root && root.kind === "NativeTranscriptInput"
        && root.id === params.sourceInputId && /^[a-f0-9]{64}$/.test(root.fingerprint)
        && root.permissionEpochs != null)
      && preModelRoots.some(root => params.roots.some(current => current.id === root.id
        && current.fingerprint === root.fingerprint))
      && metadata.nativeTranscriptInputId === params.sourceInputId
      && metadata.audioFileHash === params.fileHash
      && metadata.transcriptHash === createHash("sha256").update(audioAsset.transcriptText).digest("hex")
      && await isArtifactInputProofReadable(params.actor, audioAsset.workspaceId, preModelRoots)
      && await isArtifactInputProofReadable(params.actor, audioAsset.workspaceId, params.roots),
    409, "UNKNOWN_LINEAGE", "Cached audio transcription has no matching source proof.");
    return audioAsset.transcriptText.trim();
  }

  await authorizedAudioUpdate(params.authority, {
      status: "TRANSCRIBING" satisfies MeetingAudioAssetStatus,
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: null,
      failureMessage: null,
  });

  const storedAudio = await params.storage.get(audioAsset.storageKey, { maxBytes: audioAsset.sizeBytes });
  if (!storedAudio) {
    throw new AppError(404, "AUDIO_NOT_FOUND", "Stored meeting audio could not be read.");
  }
  const storageTypeMatches = (storedAudio.contentType ?? null) === (audioAsset.mimeType ?? null)
    || (audioAsset.mimeType == null && storedAudio.contentType === "application/octet-stream");
  invariant(storedAudio.data.byteLength === audioAsset.sizeBytes
    && storageTypeMatches
    && createHash("sha256").update(storedAudio.data).digest("hex") === params.fileHash
    && await isArtifactInputProofReadable(params.actor, audioAsset.workspaceId, params.roots),
  409, "SOURCE_CHANGED", "Stored audio or source authorization changed before transcription.");

  params.authority.heartbeat.assertActive();
  const response = await params.transcriber.transcribeAudio({
    workspaceId: audioAsset.workspaceId,
    workflowJobId: params.workflowJobId ?? undefined,
    fileName: audioAsset.fileName,
    mimeType: audioAsset.mimeType,
    data: storedAudio.data,
    prompt: audioAsset.title ? `Meeting title: ${audioAsset.title}` : null,
    authorizeAttempt: params.authority.heartbeat.authorizeAttempt,
    signal: params.authority.heartbeat.signal,
  });
  params.authority.heartbeat.assertActive();
  const transcript = response.text.trim();
  invariant(transcript.length > 0, 422, "EMPTY_TRANSCRIPT", "Audio transcription returned no text.");
  invariant(await isArtifactInputProofReadable(params.actor, audioAsset.workspaceId, params.roots),
    409, "SOURCE_CHANGED", "Audio source authorization changed during transcription.");

  await authorizedAudioUpdate(params.authority, {
      status: "TRANSCRIBED",
      transcriptText: transcript,
      transcriptProvider: response.usage.provider,
      transcriptModel: response.usage.model,
      transcriptMetadata: toInputJson({
        nativeTranscriptInputId: params.sourceInputId,
        audioFileHash: params.fileHash,
        transcriptHash: createHash("sha256").update(transcript).digest("hex"),
        preModelRoots: params.roots,
        outputTokens: response.usage.outputTokens,
        latencyMs: response.usage.latencyMs,
      }),
      workflowJobId: params.workflowJobId ?? undefined,
      failureCode: null,
      failureMessage: null,
      transcribedAt: new Date(),
  });

  return transcript;
}
