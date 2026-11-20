import { deriveMeetingEvidenceState, type listMeetings, type MeetingEvidenceStateInput } from "@corgtex/domain";
import { markdownToPlainText } from "@/lib/markdown";

type Meeting = Awaited<ReturnType<typeof listMeetings>>[number];

export function projectMeetingDirectoryRow(meeting: Meeting) {
  return {
    id: meeting.id, title: meeting.title, source: meeting.source, status: meeting.status,
    recordedAt: meeting.recordedAt, scheduledEndAt: meeting.scheduledEndAt,
    agendaPostedAt: meeting.agendaPostedAt, meetingUrl: meeting.meetingUrl,
    hasTranscript: Boolean(meeting.transcript?.trim()),
    leadExcerpt: meeting.summaryMd ? markdownToPlainText(meeting.summaryMd, 520) : "",
    excerpt: meeting.summaryMd ? markdownToPlainText(meeting.summaryMd, 320) : "",
  };
}

export function directoryMeetingEvidenceState(input: Omit<MeetingEvidenceStateInput, "meeting"> & {
  meeting: ReturnType<typeof projectMeetingDirectoryRow>;
}) {
  // Directory rows contain no transcript bytes. The existing evidence evaluator
  // handles absent transcripts unchanged; populated ones are ready in this view.
  return input.meeting.hasTranscript
    ? { state: "ready" as const, action: "none" as const }
    : deriveMeetingEvidenceState({ ...input, meeting: { ...input.meeting, transcript: null } });
}

export function pageMeetingRows<T extends { id: string; recordedAt: Date | string }>(rows: T[], value: string | string[] | undefined, ascending = false) {
  const raw = Array.isArray(value) ? value[0] : value;
  const requested = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Math.max(1, Number(raw)) : 1;
  const sorted = [...rows].sort((a, b) => (ascending ? 1 : -1) * (new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()) || a.id.localeCompare(b.id));
  const pageCount = Math.max(1, Math.ceil(sorted.length / 20));
  const page = Math.min(pageCount, requested);
  return { items: sorted.slice((page - 1) * 20, page * 20), total: sorted.length, page, pageCount };
}
