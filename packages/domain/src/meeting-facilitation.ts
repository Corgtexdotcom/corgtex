import { defaultModelGateway } from "@corgtex/models";
import { prisma, toInputJson, type AppActor } from "@corgtex/shared";
import type { MeetingInsightType } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { fetchSlackThreadMessages, sendSlackMessage, updateSlackMessage, validateSlackPostTarget } from "./communication";
import {
  markSlackMeetingActionReviewPosted,
  prepareSlackMeetingActionReviewPost,
} from "./meeting-action-review";
import {
  buildLegacyAgendaFallback,
  buildRegularUpdateAgenda,
  isRegularUpdateAgenda,
  normalizeLegacyAgenda,
  REGULAR_UPDATE_AGENDA_TEMPLATE_KEY,
  renderAgendaSlackBlocks,
  selectedMeetingAgendaTemplate,
  type LegacyMeetingAgenda,
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

export async function enqueueMeetingAgendaPreparation(actor: AppActor, params: {
  workspaceId: string;
  runAfter?: Date;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const runAfter = params.runAfter ?? new Date();
  const dedupeKey = `meeting-agenda-prepare:${params.workspaceId}:manual:${runAfter.toISOString()}`;
  return prisma.workflowJob.upsert({
    where: { dedupeKey },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      type: "meeting.agenda.prepare",
      payload: {
        targetDateISO: dateKey(new Date(runAfter.getTime() + 24 * 60 * 60 * 1000)),
      },
      runAfter,
      dedupeKey,
    },
  });
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

  const agenda = normalizeLegacyAgenda(extraction.output, context.meeting.title || "Meeting agenda", fallbackAgenda.sections);
  await prisma.meeting.update({
    where: { id: context.meeting.id },
    data: { agendaJson: toInputJson(agenda) },
  });

  return { meeting: context.meeting, agenda, context };
}

export async function runMeetingAgendaPreparation(params: {
  workspaceId: string;
  workflowJobId?: string;
  targetDateISO?: string | null;
}) {
  const installation = await activeSlackInstallation(params.workspaceId);
  const settings = agendaSettings(installation?.settings);
  const channelId = settings.defaultAgendaChannelId?.trim();

  if (!installation || !channelId) {
    await scheduleNextAgendaJob(params.workspaceId, settings);
    return { skipped: true, reason: "slack_agenda_channel_missing" };
  }
  const channelValidation = await validateSlackPostTarget(installation.id, channelId);
  if (!channelValidation.ok) {
    await scheduleNextAgendaJob(params.workspaceId, settings);
    return { skipped: true, reason: channelValidation.code };
  }

  const targetDate = params.targetDateISO ? new Date(`${params.targetDateISO}T00:00:00.000Z`) : tomorrowBounds().start;
  const { start, end } = utcDayBounds(Number.isNaN(targetDate.valueOf()) ? tomorrowBounds().start : targetDate);
  const meetings = await prisma.meeting.findMany({
    where: {
      workspaceId: params.workspaceId,
      status: "SCHEDULED",
      archivedAt: null,
      agendaPostedAt: null,
      recordedAt: { gte: start, lt: end },
    },
    orderBy: { recordedAt: "asc" },
  });

  let posted = 0;
  for (const meeting of meetings) {
    const { agenda, context } = await prepareAgendaForMeeting({
      workspaceId: params.workspaceId,
      meetingId: meeting.id,
      workflowJobId: params.workflowJobId,
    });

    const attendeeMentions = await attendeeMentionsForContext(installation.id, params.workspaceId, context.attendees);

    const response = await sendSlackMessage(installation.id, { channel: channelId }, renderAgendaSlackBlocks({
      meeting,
      agenda,
      attendeeMentions,
      timezone: settings.agendaTimezone || "UTC",
    }));

    await prisma.meeting.update({
      where: { id: meeting.id },
      data: {
        agendaJson: toInputJson(agenda),
        agendaChannelId: String(response.channel ?? channelId),
        agendaMessageTs: String(response.ts ?? ""),
        agendaPostedAt: new Date(),
      },
    });
    posted += 1;
  }

  await scheduleNextAgendaJob(params.workspaceId, settings);
  return { posted, meetingIds: meetings.map((meeting: { id: string }) => meeting.id) };
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
