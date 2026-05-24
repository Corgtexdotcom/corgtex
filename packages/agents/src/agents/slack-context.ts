import { Prisma } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import {
  AGENT_REGISTRY,
  createWorkItemFromCommunicationSource,
  getAgentModelOverride,
  isAgentEnabled,
  sendSlackMessage,
} from "@corgtex/domain";

const DEFAULT_PROACTIVE_CONFIDENCE = 0.9;
const DEFAULT_UNANSWERED_DELAY_MINUTES = 240;
const MAX_PROACTIVE_WORK_ITEMS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function dayBounds(dayISO: string) {
  const start = new Date(`${dayISO}T00:00:00.000Z`);
  const safeStart = Number.isNaN(start.valueOf()) ? new Date() : start;
  safeStart.setUTCHours(0, 0, 0, 0);
  const end = new Date(safeStart);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: safeStart, end };
}

function dateKey(date: Date) {
  return date.toISOString().split("T")[0];
}

function summaryKey(channelId: string, threadTs: string | null, dayISO: string) {
  return `channel:${channelId}:thread:${threadTs || "channel"}:day:${dayISO}`;
}

function slackAgentConfig(value: unknown) {
  const config = isRecord(value) ? value : {};
  const mutedChannelIds = Array.isArray(config.mutedChannelIds)
    ? config.mutedChannelIds.map((entry) => asString(entry)).filter(Boolean)
    : [];
  const proactiveConfidenceThreshold = typeof config.proactiveConfidenceThreshold === "number"
    ? config.proactiveConfidenceThreshold
    : DEFAULT_PROACTIVE_CONFIDENCE;
  const unansweredFollowupDelayMinutes = typeof config.unansweredFollowupDelayMinutes === "number"
    ? config.unansweredFollowupDelayMinutes
    : DEFAULT_UNANSWERED_DELAY_MINUTES;

  return {
    publicIngestionEnabled: config.publicIngestionEnabled !== false,
    proactiveEnabled: config.proactiveEnabled !== false,
    proactiveConfidenceThreshold: Math.max(0, Math.min(1, proactiveConfidenceThreshold)),
    unansweredFollowupDelayMinutes: Math.max(15, Math.floor(unansweredFollowupDelayMinutes)),
    mutedChannelIds,
  };
}

async function readSlackAgentConfig(workspaceId: string) {
  const config = await prisma.workspaceAgentConfig.findUnique({
    where: { workspaceId_agentKey: { workspaceId, agentKey: "slack-agent" } },
    select: { configJson: true },
  });
  return slackAgentConfig(config?.configJson);
}

export async function runSlackContextSummary(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  threadTs?: string | null;
  dayISO: string;
  workflowJobId?: string;
}) {
  const config = await readSlackAgentConfig(params.workspaceId);
  if (!config.publicIngestionEnabled || config.mutedChannelIds.includes(params.channelId)) {
    return { skipped: true, reason: "slack_context_disabled" };
  }

  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      id: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!installation) return { skipped: true, reason: "slack_installation_missing" };

  const { start, end } = dayBounds(params.dayISO);
  const threadTs = params.threadTs?.trim() || null;
  const messages = await prisma.communicationMessage.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      externalChannelId: params.channelId,
      messageTs: { gte: start, lt: end },
      text: { not: null },
      textRedactedAt: null,
      isBot: false,
      isHidden: false,
      isDeleted: false,
      ...(threadTs
        ? { OR: [{ externalMessageId: threadTs }, { threadExternalId: threadTs }] }
        : {}),
    },
    orderBy: { messageTs: "asc" },
    take: 120,
  });

  if (messages.length === 0) {
    await prisma.communicationContextSummary.deleteMany({
      where: {
        installationId: params.installationId,
        summaryKey: summaryKey(params.channelId, threadTs, params.dayISO),
      },
    });
    return { skipped: true, reason: "no_messages" };
  }

  const channel = await prisma.communicationChannel.findUnique({
    where: {
      installationId_externalChannelId: {
        installationId: params.installationId,
        externalChannelId: params.channelId,
      },
    },
    select: { name: true },
  });
  const channelLabel = channel?.name ? `#${channel.name}` : params.channelId;
  const transcript = messages.map((message) => {
    const speaker = message.externalUserId ?? "unknown";
    const time = message.messageTs?.toISOString() ?? message.externalMessageId;
    return `[${time}] ${speaker}: ${message.text}`;
  }).join("\n");

  const model = resolveModel(AGENT_REGISTRY["slack-agent"].defaultModelTier);
  const response = await defaultModelGateway.chat({
    model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    taskType: "SUMMARY",
    messages: [
      {
        role: "system",
        content: "Summarize Slack context for retrieval. Capture decisions, open questions, action candidates, owners mentioned, and unresolved risks. Do not add facts that are not in the transcript.",
      },
      {
        role: "user",
        content: JSON.stringify({
          channel: channelLabel,
          threadTs,
          dayISO: params.dayISO,
          transcript,
        }),
      },
    ],
  });

  const first = messages[0];
  const last = messages[messages.length - 1];
  const key = summaryKey(params.channelId, threadTs, params.dayISO);
  await prisma.communicationContextSummary.upsert({
    where: {
      installationId_summaryKey: {
        installationId: params.installationId,
        summaryKey: key,
      },
    },
    update: {
      title: `Slack ${channelLabel} ${threadTs ? "thread" : "channel"} ${params.dayISO}`,
      summaryMd: response.content.trim(),
      messageCount: messages.length,
      firstMessageTs: first.messageTs,
      lastMessageTs: last.messageTs,
      lastMessageExternalId: last.externalMessageId,
      sourceMessageIds: messages.map((message) => message.id),
      metadata: toInputJson({ channel: channelLabel, threadTs, dayISO: params.dayISO, workflowJobId: params.workflowJobId }),
    },
    create: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      externalChannelId: params.channelId,
      threadExternalId: threadTs,
      summaryDate: start,
      summaryKey: key,
      title: `Slack ${channelLabel} ${threadTs ? "thread" : "channel"} ${params.dayISO}`,
      summaryMd: response.content.trim(),
      messageCount: messages.length,
      firstMessageTs: first.messageTs,
      lastMessageTs: last.messageTs,
      lastMessageExternalId: last.externalMessageId,
      sourceMessageIds: messages.map((message) => message.id),
      metadata: toInputJson({ channel: channelLabel, threadTs, dayISO: params.dayISO, workflowJobId: params.workflowJobId }),
    },
  });

  return { summarized: true, messageCount: messages.length };
}

function looksUnanswered(text: string) {
  return /\?/.test(text) || /\b(can someone|anyone|please|could someone|does anyone|who can|need help)\b/i.test(text);
}

function looksWorkLike(text: string) {
  return /\b(should|todo|to do|follow up|need to|needs to|please|can you|owner|by tomorrow|proposal|tension|action item)\b/i.test(text);
}

function normalizeProactiveExtraction(output: Record<string, unknown>) {
  const intent = asString(output.intent);
  const confidence = typeof output.confidence === "number" ? output.confidence : Number(output.confidence);
  return {
    intent,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    title: asString(output.title),
    bodyMd: asString(output.bodyMd) || asString(output.body),
    couldNot: Array.isArray(output.couldNot) ? output.couldNot.map((entry) => asString(entry)).filter(Boolean) : [],
  };
}

function isSlackInvalidAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const dataError = isRecord(error) && isRecord(error.data) ? asString(error.data.error) : "";
  return message.includes("invalid_auth") || dataError === "invalid_auth";
}

async function markSlackInstallationReauthRequired(params: {
  installationId: string;
  workspaceId: string;
  error: unknown;
}) {
  if (!isSlackInvalidAuthError(params.error)) {
    return false;
  }
  await prisma.communicationInstallation.updateMany({
    where: {
      id: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
    },
    data: {
      status: "ERROR",
      disconnectedAt: new Date(),
      lastError: "invalid_auth",
    },
  });
  return true;
}

export async function runSlackProactiveScan(params: {
  workspaceId: string;
  installationId: string;
  workflowJobId?: string;
}) {
  if (!await isAgentEnabled(params.workspaceId, "slack-agent")) {
    return { skipped: true, reason: "slack_agent_disabled" };
  }
  const config = await readSlackAgentConfig(params.workspaceId);
  if (!config.publicIngestionEnabled || !config.proactiveEnabled) {
    return { skipped: true, reason: "slack_proactive_disabled" };
  }

  const installation = await prisma.communicationInstallation.findFirst({
    where: {
      id: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      status: "ACTIVE",
    },
    select: { id: true, settings: true },
  });
  if (!installation) return { skipped: true, reason: "slack_installation_missing" };

  const muted = new Set(config.mutedChannelIds);
  const channels = await prisma.communicationChannel.findMany({
    where: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      kind: "PUBLIC",
      isIngestEnabled: true,
      isArchived: false,
    },
    select: { externalChannelId: true },
  });
  const channelIds = channels.map((channel) => channel.externalChannelId).filter((id) => !muted.has(id));
  if (channelIds.length === 0) return { skipped: true, reason: "no_channels" };

  const now = new Date();
  const agendaSettings = isRecord(installation.settings) ? installation.settings : {};
  let agendaJobs = 0;
  const agendaChannelId = asString(agendaSettings.defaultAgendaChannelId);
  if (agendaChannelId) {
    const targetDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const targetDateISO = dateKey(targetDate);
    await prisma.workflowJob.upsert({
      where: { dedupeKey: `${params.workspaceId}:slack-proactive-agenda:${targetDateISO}` },
      update: {},
      create: {
        workspaceId: params.workspaceId,
        type: "meeting.agenda.prepare",
        payload: toInputJson({ targetDateISO }) as Prisma.InputJsonObject,
        dedupeKey: `${params.workspaceId}:slack-proactive-agenda:${targetDateISO}`,
      },
    });
    agendaJobs = 1;
  }

  const unansweredCutoff = new Date(now.getTime() - config.unansweredFollowupDelayMinutes * 60 * 1000);
  const recentCutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const candidates = await prisma.communicationMessage.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      externalChannelId: { in: channelIds },
      messageTs: { gte: recentCutoff, lte: unansweredCutoff },
      text: { not: null },
      textRedactedAt: null,
      isBot: false,
      isHidden: false,
      isDeleted: false,
    },
    orderBy: { messageTs: "desc" },
    take: 100,
  });

  let nudges = 0;
  for (const candidate of candidates.filter((message) => looksUnanswered(message.text ?? "")).slice(0, 10)) {
    const threadTs = candidate.threadExternalId || candidate.externalMessageId;
    const alreadyNudged = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        messageId: candidate.id,
        action: "proactive_unanswered_nudge",
        createdAt: { gte: dayBounds(dateKey(now)).start },
      },
      select: { id: true },
    });
    if (alreadyNudged) continue;

    const replies = await prisma.communicationMessage.count({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        provider: "SLACK",
        externalChannelId: candidate.externalChannelId,
        messageTs: candidate.messageTs ? { gt: candidate.messageTs } : undefined,
        text: { not: null },
        textRedactedAt: null,
        isBot: false,
        isHidden: false,
        isDeleted: false,
        OR: [{ externalMessageId: threadTs }, { threadExternalId: threadTs }],
      },
    });
    if (replies > 0) continue;

    try {
      await sendSlackMessage(params.installationId, {
        channel: candidate.externalChannelId,
        threadTs,
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: "This looks unanswered. Should someone take it, or should I turn it into a Corgtex action?" },
      }], "This looks unanswered.");
    } catch (error) {
      if (await markSlackInstallationReauthRequired({ ...params, error })) {
        return { skipped: true, reason: "slack_reauth_required" };
      }
      throw error;
    }

    await prisma.communicationEntityLink.create({
      data: {
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        provider: "SLACK",
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: "CommunicationMessage",
        entityId: candidate.id,
        action: "proactive_unanswered_nudge",
      },
    });
    nudges += 1;
    if (nudges >= 3) break;
  }

  const model = await getAgentModelOverride(params.workspaceId, "slack-agent")
    ?? resolveModel(AGENT_REGISTRY["slack-agent"].defaultModelTier);
  const agentActor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "slack-agent" };
  let drafts = 0;
  const workCandidates = candidates.filter((message) => looksWorkLike(message.text ?? "")).slice(0, 10);

  for (const candidate of workCandidates) {
    if (drafts >= MAX_PROACTIVE_WORK_ITEMS) break;
    const existing = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        messageId: candidate.id,
        action: { in: ["create_action", "create_tension", "create_proposal", "create_brain_note"] },
      },
      select: { id: true },
    });
    if (existing) continue;

    const extraction = await defaultModelGateway.extract({
      model,
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      instruction: [
        "Classify whether this public Slack message should become a private Corgtex draft.",
        "Return JSON only with intent, confidence, title, bodyMd, and couldNot.",
        "Allowed intents: create_action, create_tension, create_proposal, capture_note, ignore.",
        "Use ignore for destructive, admin, finance, permission, invite, role, delete, archive, payment, broad-notification, or unclear requests.",
      ].join(" "),
      schemaHint: "{ intent: string, confidence: number, title: string, bodyMd: string, couldNot: string[] }",
      input: JSON.stringify({
        text: candidate.text,
        externalUserId: candidate.externalUserId,
        channelId: candidate.externalChannelId,
        messageTs: candidate.externalMessageId,
      }),
    });
    const parsed = normalizeProactiveExtraction(extraction.output);
    if (parsed.confidence < config.proactiveConfidenceThreshold || parsed.intent === "ignore" || parsed.couldNot.length > 0) {
      continue;
    }

    const kind = parsed.intent === "create_action"
      ? "ACTION"
      : parsed.intent === "create_tension"
        ? "TENSION"
        : parsed.intent === "create_proposal"
          ? "PROPOSAL"
          : parsed.intent === "capture_note"
            ? "BRAIN_NOTE"
            : null;
    if (!kind || !parsed.title) continue;

    const item = await createWorkItemFromCommunicationSource(agentActor, {
      workspaceId: params.workspaceId,
      provider: "SLACK",
      installationId: params.installationId,
      kind,
      title: parsed.title,
      bodyMd: parsed.bodyMd || candidate.text,
      sourceMessageId: candidate.id,
      externalUserId: candidate.externalUserId,
      open: false,
    });

    try {
      await sendSlackMessage(params.installationId, {
        channel: candidate.externalChannelId,
        threadTs: candidate.threadExternalId || candidate.externalMessageId,
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: `I created a private Corgtex draft from this: <${item.webUrl}|${parsed.title}>.` },
      }], `Created a private Corgtex draft: ${parsed.title}`);
    } catch (error) {
      if (await markSlackInstallationReauthRequired({ ...params, error })) {
        return { skipped: true, reason: "slack_reauth_required" };
      }
      throw error;
    }
    drafts += 1;
  }

  return { agendaJobs, nudges, drafts };
}
