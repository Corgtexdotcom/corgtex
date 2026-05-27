import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Meeting, MeetingRecordingStatus, MeetingStatus, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { invariant } from "./errors";

const DEFAULT_OCCURRENCE_WINDOW_DAYS = 30;
const TRANSCRIPT_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const TRANSCRIPT_AUTO_MATCH_THRESHOLD = 0.65;
const TRANSCRIPT_MATCH_MARGIN = 0.1;
const ACTIVE_RECORDING_STATUSES_FOR_CLEANUP: MeetingRecordingStatus[] = ["PENDING", "SCHEDULED", "JOINING", "RECORDING"];

type MeetingCandidate = {
  meetingId: string;
  title: string | null;
  status: MeetingStatus;
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

function normalizeTranscriptForCompare(value?: string | null) {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

function mergeTranscript(existing: string | null | undefined, incoming: string) {
  const current = existing?.trim() ?? "";
  const next = incoming.trim();
  if (!current) return next;
  if (!next) return current;

  const normalizedCurrent = normalizeTranscriptForCompare(current);
  const normalizedNext = normalizeTranscriptForCompare(next);
  if (normalizedCurrent === normalizedNext || normalizedCurrent.includes(normalizedNext)) {
    return current;
  }
  if (normalizedNext.includes(normalizedCurrent)) {
    return next;
  }

  return `${current}\n\n---\nAdditional transcript upload:\n${next}`;
}

function mergeMarkdownNote(existing?: string | null, incoming?: string | null) {
  const current = existing?.trim() ?? "";
  const next = incoming?.trim() ?? "";
  if (!next) return current || null;
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current}\n\nAdditional guidance:\n${next}`;
}

function chooseMergedTitle(existing?: string | null, incoming?: string | null) {
  const current = existing?.trim() ?? "";
  const next = incoming?.trim() ?? "";
  if (!next) return current || null;
  if (!current || normalizeTitle(current) === "untitled meeting") return next;
  return current;
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

function normalizeMeetingUrl(value: string) {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.hostname.includes("zoom.us")) {
      url.searchParams.sort();
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

function meetingUrlHash(value: string) {
  return createHash("sha256").update(normalizeMeetingUrl(value)).digest("hex");
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
  meetingUrlHash?: string | null;
  calendarExternalId?: string | null;
}) {
  const start = new Date(params.recordedAt.getTime() - TRANSCRIPT_MATCH_WINDOW_MS);
  const end = new Date(params.recordedAt.getTime() + TRANSCRIPT_MATCH_WINDOW_MS);
  const title = normalizeTitle(params.title);
  const participantEmails = normalizeEmails(params.participantEmails);
  const candidates = await prisma.meeting.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: { in: ["SCHEDULED", "COMPLETED"] },
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
    const urlScore = params.meetingUrlHash && meeting.meetingUrlHash === params.meetingUrlHash ? 0.15 : 0;
    const calendarScore = params.calendarExternalId?.trim() && meeting.calendarExternalId === params.calendarExternalId.trim() ? 0.15 : 0;
    const score = Number(Math.min(1, titleScore + timeScore + attendeeScore + urlScore + calendarScore).toFixed(3));
    const reason = [
      titleScore > 0 ? "title" : null,
      timeScore > 0 ? "time" : null,
      attendeeScore > 0.05 ? "attendees" : null,
      urlScore > 0 ? "meeting URL" : null,
      calendarScore > 0 ? "calendar id" : null,
    ].filter(Boolean).join(", ");

    return {
      meetingId: meeting.id,
      title: meeting.title,
      status: meeting.status,
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
    source?: string | null;
    recordedAt?: Date | null;
    transcript: string;
    summaryMd?: string | null;
    ingestionGuidanceMd?: string | null;
    participantIds?: string[] | null;
    participantEmails?: string[] | null;
    externalId?: string | null;
    calendarExternalId?: string | null;
    meetingUrl?: string | null;
    replaceTranscript?: boolean;
  }
) {
  const existing = await tx.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
    select: {
      id: true,
      title: true,
      transcript: true,
      summaryMd: true,
      ingestionGuidanceMd: true,
      participantIds: true,
      participantEmails: true,
      source: true,
      externalId: true,
      calendarExternalId: true,
      meetingUrl: true,
      meetingUrlHash: true,
    },
  });
  invariant(existing, 404, "NOT_FOUND", "Meeting not found.");

  const transcript = params.replaceTranscript ? params.transcript.trim() : mergeTranscript(existing.transcript, params.transcript);
  const ingestionGuidanceMd = mergeMarkdownNote(existing.ingestionGuidanceMd, params.ingestionGuidanceMd);
  const participantIds = normalizeIds([
    ...existing.participantIds,
    ...(params.participantIds ?? []),
  ]);
  const participantEmails = normalizeEmails([
    ...existing.participantEmails,
    ...(params.participantEmails ?? []),
  ]);
  const title = chooseMergedTitle(existing.title, params.title);
  const source = params.source?.trim() || existing.source;
  const meetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : existing.meetingUrl;
  const externalId = existing.externalId || params.externalId?.trim() || null;
  const calendarExternalId = existing.calendarExternalId || params.calendarExternalId?.trim() || null;

  const incomingSummaryMd = params.summaryMd?.trim() || null;
  const meeting = await tx.meeting.update({
    where: { id: params.meetingId },
    data: {
      status: "COMPLETED",
      title,
      source,
      externalId,
      calendarExternalId,
      meetingUrl,
      meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : existing.meetingUrlHash,
      recordedAt: params.recordedAt && !Number.isNaN(params.recordedAt.valueOf()) ? params.recordedAt : undefined,
      transcript,
      summaryMd: incomingSummaryMd || existing.summaryMd || undefined,
      ingestionGuidanceMd,
      participantIds,
      participantEmails,
      aiProcessedAt: null,
    },
  });

  await tx.meetingInsight.deleteMany({
    where: {
      meetingId: meeting.id,
      workspaceId: params.workspaceId,
      status: "SUGGESTED",
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
        hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
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
        hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
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
  const meeting = await prisma.meeting.findFirst({
    where: {
      id: meetingId,
      workspaceId,
      archivedAt: null,
    },
    include: {
      series: true,
      insights: {
        orderBy: [
          { sourceRecordedAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
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
  if (!meeting) return null;

  const raisedActionIds = [...new Set(meeting.insights
    .filter((insight) => (
      insight.status === "APPLIED"
      && insight.appliedEntityType === "Action"
      && insight.appliedEntityId
      && insight.operation === "CREATE"
      && (insight.type === "ACTION_ITEM" || insight.type === "FOLLOW_UP")
    ))
    .map((insight) => insight.appliedEntityId as string))];
  const raisedActions = raisedActionIds.length > 0
    ? await prisma.action.findMany({
      where: {
        workspaceId,
        id: { in: raisedActionIds },
        archivedAt: null,
      },
      include: {
        author: {
          select: {
            displayName: true,
            email: true,
          },
        },
        assigneeMember: {
          include: {
            user: {
              select: {
                displayName: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    })
    : [];

  return {
    ...meeting,
    raisedActions,
  };
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

export async function createScheduledMeeting(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  startsAt: Date;
  scheduledEndAt?: Date | null;
  meetingUrl?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
  source?: string | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const title = params.title.trim();
  const source = params.source?.trim() || "manual";
  const meetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : null;
  invariant(title.length > 0, 400, "INVALID_INPUT", "Meeting title is required.");
  invariant(!Number.isNaN(params.startsAt.valueOf()), 400, "INVALID_INPUT", "startsAt must be a valid date.");
  invariant(!params.scheduledEndAt || !Number.isNaN(params.scheduledEndAt.valueOf()), 400, "INVALID_INPUT", "scheduledEndAt must be a valid date.");
  invariant(!params.scheduledEndAt || params.scheduledEndAt > params.startsAt, 400, "INVALID_INPUT", "scheduledEndAt must be after startsAt.");

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.create({
      data: {
        workspaceId: params.workspaceId,
        status: "SCHEDULED",
        title,
        source,
        recordedAt: params.startsAt,
        scheduledEndAt: params.scheduledEndAt ?? null,
        transcript: null,
        summaryMd: null,
        meetingUrl,
        meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : null,
        participantIds: normalizeIds(params.participantIds),
        participantEmails: normalizeEmails(params.participantEmails),
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.scheduled",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          source: meeting.source,
          recordedAt: meeting.recordedAt.toISOString(),
          hasMeetingUrl: Boolean(meeting.meetingUrl),
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "meeting.scheduled",
        aggregateType: "Meeting",
        aggregateId: meeting.id,
        payload: {
          meetingId: meeting.id,
          title: meeting.title,
          source: meeting.source,
          status: meeting.status,
          hasMeetingUrl: Boolean(meeting.meetingUrl),
        },
      },
    ]);

    return meeting;
  });
}

export async function discardManualScheduledMeeting(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.findFirst({
      where: {
        id: params.meetingId,
        workspaceId: params.workspaceId,
        status: "SCHEDULED",
        source: "manual-recorder",
        archivedAt: null,
      },
      select: {
        id: true,
        recordings: {
          where: { status: { in: ACTIVE_RECORDING_STATUSES_FOR_CLEANUP } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!meeting) {
      return { id: params.meetingId, deleted: false };
    }
    invariant(meeting.recordings.length === 0, 409, "RECORDER_ALREADY_SCHEDULING", "Manual meeting has an active recorder.");

    await tx.meeting.delete({ where: { id: meeting.id } });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.manual_schedule_discarded",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          reason: "Recorder scheduling failed before the manual meeting could be finalized.",
        },
      },
    });

    await appendEvents(tx, [
      {
        workspaceId: params.workspaceId,
        type: "meeting.manual_schedule_discarded",
        aggregateType: "Meeting",
        aggregateId: meeting.id,
        payload: {
          meetingId: meeting.id,
          reason: "recorder_scheduling_failed",
        },
      },
    ]);

    return { id: meeting.id, deleted: true };
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
  externalId?: string | null;
  calendarExternalId?: string | null;
  meetingUrl?: string | null;
  recordedAt: Date;
  transcript: string;
  summaryMd?: string | null;
  ingestionGuidanceMd?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
  replaceTranscript?: boolean;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  invariant(params.transcript.trim().length > 0, 400, "INVALID_INPUT", "Transcript is required.");
  const normalizedMeetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : null;
  const normalizedMeetingUrlHash = normalizedMeetingUrl ? meetingUrlHash(normalizedMeetingUrl) : null;

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

  const directMatchClauses: Prisma.MeetingWhereInput[] = [];
  if (params.externalId?.trim()) {
    directMatchClauses.push({ externalId: params.externalId.trim() });
  }
  if (directMatchClauses.length > 0) {
    const directMatch = await prisma.meeting.findFirst({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        OR: directMatchClauses,
      },
      select: { id: true },
    });
    if (directMatch) {
      const meeting = await prisma.$transaction((tx) => updateMeetingWithTranscriptTx(tx, actor, {
        ...params,
        meetingId: directMatch.id,
        meetingUrl: normalizedMeetingUrl,
      }));
      return { status: "matched" as const, meeting, candidates: [] };
    }
  }

  const candidates = await findTranscriptMeetingCandidatesInternal({
    ...params,
    meetingUrlHash: normalizedMeetingUrlHash,
    calendarExternalId: params.calendarExternalId,
  });
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
    externalId: params.externalId,
    calendarExternalId: params.calendarExternalId,
    meetingUrl: normalizedMeetingUrl,
    recordedAt: params.recordedAt,
    transcript: params.transcript,
    summaryMd: params.summaryMd,
    ingestionGuidanceMd: params.ingestionGuidanceMd,
    participantIds: params.participantIds ?? [],
    participantEmails: params.participantEmails ?? [],
  });

  return { status: "created" as const, meeting, candidates: [] };
}

export async function requestMeetingIntelligenceRegeneration(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  guidanceMd: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const guidanceMd = params.guidanceMd.trim();
  invariant(guidanceMd.length > 0, 400, "INVALID_INPUT", "Tell the AI what is missing or should change before regenerating meeting intelligence.");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      select: {
        id: true,
        title: true,
        source: true,
        status: true,
        transcript: true,
        ingestionGuidanceMd: true,
      },
    });
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");
    invariant(existing.transcript, 400, "INVALID_STATE", "Meeting has no transcript to regenerate.");

    const meeting = await tx.meeting.update({
      where: { id: existing.id },
      data: {
        ingestionGuidanceMd: mergeMarkdownNote(existing.ingestionGuidanceMd, guidanceMd),
        aiProcessedAt: null,
      },
    });

    await tx.meetingInsight.deleteMany({
      where: {
        meetingId: meeting.id,
        workspaceId: params.workspaceId,
        status: "SUGGESTED",
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.intelligence-regeneration-requested",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          hasGuidance: true,
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
          hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
        },
      },
    ]);

    return meeting;
  });
}

export async function createMeeting(actor: AppActor, params: {
  workspaceId: string;
  title?: string | null;
  source: string;
  externalId?: string | null;
  calendarExternalId?: string | null;
  meetingUrl?: string | null;
  recordedAt: Date;
  scheduledEndAt?: Date | null;
  transcript?: string | null;
  summaryMd?: string | null;
  ingestionGuidanceMd?: string | null;
  participantIds?: string[];
  participantEmails?: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const source = params.source.trim();
  const meetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : null;
  invariant(source.length > 0, 400, "INVALID_INPUT", "Meeting source is required.");
  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");

  return prisma.$transaction(async (tx) => {
    const meeting = await tx.meeting.create({
      data: {
        workspaceId: params.workspaceId,
        title: params.title?.trim() || null,
        source,
        externalId: params.externalId?.trim() || null,
        calendarExternalId: params.calendarExternalId?.trim() || null,
        meetingUrl,
        meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : null,
        status: "COMPLETED",
        recordedAt: params.recordedAt,
        scheduledEndAt: params.scheduledEndAt ?? null,
        transcript: params.transcript?.trim() || null,
        summaryMd: params.summaryMd?.trim() || null,
        ingestionGuidanceMd: params.ingestionGuidanceMd?.trim() || null,
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
          hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
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
          hasIngestionGuidance: Boolean(meeting.ingestionGuidanceMd),
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
