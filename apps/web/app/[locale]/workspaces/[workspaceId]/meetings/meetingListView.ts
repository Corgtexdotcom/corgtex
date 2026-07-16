import type { MeetingEvidenceState } from "@corgtex/domain";

export const MEETING_STATUS_FILTERS = ["COMPLETED", "SCHEDULED"] as const;

export type MeetingStatusFilter = (typeof MEETING_STATUS_FILTERS)[number];

export const ACTION_NEEDED_MEETING_EVIDENCE_STATES = new Set<MeetingEvidenceState["state"]>([
  "needs_transcript",
  "provider_recovery_pending",
]);

const ACTIVE_RECORDING_STATUSES = new Set(["PENDING", "SCHEDULED", "JOINING", "RECORDING"]);

type MeetingListRow = {
  id: string;
};

export type MeetingListView<TCompleted extends MeetingListRow, TScheduled extends MeetingListRow> = {
  completedMeetings: TCompleted[];
  actionNeededMeetings: TScheduled[];
  upcomingMeetings: TScheduled[];
  counts: {
    all: number;
    completed: number;
    scheduled: number;
  };
};

export function normalizeMeetingStatusFilters(value: string | string[] | undefined): MeetingStatusFilter[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<MeetingStatusFilter>();
  for (const entry of values) {
    if (MEETING_STATUS_FILTERS.includes(entry as MeetingStatusFilter)) {
      seen.add(entry as MeetingStatusFilter);
    }
  }
  return seen.size === MEETING_STATUS_FILTERS.length ? [] : [...seen];
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

export function buildMeetingListView<TCompleted extends MeetingListRow, TScheduled extends MeetingListRow>(params: {
  completedMeetings: TCompleted[];
  scheduledMeetings: TScheduled[];
  evidenceStateByMeetingId: Map<string, MeetingEvidenceState>;
  statusFilters: readonly MeetingStatusFilter[];
}): MeetingListView<TCompleted, TScheduled> {
  const actionNeededMeetings = params.scheduledMeetings.filter((meeting) => (
    isActionNeededMeetingEvidenceState(params.evidenceStateByMeetingId.get(meeting.id))
  ));
  const upcomingMeetings = params.scheduledMeetings.filter((meeting) => (
    !isActionNeededMeetingEvidenceState(params.evidenceStateByMeetingId.get(meeting.id))
  ));
  const showCompletedArea = !params.statusFilters.includes("SCHEDULED");
  const showScheduledArea = !params.statusFilters.includes("COMPLETED");

  return {
    completedMeetings: showCompletedArea ? params.completedMeetings : [],
    actionNeededMeetings: showCompletedArea ? actionNeededMeetings : [],
    upcomingMeetings: showScheduledArea ? upcomingMeetings : [],
    counts: {
      all: params.completedMeetings.length + actionNeededMeetings.length + upcomingMeetings.length,
      completed: params.completedMeetings.length + actionNeededMeetings.length,
      scheduled: upcomingMeetings.length,
    },
  };
}
