import type { AppActor } from "@corgtex/shared";
import type { ModelTool } from "@corgtex/models";
import { createMeetingSeries, intakeMeetingTranscript } from "@corgtex/domain";

export const createCorgtexScheduledMeetingTool: ModelTool = {
  type: "function",
  function: {
    name: "create_corgtex_scheduled_meeting",
    description: "Create a scheduled meeting record inside Corgtex so it appears in Upcoming Meetings. This does not send calendar invites.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Meeting title" },
        startsAt: { type: "string", description: "ISO 8601 start date-time" },
        scheduledEndAt: { type: "string", description: "Optional ISO 8601 end date-time" },
        description: { type: "string", description: "Optional meeting description or agenda" },
        recurrenceRule: { type: "string", description: "Optional RRULE, e.g. FREQ=WEEKLY" },
        participantEmails: {
          type: "array",
          items: { type: "string" },
          description: "Attendee emails",
        },
      },
      required: ["title", "startsAt"],
    },
  },
};

export const uploadMeetingTranscriptTool: ModelTool = {
  type: "function",
  function: {
    name: "upload_meeting_transcript",
    description: "Save pasted meeting transcript text as a Corgtex Meeting, matching a scheduled meeting when possible and queuing summary/follow-up extraction.",
    parameters: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Meeting transcript or minutes text" },
        title: { type: "string", description: "Optional meeting title" },
        recordedAt: { type: "string", description: "ISO 8601 date-time when the meeting happened" },
        source: { type: "string", description: "Where this transcript came from" },
        participantEmails: {
          type: "array",
          items: { type: "string" },
          description: "Attendee emails",
        },
      },
      required: ["transcript"],
    },
  },
};

export async function createCorgtexScheduledMeeting(actor: AppActor, workspaceId: string, args: {
  title: string;
  startsAt: string;
  scheduledEndAt?: string;
  description?: string;
  recurrenceRule?: string;
  participantEmails?: string[];
}) {
  const result = await createMeetingSeries(actor, {
    workspaceId,
    title: args.title,
    description: args.description ?? null,
    startsAt: new Date(args.startsAt),
    scheduledEndAt: args.scheduledEndAt ? new Date(args.scheduledEndAt) : null,
    recurrenceRule: args.recurrenceRule ?? null,
    participantEmails: args.participantEmails ?? [],
  });
  return {
    seriesId: result.series.id,
    meetings: result.meetings.map((meeting) => ({
      id: meeting.id,
      title: meeting.title,
      recordedAt: meeting.recordedAt,
      status: meeting.status,
    })),
  };
}

export async function uploadMeetingTranscriptFromTool(actor: AppActor, workspaceId: string, args: {
  transcript: string;
  title?: string;
  recordedAt?: string;
  source?: string;
  participantEmails?: string[];
}) {
  return intakeMeetingTranscript(actor, {
    workspaceId,
    transcript: args.transcript,
    title: args.title ?? null,
    recordedAt: args.recordedAt ?? null,
    source: args.source ?? "agent-upload",
    participantEmails: args.participantEmails ?? [],
  });
}
