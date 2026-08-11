import { Prisma } from "@prisma/client";
import { prisma, toInputJson } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { defaultModelGateway, resolveModel } from "@corgtex/models";
import {
  AGENT_REGISTRY,
  createWorkItemFromCommunicationSource,
  getAgentModelOverride,
  isAgentEnabled,
  postDeliberationEntry,
  sendSlackMessage,
} from "@corgtex/domain";

const DEFAULT_PROACTIVE_CONFIDENCE = 0.9;
const DEFAULT_UNANSWERED_DELAY_MINUTES = 24 * 60;
const DEFAULT_UNANSWERED_ACTION_DELAY_MINUTES = 24 * 60;
const DEFAULT_STALE_ACTION_FOLLOWUP_DELAY_MINUTES = 72 * 60;
const PROACTIVE_LOOKBACK_MINUTES = 7 * 24 * 60;
const MAX_PROACTIVE_NUDGES = 3;
const MAX_PROACTIVE_ACTIONS = 3;
const MAX_PROACTIVE_ACTION_FOLLOWUPS = 3;
const PROACTIVE_EXISTING_ACTION_UPDATE = "proactive_existing_action_update";
const PROACTIVE_ACTION_WAITING_UPDATE = "proactive_action_waiting_update";
const PROACTIVE_NON_ACTION = "proactive_unanswered_non_action";
const PROACTIVE_ACTION_CLAIM_PREFIX = "slack-proactive-action";
const PROACTIVE_NON_ACTION_CLAIM_PREFIX = "slack-proactive-non-action";

type ProactiveResolutionState = "answered" | "open" | "unknown";
type ProactiveWorkDisposition = "action" | "awareness" | "information" | "test" | "ignore" | "unknown";

type SlackCandidateMessage = {
  id: string;
  externalChannelId: string;
  externalMessageId: string;
  externalUserId: string | null;
  threadExternalId: string | null;
  text: string | null;
  messageTs: Date | null;
};

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

function delayMinutes(value: unknown, fallback: number) {
  return typeof value === "number"
    ? Math.max(15, Math.floor(value))
    : fallback;
}

function slackAgentConfig(value: unknown) {
  const config = isRecord(value) ? value : {};
  const mutedChannelIds = Array.isArray(config.mutedChannelIds)
    ? config.mutedChannelIds.map((entry) => asString(entry)).filter(Boolean)
    : [];
  const proactiveConfidenceThreshold = typeof config.proactiveConfidenceThreshold === "number"
    ? config.proactiveConfidenceThreshold
    : DEFAULT_PROACTIVE_CONFIDENCE;

  return {
    publicIngestionEnabled: config.publicIngestionEnabled !== false,
    proactiveEnabled: config.proactiveEnabled !== false,
    proactiveActionPublicationEnabled: config.proactiveActionPublicationEnabled === true,
    proactiveConfidenceThreshold: Math.max(0, Math.min(1, proactiveConfidenceThreshold)),
    unansweredFollowupDelayMinutes: delayMinutes(config.unansweredFollowupDelayMinutes, DEFAULT_UNANSWERED_DELAY_MINUTES),
    unansweredActionCreationDelayMinutes: delayMinutes(config.unansweredActionCreationDelayMinutes, DEFAULT_UNANSWERED_ACTION_DELAY_MINUTES),
    staleActionFollowupDelayMinutes: delayMinutes(config.staleActionFollowupDelayMinutes, DEFAULT_STALE_ACTION_FOLLOWUP_DELAY_MINUTES),
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAddressedToSlackBot(text: string, botUserId: string | null | undefined) {
  const normalizedBotUserId = botUserId?.trim();
  if (!normalizedBotUserId) return false;
  return new RegExp(`<@${escapeRegExp(normalizedBotUserId)}(?:\\|[^>]+)?>`).test(text);
}

function normalizeResolutionState(value: unknown): ProactiveResolutionState {
  return value === "answered" || value === "open" ? value : "unknown";
}

function normalizeWorkDisposition(value: unknown): ProactiveWorkDisposition {
  return value === "action"
    || value === "awareness"
    || value === "information"
    || value === "test"
    || value === "ignore"
    ? value
    : "unknown";
}

function normalizeProactiveExtraction(output: Record<string, unknown>) {
  const intent = asString(output.intent);
  const confidence = typeof output.confidence === "number" ? output.confidence : Number.NaN;
  const couldNot = Array.isArray(output.couldNot) && output.couldNot.every((entry) => typeof entry === "string")
    ? output.couldNot.map((entry) => entry.trim()).filter(Boolean)
    : ["invalid couldNot"];
  return {
    intent,
    resolutionState: normalizeResolutionState(output.resolutionState),
    workDisposition: normalizeWorkDisposition(output.workDisposition),
    concreteNextStep: asString(output.concreteNextStep),
    ownerEvidence: asString(output.ownerEvidence),
    timingEvidence: asString(output.timingEvidence),
    explicitActionRequest: output.explicitActionRequest === true,
    negativeCategory: output.negativeCategory !== false,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    title: asString(output.title),
    bodyMd: asString(output.bodyMd) || asString(output.body),
    updateMd: asString(output.updateMd),
    reason: asString(output.reason),
    couldNot,
    followupDelayMultiplier: typeof output.followupDelayMultiplier === "number"
      ? Math.max(1, Math.min(4, Math.floor(output.followupDelayMultiplier)))
      : 1,
  };
}

function hasDeterministicNegativeCategory(text: string) {
  if (/\b(?:not\s+(?:yet\s+)?(?:done|sent|handled|finished|completed|resolved)|(?:must|should|will|needs? to|please ensure(?: that)?)[^.!?\n]{0,80}\b(?:be|is|are)\s+(?:done|sent|handled|finished|completed|resolved))\b/i.test(text)) return false;
  return /(?:^|[.!?\n]\s*)(?:this is |just |only )?(?:a )?(?:test(?:ing)?(?: message)?|dry run|routing check|checking (?:the )?routing)\b/im.test(text) || /(?:^|\n)\s*(?:(?:quick|just)\s+)?(?:fyi|for your information|heads[- ]?up)\b/im.test(text)
    || /(?:^|\n)\s*(?:ack(?:nowledged)?|got it|sounds good|thank you|thanks)[.!]?\s*$/im.test(text)
    || (/\b(?:already (?:done|sent|handled|finished|completed|resolved)|(?:i|we|it|this|that)(?:'s|'ve| have| is)? (?:already )?(?:did|sent|handled|finished|completed|resolved|done)|(?:has|have|had|was|were|is|are) (?:already )?(?:been )?(?:done|sent|handled|finished|completed|resolved)|(?:did|sent|handled|finished|completed|resolved) it|no action (?:is )?needed|not an? action item)\b/i.test(text) || /\b(?:[A-Z][\p{L}'-]*|<@[A-Z0-9]+(?:\|[^>]+)?>) (?:already )?(?:sent|handled|finished|completed|resolved)\b/u.test(text))
    || /(?:^|[.!?]\s*)done\b/i.test(text);
}

function hasExplicitActionCreateRequest(text: string) {
  if (/\b(?:do not|don't|dont|never|must not|mustn't|no need to|should not|shouldn't)\b[^.!?\n]{0,50}\b(?:create|make|open|add|assign|turn)\b[^.!?\n]{0,40}\baction(?: item)?\b/i.test(text)
    || /\bnot an? action item\b/i.test(text)) {
    return false;
  }
  return /\b(?:create|make|open|add|assign)\b[^.!?\n]{0,50}\b(?:corgtex\s+)?action(?: item)?\b/i.test(text)
    || /\bturn\b[^.!?\n]{0,30}\binto\b[^.!?\n]{0,20}\b(?:an?\s+)?action(?: item)?\b/i.test(text);
}

function evidenceIsGrounded(evidence: string, threadMessages: SlackCandidateMessage[]) {
  if (evidence.trim().length < 2) return false;
  const transcript = threadMessages.map((message) => message.text ?? "").join("\n").toLowerCase();
  return transcript.includes(evidence.toLowerCase());
}

function hasConcreteOwnerEvidence(ownerEvidence: string, threadMessages: SlackCandidateMessage[]) {
  return !/^(?:a|an|and|at|by|for|from|in|it|of|on|or|please|someone|somebody|anyone|anybody|team|the team|to|us|we|they|owner|unknown|tbd|unassigned|today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)$/i.test(ownerEvidence.trim()) && (/<@[A-Z0-9]+(?:\|[^>]+)?>/i.test(ownerEvidence) || threadMessages.some((message) => (message.text ?? "").includes(ownerEvidence)))
    && evidenceIsGrounded(ownerEvidence, threadMessages);
}

function hasConcreteDeliverableEvidence(evidence: string, threadMessages: SlackCandidateMessage[]) {
  const words = evidence.match(/[a-z0-9]+/gi) ?? [];
  return words.length >= 2
    && !/^(?:(?:send|do|handle|check|review|confirm|follow up|look into|take care of) (?:it|this|that)|(?:by|before|after|on|at|during|until|this|next)\s+(?:the\s+)?(?:end\s+of\s+)?[a-z0-9'-]+)$/i.test(evidence.trim())
    && evidenceIsGrounded(evidence, threadMessages);
}

function shouldPublishProactiveAction(params: {
  parsed: ReturnType<typeof normalizeProactiveExtraction>;
  sourceText: string;
  threadMessages: SlackCandidateMessage[];
  botUserId: string | null;
  confidenceThreshold: number;
  publicationEnabled: boolean;
}) {
  const { parsed } = params;
  const threadText = params.threadMessages.map((message) => message.text ?? "").join("\n");
  const hasOwner = hasConcreteOwnerEvidence(parsed.ownerEvidence, params.threadMessages);
  const hasExplicitCreate = parsed.explicitActionRequest && hasExplicitActionCreateRequest(params.sourceText);
  return params.publicationEnabled
    && Boolean(params.botUserId)
    && !isAddressedToSlackBot(params.sourceText, params.botUserId)
    && parsed.resolutionState === "open"
    && parsed.workDisposition === "action"
    && parsed.intent === "create_action"
    && hasConcreteDeliverableEvidence(parsed.concreteNextStep, params.threadMessages)
    && !parsed.negativeCategory
    && !hasDeterministicNegativeCategory(threadText)
    && parsed.couldNot.length === 0
    && parsed.confidence >= params.confidenceThreshold
    && (hasOwner || hasExplicitCreate);
}

function threadTsForMessage(message: SlackCandidateMessage) {
  return message.threadExternalId || message.externalMessageId;
}

function transcriptForMessages(messages: SlackCandidateMessage[]) {
  return messages.map((message) => {
    const speaker = message.externalUserId ?? "unknown";
    const time = message.messageTs?.toISOString() ?? message.externalMessageId;
    return `[${time}] ${speaker}: ${message.text}`;
  }).join("\n");
}

async function fetchHumanThreadMessages(params: {
  workspaceId: string;
  installationId: string;
  source: SlackCandidateMessage;
}) {
  const threadTs = threadTsForMessage(params.source);
  const messages = await prisma.communicationMessage.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      externalChannelId: params.source.externalChannelId,
      messageTs: params.source.messageTs ? { gte: params.source.messageTs } : undefined,
      text: { not: null },
      textRedactedAt: null,
      isBot: false,
      isHidden: false,
      isDeleted: false,
      OR: [{ externalMessageId: threadTs }, { threadExternalId: threadTs }],
    },
    orderBy: { messageTs: "asc" },
    take: 40,
  });

  return messages.length > 0 ? messages as SlackCandidateMessage[] : [params.source];
}

async function reviewThreadForAction(params: {
  workspaceId: string;
  workflowJobId?: string;
  model: string;
  source: SlackCandidateMessage;
  nudgeCreatedAt: Date;
  threadMessages: SlackCandidateMessage[];
  linkedActionId?: string | null;
}) {
  const extraction = await defaultModelGateway.extract({
    model: params.model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    instruction: [
      "Review this public Slack thread after Corgtex already asked whether someone should take it.",
      "Return JSON only with intent, resolutionState, workDisposition, concreteNextStep, ownerEvidence, timingEvidence, explicitActionRequest, negativeCategory, confidence, reason, title, bodyMd, updateMd, followupDelayMultiplier, and couldNot.",
      "Allowed intents: create_action, update_existing_action, wait_existing_action, ignore.",
      "Allowed resolutionState values: answered, open, unknown. Allowed workDisposition values: action, awareness, information, test, ignore.",
      "Resolution and work disposition are separate: an unanswered or open thread is not automatically an action.",
      "For no linked action, use create_action only for open future work with a concrete deliverable and either an owner named in the transcript or an explicit source request to create or assign a Corgtex Action.",
      "Use awareness, information, test, or ignore for routing checks, tests, FYIs, acknowledgements, already-completed requests, general questions, and items that only need visibility.",
      "Continued silence is not task evidence. Missing or uncertain evidence must use unknown or ignore and describe the gap in couldNot.",
      "Set ownerEvidence to an exact owner substring and concreteNextStep to an exact future-deliverable substring from the transcript; set timingEvidence when present and explicitActionRequest only when the source explicitly asks to create or assign an Action.",
      "Set negativeCategory true for tests, routing checks, FYIs, acknowledgements, completed work, bot-directed requests, negated action language, or awareness/information-only content.",
      "Use update_existing_action when a linked action exists and a human reply gives a meaningful status, ownership, timing, or decision update for that action.",
      "Use wait_existing_action when a linked action exists and a human reply says no more action is needed yet, someone is waiting on another party, or action was taken but more time is needed.",
      "Use ignore when someone answered and no Corgtex record update is useful, the request is unsafe, or the next step is unclear.",
      "For update_existing_action or wait_existing_action, write updateMd as a concise deliberation note grounded only in the thread.",
      "For wait_existing_action, set followupDelayMultiplier to 2 unless the thread gives a shorter or longer explicit follow-up window.",
      "Preserve grounded timing in bodyMd when present. Do not invent owners, deadlines, deliverables, or completion state.",
    ].join(" "),
    schemaHint: "{ intent: string, resolutionState: string, workDisposition: string, concreteNextStep: string, ownerEvidence: string, timingEvidence: string, explicitActionRequest: boolean, negativeCategory: boolean, confidence: number, reason: string, title: string, bodyMd: string, updateMd: string, followupDelayMultiplier: number, couldNot: string[] }",
    input: JSON.stringify({
      sourceMessage: {
        text: params.source.text,
        externalUserId: params.source.externalUserId,
        channelId: params.source.externalChannelId,
        messageTs: params.source.externalMessageId,
      },
      linkedActionId: params.linkedActionId ?? null,
      corgtexAskedAt: params.nudgeCreatedAt.toISOString(),
      threadTranscript: transcriptForMessages(params.threadMessages),
    }),
  });
  return normalizeProactiveExtraction(extraction.output);
}

async function recordProactiveMarker(params: {
  workspaceId: string;
  installationId: string;
  provider?: "SLACK";
  messageId: string | null;
  externalUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  claimKey?: string;
}) {
  const data = {
    installationId: params.installationId,
    workspaceId: params.workspaceId,
    provider: params.provider ?? "SLACK" as const,
    messageId: params.messageId,
    externalUserId: params.externalUserId ?? null,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    claimKey: params.claimKey,
  };
  if (params.claimKey) {
    await prisma.communicationEntityLink.upsert({
      where: { workspaceId_claimKey: { workspaceId: params.workspaceId, claimKey: params.claimKey } },
      update: {},
      create: data,
    });
    return;
  }
  await prisma.communicationEntityLink.create({ data });
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
    select: { id: true, settings: true, botUserId: true },
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
  const recentCutoff = new Date(now.getTime() - PROACTIVE_LOOKBACK_MINUTES * 60 * 1000);
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
    if (isAddressedToSlackBot(candidate.text ?? "", installation.botUserId)) continue;
    const threadTs = threadTsForMessage(candidate);
    const alreadyNudged = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        messageId: candidate.id,
        action: "proactive_unanswered_nudge",
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
        text: "Bringing this back into view.",
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: "Bringing this back into view in case it still needs attention." },
      }]);
    } catch (error) {
      if (await markSlackInstallationReauthRequired({ ...params, error })) {
        return { skipped: true, reason: "slack_reauth_required" };
      }
      throw error;
    }

    await recordProactiveMarker({
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      messageId: candidate.id,
      externalUserId: candidate.externalUserId,
      entityType: "CommunicationMessage",
      entityId: candidate.id,
      action: "proactive_unanswered_nudge",
    });
    nudges += 1;
    if (nudges >= MAX_PROACTIVE_NUDGES) break;
  }

  const model = await getAgentModelOverride(params.workspaceId, "slack-agent")
    ?? resolveModel(AGENT_REGISTRY["slack-agent"].defaultModelTier);
  const agentActor: AppActor = { kind: "agent", authProvider: "bootstrap", label: "slack-agent" };
  let actions = 0;
  const actionCreationCutoff = new Date(now.getTime() - config.unansweredActionCreationDelayMinutes * 60 * 1000);
  const pendingNudges = await prisma.communicationEntityLink.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      action: "proactive_unanswered_nudge",
      messageId: { not: null },
      createdAt: { lte: actionCreationCutoff },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true,
      createdAt: true,
      externalUserId: true,
      messageId: true,
      message: {
        select: {
          id: true,
          externalChannelId: true,
          externalMessageId: true,
          externalUserId: true,
          threadExternalId: true,
          text: true,
          messageTs: true,
        },
      },
    },
  });

  for (const nudge of pendingNudges) {
    if (actions >= MAX_PROACTIVE_ACTIONS) break;
    const candidate = nudge.message as SlackCandidateMessage | null;
    if (!candidate || !candidate.text || !channelIds.includes(candidate.externalChannelId)) continue;
    const linkedAction = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        messageId: candidate.id,
        entityType: "Action",
        action: { in: ["proactive_unanswered_action_created", "create_action"] },
      },
      select: { id: true, entityId: true },
    });
    const terminalMarker = linkedAction ? null : await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        messageId: candidate.id,
        action: { in: ["proactive_unanswered_resolved", PROACTIVE_NON_ACTION] },
      },
      select: { id: true },
    });
    if (terminalMarker) continue;

    if (isAddressedToSlackBot(candidate.text, installation.botUserId)) {
      await recordProactiveMarker({
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: "CommunicationMessage",
        entityId: candidate.id,
        action: PROACTIVE_NON_ACTION,
        claimKey: `${PROACTIVE_NON_ACTION_CLAIM_PREFIX}:${params.installationId}:${candidate.id}`,
      });
      continue;
    }

    const threadMessages = await fetchHumanThreadMessages({
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      source: candidate,
    });
    const latestThreadMessage = threadMessages[threadMessages.length - 1] ?? candidate;
    if (linkedAction) {
      const existingUpdate = await prisma.communicationEntityLink.findFirst({
        where: {
          workspaceId: params.workspaceId,
          installationId: params.installationId,
          provider: "SLACK",
          messageId: latestThreadMessage.id,
          entityType: "Action",
          entityId: linkedAction.entityId,
          action: { in: [PROACTIVE_EXISTING_ACTION_UPDATE, PROACTIVE_ACTION_WAITING_UPDATE] },
        },
        select: { id: true },
      });
      if (existingUpdate) continue;
    }

    const parsed = await reviewThreadForAction({
      workspaceId: params.workspaceId,
      workflowJobId: params.workflowJobId,
      model,
      source: candidate,
      nudgeCreatedAt: nudge.createdAt,
      threadMessages,
      linkedActionId: linkedAction?.entityId ?? null,
    });

    if (linkedAction) {
      const updateMd = parsed.updateMd || parsed.bodyMd;
      const shouldPostUpdate = parsed.intent === "update_existing_action" || parsed.intent === "wait_existing_action";
      if (shouldPostUpdate && parsed.confidence >= config.proactiveConfidenceThreshold && updateMd) {
        await postDeliberationEntry(agentActor, {
          workspaceId: params.workspaceId,
          parentType: "ACTION",
          parentId: linkedAction.entityId,
          entryType: "REACTION",
          bodyMd: updateMd,
        });

        await recordProactiveMarker({
          installationId: params.installationId,
          workspaceId: params.workspaceId,
          messageId: latestThreadMessage.id,
          externalUserId: latestThreadMessage.externalUserId,
          entityType: "Action",
          entityId: linkedAction.entityId,
          action: parsed.intent === "wait_existing_action" || parsed.followupDelayMultiplier > 1
            ? PROACTIVE_ACTION_WAITING_UPDATE
            : PROACTIVE_EXISTING_ACTION_UPDATE,
        });
      }
      continue;
    }

    const shouldPublish = shouldPublishProactiveAction({
      parsed,
      sourceText: candidate.text,
      threadMessages,
      botUserId: installation.botUserId,
      confidenceThreshold: config.proactiveConfidenceThreshold,
      publicationEnabled: config.proactiveActionPublicationEnabled,
    });
    if (!shouldPublish) {
      await recordProactiveMarker({
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: "CommunicationMessage",
        entityId: candidate.id,
        action: PROACTIVE_NON_ACTION,
        claimKey: `${PROACTIVE_NON_ACTION_CLAIM_PREFIX}:${params.installationId}:${candidate.id}`,
      });
      continue;
    }

    const actionTitle = `${parsed.concreteNextStep.charAt(0).toUpperCase()}${parsed.concreteNextStep.slice(1, 120)}`;
    const item = await createWorkItemFromCommunicationSource(agentActor, {
      workspaceId: params.workspaceId,
      provider: "SLACK",
      installationId: params.installationId,
      kind: "ACTION",
      title: actionTitle,
      bodyMd: candidate.text,
      sourceMessageId: candidate.id,
      externalUserId: candidate.externalUserId,
      open: true,
      claimKey: `${PROACTIVE_ACTION_CLAIM_PREFIX}:${params.installationId}:${candidate.id}`,
    });

    try {
      await sendSlackMessage(params.installationId, {
        channel: candidate.externalChannelId,
        threadTs: threadTsForMessage(candidate),
        text: `Created Corgtex action: ${actionTitle}`,
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: `I created a Corgtex action for this concrete future deliverable: <${item.webUrl}|${actionTitle}>.` },
      }]);
    } catch (error) {
      if (await markSlackInstallationReauthRequired({ ...params, error })) {
        return { skipped: true, reason: "slack_reauth_required" };
      }
      throw error;
    }
    actions += 1;
  }

  let followups = 0;
  const actionFollowupCutoff = new Date(now.getTime() - config.staleActionFollowupDelayMinutes * 60 * 1000);
  const waitingUpdateCutoff = new Date(now.getTime() - config.staleActionFollowupDelayMinutes * 2 * 60 * 1000);
  const actionLinks = await prisma.communicationEntityLink.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      entityType: "Action",
      createdAt: { lte: actionFollowupCutoff },
      OR: [
        { action: "proactive_unanswered_action_created" },
        {
          action: "create_action",
          claimKey: { startsWith: `${PROACTIVE_ACTION_CLAIM_PREFIX}:${params.installationId}:` },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: {
      id: true,
      entityId: true,
      createdAt: true,
      messageId: true,
      externalUserId: true,
      message: {
        select: {
          id: true,
          externalChannelId: true,
          externalMessageId: true,
          externalUserId: true,
          threadExternalId: true,
          text: true,
          messageTs: true,
        },
      },
    },
  });
  const actionIds = [...new Set(actionLinks.map((link) => link.entityId).filter(Boolean))];
  const openActions = actionIds.length > 0
    ? await prisma.action.findMany({
        where: {
          workspaceId: params.workspaceId,
          id: { in: actionIds },
          archivedAt: null,
          status: { not: "COMPLETED" },
        },
        select: { id: true, title: true },
      })
    : [];
  const openActionById = new Map(openActions.map((action) => [action.id, action]));

  for (const link of actionLinks) {
    if (followups >= MAX_PROACTIVE_ACTION_FOLLOWUPS) break;
    const action = openActionById.get(link.entityId);
    const source = link.message as SlackCandidateMessage | null;
    if (!action || !source || !channelIds.includes(source.externalChannelId)) continue;

    const waitingUpdate = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        provider: "SLACK",
        entityType: "Action",
        entityId: action.id,
        action: PROACTIVE_ACTION_WAITING_UPDATE,
        createdAt: { gte: waitingUpdateCutoff },
      },
      select: { id: true },
    });
    if (waitingUpdate) continue;

    const recentFollowup = await prisma.communicationEntityLink.findFirst({
      where: {
        workspaceId: params.workspaceId,
        installationId: params.installationId,
        provider: "SLACK",
        entityType: "Action",
        entityId: action.id,
        action: "proactive_action_followup",
        createdAt: { gte: actionFollowupCutoff },
      },
      select: { id: true },
    });
    if (recentFollowup) continue;

    try {
      await sendSlackMessage(params.installationId, {
        channel: source.externalChannelId,
        threadTs: threadTsForMessage(source),
        text: `Corgtex action still not completed: ${action.title}`,
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: `This Corgtex action still is not completed after 72 hours: *${action.title}*.` },
      }]);
    } catch (error) {
      if (await markSlackInstallationReauthRequired({ ...params, error })) {
        return { skipped: true, reason: "slack_reauth_required" };
      }
      throw error;
    }

    await recordProactiveMarker({
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      messageId: source.id,
      externalUserId: source.externalUserId,
      entityType: "Action",
      entityId: action.id,
      action: "proactive_action_followup",
    });
    followups += 1;
  }

  return { agendaJobs, nudges, actions, followups, drafts: actions };
}
