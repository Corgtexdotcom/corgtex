import { lockCompanyTranscriptPublication, finishCompanyTranscriptPublication } from "./native-transcript-publication";
import { createHash, randomUUID } from "node:crypto";
import ICAL from "ical.js";
import { prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import type { Meeting, MeetingStatus, Prisma } from "@prisma/client";
import { appendEvents } from "./events";
import { requireWorkspaceMembership } from "./auth";
import { archiveFilterWhere, archiveWorkspaceArtifact, type ArchiveFilter } from "./archive";
import { ensureWorkspacePermalink, workspaceEntityCanonicalPath } from "./permalinks";
import { invariant } from "./errors";
import { captureArtifactInputProof, captureArtifactInputSnapshotProof, captureImmutableArtifactInputProof, currentArtifactInputRoots, invalidateArtifactInputLineage, lineageContentFingerprint, preserveUnknownArtifactInputSnapshot, readableArtifactIds, recordArtifactInputLineage, type LineageKind, type LineageRoot } from "./source-lineage";
import { finishProducerLineage, prepareProducerLineage, type ProducerLineageParams } from "./producer-lineage";
import { meetingAgendaInputProjection, meetingTranscriptInputProjection, readMeetingInputBatches } from "./meeting-intelligence-context";
import { requireMeetingProcessedContentEditor } from "./collaborative-permissions";
import { humanMemberIdentityWhere } from "./member-identity";
import { DigestReadRelease } from "./digest-lineage";
import { sealArtifactInputActor } from "./artifact-input-actor";
import { extractSupportedMeetingUrlFromText, meetingUrlHash, normalizeMeetingUrl, normalizeRecorderMeetingUrl } from "./meeting-urls";
import { getRecorderTranscriptWorkerPurpose } from "./native-transcript-principal";
import { resetMeetingTranscriptProcessingProgress } from "./meeting-transcript-processing";
import {
  checkWorkspaceDuplicateGuard,
  duplicateGuardAuditMeta,
  type DuplicateGuardOptions,
} from "./duplicate-guard";

const DEFAULT_OCCURRENCE_LOOKBACK_DAYS = 14;
const DEFAULT_OCCURRENCE_LOOKAHEAD_DAYS = 60;
const TRANSCRIPT_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;
const TRANSCRIPT_AUTO_MATCH_THRESHOLD = 0.65;
const TRANSCRIPT_MATCH_MARGIN = 0.1;

// Proofs compare the complete canonical profile fingerprint. Only the existing
// public label fields are projected into meeting responses after admission.
const MEETING_PROFILE_INPUT_SELECT = { id: true, email: true, displayName: true,
  bio: true, avatarUrl: true, linkedinUrl: true, websiteUrl: true, createdAt: true, updatedAt: true } satisfies Prisma.UserSelect;
function meetingProfileLabel(user: { id: string; email: string; displayName: string | null }) {
  return { id: user.id, displayName: user.displayName, email: user.email };
}

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
  meetingUrl: string | null;
  meetingUrlHash: string | null;
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

function normalizeSeriesRecorderUrl(value?: string | null) {
  if (!value?.trim()) return null;
  const recorderUrl = normalizeRecorderMeetingUrl(value);
  invariant(recorderUrl?.providerSchedulable, 400, "UNSUPPORTED_MEETING_URL", "Paste a supported live meeting link.");
  return recorderUrl.url;
}

function normalizeTranscriptForCompare(value?: string | null) {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function mergeMeetingTranscript(existing: string | null | undefined, incoming: string) {
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

async function preserveMeetingPriorRevision(tx: Prisma.TransactionClient, actor: AppActor, workspaceId: string,
  kind: "Meeting" | "MeetingTranscript", row: Record<string, unknown>, receiptMode: string) {
  const artifact = { kind, id: String(row.id) };
  if (!await currentArtifactInputRoots(tx, workspaceId, artifact, row)) {
    await preserveUnknownArtifactInputSnapshot(tx, workspaceId, artifact, row);
  } else if (receiptMode !== "DERIVED") {
    await captureArtifactInputSnapshotProof(actor, workspaceId,
      { ...artifact, fingerprint: lineageContentFingerprint(kind, row) }, tx);
  }
}

function mergeMarkdownNote(existing?: string | null, incoming?: string | null) {
  const current = existing?.trim() ?? "";
  const next = incoming?.trim() ?? "";
  if (!next) return current || null;
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current}\n\nAdditional guidance:\n${next}`;
}

function normalizeProcessedContentValue(value: string | null | undefined) {
  return value?.trim() || null;
}

function isPrismaNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2025";
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

function workspaceScopedMeetingExternalId(workspaceId: string, externalId?: string | null) {
  const trimmed = externalId?.trim();
  if (!trimmed) return null;
  const prefix = `workspace:${workspaceId}:`;
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
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

async function lockMeetingSeriesTx(tx: Prisma.TransactionClient, workspaceId: string, seriesId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "MeetingSeries" WHERE "id" = ${seriesId} AND "workspaceId" = ${workspaceId} FOR UPDATE
  `;
  invariant(locked.length === 1, 409, "SOURCE_CHANGED", "A meeting series changed during materialization.");
}

async function lockMeetingInviteIdentityTx(tx: Prisma.TransactionClient, workspaceId: string, externalId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${externalId}))::text AS locked`;
}

async function materializeMeetingSeriesOccurrencesTx(
  tx: Prisma.TransactionClient,
  series: MeetingSeriesForExpansion,
  params?: { from?: Date; to?: Date; createdIds?: Set<string>; actor?: AppActor }
) {
  await lockMeetingSeriesTx(tx, series.workspaceId, series.id);
  const seriesSnapshot = structuredClone(series);
  const from = params?.from ?? seriesSnapshot.startsAt;
  const to = params?.to ?? addDays(new Date(), DEFAULT_OCCURRENCE_LOOKAHEAD_DAYS);
  const component = componentForSeries(seriesSnapshot);
  const occurrences = expandIcsEvent(component, {
    from,
    to,
    externalIdPrefix: `meeting-series:${seriesSnapshot.id}`,
  });

  const actor = params?.actor ?? { kind: "agent" as const, authProvider: "bootstrap" as const,
    label: "meeting-series-materialization", workspaceIds: [seriesSnapshot.workspaceId] };
  const receipt = await prepareProducerLineage({ tx, actor, workspaceId: seriesSnapshot.workspaceId,
    dependencies: [{ kind: "MeetingSeries", id: seriesSnapshot.id, snapshot: seriesSnapshot as unknown as Record<string, unknown> }], completeCopy: true });

  const meetings: Meeting[] = [];
  for (const occurrence of occurrences) {
    const meetingId = randomUUID();
    const inserted = await tx.$executeRaw`
      INSERT INTO "Meeting" (
        "id",
        "workspaceId",
        "seriesId",
        "status",
        "title",
        "source",
        "externalId",
        "calendarExternalId",
        "meetingUrl",
        "meetingUrlHash",
        "recordedAt",
        "scheduledEndAt",
        "participantIds",
        "participantEmails",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${meetingId},
        ${seriesSnapshot.workspaceId},
        ${seriesSnapshot.id},
        'SCHEDULED'::"MeetingStatus",
        ${seriesSnapshot.title},
        ${seriesSnapshot.source},
        ${occurrence.externalId},
        ${occurrence.calendarExternalId},
        ${seriesSnapshot.meetingUrl},
        ${seriesSnapshot.meetingUrlHash},
        ${occurrence.start},
        ${occurrence.end},
        ${seriesSnapshot.participantIds},
        ${seriesSnapshot.participantEmails},
        NOW(),
        NOW()
      )
      ON CONFLICT ("externalId") DO NOTHING
    `;
    const meeting = await tx.meeting.findUnique({
      where: { externalId: occurrence.externalId },
    });
    invariant(meeting && meeting.workspaceId === seriesSnapshot.workspaceId && meeting.seriesId === seriesSnapshot.id,
      409, "SOURCE_CHANGED", "Unable to verify the recurring meeting occurrence.");
    if (inserted > 0) {
      await finishProducerLineage({ tx, actor, workspaceId: seriesSnapshot.workspaceId,
        artifact: { kind: "Meeting", id: meeting.id }, content: meeting, receipt });
      params?.createdIds?.add(meeting.id);
    }
    meetings.push(meeting);
  }

  return meetings;
}

type FrozenSeriesChild = {
  meeting: Meeting;
  meetingProof: LineageRoot[] | null;
  transcriptProof: LineageRoot[] | null;
};

async function freezeMeetingSourceRevision(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, kind: "Meeting" | "MeetingTranscript" | "MeetingSeries", row: Record<string, unknown>) {
  const artifact = { kind, id: String(row.id) };
  const roots = await currentArtifactInputRoots(tx, workspaceId, artifact, row);
  if (!roots) {
    await preserveUnknownArtifactInputSnapshot(tx, workspaceId, artifact, row);
    return null;
  }
  return captureImmutableArtifactInputProof(actor, workspaceId,
    [{ ...artifact, fingerprint: lineageContentFingerprint(kind, row) }], tx);
}

/** Capture every still-visible child before a mutable series revision changes. */
async function freezeSeriesChildrenTx(tx: Prisma.TransactionClient, actor: AppActor,
  workspaceId: string, seriesId: string): Promise<FrozenSeriesChild[]> {
  const meetings = await readMeetingInputBatches((page) => tx.meeting.findMany({
    where: { workspaceId, seriesId, archivedAt: null }, orderBy: { id: "asc" }, ...page,
  }), async (rows) => rows);
  const frozen: FrozenSeriesChild[] = [];
  for (const meeting of meetings) {
    const meetingProof = await freezeMeetingSourceRevision(tx, actor, workspaceId, "Meeting", meeting);
    const transcriptProof = meeting.transcript ? await freezeMeetingSourceRevision(tx, actor,
      workspaceId, "MeetingTranscript", meetingTranscriptInputProjection(meeting)) : null;
    frozen.push({ meeting, meetingProof, transcriptProof });
  }
  return frozen;
}

async function finishSeriesChildrenTx(tx: Prisma.TransactionClient, actor: AppActor, params: {
  workspaceId: string;
  children: FrozenSeriesChild[];
  meetingUrl?: string | null;
  meetingUrlHash?: string | null;
  previousMeetingUrlHash?: string | null;
  now: Date;
  newSeriesRoot: LineageRoot | null;
}) {
  let count = 0;
  for (const { meeting: old, meetingProof, transcriptProof } of params.children) {
    const eligible = params.meetingUrl != null && old.status === "SCHEDULED" && old.recordedAt >= params.now
      && old.transcript == null && old.summaryMd == null
      && (old.meetingUrl == null || Boolean(params.previousMeetingUrlHash && old.meetingUrlHash === params.previousMeetingUrlHash));
    const changedUrl = eligible && (old.meetingUrl !== params.meetingUrl || old.meetingUrlHash !== params.meetingUrlHash);
    let next = await tx.meeting.findFirst({ where: { id: old.id, workspaceId: params.workspaceId, archivedAt: null } });
    invariant(next && lineageContentFingerprint("Meeting", next) === lineageContentFingerprint("Meeting", old),
      409, "SOURCE_CHANGED", "A meeting changed while its series was being updated.");
    if (changedUrl) {
      next = await tx.meeting.update({ where: { id: old.id, updatedAt: old.updatedAt },
        data: { meetingUrl: params.meetingUrl, meetingUrlHash: params.meetingUrlHash } });
      count++;
    }
    if (meetingProof && (!changedUrl || params.newSeriesRoot)) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Meeting", id: old.id }, content: next, origin: "DERIVED", inputs: [],
        inheritedRoots: [...meetingProof, ...(changedUrl && params.newSeriesRoot ? [params.newSeriesRoot] : [])] });
    } else if (changedUrl) {
      await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
        artifact: { kind: "Meeting", id: old.id }, content: next });
    }
    if (old.transcript && transcriptProof) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "MeetingTranscript", id: old.id }, content: meetingTranscriptInputProjection(next),
        origin: "DERIVED", inputs: [], inheritedRoots: transcriptProof });
    }
  }
  return { count };
}

export async function ensureMeetingSeriesOccurrences(params: {
  workspaceId: string;
  from?: Date;
  to?: Date;
  reason?: string | null;
}) {
  const now = new Date();
  const from = params.from ?? addDays(now, -DEFAULT_OCCURRENCE_LOOKBACK_DAYS);
  const to = params.to ?? addDays(now, DEFAULT_OCCURRENCE_LOOKAHEAD_DAYS);
  invariant(!Number.isNaN(from.valueOf()), 400, "INVALID_INPUT", "from must be a valid date.");
  invariant(!Number.isNaN(to.valueOf()), 400, "INVALID_INPUT", "to must be a valid date.");
  invariant(to >= from, 400, "INVALID_INPUT", "to must be on or after from.");

  const seriesList = await prisma.meetingSeries.findMany({
    where: {
      workspaceId: params.workspaceId,
      archivedAt: null,
      recurrenceRule: { not: null },
    },
    orderBy: { startsAt: "asc" },
  });

  const createdIds = new Set<string>();
  const meetings = await prisma.$transaction(async (tx) => {
    const materialized: Meeting[] = [];
    for (const series of seriesList) {
      const current = await tx.meetingSeries.findFirst({ where: { id: series.id, workspaceId: params.workspaceId, archivedAt: null } });
      invariant(current, 409, "SOURCE_CHANGED", "A meeting series changed before occurrence materialization.");
      materialized.push(...await materializeMeetingSeriesOccurrencesTx(tx, current, { from, to, createdIds }));
    }
    return materialized;
  });

  return {
    workspaceId: params.workspaceId,
    from,
    to,
    reason: params.reason ?? null,
    seriesCount: seriesList.length,
    meetingCount: meetings.length,
    createdCount: createdIds.size,
    meetings,
  };
}

export async function enqueueMeetingSeriesMaterialization(params: {
  workspaceId: string;
  runAfter?: Date;
  date?: Date;
}) {
  const date = params.date ?? params.runAfter ?? new Date();
  const dateISO = date.toISOString().slice(0, 10);
  const dedupeKey = `meeting-series-materialize:${params.workspaceId}:${dateISO}`;
  return prisma.workflowJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      type: "meeting.series.materialize",
      payload: {
        reason: "daily-recurring-series-repair",
      },
      runAfter: params.runAfter ?? new Date(),
      dedupeKey,
    },
  });
}

async function findTranscriptMeetingCandidatesInternal(actor: AppActor, params: {
  workspaceId: string;
  title?: string | null;
  recordedAt: Date;
  participantEmails?: string[] | null;
  meetingUrlHash?: string | null;
  calendarExternalId?: string | null;
}, db: Prisma.TransactionClient = prisma as Prisma.TransactionClient) {
  const start = new Date(params.recordedAt.getTime() - TRANSCRIPT_MATCH_WINDOW_MS);
  const end = new Date(params.recordedAt.getTime() + TRANSCRIPT_MATCH_WINDOW_MS);
  const title = normalizeTitle(params.title);
  const participantEmails = normalizeEmails(params.participantEmails);
  const candidates = await readMeetingInputBatches((page) => db.meeting.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: { in: ["SCHEDULED", "COMPLETED"] },
      archivedAt: null,
      recordedAt: { gte: start, lte: end },
    },
    orderBy: [{ recordedAt: "asc" }, { id: "asc" }], ...page,
  }), (rows) => projectMeetingsForReader(actor, params.workspaceId, rows, db), 20);
  const candidateParticipantIds = [...new Set(candidates.flatMap((meeting) => meeting.participantIds ?? []))];
  const memberEmailsByParticipantId = new Map<string, string>();
  if (candidateParticipantIds.length > 0) {
    const members = await db.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        OR: [
          { id: { in: candidateParticipantIds } },
          { userId: { in: candidateParticipantIds } },
        ],
      },
      include: { user: { select: MEETING_PROFILE_INPUT_SELECT } },
    });
    const [visibleMembers, visibleUsers] = await Promise.all([
      readableArtifactIds(actor, params.workspaceId, "Member", members.map((member) => ({ ...member, user: meetingProfileLabel(member.user) })), db),
      readableArtifactIds(actor, params.workspaceId, "User", members.map((member) => member.user), db),
    ]);
    for (const member of members) {
      if (!visibleMembers.has(member.id) || !visibleUsers.has(member.user.id)) continue;
      const email = member.user.email.trim().toLowerCase();
      memberEmailsByParticipantId.set(member.id, email);
      memberEmailsByParticipantId.set(member.userId, email);
    }
  }

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
    const meetingEmails = new Set([
      ...normalizeEmails(meeting.participantEmails),
      ...(meeting.participantIds ?? []).flatMap((id) => {
        const email = memberEmailsByParticipantId.get(id);
        return email ? [email] : [];
      }),
    ]);
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
  params: ProducerLineageParams & {
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
    sourceRecordId?: string | null;
    replaceTranscript?: boolean;
    allowTranscriptAppend?: boolean;
    copied?: boolean;
  }
) {
  await lockCompanyTranscriptPublication(tx, actor, params.workspaceId, params.meetingId);
  const existing = await tx.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
  });
  invariant(existing, 404, "NOT_FOUND", "Meeting not found.");

  const hasExistingTranscript = Boolean(existing.transcript?.trim());
  const trustedTranscriptAppend = params.allowTranscriptAppend === true
    && Boolean(getRecorderTranscriptWorkerPurpose(actor, params.workspaceId));
  invariant(
    !hasExistingTranscript || (trustedTranscriptAppend && !params.replaceTranscript),
    400,
    "INVALID_STATE",
    "Meeting already has source transcript evidence. Edit the processed summary or guidance instead.",
  );
  const transcript = params.replaceTranscript ? params.transcript.trim() : mergeMeetingTranscript(existing.transcript, params.transcript);
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
  const externalId = existing.externalId || workspaceScopedMeetingExternalId(params.workspaceId, params.externalId);
  const calendarExternalId = existing.calendarExternalId || params.calendarExternalId?.trim() || null;
  const copied = params.copied === true || Boolean(params.sourceRecordId) || actor.kind === "agent";
  const priorTranscript = meetingTranscriptInputProjection(existing);
  // The first transcript merges scheduled title, time, and participants into its
  // input projection. Capture that exact prior Meeting revision before calling
  // the new transcript an original; an unproved calendar row cannot be adopted.
  const scheduledInput = hasExistingTranscript ? [] : [{ kind: "Meeting" as const, id: existing.id }];
  const transcriptReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    ...(hasExistingTranscript ? { artifact: { kind: "MeetingTranscript" as const, id: existing.id }, before: priorTranscript } : {}),
    capture: params, copied: copied || scheduledInput.length > 0,
    completeCopy: scheduledInput.length > 0 && actor.kind === "user" && !copied,
    dependencies: scheduledInput, snapshotDependencies: scheduledInput });
  invariant(transcriptReceipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Transcript changes require complete source proof.");
  const meetingReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "Meeting", id: existing.id }, before: existing, capture: params, copied });
  await preserveMeetingPriorRevision(tx, actor, params.workspaceId, "Meeting", existing, meetingReceipt.mode);
  if (hasExistingTranscript) await preserveMeetingPriorRevision(tx, actor, params.workspaceId,
    "MeetingTranscript", priorTranscript, transcriptReceipt.mode);

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
  const nativePublicationManifest = await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), receipt: transcriptReceipt });
  await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "Meeting", id: meeting.id }, content: meeting, receipt: meetingReceipt });

  await finishCompanyTranscriptPublication(tx, actor, params.workspaceId, nativePublicationManifest);

  await tx.meetingInsight.deleteMany({
    where: {
      meetingId: meeting.id,
      workspaceId: params.workspaceId,
      status: "SUGGESTED",
      sourceRecordId: null,
    },
  });

  if (params.sourceRecordId) {
    await tx.meetingTranscriptSourceRecord.updateMany({
      where: {
        id: params.sourceRecordId,
        workspaceId: params.workspaceId,
      },
      data: {
        meetingId: meeting.id,
      },
    });
  }

  await resetMeetingTranscriptProcessingProgress(tx, {
    workspaceId: params.workspaceId,
    meetingId: meeting.id,
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
        sourceRecordId: params.sourceRecordId ?? null,
      },
    },
  ]);

  return meeting;
}

export type ListMeetingsOptions = {
  take?: number;
  archiveFilter?: ArchiveFilter;
  status?: MeetingStatus;
  memberId?: string | null;
  memberIds?: string[] | null;
  recordedFrom?: Date;
  recordedTo?: Date;
};

function meetingDateRangeWhere(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  const filter: Prisma.DateTimeFilter = {};
  if (from) filter.gte = from;
  if (to) filter.lte = to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

async function captureMeetingReaderRows<T extends { id: string }>(actor: AppActor, workspaceId: string,
  kind: LineageKind, records: T[], release: DigestReadRelease) {
  return release.observeRead(async () => {
    const ids = await readableArtifactIds(actor, workspaceId, kind, records);
    const selected = records.filter(row => ids.has(row.id));
    release.add(await captureArtifactInputProof(actor, workspaceId,
      selected.map(row => ({ kind, id: row.id, snapshot: row }))));
    return selected;
  });
}

async function projectMeetingsForReader<T extends { id: string }>(actor: AppActor, workspaceId: string, meetings: T[], db?: Prisma.TransactionClient, release?: DigestReadRelease) {
  const admit = async <R extends { id: string }>(kind: "MeetingTranscript" | "Meeting" | "MeetingAgenda", records: R[]) => {
    if (!release) return readableArtifactIds(actor, workspaceId, kind, records, db);
    return new Set((await captureMeetingReaderRows(actor, workspaceId, kind, records, release)).map(row => row.id));
  };
  const rawIds = await admit("MeetingTranscript",
    meetings.map((meeting) => meetingTranscriptInputProjection(meeting) as { id: string }));
  const derivedIds = await admit("Meeting", meetings);
  const agendaIds = await admit("MeetingAgenda",
    meetings.map((meeting) => meetingAgendaInputProjection(meeting) as { id: string }));
  return meetings.filter((meeting) => (meeting as { transcript?: unknown }).transcript
    ? rawIds.has(meeting.id) : derivedIds.has(meeting.id)).map((meeting) => {
    const projected = { ...meeting } as T & { summaryMd?: string | null; blocksJson?: unknown; decisionsJson?: unknown; agendaJson?: unknown };
    if (!derivedIds.has(meeting.id)) {
      if ("summaryMd" in projected) projected.summaryMd = null;
      if ("blocksJson" in projected) projected.blocksJson = null;
      if ("decisionsJson" in projected) projected.decisionsJson = null;
    }
    if (!agendaIds.has(meeting.id) && "agendaJson" in projected) projected.agendaJson = null;
    return projected;
  });
}

export async function listMeetings(actor: AppActor, workspaceId: string, opts?: ListMeetingsOptions) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const memberIds = [...new Set([...(opts?.memberIds ?? []), opts?.memberId]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value)))];
  const members = memberIds.length > 0
    ? await prisma.member.findMany({
      where: {
        id: { in: memberIds },
        workspaceId,
        isActive: true,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    })
    : [];
  const participantIds = [...new Set([
    ...memberIds,
    ...members.map((member) => member.userId),
  ])];
  const participantEmails = [...new Set(members.map((member) => member.user.email))];
  const recordedAt = meetingDateRangeWhere(opts?.recordedFrom, opts?.recordedTo);
  const release = new DigestReadRelease(actor, workspaceId);
  const meetings = await readMeetingInputBatches((page) => prisma.meeting.findMany({
    where: {
      workspaceId,
      ...(opts?.status ? { status: opts.status } : {}),
      ...(recordedAt ? { recordedAt } : {}),
      ...(memberIds.length > 0
        ? {
          OR: [
            ...(participantIds.length > 0 ? [{ participantIds: { hasSome: participantIds } }] : []),
            ...(participantEmails.length > 0 ? [{ participantEmails: { hasSome: participantEmails } }] : []),
          ],
        }
        : {}),
      ...archiveFilterWhere(opts?.archiveFilter),
    },
    orderBy: [{ recordedAt: opts?.status === "SCHEDULED" ? "asc" : "desc" }, { id: "asc" }], ...page,
  }), (rows) => projectMeetingsForReader(actor, workspaceId, rows, undefined, release), opts?.take);
  return release.finish(meetings);
}

export async function listUpcomingMeetings(actor: AppActor, workspaceId: string, opts?: { from?: Date; to?: Date; take?: number }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const from = opts?.from ?? new Date();
  const to = opts?.to ?? addDays(from, DEFAULT_OCCURRENCE_LOOKAHEAD_DAYS);
  const release = new DigestReadRelease(actor, workspaceId);
  const meetings = await readMeetingInputBatches((page) => prisma.meeting.findMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: { gte: from, lte: to },
    },
    orderBy: [{ recordedAt: "asc" }, { id: "asc" }], ...page,
  }), (rows) => projectMeetingsForReader(actor, workspaceId, rows, undefined, release), opts?.take);
  return release.finish(meetings);
}

export async function getMeeting(actor: AppActor, workspaceId: string, meetingId: string, opts?: { includeArchived?: boolean }) {
  await requireWorkspaceMembership({ actor, workspaceId });
  const meeting = await prisma.meeting.findFirst({ where: { id: meetingId, workspaceId,
    ...(opts?.includeArchived ? {} : { archivedAt: null }) }, include: { series: true } });
  if (!meeting) return null;
  const release = new DigestReadRelease(actor, workspaceId);
  const projectedMeeting = (await projectMeetingsForReader(actor, workspaceId, [meeting], undefined, release))[0];
  if (!projectedMeeting) return null;
  const admit = <T extends { id: string }>(kind: "MeetingInsight" | "Proposal" | "Tension" | "Action") => async (rows: T[]) => {
    return captureMeetingReaderRows(actor, workspaceId, kind, rows, release);
  };
  const hasDerivedReceipt = (await captureMeetingReaderRows(actor, workspaceId, "Meeting", [meeting], release)).length > 0;
  const [insights, proposalRows, tensions, visibleSeries] = await Promise.all([
    hasDerivedReceipt ? readMeetingInputBatches((page) => prisma.meetingInsight.findMany({ where: { workspaceId, meetingId },
      orderBy: [{ sourceRecordedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }], ...page }),
    admit("MeetingInsight")) : Promise.resolve([]),
    readMeetingInputBatches((page) => prisma.proposal.findMany({ where: { workspaceId, meetingId, archivedAt: null },
      include: { author: { select: MEETING_PROFILE_INPUT_SELECT } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page }), admit("Proposal")),
    readMeetingInputBatches((page) => prisma.tension.findMany({ where: { workspaceId, meetingId, archivedAt: null },
      include: { author: { select: MEETING_PROFILE_INPUT_SELECT } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page }), admit("Tension")),
    captureMeetingReaderRows(actor, workspaceId, "MeetingSeries", meeting.series ? [meeting.series] : [], release),
  ]);
  if (meeting.series && !visibleSeries.some(row => row.id === meeting.series!.id)) projectedMeeting.series = null;
  const proposals = await Promise.all(proposalRows.map(async (proposal) => {
    const [relatedTensions, relatedActions] = await Promise.all([
      readMeetingInputBatches((page) => prisma.tension.findMany({ where: { workspaceId, proposalId: proposal.id, archivedAt: null },
        orderBy: { id: "asc" }, ...page }), admit("Tension")),
      readMeetingInputBatches((page) => prisma.action.findMany({ where: { workspaceId, proposalId: proposal.id, archivedAt: null },
        orderBy: { id: "asc" }, ...page }), admit("Action")),
    ]);
    return { ...proposal, tensions: relatedTensions, actions: relatedActions };
  }));
  const raisedActionIds = [...new Set(insights.filter((insight) => insight.status === "APPLIED"
    && insight.appliedEntityType === "Action" && insight.appliedEntityId && insight.operation === "CREATE"
    && (insight.type === "ACTION_ITEM" || insight.type === "FOLLOW_UP")).map((insight) => insight.appliedEntityId as string))];
  const raisedActions = raisedActionIds.length ? await readMeetingInputBatches((page) => prisma.action.findMany({
    where: { workspaceId, id: { in: raisedActionIds }, archivedAt: null },
    include: { author: { select: MEETING_PROFILE_INPUT_SELECT },
      assigneeMember: { include: { user: { select: MEETING_PROFILE_INPUT_SELECT } } } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], ...page,
  }), admit("Action")) : [];
  // The labels are native profile inputs, whose current workspace membership is checked independently.
  const users = [...proposals.map((row) => row.author), ...tensions.map((row) => row.author),
    ...raisedActions.flatMap((row) => [row.author, row.assigneeMember?.user])].filter((row): row is NonNullable<typeof row> => Boolean(row));
  const userIds = new Set((await captureMeetingReaderRows(actor, workspaceId, "User", users, release)).map(row => row.id));
  const memberIds = new Set((await captureMeetingReaderRows(actor, workspaceId, "Member", raisedActions.flatMap(row => row.assigneeMember ? [row.assigneeMember] : []), release)).map(row => row.id));
  const redactAuthor = <T extends { author: { id: string; email: string; displayName: string | null } | null }>(row: T) => ({ ...row,
    author: row.author && userIds.has(row.author.id) ? meetingProfileLabel(row.author) : null });
  for (const row of raisedActions) if (row.assigneeMember && (!memberIds.has(row.assigneeMember.id) || !userIds.has(row.assigneeMember.user.id))) row.assigneeMember = null;
  return release.finish({ ...projectedMeeting, insights, proposals: proposals.map(redactAuthor), tensions: tensions.map(redactAuthor),
    raisedActions: raisedActions.map((row) => ({ ...redactAuthor(row), assigneeMember: row.assigneeMember
      ? { ...row.assigneeMember, user: meetingProfileLabel(row.assigneeMember.user) } : null })) });
}

export async function getMeetingParticipants(actor: AppActor, workspaceId: string, participantIds: string[]) {
  await requireWorkspaceMembership({ actor, workspaceId });
  sealArtifactInputActor(actor);
  const release = new DigestReadRelease(actor, workspaceId);
  const participants = await readMeetingInputBatches((page) => prisma.member.findMany({
    where: { workspaceId, OR: [{ id: { in: participantIds } }, { userId: { in: participantIds } }] },
    include: { user: { select: MEETING_PROFILE_INPUT_SELECT }, roleAssignments: { include: { role: true } } },
    orderBy: { id: "asc" }, ...page,
  }), async (rows) => {
    const [members, users, assignments, roles] = await Promise.all([
      release.capture("Member", rows.map((row) => ({ ...row, user: meetingProfileLabel(row.user) }))),
      release.capture("User", rows.map((row) => row.user)),
      release.capture("RoleAssignment", rows.flatMap((row) => row.roleAssignments)),
      release.capture("Role", rows.flatMap((row) => row.roleAssignments.map((assignment) => assignment.role))),
    ]);
    return rows.filter((row) => members.proofs.has(row.id) && users.proofs.has(row.user.id)).map((row) => ({ ...row,
      roleAssignments: row.roleAssignments.filter((assignment) => assignments.proofs.has(assignment.id) && roles.proofs.has(assignment.role.id)),
    }));
  });
  return release.finish(participants.map((row) => ({ ...row, user: meetingProfileLabel(row.user),
    roleAssignments: row.roleAssignments.map((assignment) => ({ ...assignment, role: { name: assignment.role.name } })) })));
}

export async function createMeetingSeries(actor: AppActor, params: {
  workspaceId: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  scheduledEndAt?: Date | null;
  recurrenceRule?: string | null;
  meetingUrl?: string | null;
  participantIds?: string[] | null;
  participantEmails?: string[] | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  const requestedParticipantIds = normalizeIds(params.participantIds);
  let participantIds = requestedParticipantIds;
  if (requestedParticipantIds.length > 0) {
    const members = await prisma.member.findMany({
      where: {
        workspaceId: params.workspaceId,
        isActive: true,
        ...humanMemberIdentityWhere(),
        OR: [
          { id: { in: requestedParticipantIds } },
          { userId: { in: requestedParticipantIds } },
        ],
      },
      select: { id: true, userId: true },
    });
    const userIdByParticipantId = new Map<string, string>();
    for (const member of members) {
      userIdByParticipantId.set(member.id, member.userId);
      userIdByParticipantId.set(member.userId, member.userId);
    }
    invariant(
      requestedParticipantIds.every((id) => userIdByParticipantId.has(id)),
      400,
      "INVALID_INPUT",
      "Every selected attendee must be an active member of this workspace.",
    );
    participantIds = [...new Set(requestedParticipantIds.map((id) => userIdByParticipantId.get(id) as string))];
  }

  const title = params.title.trim();
  invariant(title.length > 0, 400, "INVALID_INPUT", "Meeting title is required.");
  invariant(!Number.isNaN(params.startsAt.valueOf()), 400, "INVALID_INPUT", "startsAt must be a valid date.");
  const defaultDurationMinutes = params.scheduledEndAt && !Number.isNaN(params.scheduledEndAt.valueOf())
    ? Math.max(1, Math.round((params.scheduledEndAt.getTime() - params.startsAt.getTime()) / 60_000))
    : 60;
  const meetingUrl = normalizeSeriesRecorderUrl(params.meetingUrl);

  return prisma.$transaction(async (tx) => {
    const series = await tx.meetingSeries.create({
      data: {
        workspaceId: params.workspaceId,
        title,
        description: params.description?.trim() || null,
        source: "internal",
        recurrenceRule: params.recurrenceRule?.trim() || null,
        meetingUrl,
        meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : null,
        startsAt: params.startsAt,
        defaultDurationMinutes,
        participantIds,
        participantEmails: normalizeEmails(params.participantEmails),
      },
    });

    if (actor.kind === "user") await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series, origin: "HUMAN_ORIGINAL", inputs: [] });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingSeries", id: series.id }, content: series });
    const meetings = await materializeMeetingSeriesOccurrencesTx(tx, series, { actor });

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
          hasMeetingUrl: Boolean(series.meetingUrl),
        },
      },
    });

    return { series, meetings };
  });
}

export async function setMeetingSeriesRecorderUrl(actor: AppActor, params: {
  workspaceId: string;
  seriesId: string;
  meetingUrl: string;
  now?: Date;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN", "FACILITATOR"],
  });

  const meetingUrl = normalizeSeriesRecorderUrl(params.meetingUrl);
  invariant(meetingUrl, 400, "MEETING_URL_REQUIRED", "A meeting URL is required.");
  const nextHash = meetingUrlHash(meetingUrl);
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    await lockMeetingSeriesTx(tx, params.workspaceId, params.seriesId);
    const series = await tx.meetingSeries.findFirst({
      where: { id: params.seriesId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(series, 404, "NOT_FOUND", "Meeting series not found.");

    const seriesProof = await freezeMeetingSourceRevision(tx, actor, params.workspaceId, "MeetingSeries", series);
    const children = await freezeSeriesChildrenTx(tx, actor, params.workspaceId, series.id);
    const previousHash = series.meetingUrlHash;
    const updatedSeries = await tx.meetingSeries.update({
      where: { id: series.id },
      data: {
        meetingUrl,
        meetingUrlHash: nextHash,
      },
    });

    if (seriesProof) await recordArtifactInputLineage({ tx, actor,
      workspaceId: params.workspaceId, artifact: { kind: "MeetingSeries", id: updatedSeries.id }, content: updatedSeries,
      origin: "DERIVED", inputs: [], inheritedRoots: seriesProof });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingSeries", id: updatedSeries.id }, content: updatedSeries });
    const updatedMeetings = await finishSeriesChildrenTx(tx, actor, {
      workspaceId: params.workspaceId,
      children,
      meetingUrl,
      meetingUrlHash: nextHash,
      previousMeetingUrlHash: previousHash,
      now,
      newSeriesRoot: seriesProof ? { kind: "MeetingSeries", id: series.id,
        fingerprint: lineageContentFingerprint("MeetingSeries", updatedSeries) } : null,
    });

    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting-series.recorder-url-updated",
        entityType: "MeetingSeries",
        entityId: series.id,
        meta: {
          title: series.title,
          hasMeetingUrl: true,
          updatedFutureScheduledMeetings: updatedMeetings.count,
        },
      },
    });

    return {
      series: updatedSeries,
      updatedFutureScheduledMeetings: updatedMeetings.count,
    };
  }, { maxWait: 5_000, timeout: 120_000 });
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

    if (actor.kind === "user" && (source === "manual" || source === "manual-recorder")) {
      await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
        artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "HUMAN_ORIGINAL", inputs: [] });
    } else {
      await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
        artifact: { kind: "Meeting", id: meeting.id }, content: meeting });
    }

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Meeting",
      entityId: meeting.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Meeting", meeting),
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
      await lockMeetingInviteIdentityTx(tx, params.workspaceId, seriesExternalId);
      const recurrenceRule = readIcsRecurrenceRule(component);
      const participantEmails = readIcsEventEmails(component);
      const meetingUrl = extractSupportedMeetingUrlFromText([
        event.location,
        event.description,
      ].filter(Boolean).join("\n"));
      let previousSeries = await tx.meetingSeries.findUnique({
        where: { externalId: seriesExternalId },
      });
      invariant(!previousSeries || previousSeries.workspaceId === params.workspaceId,
        409, "SOURCE_CHANGED", "The invite identity belongs to another workspace.");
      if (previousSeries) {
        await lockMeetingSeriesTx(tx, params.workspaceId, previousSeries.id);
        previousSeries = await tx.meetingSeries.findUnique({ where: { externalId: seriesExternalId } });
        invariant(previousSeries && previousSeries.workspaceId === params.workspaceId,
          409, "SOURCE_CHANGED", "The invite identity changed while importing.");
      }
      if (previousSeries) await freezeMeetingSourceRevision(tx, actor, params.workspaceId, "MeetingSeries", previousSeries);
      const previousChildren = previousSeries ? await freezeSeriesChildrenTx(tx, actor, params.workspaceId, previousSeries.id) : [];

      const series = await tx.meetingSeries.upsert({
        where: { externalId: seriesExternalId },
        update: {
          workspaceId: params.workspaceId,
          title: event.summary || "Untitled meeting",
          description: event.description || null,
          source: "ics",
          recurrenceRule,
          meetingUrl: meetingUrl ?? undefined,
          meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : undefined,
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
          meetingUrl,
          meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : null,
          startsAt,
          defaultDurationMinutes: durationMinutes,
          participantIds: [],
          participantEmails,
        },
      });
      // Parsed ICS bytes have no authenticated original receipt yet. Keep the
      // previous revisions, but never certify the imported replacement.
      await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
        artifact: { kind: "MeetingSeries", id: series.id }, content: series });
      if (previousSeries) {
        await finishSeriesChildrenTx(tx, actor, {
          workspaceId: params.workspaceId,
          children: previousChildren,
          meetingUrl,
          meetingUrlHash: meetingUrl ? meetingUrlHash(meetingUrl) : null,
          previousMeetingUrlHash: previousSeries?.meetingUrlHash ?? null,
          now: new Date(),
          newSeriesRoot: null,
        });
      }

      const meetings = await materializeMeetingSeriesOccurrencesTx(tx, {
        ...series,
        participantIds: series.participantIds,
        participantEmails: series.participantEmails,
      }, { actor });
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
  }, { maxWait: 5_000, timeout: 120_000 });
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
  return findTranscriptMeetingCandidatesInternal(actor, params);
}

export async function uploadMeetingTranscript(actor: AppActor, params: ProducerLineageParams & {
  tx?: Prisma.TransactionClient;
  copied?: boolean;
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
  sourceRecordId?: string | null;
  replaceTranscript?: boolean;
  allowTranscriptAppend?: boolean;
  duplicateGuard?: DuplicateGuardOptions | null;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });

  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  invariant(params.transcript.trim().length > 0, 400, "INVALID_INPUT", "Transcript is required.");
  const copied = params.copied === true || Boolean(params.sourceRecordId) || actor.kind === "agent";
  const db = (params.tx ?? prisma) as Prisma.TransactionClient;
  const admission = await prepareProducerLineage({ tx: db, actor,
    workspaceId: params.workspaceId, capture: params, copied });
  invariant(admission.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Transcript input requires complete source proof.");
  const normalizedMeetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : null;
  const normalizedMeetingUrlHash = normalizedMeetingUrl ? meetingUrlHash(normalizedMeetingUrl) : null;

  if (params.meetingId) {
    const existing = await db.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      select: { id: true },
    });
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");

    const persist = (tx: Prisma.TransactionClient) => updateMeetingWithTranscriptTx(tx, actor, {
      ...params,
      meetingId: params.meetingId as string,
    });
    const meeting = params.tx ? await persist(params.tx) : await prisma.$transaction(persist);
    return { status: "matched" as const, meeting, candidates: [] };
  }

  const directMatchClauses: Prisma.MeetingWhereInput[] = [];
  const scopedExternalId = workspaceScopedMeetingExternalId(params.workspaceId, params.externalId);
  if (scopedExternalId) {
    directMatchClauses.push({ externalId: scopedExternalId });
  }
  if (directMatchClauses.length > 0) {
    const directMatch = await db.meeting.findFirst({
      where: {
        workspaceId: params.workspaceId,
        archivedAt: null,
        OR: directMatchClauses,
      },
    });
    if (directMatch && (await projectMeetingsForReader(actor, params.workspaceId, [directMatch], db)).length) {
      const persist = (tx: Prisma.TransactionClient) => updateMeetingWithTranscriptTx(tx, actor, {
        ...params,
        meetingId: directMatch.id,
        meetingUrl: normalizedMeetingUrl,
      });
      const meeting = params.tx ? await persist(params.tx) : await prisma.$transaction(persist);
      return { status: "matched" as const, meeting, candidates: [] };
    }
  }

  const candidates = await findTranscriptMeetingCandidatesInternal(actor, {
    ...params,
    meetingUrlHash: normalizedMeetingUrlHash,
    calendarExternalId: params.calendarExternalId,
  }, db);
  const [best, second] = candidates;
  if (best && best.score >= TRANSCRIPT_AUTO_MATCH_THRESHOLD && (!second || best.score - second.score >= TRANSCRIPT_MATCH_MARGIN)) {
    const persist = (tx: Prisma.TransactionClient) => updateMeetingWithTranscriptTx(tx, actor, {
      ...params,
      meetingId: best.meetingId,
    });
    const meeting = params.tx ? await persist(params.tx) : await prisma.$transaction(persist);
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
    sourceRecordId: params.sourceRecordId ?? null,
    tx: params.tx,
    copied,
    lineageInputs: params.lineageInputs,
    lineageRoots: params.lineageRoots,
    duplicateGuard: params.duplicateGuard,
  });

  return { status: "created" as const, meeting, candidates: [] };
}

export async function requestMeetingIntelligenceRegeneration(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  guidanceMd: string;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  requireMeetingProcessedContentEditor(actor, membership);

  const guidanceMd = params.guidanceMd.trim();
  invariant(guidanceMd.length > 0, 400, "INVALID_INPUT", "Tell the AI what is missing or should change before regenerating meeting intelligence.");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
    });
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");
    invariant(existing.transcript, 400, "INVALID_STATE", "Meeting has no transcript to regenerate.");
    const original = meetingTranscriptInputProjection(existing);
    const transcriptReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingTranscript", id: existing.id }, before: original });
    await preserveMeetingPriorRevision(tx, actor, params.workspaceId, "MeetingTranscript", original, transcriptReceipt.mode);
    await preserveMeetingPriorRevision(tx, actor, params.workspaceId, "Meeting", existing, "UNKNOWN");

    const meeting = await tx.meeting.update({
      where: { id: existing.id },
      data: {
        ingestionGuidanceMd: mergeMarkdownNote(existing.ingestionGuidanceMd, guidanceMd),
        aiProcessedAt: null,
      },
    });
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), receipt: transcriptReceipt });
    await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting });

    await tx.meetingInsight.deleteMany({
      where: {
        meetingId: meeting.id,
        workspaceId: params.workspaceId,
        status: "SUGGESTED",
        sourceRecordId: null,
      },
    });

    await resetMeetingTranscriptProcessingProgress(tx, {
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
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

export async function updateMeetingProcessedContent(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  summaryMd?: string | null;
  ingestionGuidanceMd?: string | null;
  expectedSummaryMd?: string | null;
  expectedIngestionGuidanceMd?: string | null;
}) {
  const membership = await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });
  requireMeetingProcessedContentEditor(actor, membership);

  const editsSummary = params.summaryMd !== undefined;
  const editsGuidance = params.ingestionGuidanceMd !== undefined;
  invariant(editsSummary || editsGuidance, 400, "INVALID_INPUT", "Meeting summary or guidance is required.");

  return prisma.$transaction(async (tx) => {
    const existing = await tx.meeting.findFirst({
      where: { id: params.meetingId, workspaceId: params.workspaceId, archivedAt: null },
      include: { transcriptProcessingProgress: { select: { currentStage: true, completedAt: true, failedAt: true } } },
    });
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");
    const processingActive = existing.transcriptProcessingProgress
      && !existing.transcriptProcessingProgress.completedAt
      && !existing.transcriptProcessingProgress.failedAt
      && existing.transcriptProcessingProgress.currentStage !== "READY";
    invariant(!processingActive, 400, "INVALID_STATE", "Processed meeting content can be edited after transcript processing finishes.");
    const transcriptProcessingQueued = Boolean(existing.transcript)
      && !existing.aiProcessedAt
      && !existing.transcriptProcessingProgress;
    invariant(!transcriptProcessingQueued, 400, "INVALID_STATE", "Processed meeting content can be edited after transcript processing starts or finishes.");

    if (params.expectedSummaryMd !== undefined) {
      invariant(
        normalizeProcessedContentValue(params.expectedSummaryMd) === normalizeProcessedContentValue(existing.summaryMd),
        409,
        "CONFLICT",
        "Meeting summary changed while editing. Refresh and try again.",
      );
    }
    if (params.expectedIngestionGuidanceMd !== undefined) {
      invariant(
        normalizeProcessedContentValue(params.expectedIngestionGuidanceMd) === normalizeProcessedContentValue(existing.ingestionGuidanceMd),
        409,
        "CONFLICT",
        "Meeting guidance changed while editing. Refresh and try again.",
      );
    }

    const nextSummaryMd = editsSummary ? normalizeProcessedContentValue(params.summaryMd) : existing.summaryMd;
    const nextGuidanceMd = editsGuidance ? normalizeProcessedContentValue(params.ingestionGuidanceMd) : existing.ingestionGuidanceMd;
    const summaryChanged = editsSummary && nextSummaryMd !== existing.summaryMd;
    const guidanceChanged = editsGuidance && nextGuidanceMd !== existing.ingestionGuidanceMd;
    const data: Prisma.MeetingUpdateInput = {};
    if (editsSummary) data.summaryMd = nextSummaryMd;
    if (editsGuidance) data.ingestionGuidanceMd = nextGuidanceMd;

    const priorRoots = await currentArtifactInputRoots(tx, params.workspaceId, { kind: "Meeting", id: existing.id }, existing);
    const priorTranscript = guidanceChanged ? meetingTranscriptInputProjection(existing) : null;
    const transcriptReceipt = priorTranscript ? await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingTranscript", id: existing.id }, before: priorTranscript }) : null;
    await preserveMeetingPriorRevision(tx, actor, params.workspaceId, "Meeting", existing, "UNKNOWN");
    if (priorTranscript && transcriptReceipt) await preserveMeetingPriorRevision(tx, actor, params.workspaceId,
      "MeetingTranscript", priorTranscript, transcriptReceipt.mode);
    let meeting: Awaited<ReturnType<typeof tx.meeting.update>>;
    try {
      meeting = await tx.meeting.update({
        where: {
          id: existing.id,
          workspaceId: params.workspaceId,
          archivedAt: null,
          ...(editsSummary ? { summaryMd: existing.summaryMd } : {}),
          ...(editsGuidance ? { ingestionGuidanceMd: existing.ingestionGuidanceMd } : {}),
        },
        data,
      });
    } catch (error) {
      if (isPrismaNotFoundError(error)) {
        invariant(false, 409, "CONFLICT", "Meeting processed content changed while editing. Refresh and try again.");
      }
      throw error;
    }

    if (transcriptReceipt) await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), receipt: transcriptReceipt });

    if (actor.kind === "user" && priorRoots?.length && nextGuidanceMd === existing.ingestionGuidanceMd) await recordArtifactInputLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting, origin: "DERIVED", inputs: [], inheritedRoots: priorRoots });
    else await invalidateArtifactInputLineage({ tx, workspaceId: params.workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting });
    await tx.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: actor.kind === "user" ? actor.user.id : null,
        action: "meeting.processed_content_updated",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          title: meeting.title,
          editedSummary: editsSummary,
          editedGuidance: editsGuidance,
        },
      },
    });

    if (summaryChanged) {
      await appendEvents(tx, [
        {
          workspaceId: params.workspaceId,
          type: "meeting.processed-content-updated",
          aggregateType: "Meeting",
          aggregateId: meeting.id,
          payload: {
            meetingId: meeting.id,
            title: meeting.title,
            editedSummary: true,
          },
        },
      ]);
    }

    return meeting;
  });
}

type CreateMeetingParams = ProducerLineageParams & {
  copied?: boolean;
  tx?: Prisma.TransactionClient;
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
  sourceRecordId?: string | null;
  duplicateGuard?: DuplicateGuardOptions | null;
};

async function applyMeetingDuplicateUpdate(
  tx: Prisma.TransactionClient,
  actor: AppActor,
  params: CreateMeetingParams,
  meetingId: string,
  meetingUrl: string | null,
) {
  if (params.transcript?.trim()) {
    return updateMeetingWithTranscriptTx(tx, actor, {
      ...params,
      meetingId,
      meetingUrl,
      transcript: params.transcript,
    });
  }

  const existing = await tx.meeting.findFirst({
    where: { id: meetingId, workspaceId: params.workspaceId, archivedAt: null },
  });
  invariant(existing, 404, "NOT_FOUND", "Meeting not found.");
  const summaryMd = mergeMarkdownNote(existing.summaryMd, params.summaryMd);
  const ingestionGuidanceMd = mergeMarkdownNote(existing.ingestionGuidanceMd, params.ingestionGuidanceMd);
  const participantIds = normalizeIds([
    ...existing.participantIds,
    ...(params.participantIds ?? []),
  ]);
  const participantEmails = normalizeEmails([
    ...existing.participantEmails,
    ...(params.participantEmails ?? []),
  ]);
  const nextMeetingUrl = meetingUrl ?? existing.meetingUrl;
  const copied = params.copied === true || Boolean(params.sourceRecordId) || actor.kind === "agent";
  const priorTranscript = meetingTranscriptInputProjection(existing);
  const meetingReceipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "Meeting", id: existing.id }, before: existing, capture: params, copied });
  const transcriptReceipt = existing.transcript ? await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "MeetingTranscript", id: existing.id }, before: priorTranscript, capture: params, copied }) : null;
  await preserveMeetingPriorRevision(tx, actor, params.workspaceId, "Meeting", existing, meetingReceipt.mode);
  if (transcriptReceipt) await preserveMeetingPriorRevision(tx, actor, params.workspaceId,
    "MeetingTranscript", priorTranscript, transcriptReceipt.mode);
  const meeting = await tx.meeting.update({
    where: { id: existing.id },
    data: {
      title: chooseMergedTitle(existing.title, params.title),
      source: existing.source || params.source.trim(),
      externalId: existing.externalId || workspaceScopedMeetingExternalId(params.workspaceId, params.externalId),
      calendarExternalId: existing.calendarExternalId || params.calendarExternalId?.trim() || null,
      meetingUrl: nextMeetingUrl,
      meetingUrlHash: nextMeetingUrl ? meetingUrlHash(nextMeetingUrl) : existing.meetingUrlHash,
      status: "COMPLETED",
      recordedAt: params.recordedAt,
      scheduledEndAt: existing.scheduledEndAt ?? params.scheduledEndAt ?? null,
      summaryMd,
      ingestionGuidanceMd,
      participantIds,
      participantEmails,
    },
  });
  await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "Meeting", id: meeting.id }, content: meeting, receipt: meetingReceipt });
  if (transcriptReceipt) await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
    artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), receipt: transcriptReceipt });

  await tx.auditLog.create({
    data: {
      workspaceId: params.workspaceId,
      actorUserId: actor.kind === "user" ? actor.user.id : null,
      action: "meeting.updated",
      entityType: "Meeting",
      entityId: meeting.id,
      meta: { reason: "duplicate_guard_update", title: meeting.title },
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
        sourceRecordId: params.sourceRecordId ?? null,
      },
    },
  ]);
  return meeting;
}

export async function createMeeting(actor: AppActor, params: CreateMeetingParams) {
  params = { ...params, recordedAt: new Date(params.recordedAt),
    lineageRoots: params.lineageRoots ? structuredClone(params.lineageRoots) : undefined,
    lineageInputs: params.lineageInputs ? structuredClone(params.lineageInputs) : undefined,
    participantIds: params.participantIds?.slice(), participantEmails: params.participantEmails?.slice() };
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    tx: params.tx,
  });

  const source = params.source.trim();
  const meetingUrl = params.meetingUrl?.trim() ? normalizeMeetingUrl(params.meetingUrl) : null;
  const normalizedMeetingUrlHash = meetingUrl ? meetingUrlHash(meetingUrl) : null;
  const scopedExternalId = workspaceScopedMeetingExternalId(params.workspaceId, params.externalId);
  invariant(source.length > 0, 400, "INVALID_INPUT", "Meeting source is required.");
  invariant(!Number.isNaN(params.recordedAt.valueOf()), 400, "INVALID_INPUT", "recordedAt must be a valid date.");
  const copied = params.copied === true || Boolean(params.sourceRecordId) || actor.kind === "agent";
  // Admission precedes duplicate matching: even a reused row can otherwise
  // reveal whether unproved copied content matches an existing transcript.
  const admission = await prepareProducerLineage({ tx: (params.tx ?? prisma) as Prisma.TransactionClient,
    actor, workspaceId: params.workspaceId, capture: params, copied });
  invariant(admission.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Meeting content requires its complete input receipt.");
  invariant(!params.tx || !["use_existing", "update_existing"].includes(params.duplicateGuard?.resolution ?? ""),
    409, "ATOMIC_DUPLICATE_RESOLUTION_REQUIRED", "A supplied transaction cannot use an independent meeting duplicate path.");
  const duplicateDecision = await checkWorkspaceDuplicateGuard({
    workspaceId: params.workspaceId,
    entityType: "Meeting",
    title: params.title,
    body: params.transcript ?? params.summaryMd,
    content: params.transcript ?? params.summaryMd,
    source,
    externalId: scopedExternalId,
    calendarExternalId: params.calendarExternalId?.trim() || null,
    meetingUrlHash: normalizedMeetingUrlHash,
    recordedAt: params.recordedAt,
    participantEmails: params.participantEmails,
  }, params.duplicateGuard, params.tx, async (candidates) => {
    const rows = candidates as Meeting[];
    const projected = rows.map((row) => meetingTranscriptInputProjection(row) as Record<string, unknown> & { id: string });
    const derived = await (params.tx ? readableArtifactIds(actor, params.workspaceId, "Meeting", rows, params.tx)
      : readableArtifactIds(actor, params.workspaceId, "Meeting", rows));
    const originals = await (params.tx ? readableArtifactIds(actor, params.workspaceId, "MeetingTranscript", projected, params.tx)
      : readableArtifactIds(actor, params.workspaceId, "MeetingTranscript", projected));
    return rows.filter((row) => row.transcript != null ? originals.has(row.id) : derived.has(row.id))
      .map((row) => derived.has(row.id) ? row : { ...row, summaryMd: null, blocksJson: null, decisionsJson: null, agendaJson: null });
  });
  if (duplicateDecision?.resolution === "use_existing") {
    invariant(!params.tx, 409, "ATOMIC_DUPLICATE_RESOLUTION_REQUIRED", "A supplied transaction cannot reuse an independently loaded meeting.");
    const existing = await getMeeting(actor, params.workspaceId, duplicateDecision.match.entityId);
    invariant(existing, 404, "NOT_FOUND", "Meeting not found.");
    return existing;
  }
  if (duplicateDecision?.resolution === "update_existing") {
    invariant(!params.tx, 409, "ATOMIC_DUPLICATE_RESOLUTION_REQUIRED", "A supplied transaction requires a complete atomic meeting update.");
    return prisma.$transaction((tx) => applyMeetingDuplicateUpdate(tx, actor, params, duplicateDecision.match.entityId, meetingUrl));
  }

  const persist = async (tx: Prisma.TransactionClient) => {
    await lockCompanyTranscriptPublication(tx, actor, params.workspaceId);
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, tx });
    const receipt = await prepareProducerLineage({ tx, actor, workspaceId: params.workspaceId, capture: params,
      copied });
    invariant(receipt.mode !== "UNKNOWN", 409, "UNKNOWN_LINEAGE", "Meeting content requires its complete input receipt.");
    const meeting = await tx.meeting.create({
      data: {
        workspaceId: params.workspaceId,
        title: params.title?.trim() || null,
        source,
        externalId: workspaceScopedMeetingExternalId(params.workspaceId, params.externalId),
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
    await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "Meeting", id: meeting.id }, content: meeting, receipt });
    const nativePublicationManifest = await finishProducerLineage({ tx, actor, workspaceId: params.workspaceId,
      artifact: { kind: "MeetingTranscript", id: meeting.id }, content: meetingTranscriptInputProjection(meeting), receipt });

    await finishCompanyTranscriptPublication(tx, actor, params.workspaceId, nativePublicationManifest);

    await ensureWorkspacePermalink(tx, actor, {
      workspaceId: params.workspaceId,
      entityType: "Meeting",
      entityId: meeting.id,
      canonicalPath: workspaceEntityCanonicalPath(params.workspaceId, "Meeting", meeting),
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
          ...duplicateGuardAuditMeta(duplicateDecision),
        },
      },
    });

    if (params.sourceRecordId) {
      await tx.meetingTranscriptSourceRecord.updateMany({
        where: {
          id: params.sourceRecordId,
          workspaceId: params.workspaceId,
        },
        data: {
          meetingId: meeting.id,
        },
      });
    }

    if (meeting.transcript) {
      await resetMeetingTranscriptProcessingProgress(tx, {
        workspaceId: params.workspaceId,
        meetingId: meeting.id,
      });
    }

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
          sourceRecordId: params.sourceRecordId ?? null,
        },
      },
    ]);

    return meeting;
  };
  return params.tx ? persist(params.tx) : prisma.$transaction(persist);
}

export async function deleteMeeting(actor: AppActor, params: {
  workspaceId: string;
  meetingId: string;
  reason?: string | null;
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
    reason: params.reason?.trim() || "Archived from meeting delete path.",
  });

  return { id: params.meetingId };
}
