import { describe, expect, it } from "vitest";
import { deriveMeetingEvidenceState, type MeetingEvidenceStateInput } from "./meeting-evidence-state";

const now = new Date("2026-07-13T12:00:00.000Z");

function stateFor(input: Partial<MeetingEvidenceStateInput>) {
  return deriveMeetingEvidenceState({
    now,
    recorderEnabled: true,
    meeting: {
      transcript: null,
      meetingUrl: "https://meet.example.com/team",
      recordedAt: "2026-07-13T13:00:00.000Z",
      scheduledEndAt: "2026-07-13T14:00:00.000Z",
    },
    ...input,
  });
}

describe("meeting evidence state", () => {
  it("marks meetings with transcripts ready", () => {
    expect(stateFor({
      meeting: {
        transcript: "Meeting transcript",
        meetingUrl: "https://meet.example.com/team",
        recordedAt: "2026-07-13T10:00:00.000Z",
        scheduledEndAt: "2026-07-13T11:00:00.000Z",
      },
    })).toEqual({ state: "ready", action: "none" });
  });

  it("allows an upcoming meeting with a URL and no active recording to schedule a recorder", () => {
    expect(stateFor({})).toEqual({ state: "upcoming_recordable", action: "schedule_recorder" });
  });

  it("marks an upcoming meeting without a URL as missing a meeting link", () => {
    expect(stateFor({
      meeting: {
        transcript: null,
        meetingUrl: null,
        recordedAt: "2026-07-13T13:00:00.000Z",
        scheduledEndAt: "2026-07-13T14:00:00.000Z",
      },
    })).toEqual({ state: "missing_meeting_link", action: "none" });
  });

  it("lets active recorder state drive cancellation", () => {
    expect(stateFor({
      latestRecording: {
        provider: "RECALL_AI",
        externalBotId: "bot-1",
        status: "RECORDING",
      },
    })).toEqual({ state: "recording_active", action: "cancel_recorder" });
  });

  it("marks a past scheduled meeting without transcript as needing transcript upload", () => {
    expect(stateFor({
      meeting: {
        transcript: null,
        meetingUrl: "https://meet.example.com/team",
        recordedAt: "2026-07-13T10:00:00.000Z",
        scheduledEndAt: "2026-07-13T11:00:00.000Z",
      },
    })).toEqual({ state: "needs_transcript", action: "upload_transcript" });
  });

  it("shows Recall recordings with external bots as pending background recovery", () => {
    expect(stateFor({
      meeting: {
        transcript: null,
        meetingUrl: "https://meet.example.com/team",
        recordedAt: "2026-07-13T10:00:00.000Z",
        scheduledEndAt: "2026-07-13T11:00:00.000Z",
      },
      latestRecording: {
        provider: "RECALL_AI",
        externalBotId: "bot-1",
        status: "COMPLETED",
        transcriptProcessedAt: null,
      },
    })).toEqual({ state: "provider_recovery_pending", action: "upload_transcript" });
  });

  it("marks transcripts with failed processing diagnostics as processing failed", () => {
    expect(stateFor({
      meeting: {
        transcript: "Meeting transcript",
        meetingUrl: "https://meet.example.com/team",
        recordedAt: "2026-07-13T10:00:00.000Z",
        scheduledEndAt: "2026-07-13T11:00:00.000Z",
      },
      processingState: {
        diagnostics: [
          {
            workflowJobId: "job-1",
            workflowJobType: "meeting.insights.extract",
            status: "FAILED",
            attempts: 5,
            updatedAt: "2026-07-13T11:30:00.000Z",
            safeErrorCode: "WORKFLOW_JOB_FAILED",
            safeErrorMessage: "The background job failed. Retry it or review workflow logs.",
            retrySupported: true,
          },
        ],
      },
    })).toEqual({ state: "processing_failed", action: "retry_processing" });
  });
});
