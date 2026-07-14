import type { MeetingRecorderProvider, MeetingRecordingStatus } from "@prisma/client";
import type { MeetingTranscriptProcessingState } from "./meeting-transcript-processing";

export type MeetingEvidenceStateName =
  | "ready"
  | "upcoming_recordable"
  | "missing_meeting_link"
  | "recording_active"
  | "provider_recovery_pending"
  | "needs_transcript"
  | "processing_failed";

export type MeetingEvidenceAction =
  | "none"
  | "schedule_recorder"
  | "cancel_recorder"
  | "upload_transcript"
  | "retry_processing";

export type MeetingEvidenceState = {
  state: MeetingEvidenceStateName;
  action: MeetingEvidenceAction;
};

export type MeetingEvidenceMeetingSnapshot = {
  transcript: string | null;
  meetingUrl?: string | null;
  recordedAt: Date | string;
  scheduledEndAt?: Date | string | null;
};

export type MeetingEvidenceRecordingSnapshot = {
  provider: MeetingRecorderProvider | string;
  externalBotId?: string | null;
  status: MeetingRecordingStatus | string;
  failureCode?: string | null;
  transcriptProcessedAt?: Date | string | null;
};

export type MeetingEvidenceStateInput = {
  meeting: MeetingEvidenceMeetingSnapshot;
  latestRecording?: MeetingEvidenceRecordingSnapshot | null;
  recorderEnabled?: boolean;
  processingState?: Pick<MeetingTranscriptProcessingState, "diagnostics"> | null;
  now?: Date;
};

const ACTIVE_RECORDING_STATUSES = new Set<string>(["PENDING", "SCHEDULED", "JOINING", "RECORDING"]);
const RECOVERABLE_RECALL_RECORDING_STATUSES = new Set<string>(["PENDING", "SCHEDULED", "JOINING", "RECORDING", "COMPLETED"]);

function hasTranscript(transcript: string | null | undefined) {
  return Boolean(transcript?.trim());
}

function hasFailedProcessing(processingState: MeetingEvidenceStateInput["processingState"]) {
  return Boolean(processingState?.diagnostics.some((diagnostic) => diagnostic.retrySupported || diagnostic.status === "FAILED"));
}

function isActiveRecording(recording: MeetingEvidenceRecordingSnapshot | null | undefined) {
  return Boolean(recording && ACTIVE_RECORDING_STATUSES.has(recording.status));
}

function isRecallRecordingPendingRecovery(recording: MeetingEvidenceRecordingSnapshot | null | undefined) {
  if (!recording || recording.provider !== "RECALL_AI" || !recording.externalBotId || recording.transcriptProcessedAt) {
    return false;
  }

  return RECOVERABLE_RECALL_RECORDING_STATUSES.has(recording.status)
    || (recording.status === "FAILED" && recording.failureCode === "STALE_RECORDER");
}

function isPastMeeting(meeting: MeetingEvidenceMeetingSnapshot, now: Date) {
  const reference = new Date(meeting.scheduledEndAt ?? meeting.recordedAt);
  return Number.isFinite(reference.getTime()) && reference <= now;
}

export function deriveMeetingEvidenceState(input: MeetingEvidenceStateInput): MeetingEvidenceState {
  const { meeting, latestRecording = null, processingState = null, recorderEnabled = false, now = new Date() } = input;

  if (hasTranscript(meeting.transcript)) {
    return hasFailedProcessing(processingState)
      ? { state: "processing_failed", action: "retry_processing" }
      : { state: "ready", action: "none" };
  }

  if (isActiveRecording(latestRecording)) {
    return {
      state: "recording_active",
      action: recorderEnabled ? "cancel_recorder" : "none",
    };
  }

  if (isRecallRecordingPendingRecovery(latestRecording)) {
    return { state: "provider_recovery_pending", action: "upload_transcript" };
  }

  if (isPastMeeting(meeting, now)) {
    return { state: "needs_transcript", action: "upload_transcript" };
  }

  if (!meeting.meetingUrl?.trim()) {
    return { state: "missing_meeting_link", action: "none" };
  }

  return {
    state: "upcoming_recordable",
    action: recorderEnabled ? "schedule_recorder" : "none",
  };
}
