import type { MeetingEvidenceState } from "@corgtex/domain";

export const MEETING_STATUS_FILTERS = ["COMPLETED", "TRANSCRIPT_NEEDED", "SCHEDULED"] as const;

export type MeetingStatusFilter = "ALL" | (typeof MEETING_STATUS_FILTERS)[number];

const ACTION_NEEDED_MEETING_EVIDENCE_STATES = new Set<MeetingEvidenceState["state"]>([
  "needs_transcript",
  "provider_recovery_pending",
]);

const ACTIVE_RECORDING_STATUSES = new Set(["PENDING", "SCHEDULED", "JOINING", "RECORDING"]);

type MeetingListRow = {
  id: string;
  recordedAt: Date | string;
  transcript: string | null;
};

export type MeetingListView<TMeeting extends MeetingListRow> = {
  recordedMeetings: TMeeting[];
  transcriptNeededMeetings: TMeeting[];
  scheduledMeetings: TMeeting[];
  counts: {
    all: number;
    completed: number;
    transcriptNeeded: number;
    scheduled: number;
  };
};

export function normalizeMeetingStatusFilter(value: string | string[] | undefined): MeetingStatusFilter {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.find((entry): entry is (typeof MEETING_STATUS_FILTERS)[number] => (
    MEETING_STATUS_FILTERS.includes(entry as (typeof MEETING_STATUS_FILTERS)[number])
  )) ?? "ALL";
}

export function isActionNeededMeetingEvidenceState(state: MeetingEvidenceState | null | undefined) {
  return ACTION_NEEDED_MEETING_EVIDENCE_STATES.has(state?.state ?? "ready");
}

export function filterMeetingRecordingForEvidenceState<TRecording extends { status: string }>(
  recording: TRecording | null | undefined,
  options: { recorderEnabled: boolean },
): TRecording | null {
  if (!recording) {
    return null;
  }

  if (options.recorderEnabled || !ACTIVE_RECORDING_STATUSES.has(recording.status)) {
    return recording;
  }

  return null;
}

function hasTranscript(meeting: MeetingListRow) {
  return Boolean(meeting.transcript?.trim());
}

function newestFirst<TMeeting extends MeetingListRow>(meetings: TMeeting[]) {
  return meetings.sort((left, right) => new Date(right.recordedAt).getTime() - new Date(left.recordedAt).getTime());
}

export function buildMeetingListView<TMeeting extends MeetingListRow>(params: {
  completedMeetings: TMeeting[];
  scheduledMeetings: TMeeting[];
  evidenceStateByMeetingId: Map<string, MeetingEvidenceState>;
  statusFilter: MeetingStatusFilter;
}): MeetingListView<TMeeting> {
  const completedWithTranscript = params.completedMeetings.filter(hasTranscript);
  const scheduledWithTranscript = params.scheduledMeetings.filter(hasTranscript);
  const recordedMeetings = newestFirst([...completedWithTranscript, ...scheduledWithTranscript]);
  const transcriptNeededMeetings = newestFirst([
    ...params.completedMeetings.filter((meeting) => !hasTranscript(meeting)),
    ...params.scheduledMeetings.filter((meeting) => (
      !hasTranscript(meeting) && isActionNeededMeetingEvidenceState(params.evidenceStateByMeetingId.get(meeting.id))
    )),
  ]);
  const scheduledMeetings = params.scheduledMeetings.filter((meeting) => (
    !isActionNeededMeetingEvidenceState(params.evidenceStateByMeetingId.get(meeting.id))
  ));

  return {
    recordedMeetings: params.statusFilter === "ALL"
      ? recordedMeetings
      : params.statusFilter === "COMPLETED" ? completedWithTranscript : [],
    transcriptNeededMeetings: params.statusFilter === "TRANSCRIPT_NEEDED" ? transcriptNeededMeetings : [],
    scheduledMeetings: params.statusFilter === "SCHEDULED" ? scheduledMeetings : [],
    counts: {
      all: recordedMeetings.length,
      completed: completedWithTranscript.length,
      transcriptNeeded: transcriptNeededMeetings.length,
      scheduled: scheduledMeetings.length,
    },
  };
}
