import { prisma } from "@corgtex/shared";

const SUPPRESSION_ACTION = "slack_followup_suppressed";

export function slackThreadKey(channelId: string, threadTs: string) {
  return `${channelId}:${threadTs}`;
}

export function slackFollowupStopIntent(text: string) {
  const normalized = text.replace(/<@[^>]+>/g, " ").trim();
  if (normalized.length > 240) return false;
  if (normalized.includes("?")) return false;
  if (/\b(?:do\s+not|don['’]?t|never)\s+(?:stop|ignore)\b/i.test(normalized)) return false;
  if (/^stop\s*[.!?]*$/i.test(normalized)) return true;
  if (/^(?:ack|acknowledged|got it|thanks|thank you)\s*[.!?]*$/i.test(normalized)) return true;
  return /\b(?:stop\s+(?:all\s+)?(?:the\s+)?(?:follow[ -]?ups?|reminders?|nudges?)|please\s+stop\s+(?:the\s+)?reminders?|stop[.!\s]+do\s+nothing|ignore\s+(?:this\s+)?corgtex|(?:^|[.!?]\s*)ignore\s*[.!?]*$|(?:^|[.!?]\s*)solved\s*[.!?]*$|(?:^|[.!?]\s*)delete\s+it\s*[.!?]*$|(?:^|[.!?]\s*)working\s+on\s+it\b|already\s+being\s+tracked\b)/i.test(normalized);
}

export async function suppressSlackThreadFollowups(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
  messageId: string;
  externalUserId: string | null;
}) {
  const entityId = slackThreadKey(params.channelId, params.threadTs);
  const claimKey = `slack-followup-stop:${params.installationId}:${entityId}`;
  await prisma.communicationEntityLink.upsert({
    where: { workspaceId_claimKey: { workspaceId: params.workspaceId, claimKey } },
    update: {},
    create: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      messageId: params.messageId,
      externalUserId: params.externalUserId,
      entityType: "SlackThread",
      entityId,
      action: SUPPRESSION_ACTION,
      claimKey,
    },
  });
}

export async function isSlackThreadFollowupSuppressed(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
}) {
  const marker = await prisma.communicationEntityLink.findFirst({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      entityType: "SlackThread",
      entityId: slackThreadKey(params.channelId, params.threadTs),
      action: SUPPRESSION_ACTION,
    },
    select: { id: true },
  });
  if (marker) return true;

  // Reconcile commands sent before this marker was introduced, including users
  // whose Slack identity was never matched to a Corgtex member.
  const stop = await findSlackThreadStopMessage(params);
  if (!stop) return false;
  await suppressSlackThreadFollowups({ ...params, messageId: stop.id, externalUserId: stop.externalUserId });
  return true;
}

export async function reconcileSlackThreadFollowupsAfterMessageChange(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
  messageId: string;
}) {
  const marker = await prisma.communicationEntityLink.findFirst({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      entityType: "SlackThread",
      entityId: slackThreadKey(params.channelId, params.threadTs),
      action: SUPPRESSION_ACTION,
    },
    select: { id: true, messageId: true },
  });
  if (!marker || marker.messageId !== params.messageId) return;

  const otherStop = await findSlackThreadStopMessage(params);
  if (otherStop) {
    await prisma.communicationEntityLink.updateMany({
      where: { id: marker.id, messageId: params.messageId },
      data: { messageId: otherStop.id, externalUserId: otherStop.externalUserId },
    });
  } else {
    await prisma.communicationEntityLink.deleteMany({ where: { id: marker.id, messageId: params.messageId } });
  }
}

async function findSlackThreadStopMessage(params: {
  workspaceId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
}) {
  let cursor: string | undefined;
  while (true) {
    const messages = await prisma.communicationMessage.findMany({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        provider: "SLACK",
        externalChannelId: params.channelId,
        text: { not: null },
        textRedactedAt: null,
        isBot: false,
        isHidden: false,
        isDeleted: false,
        OR: [{ externalMessageId: params.threadTs }, { threadExternalId: params.threadTs }],
      },
      orderBy: [{ messageTs: "desc" }, { id: "desc" }],
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, externalUserId: true, text: true },
    });
    const stop = messages.find((message) => slackFollowupStopIntent(message.text ?? ""));
    if (stop) return stop;
    if (messages.length < 100) return null;
    cursor = messages[messages.length - 1].id;
  }
}
