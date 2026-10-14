import type { AppActor } from "@corgtex/shared";

/** Process-local authority for one verified audio transcription job. A copied
 * actor object or user-controlled label does not carry this purpose. */
export type AudioTranscriptWorkerPurpose = Readonly<{
  workspaceId: string;
  audioAssetId: string;
  workflowJobId: string;
  ownerMemberId: string;
  uploadedByUserId: string;
  assetBindingHash: string;
  jobLeaseHash: string;
}>;

const audioWorkers = new WeakMap<AppActor, AudioTranscriptWorkerPurpose>();

export function registerAudioTranscriptWorker(actor: AppActor, purpose: AudioTranscriptWorkerPurpose) {
  audioWorkers.set(actor, Object.freeze({ ...purpose }));
}

export function revokeAudioTranscriptWorker(actor: AppActor) {
  audioWorkers.delete(actor);
}

export function getAudioTranscriptWorkerPurpose(actor: AppActor, workspaceId: string) {
  const purpose = audioWorkers.get(actor);
  return purpose?.workspaceId === workspaceId ? purpose : null;
}

export function nativeTranscriptPrincipalUserId(actor: AppActor, workspaceId: string) {
  return actor.kind === "user" ? actor.user.id
    : getAudioTranscriptWorkerPurpose(actor, workspaceId)?.uploadedByUserId ?? null;
}


export type RecorderTranscriptWorkerPurpose = Readonly<{
  workspaceId: string; recordingId: string; meetingId: string; attemptId: string;
  claimId: string; generation: number; nonce: string; bindingId: string;
}>;
const recorderWorkers = new WeakMap<AppActor, RecorderTranscriptWorkerPurpose>();
export function registerRecorderTranscriptWorker(actor: AppActor, purpose: RecorderTranscriptWorkerPurpose) {
  recorderWorkers.set(actor, Object.freeze({ ...purpose }));
}
export function revokeRecorderTranscriptWorker(actor: AppActor) { recorderWorkers.delete(actor); }
export function getRecorderTranscriptWorkerPurpose(actor: AppActor, workspaceId: string) {
  const purpose = recorderWorkers.get(actor);
  return purpose?.workspaceId === workspaceId ? purpose : null;
}

/** Only the authenticated transcript adapter registers an operation. Serialized
 * labels, provider IDs and copied actor objects cannot carry pending custody. */
export type TranscriptSourceImportPurpose = Readonly<{
  workspaceId: string; connectionId: string; inputId: string; recordId: string;
  meetingId: string; operationId: string; callerMemberId?: string; callerUserId?: string;
}>;
const transcriptImports = new WeakMap<AppActor, TranscriptSourceImportPurpose>();
export function registerTranscriptSourceImport(actor: AppActor, purpose: TranscriptSourceImportPurpose) {
  transcriptImports.set(actor, Object.freeze({ ...purpose }));
}
export function revokeTranscriptSourceImport(actor: AppActor) { transcriptImports.delete(actor); }
export function getTranscriptSourceImportPurpose(actor: AppActor, workspaceId: string) {
  const purpose = transcriptImports.get(actor);
  return purpose?.workspaceId === workspaceId ? purpose : null;
}
