import { describe, expect, it } from "vitest";
import {
  buildMeetingListView,
  filterMeetingRecordingForEvidenceState,
  isActionNeededMeetingEvidenceState,
  normalizeMeetingStatusFilter,
  type MeetingStatusFilter,
} from "./meetingListView";

type TestMeeting = {
  id: string;
  title: string;
  recordedAt: Date;
  transcript: string | null;
};

const meeting = (id: string, day: number, transcript: string | null = null): TestMeeting => ({
  id,
  title: id,
  recordedAt: new Date(`2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`),
  transcript,
});

const completedReady = meeting("completed-ready", 5, "Reviewed transcript");
const completedMissing = meeting("completed-missing", 6);
const completedBlank = meeting("completed-blank", 7, "  \n  ");
const needsTranscript = meeting("needs-transcript", 4);
const recoveryPending = meeting("recovery-pending", 3);
const upcoming = meeting("upcoming", 9);
const scheduledReady = meeting("scheduled-ready", 8, "Uploaded transcript");

function evidenceStates() {
  return new Map([
    [needsTranscript.id, { state: "needs_transcript" as const, action: "upload_transcript" as const }],
    [recoveryPending.id, { state: "provider_recovery_pending" as const, action: "upload_transcript" as const }],
    [upcoming.id, { state: "upcoming_recordable" as const, action: "schedule_recorder" as const }],
    [scheduledReady.id, { state: "ready" as const, action: "none" as const }],
  ]);
}

function view(statusFilter: MeetingStatusFilter = "ALL") {
  return buildMeetingListView({
    completedMeetings: [completedReady, completedMissing, completedBlank],
    scheduledMeetings: [needsTranscript, recoveryPending, upcoming, scheduledReady],
    evidenceStateByMeetingId: evidenceStates(),
    statusFilter,
  });
}

const counts = { all: 2, completed: 1, transcriptNeeded: 4, scheduled: 2 };

describe("meeting list view", () => {
  it("normalizes legacy and repeated status values to one explicit view", () => {
    expect(normalizeMeetingStatusFilter(undefined)).toBe("ALL");
    expect(normalizeMeetingStatusFilter("unknown")).toBe("ALL");
    expect(normalizeMeetingStatusFilter("TRANSCRIPT_NEEDED")).toBe("TRANSCRIPT_NEEDED");
    expect(normalizeMeetingStatusFilter(["unknown", "SCHEDULED", "TRANSCRIPT_NEEDED"])).toBe("SCHEDULED");
    expect(normalizeMeetingStatusFilter(["COMPLETED", "SCHEDULED"])).toBe("COMPLETED");
  });

  it("treats missing transcripts and provider recovery as action-needed past meetings", () => {
    expect(isActionNeededMeetingEvidenceState({ state: "needs_transcript", action: "upload_transcript" })).toBe(true);
    expect(isActionNeededMeetingEvidenceState({ state: "provider_recovery_pending", action: "upload_transcript" })).toBe(true);
    expect(isActionNeededMeetingEvidenceState({ state: "upcoming_recordable", action: "schedule_recorder" })).toBe(false);
  });

  it("ignores active recorder attempts for evidence classification when recorders are disabled", () => {
    const activeRecording = { status: "RECORDING", provider: "RECALL_AI" };
    const completedRecording = { status: "COMPLETED", provider: "RECALL_AI" };

    expect(filterMeetingRecordingForEvidenceState(activeRecording, { recorderEnabled: false })).toBeNull();
    expect(filterMeetingRecordingForEvidenceState(activeRecording, { recorderEnabled: true })).toBe(activeRecording);
    expect(filterMeetingRecordingForEvidenceState(completedRecording, { recorderEnabled: false })).toBe(completedRecording);
  });

  it("defaults All to transcript-available meetings only, newest first", () => {
    const result = view();

    expect(result.recordedMeetings).toEqual([scheduledReady, completedReady]);
    expect(result.transcriptNeededMeetings).toEqual([]);
    expect(result.scheduledMeetings).toEqual([]);
    expect(result.counts).toEqual(counts);
  });

  it("keeps the legacy Completed filter scoped to completed meetings with transcripts", () => {
    const result = view("COMPLETED");

    expect(result.recordedMeetings).toEqual([completedReady]);
    expect(result.transcriptNeededMeetings).toEqual([]);
    expect(result.scheduledMeetings).toEqual([]);
    expect(result.counts).toEqual(counts);
  });

  it("shows missing completed and recovery rows only in Transcript needed", () => {
    const result = view("TRANSCRIPT_NEEDED");

    expect(result.recordedMeetings).toEqual([]);
    expect(result.transcriptNeededMeetings).toEqual([
      completedBlank, completedMissing, needsTranscript, recoveryPending,
    ]);
    expect(result.scheduledMeetings).toEqual([]);
    expect(result.counts).toEqual(counts);
  });

  it("keeps scheduled records in their explicit view without recovery rows", () => {
    const result = view("SCHEDULED");

    expect(result.recordedMeetings).toEqual([]);
    expect(result.transcriptNeededMeetings).toEqual([]);
    expect(result.scheduledMeetings).toEqual([upcoming, scheduledReady]);
    expect(result.counts).toEqual(counts);
  });

  it("keeps counts equal to the full visible list beyond the first screen", () => {
    const completedMeetings = Array.from({ length: 64 }, (_, index) => meeting(`recorded-${index}`, 1, "Transcript"));
    const result = buildMeetingListView({
      completedMeetings: [...completedMeetings, completedMissing],
      scheduledMeetings: [needsTranscript],
      evidenceStateByMeetingId: evidenceStates(),
      statusFilter: "ALL",
    });

    expect(result.recordedMeetings).toHaveLength(64);
    expect(result.counts).toEqual({ all: 64, completed: 64, transcriptNeeded: 2, scheduled: 0 });
  });
});
