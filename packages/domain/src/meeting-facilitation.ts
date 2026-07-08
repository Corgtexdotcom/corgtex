import { defaultModelGateway } from "@corgtex/models";
import { prisma, toInputJson, type AppActor } from "@corgtex/shared";
import type { MeetingInsightType } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";
import { fetchSlackThreadMessages, sendSlackMessage, updateSlackMessage, validateSlackPostTarget } from "./communication";
import {
  markSlackMeetingActionReviewPosted,
  prepareSlackMeetingActionReviewPost,
} from "./meeting-action-review";
import {
  buildLegacyAgendaFallback,
  buildRegularUpdateAgenda,
  isRegularUpdateAgenda,
  normalizeMeetingAgendaForDisplay,
  normalizeLegacyAgenda,
  REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
  renderAgendaSlackBlocks,
  selectedMeetingAgendaTemplate,
  type LegacyMeetingAgenda,
  type MeetingAgenda,
} from "./meeting-agendas";
import { extractMeetingInsights } from "./meeting-intelligence";
import { buildMeetingIntelligenceContext } from "./meeting-intelligence-context";

type AgendaEditOutput = {
  action: "update" | "clarify";
  changeSummary?: string | null;
  clarification?: string | null;
  agenda?: LegacyMeetingAgenda | null;
};

type AgendaSettings = {
  defaultAgendaChannelId?: string | null;
  agendaTimezone?: string | null;
  agendaRunHour?: number | null;
};

type AgendaReadinessStatus = "configured" | "ready" | "degraded" | "blocked";

type AgendaMeetingCandidate = {
  id: string;
  workspaceId: string;
  title: string | null;
  status: string;
  recordedAt: Date;
  scheduledEndAt: Date | null;
  agendaJson: unknown;
  agendaChannelId: string | null;
  agendaMessageTs: string | null;
  agendaPostedAt: Date | null;
  seriesId: string | null;
  series: { recurrenceRule: string | null } | null;
};

const AGENDA_SCAN_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;
const AGENDA_POST_LEAD_MS = 24 * 60 * 60 * 1000;
const AGENDA_DUE_GRACE_MS = 2 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agendaSettings(settings: unknown): AgendaSettings {
  if (!isRecord(settings)) return {};
  return {
    defaultAgendaChannelId: typeof settings.defaultAgendaChannelId === "string" ? settings.defaultAgendaChannelId : null,
    agendaTimezone: typeof settings.agendaTimezone === "string" ? settings.agendaTimezone : null,
    agendaRunHour: typeof settings.agendaRunHour === "number" ? settings.agendaRunHour : null,
  };
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcDayBounds(date: Date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function tomorrowBounds(now = new Date()) {
  return utcDayBounds(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

function nextAgendaRunAfter(settings: AgendaSettings, now = new Date()) {
  const hour = Number.isFinite(settings.agendaRunHour ?? NaN)
    ? Math.max(0, Math.min(23, Math.floor(settings.agendaRunHour as number)))
    : 17;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function truncate(text: string, max = 2900) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function slackSection(title: string, lines: string[]) {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: truncate(`*${title}*\n${lines.length > 0 ? lines.join("\n") : "_None._"}`),
    },
  };
}

function renderSummaryBlocks(params: {
  meeting: { title: string | null; summaryMd: string | null };
  groupedInsights: Map<MeetingInsightType, Array<{ title: string; bodyMd: string }>>;
}) {
  const sectionFor = (type: MeetingInsightType, title: string) => {
    const items = params.groupedInsights.get(type) ?? [];
    return slackSection(title, items.slice(0, 8).map((item) => `- ${item.title}`));
  };

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Meeting summary: ${params.meeting.title || "Untitled meeting"}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(params.meeting.summaryMd || "Summary is not available yet.") },
    },
    { type: "divider" },
    sectionFor("DECISION", "Decisions"),
    sectionFor("TENSION", "New tensions"),
    sectionFor("ACTION_ITEM", "Action items"),
    sectionFor("FOLLOW_UP", "Follow-ups for next meeting"),
  ];
}

async function activeSlackInstallation(workspaceId: string) {
  return prisma.communicationInstallation.findFirst({
    where: { workspaceId, provider: "SLACK", status: "ACTIVE" },
    select: { id: true, settings: true },
  });
}

async function attendeeMentionsForContext(installationId: string, workspaceId: string, attendees: Array<{ email: string; name: string | null }>) {
  const externalUsers = await prisma.communicationExternalUser.findMany({
    where: {
      installationId,
      workspaceId,
      email: { in: attendees.map((attendee) => attendee.email) },
    },
    select: { email: true, externalUserId: true },
  });
  const slackUsersByEmail = new Map(externalUsers.map((user: { email?: string | null; externalUserId: string }) => [user.email?.toLowerCase(), user.externalUserId]));
  return attendees.map((attendee) => {
    const externalUserId = slackUsersByEmail.get(attendee.email.toLowerCase());
    return externalUserId ? `<@${externalUserId}>` : attendee.name || attendee.email;
  });
}

async function scheduleNextAgendaJob(workspaceId: string, settings: AgendaSettings) {
  const runAfter = nextAgendaRunAfter(settings);
  await prisma.workflowJob.upsert({
    where: { dedupeKey: `meeting-agenda-prepare:${workspaceId}:${dateKey(runAfter)}` },
    update: {},
    create: {
      workspaceId,
      type: "meeting.agenda.prepare",
      payload: {
        targetDateISO: dateKey(new Date(runAfter.getTime() + 24 * 60 * 60 * 1000)),
      },
      runAfter,
      dedupeKey: `meeting-agenda-prepare:${workspaceId}:${dateKey(runAfter)}`,
    },
  });
}

export async function enqueueWorkspaceMeetingAgendaPreparation(params: {
  workspaceId: string;
  runAfter?: Date;
  targetDateISO?: string | null;
}) {
  const runAfter = params.runAfter ?? new Date();
  const dedupeKey = `meeting-agenda-prepare:${params.workspaceId}:manual:${runAfter.toISOString()}`;
  return prisma.workflowJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      type: "meeting.agenda.prepare",
      payload: {
        targetDateISO: params.targetDateISO ?? dateKey(new Date(runAfter.getTime() + 24 * 60 * 60 * 1000)),
      },
      runAfter,
      dedupeKey,
    },
  });
}

export async function enqueueMeetingAgendaPreparation(actor: AppActor, params: {
  workspaceId: string;
  runAfter?: Date;
  targetDateISO?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  return enqueueWorkspaceMeetingAgendaPreparation(params);
}

export async function updateSlackAgendaSettings(actor: AppActor, params: {
  workspaceId: string;
  defaultAgendaChannelId: string;
  agendaTimezone?: string | null;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });
  const installation = await activeSlackInstallation(params.workspaceId);
  invariant(installation, 404, "NOT_FOUND", "Slack is not connected for this workspace.");
  const validation = await validateSlackPostTarget(installation.id, params.defaultAgendaChannelId);
  if (!validation.ok) {
    invariant(false, 400, validation.code, validation.message);
  }

  const current = isRecord(installation.settings) ? installation.settings : {};
  const settings = {
    ...current,
    defaultAgendaChannelId: validation.channelId,
    defaultAgendaChannelName: validation.channelName,
    agendaTimezone: params.agendaTimezone?.trim() || "UTC",
  };

  const updated = await prisma.communicationInstallation.update({
    where: { id: installation.id },
    data: { settings: toInputJson(settings) },
  });

  await enqueueMeetingAgendaPreparation(actor, { workspaceId: params.workspaceId, runAfter: new Date() });
  return updated;
}

export async function buildMeetingAgendaContext(workspaceId: string, meetingId: string) {
  return buildMeetingIntelligenceContext({
    workspaceId,
    meetingId,
    mode: "agenda",
  });
}

export async function prepareAgendaForMeeting(params: {
  workspaceId: string;
  meetingId: string;
  workflowJobId?: string;
}) {
  const context = await buildMeetingAgendaContext(params.workspaceId, params.meetingId);
  const template = selectedMeetingAgendaTemplate(context);
  if (template?.key === REGULAR_UPDATE_AGENDA_TEMPLATE_KEY) {
    const agenda = buildRegularUpdateAgenda(context);
    await prisma.meeting.update({
      where: { id: context.meeting.id },
      data: { agendaJson: toInputJson(agenda) },
    });
    return { meeting: context.meeting, agenda, context };
  }

  const fallbackAgenda = buildLegacyAgendaFallback(context);
  let agenda: LegacyMeetingAgenda = fallbackAgenda;
  let fallbackReason: string | null = "model_not_used";
  try {
    const extraction = await defaultModelGateway.extract({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      instruction: [
        "Generate a concise, practical meeting agenda for a self-managed organization.",
        "Use the supplied meeting, attendee, open tension, prior follow-up, and pending action context.",
        "Do not invent private facts. Preserve source IDs where provided.",
      ].join("\n"),
      input: JSON.stringify(context),
      schemaHint: `{
        "title": "string",
        "intro": "string",
        "sections": [
          {
            "title": "string",
            "durationMinutes": "number",
            "items": [
              { "text": "string", "sourceType": "string", "sourceId": "string", "owner": "string" }
            ]
          }
        ]
      }`,
    });
    agenda = normalizeLegacyAgenda(extraction.output, context.meeting.title || "Meeting agenda", fallbackAgenda.sections);
    fallbackReason = null;
  } catch {
    agenda = fallbackAgenda;
    fallbackReason = "model_generation_failed";
  }
  await prisma.meeting.update({
    where: { id: context.meeting.id },
    data: { agendaJson: toInputJson(agenda) },
  });

  return { meeting: context.meeting, agenda, context, fallbackReason };
}

function hasPostedAgenda(meeting: Pick<AgendaMeetingCandidate, "agendaPostedAt" | "agendaChannelId" | "agendaMessageTs">) {
  return Boolean(meeting.agendaPostedAt && meeting.agendaChannelId?.trim() && meeting.agendaMessageTs?.trim());
}

function sameUtcWeekdayAndMinute(left: Date, right: Date) {
  return left.getUTCDay() === right.getUTCDay()
    && left.getUTCHours() === right.getUTCHours()
    && left.getUTCMinutes() === right.getUTCMinutes();
}

function hasSeriesSignal(meeting: Pick<AgendaMeetingCandidate, "seriesId" | "series">) {
  return Boolean(meeting.seriesId || meeting.series?.recurrenceRule);
}

async function hasConservativeRecurringFallback(workspaceId: string, meeting: Pick<AgendaMeetingCandidate, "id" | "title" | "recordedAt">) {
  const title = meeting.title?.trim();
  if (!title) return false;
  const previous = await prisma.meeting.findMany({
    where: {
      workspaceId,
      id: { not: meeting.id },
      title,
      status: "COMPLETED",
      archivedAt: null,
      recordedAt: { lt: meeting.recordedAt },
    },
    orderBy: { recordedAt: "desc" },
    take: 10,
    select: { recordedAt: true },
  });
  return previous.some((candidate: { recordedAt: Date }) => sameUtcWeekdayAndMinute(candidate.recordedAt, meeting.recordedAt));
}

async function filterRegularAgendaMeetings(workspaceId: string, meetings: AgendaMeetingCandidate[]) {
  const eligible: AgendaMeetingCandidate[] = [];
  for (const meeting of meetings) {
    if (hasSeriesSignal(meeting) || await hasConservativeRecurringFallback(workspaceId, meeting)) {
      eligible.push(meeting);
    }
  }
  return eligible;
}

async function findRegularAgendaMeetingsForDay(workspaceId: string, start: Date, end: Date) {
  const candidates = await prisma.meeting.findMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: { gte: start, lt: end },
      OR: [
        { agendaPostedAt: null },
        { agendaChannelId: null },
        { agendaMessageTs: null },
      ],
    },
    orderBy: { recordedAt: "asc" },
    include: { series: { select: { recurrenceRule: true } } },
  }) as AgendaMeetingCandidate[];
  return filterRegularAgendaMeetings(workspaceId, candidates);
}

async function findNextRegularAgendaMeeting(workspaceId: string, now = new Date()) {
  const candidates = await prisma.meeting.findMany({
    where: {
      workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      recordedAt: {
        gte: now,
        lt: new Date(now.getTime() + AGENDA_SCAN_LOOKAHEAD_MS),
      },
    },
    orderBy: { recordedAt: "asc" },
    take: 20,
    include: { series: { select: { recurrenceRule: true } } },
  }) as AgendaMeetingCandidate[];
  const eligible = await filterRegularAgendaMeetings(workspaceId, candidates);
  return eligible[0] ?? null;
}

function sanitizeAgendaFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : "Unknown agenda preparation error.";
  return truncate(raw.replace(/https?:\/\/\S+/g, "[url]"), 500);
}

function compactAgendaMeeting(meeting: AgendaMeetingCandidate | null) {
  if (!meeting) return null;
  return {
    id: meeting.id,
    title: meeting.title,
    recordedAt: meeting.recordedAt,
    scheduledEndAt: meeting.scheduledEndAt,
    seriesId: meeting.seriesId,
    hasAgendaJson: Boolean(meeting.agendaJson),
    hasPostedAgenda: hasPostedAgenda(meeting),
  };
}

function compactAgendaJob(job: { id: string; status: string; runAfter: Date; error: string | null; updatedAt: Date } | null) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    runAfter: job.runAfter,
    updatedAt: job.updatedAt,
    error: job.error ? sanitizeAgendaFailure(new Error(job.error)) : null,
  };
}

async function agendaPayloadForPosting(params: {
  workspaceId: string;
  meeting: AgendaMeetingCandidate;
  workflowJobId?: string;
}) {
  const existingAgenda = normalizeMeetingAgendaForDisplay(params.meeting.agendaJson, params.meeting.title || "Meeting agenda");
  if (existingAgenda) {
    return {
      meeting: params.meeting,
      agenda: existingAgenda,
      context: await buildMeetingAgendaContext(params.workspaceId, params.meeting.id),
      reusedExistingAgenda: true,
    };
  }
  const prepared = await prepareAgendaForMeeting({
    workspaceId: params.workspaceId,
    meetingId: params.meeting.id,
    workflowJobId: params.workflowJobId,
  });
  return {
    meeting: params.meeting,
    agenda: prepared.agenda as MeetingAgenda,
    context: prepared.context,
    reusedExistingAgenda: false,
  };
}

async function postAgendaForMeeting(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  settings: AgendaSettings;
  meeting: AgendaMeetingCandidate;
  workflowJobId?: string;
}) {
  if (hasPostedAgenda(params.meeting)) {
    return { posted: false, skipped: true, reason: "already_posted" };
  }
  const { agenda, context } = await agendaPayloadForPosting({
    workspaceId: params.workspaceId,
    meeting: params.meeting,
    workflowJobId: params.workflowJobId,
  });
  const attendeeMentions = await attendeeMentionsForContext(params.installationId, params.workspaceId, context.attendees);
  const response = await sendSlackMessage(params.installationId, { channel: params.channelId }, renderAgendaSlackBlocks({
    meeting: params.meeting,
    agenda,
    attendeeMentions,
    timezone: params.settings.agendaTimezone || "UTC",
  }));
  const messageTs = typeof response.ts === "string" ? response.ts.trim() : "";
  if (!messageTs) {
    throw new AppError(502, "SLACK_AGENDA_POST_MISSING_TS", "Slack accepted the agenda post without returning a message timestamp.");
  }
  await prisma.meeting.update({
    where: { id: params.meeting.id },
    data: {
      agendaJson: toInputJson(agenda),
      agendaChannelId: String(response.channel ?? params.channelId),
      agendaMessageTs: messageTs,
      agendaPostedAt: new Date(),
    },
  });
  return { posted: true, skipped: false };
}

export async function runMeetingAgendaPreparation(params: {
  workspaceId: string;
  workflowJobId?: string;
  targetDateISO?: string | null;
}) {
  const installation = await activeSlackInstallation(params.workspaceId);
  const settings = agendaSettings(installation?.settings);
  const channelId = settings.defaultAgendaChannelId?.trim();

  try {
    if (!installation || !channelId) {
      return { skipped: true, reason: "slack_agenda_channel_missing" };
    }
    const channelValidation = await validateSlackPostTarget(installation.id, channelId);
    if (!channelValidation.ok) {
      return { skipped: true, reason: channelValidation.code };
    }

    const targetDate = params.targetDateISO ? new Date(`${params.targetDateISO}T00:00:00.000Z`) : tomorrowBounds().start;
    const { start, end } = utcDayBounds(Number.isNaN(targetDate.valueOf()) ? tomorrowBounds().start : targetDate);
    const meetings = await findRegularAgendaMeetingsForDay(params.workspaceId, start, end);

    let posted = 0;
    const skipped: Array<{ meetingId: string; reason: string }> = [];
    const failures: Array<{ meetingId: string; reason: string }> = [];
    for (const meeting of meetings) {
      try {
        const result = await postAgendaForMeeting({
          workspaceId: params.workspaceId,
          installationId: installation.id,
          channelId,
          settings,
          meeting,
          workflowJobId: params.workflowJobId,
        });
        if (result.posted) {
          posted += 1;
        } else if (result.skipped && result.reason) {
          skipped.push({ meetingId: meeting.id, reason: result.reason });
        }
      } catch (error) {
        failures.push({ meetingId: meeting.id, reason: sanitizeAgendaFailure(error) });
      }
    }

    if (failures.length > 0) {
      throw new AppError(502, "MEETING_AGENDA_PREPARATION_PARTIAL_FAILURE", `Agenda preparation failed for ${failures.length} meeting(s): ${failures.map((failure) => `${failure.meetingId}:${failure.reason}`).join("; ")}`);
    }

    return {
      posted,
      meetingIds: meetings.map((meeting: { id: string }) => meeting.id),
      skipped,
      failures,
    };
  } finally {
    await scheduleNextAgendaJob(params.workspaceId, settings);
  }
}

export async function getMeetingAgendaReadiness(workspaceId: string, now = new Date()) {
  const [installation, nextMeeting, lastAgendaJob, failedAgendaJob] = await Promise.all([
    activeSlackInstallation(workspaceId),
    findNextRegularAgendaMeeting(workspaceId, now),
    prisma.workflowJob.findFirst({
      where: { workspaceId, type: "meeting.agenda.prepare" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, runAfter: true, error: true, updatedAt: true },
    }),
    prisma.workflowJob.findFirst({
      where: { workspaceId, type: "meeting.agenda.prepare", status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      select: { id: true, status: true, runAfter: true, error: true, updatedAt: true },
    }),
  ]);
  const settings = agendaSettings(installation?.settings);
  const channelId = settings.defaultAgendaChannelId?.trim();
  const failedChecks: Array<{ key: string; label: string; detail: string }> = [];

  if (!installation) {
    failedChecks.push({ key: "slack_installation", label: "Slack installation", detail: "No active Slack installation." });
    return { workspaceId, status: "blocked" as AgendaReadinessStatus, ready: false, configured: false, detail: "Slack is not connected.", failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }
  if (!channelId) {
    failedChecks.push({ key: "agenda_channel", label: "Agenda channel", detail: "No default agenda channel configured." });
    return { workspaceId, status: "blocked" as AgendaReadinessStatus, ready: false, configured: false, detail: "Agenda channel is not configured.", failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }

  const channelValidation = await validateSlackPostTarget(installation.id, channelId);
  if (!channelValidation.ok) {
    failedChecks.push({ key: "agenda_channel", label: "Agenda channel", detail: channelValidation.message });
    return { workspaceId, status: "blocked" as AgendaReadinessStatus, ready: false, configured: true, detail: channelValidation.message, failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }

  if (!nextMeeting) {
    return { workspaceId, status: "configured" as AgendaReadinessStatus, ready: false, configured: true, detail: "No upcoming regular call found in the next 7 days.", failedChecks, nextMeeting: null, lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }
  if (hasPostedAgenda(nextMeeting)) {
    return { workspaceId, status: "ready" as AgendaReadinessStatus, ready: true, configured: true, detail: "Next regular call has a posted agenda.", failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }

  const agendaDueAt = new Date(nextMeeting.recordedAt.getTime() - AGENDA_POST_LEAD_MS);
  const pendingJob = await prisma.workflowJob.findFirst({
    where: {
      workspaceId,
      type: "meeting.agenda.prepare",
      status: { in: ["PENDING", "RUNNING"] },
      runAfter: { lte: nextMeeting.recordedAt },
    },
    orderBy: { runAfter: "asc" },
    select: { id: true, status: true, runAfter: true, error: true, updatedAt: true },
  });
  if (pendingJob && agendaDueAt.getTime() - now.getTime() <= AGENDA_DUE_GRACE_MS) {
    return { workspaceId, status: "ready" as AgendaReadinessStatus, ready: true, configured: true, detail: "Agenda job is queued for the next regular call.", failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(pendingJob) };
  }
  if (agendaDueAt > now) {
    return { workspaceId, status: "configured" as AgendaReadinessStatus, ready: false, configured: true, detail: "Next regular call is not yet inside the 24 hour agenda window.", failedChecks, nextMeeting: compactAgendaMeeting(nextMeeting), lastAgendaJob: compactAgendaJob(lastAgendaJob) };
  }

  const failedDetail = failedAgendaJob?.error ? sanitizeAgendaFailure(new Error(failedAgendaJob.error)) : "No posted agenda or pending agenda job for the next regular call.";
  failedChecks.push({ key: "next_agenda", label: "Next regular-call agenda", detail: failedDetail });
  return {
    workspaceId,
    status: "degraded" as AgendaReadinessStatus,
    ready: false,
    configured: true,
    detail: failedDetail,
    failedChecks,
    nextMeeting: compactAgendaMeeting(nextMeeting),
    lastAgendaJob: compactAgendaJob(failedAgendaJob ?? lastAgendaJob),
  };
}

function parseAgendaEditOutput(output: Record<string, unknown>, fallbackTitle: string): AgendaEditOutput {
  const action = output.action === "update" ? "update" : "clarify";
  const agendaRaw = isRecord(output.agenda) ? output.agenda : null;
  const hasAgendaSections = Array.isArray(agendaRaw?.sections) && agendaRaw.sections.length > 0;
  return {
    action: action === "update" && hasAgendaSections ? "update" : "clarify",
    changeSummary: typeof output.changeSummary === "string" ? output.changeSummary.trim() : null,
    clarification: typeof output.clarification === "string" ? output.clarification.trim() : null,
    agenda: agendaRaw && hasAgendaSections ? normalizeLegacyAgenda(agendaRaw, fallbackTitle, []) : null,
  };
}

export async function runMeetingAgendaThreadEdit(params: {
  workspaceId: string;
  meetingId: string;
  actorUserId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  messageText: string;
  workflowJobId?: string;
}) {
  const actorUser = await prisma.user.findUnique({
    where: { id: params.actorUserId },
    select: { id: true, email: true, displayName: true, globalRole: true },
  });
  invariant(actorUser, 404, "NOT_FOUND", "Agenda editor user not found.");
  const actor: AppActor = { kind: "user", user: actorUser };
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

  const meeting = await prisma.meeting.findFirst({
    where: {
      id: params.meetingId,
      workspaceId: params.workspaceId,
      agendaChannelId: params.channelId,
      agendaMessageTs: params.threadTs,
      archivedAt: null,
    },
    select: {
      id: true,
      title: true,
      recordedAt: true,
      scheduledEndAt: true,
      agendaJson: true,
      agendaChannelId: true,
      agendaMessageTs: true,
    },
  });
  invariant(meeting?.agendaJson && meeting.agendaChannelId && meeting.agendaMessageTs, 404, "NOT_FOUND", "Agenda thread not found.");
  if (isRegularUpdateAgenda(meeting.agendaJson)) {
    await sendSlackMessage(params.installationId, {
      channel: params.channelId,
      threadTs: params.threadTs,
    }, [slackSection("Agenda is read-only", ["This recurring meeting agenda is generated from Corgtex records. Edit the source tension, proposal, action, or meeting instead."])]);
    return { edited: false, reason: "read_only_regular_agenda" };
  }

  const currentAgenda = normalizeLegacyAgenda(isRecord(meeting.agendaJson) ? meeting.agendaJson : {}, meeting.title || "Meeting agenda", []);
  invariant(currentAgenda.sections.length > 0, 400, "AGENDA_NOT_READY", "The agenda is not ready for editing yet.");

  const installation = await activeSlackInstallation(params.workspaceId);
  invariant(installation?.id === params.installationId, 404, "NOT_FOUND", "Slack installation not found.");
  const settings = agendaSettings(installation.settings);
  const threadMessages = await fetchSlackThreadMessages(params.installationId, {
    channelId: params.channelId,
    threadTs: params.threadTs,
    limit: 20,
  });

  const extraction = await defaultModelGateway.extract({
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    instruction: [
      "You edit an existing meeting agenda based only on an explicit Slack thread request.",
      "If the request does not ask for a concrete agenda edit, set action to clarify and do not return an agenda.",
      "Supported edits: add, remove, reword, reorder sections or items, clarify action items, adjust owners, or adjust durations.",
      "Return the complete updated agenda JSON when action is update.",
      "Keep existing source IDs and owners unless the user asks to change them.",
    ].join("\n"),
    input: JSON.stringify({
      meeting: {
        id: meeting.id,
        title: meeting.title,
        startsAt: meeting.recordedAt.toISOString(),
        scheduledEndAt: meeting.scheduledEndAt?.toISOString() ?? null,
      },
      currentAgenda,
      request: params.messageText,
      threadMessages,
    }),
    schemaHint: `{
      "action": "update | clarify",
      "changeSummary": "short sentence describing what changed",
      "clarification": "short request for a more specific agenda edit",
      "agenda": {
        "title": "string",
        "intro": "string",
        "sections": [
          {
            "title": "string",
            "durationMinutes": "number",
            "items": [
              { "text": "string", "sourceType": "string", "sourceId": "string", "owner": "string" }
            ]
          }
        ]
      }
    }`,
  });

  const edit = parseAgendaEditOutput(extraction.output, meeting.title || currentAgenda.title);
  if (edit.action !== "update" || !edit.agenda) {
    const clarification = edit.clarification || "I could not identify a concrete agenda edit. Please tell me what to add, remove, reword, or reorder.";
    await sendSlackMessage(params.installationId, {
      channel: params.channelId,
      threadTs: params.threadTs,
    }, [slackSection("Agenda edit", [clarification])]);
    return { edited: false, reason: "clarification_requested" };
  }

  const context = await buildMeetingAgendaContext(params.workspaceId, meeting.id);
  const attendeeMentions = await attendeeMentionsForContext(params.installationId, params.workspaceId, context.attendees);
  const changeSummary = edit.changeSummary || "Updated the agenda.";

  await updateSlackMessage(params.installationId, {
    channel: params.channelId,
    ts: params.threadTs,
  }, renderAgendaSlackBlocks({
    meeting,
    agenda: edit.agenda,
    attendeeMentions,
    timezone: settings.agendaTimezone || "UTC",
  }));
  await sendSlackMessage(params.installationId, {
    channel: params.channelId,
    threadTs: params.threadTs,
  }, [slackSection("Agenda updated", [changeSummary])]);

  await prisma.$transaction([
    prisma.meeting.update({
      where: { id: meeting.id },
      data: { agendaJson: toInputJson(edit.agenda) },
    }),
    prisma.auditLog.create({
      data: {
        workspaceId: params.workspaceId,
        actorUserId: params.actorUserId,
        action: "meeting.agenda.edited",
        entityType: "Meeting",
        entityId: meeting.id,
        meta: {
          channelId: params.channelId,
          threadTs: params.threadTs,
          messageTs: params.messageTs,
          changeSummary,
        },
      },
    }),
  ]);

  return { edited: true, changeSummary };
}

export async function runMeetingInsightsExtraction(params: {
  workspaceId: string;
  meetingId: string;
  workflowJobId?: string | null;
}) {
  const meeting = await prisma.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId },
    select: { id: true, transcript: true, aiProcessedAt: true },
  });
  if (!meeting?.transcript || meeting.aiProcessedAt) {
    return { skipped: true, reason: "missing_transcript_or_already_processed" };
  }

  const actor: AppActor = {
    kind: "agent",
    authProvider: "bootstrap",
    label: "Meeting facilitation",
    workspaceIds: [params.workspaceId],
    scopes: ["meetings:write"],
  };
  const insights = await extractMeetingInsights(actor, {
    workspaceId: params.workspaceId,
    meetingId: params.meetingId,
    workflowJobId: params.workflowJobId ?? null,
  });
  return { extracted: insights.length };
}

export async function postMeetingSummaryToAgendaThread(params: {
  workspaceId: string;
  meetingId: string;
}) {
  const reviewPreparation = await prepareSlackMeetingActionReviewPost(params);
  if (reviewPreparation?.configured) {
    if (reviewPreparation.skipped) {
      return { skipped: true, reason: reviewPreparation.reason };
    }

    const validation = await validateSlackPostTarget(reviewPreparation.installationId, reviewPreparation.channelId);
    if (!validation.ok) {
      return { skipped: true, reason: validation.code };
    }

    const response = await sendSlackMessage(reviewPreparation.installationId, {
      channel: reviewPreparation.channelId,
      threadTs: reviewPreparation.threadTs ?? undefined,
    }, reviewPreparation.message.mainBlocks);
    const messageTs = typeof response.ts === "string" ? response.ts : "";
    invariant(messageTs, 502, "SLACK_POST_FAILED", "Slack did not return a message timestamp for the meeting follow-up review.");
    const threadTs = reviewPreparation.threadTs ?? messageTs;

    await markSlackMeetingActionReviewPosted({
      workspaceId: reviewPreparation.workspaceId,
      meetingId: reviewPreparation.meetingId,
      reviewId: reviewPreparation.reviewId,
      installationId: reviewPreparation.installationId,
      channelId: reviewPreparation.channelId,
      messageTs,
      threadTs,
      text: reviewPreparation.message.text,
      raw: response,
    });

    for (const blocks of reviewPreparation.message.overflowBlocks) {
      await sendSlackMessage(reviewPreparation.installationId, {
        channel: reviewPreparation.channelId,
        threadTs,
      }, blocks);
    }

    await prisma.meeting.update({
      where: { id: reviewPreparation.meetingId },
      data: { summaryPostedAt: new Date() },
    });
    return { posted: true, mode: "slack_meeting_action_review" };
  }

  const meeting = await prisma.meeting.findFirst({
    where: { id: params.meetingId, workspaceId: params.workspaceId },
    select: {
      id: true,
      title: true,
      summaryMd: true,
      agendaChannelId: true,
      agendaMessageTs: true,
      summaryPostedAt: true,
    },
  });
  if (!meeting?.summaryMd || !meeting.agendaChannelId || !meeting.agendaMessageTs || meeting.summaryPostedAt) {
    return { skipped: true, reason: "summary_thread_not_ready" };
  }

  const installation = await activeSlackInstallation(params.workspaceId);
  if (!installation) {
    return { skipped: true, reason: "slack_not_connected" };
  }

  const insights = await prisma.meetingInsight.findMany({
    where: {
      workspaceId: params.workspaceId,
      meetingId: params.meetingId,
      status: { not: "DISMISSED" },
    },
    orderBy: { createdAt: "asc" },
    select: { type: true, title: true, bodyMd: true },
  });
  const groupedInsights = new Map<MeetingInsightType, Array<{ title: string; bodyMd: string }>>();
  for (const insight of insights) {
    const items = groupedInsights.get(insight.type) ?? [];
    items.push({ title: insight.title, bodyMd: insight.bodyMd });
    groupedInsights.set(insight.type, items);
  }

  await sendSlackMessage(installation.id, {
    channel: meeting.agendaChannelId,
    threadTs: meeting.agendaMessageTs,
  }, renderSummaryBlocks({ meeting, groupedInsights }));

  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { summaryPostedAt: new Date() },
  });
  return { posted: true };
}
