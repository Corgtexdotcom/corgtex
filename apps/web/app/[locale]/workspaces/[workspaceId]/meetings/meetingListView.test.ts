import { describe, expect, it } from "vitest";
import {
  buildMeetingListView,
  filterMeetingRecordingForEvidenceState,
  isActionNeededMeetingEvidenceState,
  normalizeMeetingStatusFilters,
} from "./meetingListView";

type TestMeeting = {
  id: string;
  title: string;
};

const completedMeeting: TestMeeting = { id: "completed", title: "Completed meeting" };
const needsTranscriptMeeting: TestMeeting = { id: "needs-transcript", title: "Needs transcript" };
const recoveryPendingMeeting: TestMeeting = { id: "recovery-pending", title: "Recorder recovery" };
const upcomingMeeting: TestMeeting = { id: "upcoming", title: "Upcoming meeting" };

function evidenceStates() {
  return new Map([
    [needsTranscriptMeeting.id, { state: "needs_transcript" as const, action: "upload_transcript" as const }],
    [recoveryPendingMeeting.id, { state: "provider_recovery_pending" as const, action: "upload_transcript" as const }],
    [upcomingMeeting.id, { state: "upcoming_recordable" as const, action: "schedule_recorder" as const }],
  ]);
}

function view(statusFilters: Array<"COMPLETED" | "SCHEDULED"> = []) {
  return buildMeetingListView({
    completedMeetings: [completedMeeting],
    scheduledMeetings: [needsTranscriptMeeting, recoveryPendingMeeting, upcomingMeeting],
    evidenceStateByMeetingId: evidenceStates(),
    statusFilters,
  });
}

describe("meeting list view", () => {
  it("normalizes all selected statuses back to the all view", () => {
    expect(normalizeMeetingStatusFilters(["COMPLETED", "SCHEDULED"])).toEqual([]);
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

  it("shows action-needed scheduled rows in the completed area for the all view", () => {
    const result = view();

    expect(result.completedMeetings).toEqual([completedMeeting]);
    expect(result.actionNeededMeetings).toEqual([needsTranscriptMeeting, recoveryPendingMeeting]);
    expect(result.upcomingMeetings).toEqual([upcomingMeeting]);
    expect(result.counts).toEqual({ all: 4, completed: 3, scheduled: 1 });
  });

  it("keeps action-needed scheduled rows visible when filtering to completed", () => {
    const result = view(["COMPLETED"]);

    expect(result.completedMeetings).toEqual([completedMeeting]);
    expect(result.actionNeededMeetings).toEqual([needsTranscriptMeeting, recoveryPendingMeeting]);
    expect(result.upcomingMeetings).toEqual([]);
    expect(result.counts).toEqual({ all: 4, completed: 3, scheduled: 1 });
  });

  it("excludes action-needed past rows from the scheduled filter", () => {
    const result = view(["SCHEDULED"]);

    expect(result.completedMeetings).toEqual([]);
    expect(result.actionNeededMeetings).toEqual([]);
    expect(result.upcomingMeetings).toEqual([upcomingMeeting]);
    expect(result.counts).toEqual({ all: 4, completed: 3, scheduled: 1 });
  });
});
