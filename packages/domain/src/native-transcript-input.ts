import { MAX_AUDIO_FILE_BYTES } from "./meeting-audio-limits";
import { withCompanyTranscriptPublication, type CompanyTranscriptPublicationHooks } from "./native-transcript-publication-context";
import { nativeTranscriptCanonicalPayload, nativeTranscriptPayloadHash } from "./native-transcript-payload";
export { nativeTranscriptPayloadHash } from "./native-transcript-payload";
import { capturePermissionEpochs, type PermissionEpochProof } from "./source-permission-epochs";
import { createHash } from "node:crypto";
import type { MeetingAudioAsset, Prisma, WorkflowJob } from "@prisma/client";
import { decryptSecret, encryptSecret, prisma, type AppActor } from "@corgtex/shared";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { captureArtifactInputProof, isArtifactInputProofReadable, lineageContentFingerprint, type LineageRoot } from "./source-lineage";
import { getAudioTranscriptWorkerPurpose, nativeTranscriptPrincipalUserId, registerAudioTranscriptWorker,
  revokeAudioTranscriptWorker } from "./native-transcript-principal";

type AuthorityDb = Prisma.TransactionClient | typeof prisma;
type NativeTranscriptInputRecord = {
  workspaceId: string;
  mode: string;
  ownerMemberId: string | null;
  submittedByUserId: string | null;
  recordingId: string | null;
  recorderAttemptId?: string | null;
  recorderMeetingId?: string | null;
  recorderBindingId?: string | null;
  recorderProvider?: string | null;
  meetingAudioAssetId: string | null;
  sourceRecordId: string | null;
  connectionId: string | null;
  encryptedPayloadJson: string;
  payloadHash: string;
  fileHash: string | null;
  storageKey: string | null;
  fileSizeBytes: number | null;
  mimeType: string | null;
  grantHash: string | null;
};

/** The marker has no serialized authority. Only captureDirectMemberTranscriptInput
 * can register one for the same actor object and exact request body. */
export type DirectMemberTranscriptReceipt = Readonly<{ inputId: string }>;
export type AudioTranscriptIntakeReceipt = Readonly<{ inputId: string }>;
const directReceipts = new WeakMap<DirectMemberTranscriptReceipt, {
  actor: AppActor;
  workspaceId: string;
  payloadHash: string;
  roots: readonly LineageRoot[];
  company: boolean;
  hooks?: CompanyTranscriptPublicationHooks;
  callerEpochs: PermissionEpochProof | null;
}>();
const audioReceipts = new WeakMap<AudioTranscriptIntakeReceipt, {
  actor: AppActor; workspaceId: string; payloadHash: string; roots: readonly LineageRoot[];
}>();

function audioUploadPayload(asset: MeetingAudioAsset, fileHash: string) {
  return { audioAssetId: asset.id, workspaceId: asset.workspaceId, uploadedByUserId: asset.uploadedByUserId,
    meetingId: asset.meetingId, fileName: asset.fileName, mimeType: asset.mimeType,
    storageKey: asset.storageKey, fileSizeBytes: asset.sizeBytes, fileHash,
    durationSeconds: asset.durationSeconds, title: asset.title,
    recordedAt: asset.recordedAt?.toISOString() ?? null, participantEmails: asset.participantEmails };
}

function audioAssetBindingHash(input: { workspaceId: string; meetingAudioAssetId: string | null;
  ownerMemberId: string; submittedByUserId: string; fileHash: string | null; storageKey: string | null }) {
  return nativeTranscriptPayloadHash(input);
}

function audioJobLeaseHash(job: WorkflowJob) {
  return nativeTranscriptPayloadHash({ id: job.id, workspaceId: job.workspaceId, type: job.type,
    payload: job.payload, status: job.status, attempts: job.attempts,
    lockedBy: job.lockedBy, lockedAt: job.lockedAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null });
}

/** This is an authenticated direct user submission, never a model tool argument.
 * The adapter must pass the complete raw request, including raw file bytes when
 * a file was uploaded, before extraction or any metadata model call. */
async function captureMemberTranscriptInput(actor: AppActor, params: {
  workspaceId: string;
  submission: Record<string, unknown>;
}, company: boolean) {
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "A direct transcript upload requires a human member.");
  const workspaceId = params.workspaceId;
  const userId = actor.user.id;
  invariant(params.submission && typeof params.submission === "object" && !Array.isArray(params.submission),
    400, "INVALID_INPUT", "Transcript submission is invalid.");
  const submission = structuredClone(params.submission);
  invariant(submission.workspaceId === workspaceId, 409, "UNKNOWN_LINEAGE", "Transcript workspace does not match the authenticated request.");
  invariant(!submission.provider && !submission.sourceRecordId && !submission.batchId
    && !submission.allowTranscriptAppend && !submission.replaceTranscript,
  409, "UNKNOWN_LINEAGE", "Provider or copied content cannot become a direct member upload.");
  const fileName = submission.fileName;
  const rawFileBase64 = submission.rawFileBase64;
  if (fileName != null || rawFileBase64 != null) {
    invariant(typeof fileName === "string" && fileName.length > 0 && typeof rawFileBase64 === "string"
      && rawFileBase64.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(rawFileBase64),
    409, "UNKNOWN_LINEAGE", "A transcript file requires its exact original bytes.");
    const bytes = Buffer.from(rawFileBase64, "base64");
    invariant(bytes.byteLength > 0 && bytes.byteLength <= 5 * 1024 * 1024
      && bytes.toString("base64") === rawFileBase64, 413, "TRANSCRIPT_TOO_LARGE", "Transcript file is invalid or too large.");
    const { extractTextFromFileBuffer } = await import("@corgtex/knowledge");
    const extracted = await extractTextFromFileBuffer({ fileBuffer: bytes, fileName,
      mimeType: typeof submission.rawFileMimeType === "string" ? submission.rawFileMimeType : "application/octet-stream",
      maxExtractBytes: 5 * 1024 * 1024, maxTextLength: 1_000_001 });
    invariant(!extracted.truncated && typeof submission.transcript === "string"
      && extracted.textContent?.trim() === submission.transcript.trim(),
    409, "SOURCE_CHANGED", "Transcript text does not match the uploaded file.");
  }
  const plaintext = nativeTranscriptCanonicalPayload(submission);
  invariant(plaintext.length <= 20 * 1024 * 1024, 413, "TRANSCRIPT_TOO_LARGE", "Transcript submission is too large.");
  const payloadHash = nativeTranscriptPayloadHash(submission);
  invariant(actor.kind === "user" && actor.user.id === userId, 409, "SOURCE_CHANGED", "Transcript uploader changed.");
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR SHARE`;
    await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "workspaceId" = ${workspaceId} AND "userId" = ${userId} FOR SHARE`;
    invariant(actor.kind === "user" && actor.user.id === userId, 409, "SOURCE_CHANGED", "Transcript uploader changed.");
    const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
    invariant(membership && membership.id !== "global-operator" && membership.userId === userId,
      403, "SOURCE_RESTRICTED", "A direct transcript upload requires an active member.");
    const callerEpochs = company ? await capturePermissionEpochs(tx, workspaceId, [
      { kind: "Member", id: membership.id }, { kind: "MemberRolePolicy", id: membership.id }, { kind: "MemberUserPolicy", id: userId }, { kind: "WorkspaceSupportPolicy", id: userId },
    ]) : null;
    const input = await tx.nativeTranscriptInput.create({ data: {
      workspaceId,
      mode: company ? "COMPANY_MEMBER_UPLOAD" : "DIRECT_MEMBER_UPLOAD",
      ownerMemberId: membership.id,
      submittedByUserId: userId,
      mimeType: typeof submission.rawFileMimeType === "string" ? submission.rawFileMimeType : null,
      encryptedPayloadJson: encryptSecret(plaintext),
      payloadHash,
    } });
    const capture = () => captureArtifactInputProof(actor, workspaceId,
      [{ kind: "NativeTranscriptInput", id: input.id, snapshot: input }], tx);
    const roots = company && callerEpochs ? await withCompanyTranscriptPublication({
      actor, workspaceId, inputId: input.id, fingerprint: lineageContentFingerprint("NativeTranscriptInput", input), roots: [], callerEpochs,
    }, capture) : await capture();
    return { input, roots, callerEpochs };
  });
  const receipt: DirectMemberTranscriptReceipt = Object.freeze({ inputId: result.input.id });
  directReceipts.set(receipt, { actor, workspaceId, payloadHash, company, callerEpochs: result.callerEpochs,
    roots: Object.freeze(result.roots.map(root => Object.freeze({ ...root }))) });
  return receipt;
}

export function captureDirectMemberTranscriptInput(actor: AppActor, params: { workspaceId: string; submission: Record<string, unknown> }) {
  return captureMemberTranscriptInput(actor, params, false);
}
/** Standalone Meetings upload adapter only; existing private receipts stay private. */
export function captureCompanyMemberTranscriptInput(actor: AppActor, params: { workspaceId: string; submission: Record<string, unknown> }) {
  return captureMemberTranscriptInput(actor, params, true);
}
/** Internal adapter-only transaction hooks; receipt identity is never serializable. */
export function bindCompanyTranscriptPublicationHooks(actor: AppActor, receipt: DirectMemberTranscriptReceipt, hooks: CompanyTranscriptPublicationHooks) {
  const captured = directReceipts.get(receipt);
  invariant(captured?.company && captured.actor === actor && !captured.hooks, 409, "UNKNOWN_LINEAGE", "Manual import requires its exact new member receipt.");
  captured.hooks = hooks;
}
export async function withMemberTranscriptReceipt<T>(actor: AppActor, workspaceId: string, submission: Record<string, unknown>, receipt: DirectMemberTranscriptReceipt | undefined, work: () => Promise<T>) {
  const captured = receipt && directReceipts.get(receipt);
  if (!captured?.company) return work();
  invariant(captured.callerEpochs && captured.actor === actor && captured.workspaceId === workspaceId && captured.payloadHash === nativeTranscriptPayloadHash(submission),
    409, "UNKNOWN_LINEAGE", "Transcript submission has no exact authenticated upload receipt.");
  const root = captured.roots.find(item => item.kind === "NativeTranscriptInput" && item.id === receipt!.inputId)!;
  return withCompanyTranscriptPublication({ actor, workspaceId,
    inputId: receipt!.inputId, fingerprint: root.fingerprint!, roots: captured.roots, hooks: captured.hooks, callerEpochs: captured.callerEpochs }, work);
}

export async function directMemberTranscriptRoots(actor: AppActor, workspaceId: string,
  submission: Record<string, unknown>, receipt: DirectMemberTranscriptReceipt | null | undefined) {
  const captured = receipt && directReceipts.get(receipt);
  invariant(captured && captured.actor === actor && captured.workspaceId === workspaceId
    && captured.payloadHash === nativeTranscriptPayloadHash(submission),
  409, "UNKNOWN_LINEAGE", "Transcript submission has no exact authenticated upload receipt.");
  invariant(await isArtifactInputProofReadable(actor, workspaceId, captured.roots),
    409, "SOURCE_CHANGED", "Transcript upload authority changed.");
  return captured.roots.map(root => ({ ...root }));
}

/** Persist the exact immutable audio input alongside its asset and queued job. */
export async function captureAudioUploadInput(actor: AppActor, params: {
  workspaceId: string; asset: MeetingAudioAsset; fileBuffer: Buffer; tx: Prisma.TransactionClient;
}) {
  const workspaceId = params.workspaceId;
  const asset = structuredClone(params.asset);
  const fileSizeBytes = params.fileBuffer.byteLength;
  invariant(fileSizeBytes > 0, 400, "INVALID_INPUT", "Audio file is required.");
  invariant(fileSizeBytes <= MAX_AUDIO_FILE_BYTES, 413, "AUDIO_TOO_LARGE", "Audio file is too large.");
  // Seal before the first await. The upload owner already holds its isolated
  // storage copy; hashing synchronously avoids a second full audio allocation.
  const fileHash = createHash("sha256").update(params.fileBuffer).digest("hex");
  const tx = params.tx;
  const userId = actor.kind === "user" ? actor.user.id : null;
  invariant(userId && asset.workspaceId === workspaceId
    && asset.uploadedByUserId === userId && asset.sizeBytes === fileSizeBytes,
  403, "SOURCE_RESTRICTED", "Audio upload requires its active human owner and exact bytes.");
  const membership = await requireWorkspaceMembership({ actor, workspaceId, tx });
  invariant(actor.kind === "user" && actor.user.id === userId
    && membership && membership.id !== "global-operator" && membership.userId === userId,
    403, "SOURCE_RESTRICTED", "Audio upload requires an active member.");
  const payload = audioUploadPayload(asset, fileHash);
  const binding = { workspaceId, meetingAudioAssetId: asset.id,
    ownerMemberId: membership.id, submittedByUserId: userId,
    fileHash, storageKey: asset.storageKey };
  const input = await tx.nativeTranscriptInput.create({ data: {
    workspaceId, mode: "AUDIO_UPLOAD", ownerMemberId: membership.id,
    submittedByUserId: userId, meetingAudioAssetId: asset.id,
    encryptedPayloadJson: encryptSecret(nativeTranscriptCanonicalPayload(payload)), payloadHash: nativeTranscriptPayloadHash(payload),
    fileHash, storageKey: asset.storageKey, fileSizeBytes,
    mimeType: asset.mimeType,
    grantHash: audioAssetBindingHash(binding),
  } });
  const roots = await captureArtifactInputProof(actor, workspaceId,
    [{ kind: "NativeTranscriptInput", id: input.id, snapshot: input }], tx);
  return { input, roots };
}

/** Mint only from the exact active leased job; caller revokes after processing. */
export async function createAudioTranscriptWorkerActor(params: {
  workspaceId: string; audioAssetId: string; workflowJobId: string;
  expectedLease: { attempts: number; lockedBy: string; lockedAt: Date };
}) {
  const [asset, input, job] = await Promise.all([
    prisma.meetingAudioAsset.findFirst({ where: { id: params.audioAssetId, workspaceId: params.workspaceId } }),
    prisma.nativeTranscriptInput.findFirst({ where: { workspaceId: params.workspaceId,
      mode: "AUDIO_UPLOAD", meetingAudioAssetId: params.audioAssetId } }),
    prisma.workflowJob.findFirst({ where: { id: params.workflowJobId, workspaceId: params.workspaceId } }),
  ]);
  invariant(asset && input && job && job.type === "meeting-audio.transcribe" && job.status === "RUNNING"
    && job.lockedAt && job.lockedBy && job.attempts === params.expectedLease.attempts
    && job.lockedBy === params.expectedLease.lockedBy
    && job.lockedAt.getTime() === params.expectedLease.lockedAt.getTime()
    && (job.payload as { audioAssetId?: string })?.audioAssetId === asset.id,
  409, "SOURCE_RESTRICTED", "Audio transcription requires its active leased job and source.");
  const actor: AppActor = Object.freeze({ kind: "agent", authProvider: "bootstrap", label: "meeting-audio-transcription-worker",
    workspaceIds: Object.freeze([params.workspaceId]) as unknown as string[], scopes: Object.freeze(["meetings:write"]) as unknown as string[] });
  invariant(input.ownerMemberId && input.submittedByUserId, 409, "SOURCE_CHANGED", "Audio input has no human owner.");
  registerAudioTranscriptWorker(actor, { workspaceId: params.workspaceId, audioAssetId: asset.id,
    workflowJobId: job.id, ownerMemberId: input.ownerMemberId, uploadedByUserId: input.submittedByUserId,
    assetBindingHash: String(input.grantHash ?? ""), jobLeaseHash: audioJobLeaseHash(job) });
  try {
    const roots = await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "NativeTranscriptInput", id: input.id, snapshot: input }]);
    return { actor, asset, input, roots };
  } catch (error) { revokeAudioTranscriptWorker(actor); throw error; }
}

export function revokeAudioTranscriptWorkerActor(actor: AppActor) { revokeAudioTranscriptWorker(actor); }

export async function captureAudioTranscriptIntakeReceipt(actor: AppActor, workspaceId: string,
  submission: Record<string, unknown>, inputId: string, roots: readonly LineageRoot[]) {
  invariant(getAudioTranscriptWorkerPurpose(actor, workspaceId)?.audioAssetId
    && roots.some(root => root.kind === "NativeTranscriptInput" && root.id === inputId)
    && await isArtifactInputProofReadable(actor, workspaceId, roots),
  409, "SOURCE_CHANGED", "Audio transcript source authority changed.");
  const receipt: AudioTranscriptIntakeReceipt = Object.freeze({ inputId });
  audioReceipts.set(receipt, { actor, workspaceId, payloadHash: nativeTranscriptPayloadHash(submission),
    roots: Object.freeze(roots.map(root => Object.freeze({ ...root }))) });
  return receipt;
}

export async function audioTranscriptIntakeRoots(actor: AppActor, workspaceId: string,
  submission: Record<string, unknown>, receipt: AudioTranscriptIntakeReceipt | null | undefined) {
  const captured = receipt && audioReceipts.get(receipt);
  invariant(captured && captured.actor === actor && captured.workspaceId === workspaceId
    && captured.payloadHash === nativeTranscriptPayloadHash(submission),
  409, "UNKNOWN_LINEAGE", "Audio transcript has no exact source receipt.");
  invariant(await isArtifactInputProofReadable(actor, workspaceId, captured.roots),
    409, "SOURCE_CHANGED", "Audio transcript source authority changed.");
  return captured.roots.map(root => ({ ...root }));
}

/** Called by the source-lineage root gate on every read, including nested roots. */
export async function isNativeTranscriptInputCurrent(actor: AppActor, workspaceId: string,
  input: NativeTranscriptInputRecord, db: AuthorityDb = prisma) {
  try {
    const payload = JSON.parse(decryptSecret(input.encryptedPayloadJson)) as Record<string, unknown>;
    if (input.workspaceId !== workspaceId || !/^[a-f0-9]{64}$/.test(input.payloadHash)
      || !payload || Array.isArray(payload) || typeof payload !== "object"
      || nativeTranscriptPayloadHash(payload) !== input.payloadHash) return false;
    if (input.mode === "COMPANY_MEMBER_UPLOAD") {
      return (await import("./native-transcript-publication")).isCompanyTranscriptInputCurrent(actor, workspaceId, input as import("@prisma/client").NativeTranscriptInput, db);
    }
    if (input.mode === "PROVIDER_IMPORT") {
      const { isProviderTranscriptInputCurrent } = await import("./transcript-source-native-input");
      return isProviderTranscriptInputCurrent(actor, workspaceId, input as import("@prisma/client").NativeTranscriptInput, db);
    }
    if (input.mode === "RECORDER") {
      const { isRecorderTranscriptInputCurrent } = await import("./recorder-transcript-input");
      return isRecorderTranscriptInputCurrent(actor, workspaceId, input, payload, db);
    }
    if (!input.ownerMemberId || !input.submittedByUserId) return false;
    const principalUserId = nativeTranscriptPrincipalUserId(actor, workspaceId);
    if (!principalUserId || principalUserId !== input.submittedByUserId) return false;
    const member = await db.member.findFirst({ where: { id: input.ownerMemberId,
      workspaceId, userId: principalUserId, isActive: true }, select: { id: true } });
    if (!member) return false;
    if (input.mode === "DIRECT_MEMBER_UPLOAD") return actor.kind === "user"
      && input.meetingAudioAssetId == null && input.sourceRecordId == null
      && input.connectionId == null && input.recordingId == null && input.storageKey == null
      && input.fileHash == null && input.fileSizeBytes == null && input.grantHash == null
      && input.mimeType === (typeof payload.rawFileMimeType === "string" ? payload.rawFileMimeType : null);
    if (input.mode === "AUDIO_UPLOAD") {
      if (!input.meetingAudioAssetId || !input.fileHash || !input.storageKey || !input.fileSizeBytes
        || !input.grantHash || input.sourceRecordId || input.connectionId || input.recordingId) return false;
      const asset = await db.meetingAudioAsset.findFirst({ where: { id: input.meetingAudioAssetId, workspaceId } });
      if (!asset || asset.uploadedByUserId !== input.submittedByUserId || asset.storageKey !== input.storageKey
        || asset.sizeBytes !== input.fileSizeBytes || asset.mimeType !== input.mimeType
        || nativeTranscriptPayloadHash(audioUploadPayload(asset, input.fileHash)) !== input.payloadHash
        || audioAssetBindingHash({ workspaceId, meetingAudioAssetId: asset.id,
          ownerMemberId: input.ownerMemberId, submittedByUserId: input.submittedByUserId,
          fileHash: input.fileHash, storageKey: input.storageKey }) !== input.grantHash) return false;
      if (actor.kind === "user") return true;
      const purpose = getAudioTranscriptWorkerPurpose(actor, workspaceId);
      if (!purpose || purpose.audioAssetId !== asset.id || purpose.ownerMemberId !== input.ownerMemberId
        || purpose.assetBindingHash !== input.grantHash) return false;
      const job = await db.workflowJob.findFirst({ where: { id: purpose.workflowJobId, workspaceId } });
      const supportGrant = await db.workspaceSupportGrant.findUnique({ where: {
        workspaceId_userId: { workspaceId, userId: input.submittedByUserId } }, select: { role: true, isActive: true } });
      return Boolean(job && job.type === "meeting-audio.transcribe" && job.status === "RUNNING"
        && job.lockedAt && job.lockedBy && (job.payload as { audioAssetId?: string })?.audioAssetId === asset.id
        && audioJobLeaseHash(job) === purpose.jobLeaseHash
        && (!supportGrant || (supportGrant.isActive && supportGrant.role === "FULL")));
    }
    // Provider and recorder modes remain unavailable until their exact source
    // fetch/signature and current connection/recording lease adapters land.
    return false;
  } catch { return false; }
}
