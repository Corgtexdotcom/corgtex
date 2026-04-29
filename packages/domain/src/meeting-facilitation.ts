import { defaultModelGateway } from "@corgtex/models";
import { prisma, toInputJson, type AppActor } from "@corgtex/shared";
import type { MeetingInsightType, Prisma } from "@prisma/client";
import { requireWorkspaceMembership } from "./auth";
import { invariant } from "./errors";
import { sendSlackMessage } from "./communication";
import { extractMeetingInsights } from "./meeting-intelligence";

type AgendaSection = {
  title: string;
  items: Array<{
    text: string;
    sourceType?: string | null;
    sourceId?: string | null;
    owner?: string | null;
  }>;
  durationMinutes?: number | null;
};

type AgendaJson = {
  title: string;
  intro?: string | null;
  sections: AgendaSection[];
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

function displayDate(date: Date, timeZone = "UTC") {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function userLabel(user?: { displayName?: string | null; email?: string | null } | null) {
  return user?.displayName || user?.email || null;
}

function truncate(text: string, max = 2900) {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeAgenda(output: Record<string, unknown>, fallbackTitle: string, fallbackSections: AgendaSection[]): AgendaJson {
  const sectionsRaw = Array.isArray(output.sections) ? output.sections : [];
  const sections = sectionsRaw.map((section): AgendaSection | null => {
    if (!isRecord(section)) return null;
    const title = typeof section.title === "string" && section.title.trim() ? section.title.trim() : null;
    const itemsRaw = Array.isArray(section.items) ? section.items : [];
    const items: AgendaSection["items"] = [];
    for (const item of itemsRaw) {
      if (typeof item === "string") {
        const text = item.trim();
        if (text) items.push({ text });
        continue;
      }
      if (!isRecord(item)) continue;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) continue;
      items.push({
        text,
        sourceType: typeof item.sourceType === "string" ? item.sourceType : null,
        sourceId: typeof item.sourceId === "string" ? item.sourceId : null,
        owner: typeof item.owner === "string" ? item.owner : null,
      });
    }
    if (!title || items.length === 0) return null;
    return {
      title,
      items,
      durationMinutes: typeof section.durationMinutes === "number" ? section.durationMinutes : null,
    };
  }).filter((section): section is AgendaSection => Boolean(section));

  return {
    title: typeof output.title === "string" && output.title.trim() ? output.title.trim() : fallbackTitle,
    intro: typeof output.intro === "string" ? output.intro.trim() : null,
    sections: sections.length > 0 ? sections : fallbackSections,
  };
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

function renderAgendaBlocks(params: {
  meeting: { title: string | null; recordedAt: Date; scheduledEndAt: Date | null };
  agenda: AgendaJson;
  attendeeMentions: string[];
  timezone: string;
}) {
  const when = params.meeting.scheduledEndAt
    ? `${displayDate(params.meeting.recordedAt, params.timezone)}-${new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: params.timezone,
    }).format(params.meeting.scheduledEndAt)}`
    : displayDate(params.meeting.recordedAt, params.timezone);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Tomorrow's agenda: ${params.meeting.title || params.agenda.title}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*When:* ${when}`,
          params.attendeeMentions.length > 0 ? `*Attendees:* ${params.attendeeMentions.join(" ")}` : null,
          params.agenda.intro ? `\n${params.agenda.intro}` : null,
        ].filter(Boolean).join("\n"),
      },
    },
    { type: "divider" },
    ...params.agenda.sections.map((section) => slackSection(section.title, section.items.map((item, index) => {
      const owner = item.owner ? ` (${item.owner})` : "";
      return `${index + 1}. ${item.text}${owner}`;
    }))),
  ];
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

  const current = isRecord(installation.settings) ? installation.settings : {};
  const settings = {
    ...current,
    defaultAgendaChannelId: params.defaultAgendaChannelId.trim() || null,
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
  const meeting = await prisma.meeting.findFirst({
    where: { id: meetingId, workspaceId, archivedAt: null },
    include: { series: true },
  });
  invariant(meeting, 404, "NOT_FOUND", "Meeting not found.");

  const participantEmails = meeting.participantEmails.map((email) => email.toLowerCase());
  const memberOr = [
    meeting.participantIds.length > 0 ? { id: { in: meeting.participantIds } } : null,
    participantEmails.length > 0 ? { user: { email: { in: participantEmails } } } : null,
  ].filter(Boolean) as Prisma.MemberWhereInput[];
  const members = await prisma.member.findMany({
    where: {
      workspaceId,
      isActive: true,
      ...(memberOr.length > 0 ? { OR: memberOr } : { id: { in: [] } }),
    },
    include: {
      user: { select: { displayName: true, email: true } },
      roleAssignments: {
        include: {
          role: {
            select: {
              circleId: true,
              circle: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  const memberIds = members.map((member) => member.id);
  const circleIds = [...new Set(members.flatMap((member) => member.roleAssignments.map((assignment) => assignment.role.circleId)))];
  const scopedOr = [
    circleIds.length > 0 ? { circleId: { in: circleIds } } : null,
    memberIds.length > 0 ? { assigneeMemberId: { in: memberIds } } : null,
    memberIds.length > 0 ? { raisedByMemberId: { in: memberIds } } : null,
  ].filter(Boolean) as Prisma.TensionWhereInput[];

  const [tensions, actions, previousMeeting] = await Promise.all([
    prisma.tension.findMany({
      where: {
        workspaceId,
        status: "OPEN",
        isPrivate: false,
        publishedAt: { not: null },
        archivedAt: null,
        ...(scopedOr.length > 0 ? { OR: scopedOr } : {}),
      },
      include: {
        upvotes: true,
        circle: { select: { name: true } },
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
        raisedByMember: { include: { user: { select: { displayName: true, email: true } } } },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 8,
    }),
    prisma.action.findMany({
      where: {
        workspaceId,
        status: { in: ["OPEN", "IN_PROGRESS"] },
        isPrivate: false,
        publishedAt: { not: null },
        archivedAt: null,
        ...(memberIds.length > 0 || circleIds.length > 0
          ? {
            OR: [
              memberIds.length > 0 ? { assigneeMemberId: { in: memberIds } } : null,
              circleIds.length > 0 ? { circleId: { in: circleIds } } : null,
            ].filter(Boolean) as Prisma.ActionWhereInput[],
          }
          : {}),
      },
      include: {
        circle: { select: { name: true } },
        assigneeMember: { include: { user: { select: { displayName: true, email: true } } } },
      },
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      take: 8,
    }),
    prisma.meeting.findFirst({
      where: {
        workspaceId,
        id: { not: meeting.id },
        status: "COMPLETED",
        archivedAt: null,
        recordedAt: { lt: meeting.recordedAt },
        OR: [
          meeting.seriesId ? { seriesId: meeting.seriesId } : null,
          meeting.title ? { title: meeting.title } : null,
        ].filter(Boolean) as Prisma.MeetingWhereInput[],
      },
      orderBy: { recordedAt: "desc" },
      select: { id: true },
    }),
  ]);

  const followUps = previousMeeting
    ? await prisma.meetingInsight.findMany({
      where: {
        workspaceId,
        meetingId: previousMeeting.id,
        type: "FOLLOW_UP",
        status: { not: "DISMISSED" },
      },
      orderBy: { createdAt: "asc" },
      take: 8,
    })
    : [];

  return {
    meeting,
    attendees: members.map((member) => ({
      memberId: member.id,
      name: userLabel(member.user),
      email: member.user.email,
      circles: member.roleAssignments.map((assignment) => assignment.role.circle?.name).filter(Boolean),
    })),
    tensions: tensions.map((tension) => ({
      id: tension.id,
      title: tension.title,
      priority: tension.priority,
      upvotes: tension.upvotes.length,
      circle: tension.circle?.name ?? null,
      owner: userLabel(tension.assigneeMember?.user) ?? userLabel(tension.raisedByMember?.user),
    })),
    actions: actions.map((action) => ({
      id: action.id,
      title: action.title,
      status: action.status,
      dueAt: action.dueAt?.toISOString() ?? null,
      circle: action.circle?.name ?? null,
      owner: userLabel(action.assigneeMember?.user),
    })),
    followUps: followUps.map((followUp) => ({
      id: followUp.id,
      title: followUp.title,
      bodyMd: followUp.bodyMd,
      owner: followUp.assigneeHint,
    })),
  };
}

export async function prepareAgendaForMeeting(params: {
  workspaceId: string;
  meetingId: string;
  workflowJobId?: string;
}) {
  const context = await buildMeetingAgendaContext(params.workspaceId, params.meetingId);
  const fallbackSections: AgendaSection[] = [
    {
      title: "Check-in",
      durationMinutes: 5,
      items: [{ text: "Brief check-in round." }],
    },
    {
      title: "Tensions to process",
      items: context.tensions.map((tension) => ({
        text: `${tension.title}${tension.upvotes ? ` (${tension.upvotes} upvotes)` : ""}`,
        sourceType: "Tension",
        sourceId: tension.id,
        owner: tension.owner,
      })),
    },
    {
      title: "Follow-ups from last meeting",
      items: context.followUps.map((followUp) => ({
        text: followUp.title,
        sourceType: "MeetingInsight",
        sourceId: followUp.id,
        owner: followUp.owner,
      })),
    },
    {
      title: "Pending actions",
      items: context.actions.map((action) => ({
        text: action.title,
        sourceType: "Action",
        sourceId: action.id,
        owner: action.owner,
      })),
    },
    {
      title: "Checkout",
      durationMinutes: 3,
      items: [{ text: "Confirm decisions, owners, and next follow-ups." }],
    },
  ].map((section) => ({
    ...section,
    items: section.items.length > 0 ? section.items : [{ text: "No items found." }],
  }));

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

  const agenda = normalizeAgenda(extraction.output, context.meeting.title || "Meeting agenda", fallbackSections);
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

    const externalUsers = await prisma.communicationExternalUser.findMany({
      where: {
        installationId: installation.id,
        workspaceId: params.workspaceId,
        email: { in: context.attendees.map((attendee) => attendee.email) },
      },
      select: { email: true, externalUserId: true },
    });
    const slackUsersByEmail = new Map(externalUsers.map((user) => [user.email?.toLowerCase(), user.externalUserId]));
    const attendeeMentions = context.attendees.map((attendee) => {
      const externalUserId = slackUsersByEmail.get(attendee.email.toLowerCase());
      return externalUserId ? `<@${externalUserId}>` : attendee.name || attendee.email;
    });

    const response = await sendSlackMessage(installation.id, { channel: channelId }, renderAgendaBlocks({
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
  return { posted, meetingIds: meetings.map((meeting) => meeting.id) };
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
