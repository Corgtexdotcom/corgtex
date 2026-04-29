import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Meeting, MeetingStatus, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

const DEFAULT_OCCURRENCE_WINDOW_DAYS = 30;
const TRANSCRIPT_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const TRANSCRIPT_AUTO_MATCH_THRESHOLD = 0.65;
const TRANSCRIPT_MATCH_MARGIN = 0.1;

type MeetingCandidate = {
  meetingId: string;
  title: string | null;
  recordedAt: Date;
  scheduledEndAt: Date | null;
  score: number;
  reason: string;
};

type MeetingSeriesForExpansion = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  source: string;
  externalId: string | null;
  recurrenceRule: string | null;
  startsAt: Date;
  defaultDurationMinutes: number;
  participantIds: string[];
  participantEmails: string[];
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizeEmails(values?: string[] | null) {
  return [...new Set((values ?? []).map(normalizeEmail).filter(Boolean))];
}

function normalizeIds(values?: string[] | null) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeTitle(value?: string | null) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeIcsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function toIcsDate(value: Date) {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function hashStableId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function seriesEnd(series: MeetingSeriesForExpansion) {
  return new Date(series.startsAt.getTime() + Math.max(1, series.defaultDurationMinutes) * 60 * 1000);
}

function readIcsEventEmails(component: any) {
  return normalizeEmails(component.getAllProperties("attendee")
    .map((property: any) => String(property.getFirstValue() ?? "").replace(/^mailto:/i, "")));
}

function readIcsRecurrenceRule(component: any) {
  const rule = component.getFirstPropertyValue("rrule");
  return rule ? String(rule) : null;
}

function eventDurationMs(event: any) {
  const start = event.startDate?.toJSDate();
  const end = event.endDate?.toJSDate();
  const duration = start && end ? end.getTime() - start.getTime() : 0;
  return duration > 0 ? duration : 60 * 60 * 1000;
}

function expandIcsEvent(component: any, params: {
  from: Date;
  to: Date;
  externalIdPrefix: string;
}) {
  const event = new ICAL.Event(component);
  const duration = eventDurationMs(event);
  const occurrences: Array<{ start: Date; end: Date; externalId: string; calendarExternalId: string | null }> = [];

  if (!event.isRecurring()) {
    const start = event.startDate.toJSDate();
    if (start >= params.from && start <= params.to) {
      occurrences.push({
        start,
        end: new Date(start.getTime() + duration),
        externalId: `${params.externalIdPrefix}:${start.toISOString()}`,
        calendarExternalId: event.uid || null,
      });
    }
    return occurrences;
  }

  const iterator = event.iterator();
  for (let index = 0; index < 370; index += 1) {
    const next = iterator.next();
    if (!next) break;
    const start = next.toJSDate();
    if (start > params.to) break;
    if (start >= params.from) {
      occurrences.push({
        start,
        end: new Date(start.getTime() + duration),
        externalId: `${params.externalIdPrefix}:${start.toISOString()}`,
        calendarExternalId: event.uid || null,
      });
    }
  }

  return occurrences;
}

function componentForSeries(series: MeetingSeriesForExpansion) {
  const uid = series.externalId ?? `internal-series-${series.id}`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Corgtex//Meeting Facilitation//EN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${toIcsDate(new Date())}`,
    `DTSTART:${toIcsDate(series.startsAt)}`,
    `DTEND:${toIcsDate(seriesEnd(series))}`,
    `SUMMARY:${escapeIcsText(series.title)}`,
    series.description ? `DESCRIPTION:${escapeIcsText(series.description)}` : null,
    series.recurrenceRule ? `RRULE:${series.recurrenceRule}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\n");

  const calendar = new ICAL.Component(ICAL.parse(lines));
  return calendar.getFirstSubcomponent("vevent");
}

async function materializeMeetingSeriesOccurrencesTx(
  tx: Prisma.TransactionClient,
  series: MeetingSeriesForExpansion,
  params?: { from?: Date; to?: Date }
) {
  const from = params?.from ?? series.startsAt;
  const to = params?.to ?? addDays(new Date(), DEFAULT_OCCURRENCE_WINDOW_DAYS);
  const component = componentForSeries(series);
  const occurrences = expandIcsEvent(component, {
    from,
    to,
    externalIdPrefix: `meeting-series:${series.id}`,
  });

  const meetings: Meeting[] = [];
  for (const occurrence of occurrences) {
    const meeting = await tx.meeting.upsert({
      where: { externalId: occurrence.externalId },
      update: {
        title: series.title,
        source: series.source,
        seriesId: series.id,
        scheduledEndAt: occurrence.end,
        participantIds: series.participantIds,
        participantEmails: series.participantEmails,
        calendarExternalId: occurrence.calendarExternalId,
      },
      create: {
        workspaceId: series.workspaceId,
        seriesId: series.id,
        status: "SCHEDULED",
        title: series.title,
        source: series.source,
        externalId: occurrence.externalId,
        calendarExternalId: occurrence.calendarExternalId,
        recordedAt: occurrence.start,
        scheduledEndAt: occurrence.end,
        participantIds: series.participantIds,
        participantEmails: series.participantEmails,
      },
    });
    meetings.push(meeting);
  }

  return meetings;
}

async function findTranscriptMeetingCandidatesInternal(params: {
  workspaceId: string;
  title?: string | null;
  recordedAt: Date;
  participantEmails?: string[] | null;
}) {
  const start = new Date(params.recordedAt.getTime() - TRANSCRIPT_MATCH_WINDOW_MS);
  const end = new Date(params.recordedAt.getTime() + TRANSCRIPT_MATCH_WINDOW_MS);
  const title = normalizeTitle(params.title);
  const participantEmails = normalizeEmails(params.participantEmails);
  const candidates = await prisma.meeting.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: { gte: start, lte: end },
    },
    orderBy: { recordedAt: "asc" },
    take: 20,
  });

  return candidates.map((meeting): MeetingCandidate => {
    const meetingTitle = normalizeTitle(meeting.title);
    let titleScore = 0;
    if (title && meetingTitle) {
      if (title === meetingTitle) {
        titleScore = 0.4;
      } else if (title.includes(meetingTitle) || meetingTitle.includes(title)) {
        titleScore = 0.28;
      }
    }

    const diff = Math.abs(meeting.recordedAt.getTime() - params.recordedAt.getTime());
    const timeScore = Math.max(0, 0.4 * (1 - diff / TRANSCRIPT_MATCH_WINDOW_MS));
    const meetingEmails = new Set(normalizeEmails(meeting.participantEmails));
    const overlap = participantEmails.filter((email) => meetingEmails.has(email)).length;
    const attendeeScore = participantEmails.length > 0
      ? 0.2 * (overlap / participantEmails.length)
      : 0.05;
    const score = Number((titleScore + timeScore + attendeeScore).toFixed(3));
    const reason = [
      titleScore > 0 ? "title" : null,
      timeScore > 0 ? "time" : null,
      attendeeScore > 0.05 ? "attendees" : null,
    ].filter(Boolean).join(", ");

    return {
      meetingId: meeting.id,
      title: meeting.title,
      recordedAt: meeting.recordedAt,
      scheduledEndAt: meeting.scheduledEndAt,
      score,
      reason: reason || "nearby scheduled meeting",
    };
  }).sort((left, right) => right.score - left.score);
}

async function updateMeetingWithTranscriptTx(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: {
    workspaceId: string;
    meetingId: string;
    title?: string | null;
    recordedAt?: Date | null;
    transcript: string;
    summaryMd?: string | null;
    participantIds?: string[] | null;
    participantEmails?: string[] | null;
  }
) {
  const meeting = await tx.meeting.update({
    where: { id: params.meetingId },
    data: {
      status: "COMPLETED",
      title: params.title?.trim() || undefined,
      recordedAt: params.recordedAt && !Number.isNaN(params.recordedAt.valueOf()) ? params.recordedAt : undefined,
      transcript: params.transcript.trim(),
      summaryMd: params.summaryMd?.trim() || undefined,
      participantIds: params.participantIds ? normalizeIds(params.participantIds) : undefined,
      participantEmails: params.participantEmails ? normalizeEmails(params.participantEmails) : undefined,
    },
  });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: "meeting.transcript-uploaded",
      entityType: "Meeting",
      entityId: meeting.id,
      meta: {
        title: meeting.title,
        recordedAt: meeting.recordedAt.toISOString(),
      },
    },
  });

  await appendEvents(tx, [
    {
      workspaceId: params.workspaceId,
      type: "meeting.transcript-uploaded",
      aggregateType: "Meeting",
      aggregateId: meeting.id,
      payload: {
        meetingId: meeting.id,
        title: meeting.title,
        source: meeting.source,
        status: meeting.status,
        hasTranscript: Boolean(meeting.transcript),
      },
    },
  ]);

  return meeting;
}

export async function listMeetings(workspaceId: string, opts?: { archiveFilter?: ArchiveFilter; status?: MeetingStatus }) {
  return prisma.meeting.findMany({
    where: {
      workspaceId,
      ...(opts?.status ? { status: opts.status } : {}),
      ...archiveFilterWhere(opts?.archiveFilter),
    },
    orderBy: { recordedAt: opts?.status === "SCHEDULED" ? "asc" : "desc" },
  });
}

export async function listUpcomingMeetings(workspaceId: string, opts?: { from?: Date; to?: Date }) {
  const from = opts?.from ?? new Date();
  const to = opts?.to ?? addDays(from, DEFAULT_OCCURRENCE_WINDOW_DAYS);
  return prisma.meeting.findMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: { gte: from, lte: to },
    },
    orderBy: { recordedAt: "asc" },
  });
}

export async function getMeeting(workspaceId: string, meetingId: string) {
  return prisma.meeting.findFirst({
    where: {
      id: meetingId,
      workspaceId,
      archivedAt: null,
    },
    include: {
      series: true,
      insights: {
        orderBy: { createdAt: "desc" },
      },
      proposals: {
        include: {
          author: {
            select: {
              displayName: true,
              email: true,
            },
          },
          reactions: true,
          tensions: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
          actions: {
            select: {
              id: true,
              title: true,
              status: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      tensions: {
        include: {
          author: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function getMeetingParticipants(workspaceId: string, participantIds: string[]) {
  return prisma.member.findMany({
    where: {
      workspaceId,
      userId: { in: participantIds },
    },
    include: {
      user: { select: { displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: { select: { name: true } },
        },
      },
    },
  });
}

export async function createMeetingSeries(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  scheduledEndAt?: Date | null;
  recurrenceRule?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Meeting title is required.");
  invariant(!Number.isNaN(params.startsAt.valueOf()), 400, "INVALID_INPUT", "startsAt must be a valid date.");
  const defaultDurationMinutes = params.scheduledEndAt && !Number.isNaN(params.scheduledEndAt.valueOf())
    ? Math.max(1, Math.round((params.scheduledEndAt.getTime() - params.startsAt.getTime()) / 60_000))
    : 60;

  return prisma.$transaction(async (tx) => {
    const series = await tx.meetingSeries.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        description: params.description?.trim() || null,
        source: "internal",
        recurrenceRule: params.recurrenceRule?.trim() || null,
        startsAt: params.startsAt,
        defaultDurationMinutes,
        participantIds: normalizeIds(params.participantIds),
        participantEmails: normalizeEmails(params.participantEmails),
      },
    });

    const meetings = await materializeMeetingSeriesOccurrencesTx(tx, series);

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting-series.created",
        entityType: "MeetingSeries",
        entityId: series.id,
        meta: {
          title: series.title,
          recurrenceRule: series.recurrenceRule,
          materializedMeetings: meetings.length,
        },
      },
    });

    return { series, meetings };
  });
}

export async function importMeetingInvite(actor: AppActor, params: {
  workspaceId: string;
  icsText: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const calendar = new ICAL.Component(ICAL.parse(params.icsText));
  const events = calendar.getAllSubcomponents("vevent");
  invariant(events.length > 0, 400, "INVALID_INPUT", "Invite does not contain a calendar event.");

  return prisma.$transaction(async (tx) => {
    const imported: Array<{ seriesId: string; meetings: Meeting[] }> = [];

    for (const component of events) {
      const event = new ICAL.Event(component);
      const startsAt = event.startDate.toJSDate();
      const durationMinutes = Math.max(1, Math.round(eventDurationMs(event) / 60_000));
      const uid = event.uid || hashStableId(`${event.summary}:${startsAt.toISOString()}`);
      const seriesExternalId = `ics-series:${params.workspaceId}:${uid}`;
      const recurrenceRule = readIcsRecurrenceRule(component);
      const participantEmails = readIcsEventEmails(component);

      const series = await tx.meetingSeries.upsert({
        where: { externalId: seriesExternalId },
        update: {
          workspaceId: params.workspaceId,
          title: event.summary || "Untitled meeting",
          description: event.description || null,
          source: "ics",
          recurrenceRule,
          startsAt,
          defaultDurationMinutes: durationMinutes,
          participantEmails,
        },
        create: {
          workspaceId: params.workspaceId,
          title: event.summary || "Untitled meeting",
          description: event.description || null,
          source: "ics",
          externalId: seriesExternalId,
          recurrenceRule,
          startsAt,
          defaultDurationMinutes: durationMinutes,
          participantIds: [],
          participantEmails,
        },
      });

      const meetings = await materializeMeetingSeriesOccurrencesTx(tx, {
        ...series,
        participantIds: series.participantIds,
        participantEmails: series.participantEmails,
      });
      imported.push({ seriesId: series.id, meetings });
    }

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting-invite.imported",
        entityType: "MeetingSeries",
        entityId: imported[0].seriesId,
        meta: {
          eventCount: events.length,
          materializedMeetings: imported.reduce((total, item) => total + item.meetings.length, 0),
        },
      },
    });

    return imported;
  });
}

export async function findTranscriptMeetingCandidates(actor: AppActor, params: {
  workspaceId: string;
  title?: string | null;
  recordedAt: Date;
  participantEmails?: string[] | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  return findTranscriptMeetingCandidatesInternal(params);
}

export async function uploadMeetingTranscript(actor: AppActor, params: {
  workspaceId: string;
  meetingId?: string | null;
  title?: string | null;
  source?: string | null;
  recordedAt: Date;
  transcript: string;
  summaryMd?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  invariant(params.transcript.trim().length > 0, 400, "INVALID_INPUT", "Transcript is required.");

  if (params.meetingId) {
    const existing = await prisma.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");

    const meeting = await prisma.$transaction((tx) => updateMeetingWithTranscriptTx(tx, actor, {
      ...params,
      meetingId: params.meetingId as string,
    }));
    return { status: "matched" as const, meeting, candidates: [] };
  }

  const candidates = await findTranscriptMeetingCandidatesInternal(params);
  const [best, second] = candidates;
  if (best && best.score >= TRANSCRIPT_AUTO_MATCH_THRESHOLD && (!second || best.score - second.score >= TRANSCRIPT_MATCH_MARGIN)) {
    const meeting = await prisma.$transaction((tx) => updateMeetingWithTranscriptTx(tx, actor, {
      ...params,
      meetingId: best.meetingId,
    }));
    return { status: "matched" as const, meeting, candidates };
  }

  if (candidates.length > 0) {
    return { status: "needs_selection" as const, meeting: null, candidates };
  }

  const meeting = await createMeeting(actor, {
    workspaceId: params.workspaceId,
    title: params.title,
    source: params.source || "transcript-upload",
    recordedAt: params.recordedAt,
    transcript: params.transcript,
    summaryMd: params.summaryMd,
    participantIds: params.participantIds ?? [],
    participantEmails: params.participantEmails ?? [],
  });

  return { status: "created" as const, meeting, candidates: [] };
}

export async function createMeeting(actor: AppActor, params: {
  workspaceId: string;
  title?: string | null;
  source: string;
  recordedAt: Date;
  scheduledEndAt?: Date | null;
  transcript?: string | null;
  summaryMd?: string | null;
  participantIds?: string[];
  participantEmails?: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const source = params.source.trim();
  invariant(source.length > 0, 400, "INVALID_INPUT", "Meeting source is required.");
  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.create({
      data: {
        workspaceId: params.workspaceId,
        title: params.title?.trim() || null,
        source,
        status: "COMPLETED",
        recordedAt: params.recordedAt,
        scheduledEndAt: params.scheduledEndAt ?? null,
        transcript: params.transcript?.trim() || null,
        summaryMd: params.summaryMd?.trim() || null,
        participantIds: normalizeIds(params.participantIds),
        participantEmails: normalizeEmails(params.participantEmails),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.created",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          source: meeting.source,
          recordedAt: meeting.recordedAt.toISOString(),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "meeting.created",
        aggregateType: "Meeting",
        aggregateId: meeting.id,
        payload: {
          meetingId: meeting.id,
          title: meeting.title,
          source: meeting.source,
          status: meeting.status,
          hasTranscript: Boolean(meeting.transcript),
        },
      },
    ]);

    return meeting;
  });
}

export async function deleteMeeting(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  await archiveWorkspaceArtifact(actor, {
    workspaceId: params.workspaceId,
    entityType: "Meeting",
    entityId: params.meetingId,
    reason: "Archived from meeting delete path.",
  });

  return { id: params.meetingId };
}
