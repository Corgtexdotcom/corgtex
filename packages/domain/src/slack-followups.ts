import { prisma } from "@corgtex/shared";

const SUPPRESSION_ACTION = "slack_followup_suppressed";

export function slackThreadKey(channelId: string, threadTs: string) {
  return `${channelId}:${threadTs}`;
}

export function slackSourceUrl(channelId: string, threadTs: string) {
  return `https://app.slack.com/archives/${encodeURIComponent(channelId)}/p${threadTs.replace(".", "")}`;
}

export function slackFollowupStopIntent(text: string) {
  const normalized = text.replace(/<@[^>]+>/g, " ").trim();
  if (normalized.length > 240) return false;
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
    orderBy: { messageTs: "desc" },
    take: 100,
    select: { id: true, externalUserId: true, text: true },
  });
  const stop = messages.find((message) => slackFollowupStopIntent(message.text ?? ""));
  if (!stop) return false;
  await suppressSlackThreadFollowups({ ...params, messageId: stop.id, externalUserId: stop.externalUserId });
  return true;
}
