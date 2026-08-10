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

function looksWorkLike(text: string) {
  return /\b(should|will|must|todo|to do|follow up|need to|needs to|please|can you|ask|owner|by tomorrow|proposal|tension|action item)\b/i.test(text);
}

function isBotMentioned(text: string, botUserId: string | null) {
  if (!botUserId) return false;
  const escapedId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<@${escapedId}(?:\\|[^>]+)?>`);
  return regex.test(text);
}

function isNegatedActionRequest(text: string, concreteNextStep = "", ownerEvidence = ""): boolean {
  if (/\b(do not|cannot|(?:don|doesn|didn|shouldn|couldn|can|won|wouldn|mustn|needn|isn|aren|wasn|weren|shan)['’]t|no|not|never)\b(?:[\s,;:()-]+[a-z]+){0,5}[\s,;:()-]+(create|add|make|assign|open|log|turn(?:\s+(?:this|that|it))?\s+into|convert(?:\s+(?:this|that|it))?\s+(?:to|into))\s+(?:(?:this|that|it)\s+(?:as\s+)?)?(?:(?:an?|the|new|another|corgtex)\s+)*(?:action(?:\s+item)?|task|work\s+item)\b/i.test(text)
    || /\b(?:(?:avoid(?:s|ed)?|skip(?:s|ped)?)\s+|refrain(?:s|ed)?\s+from\s+)(?:creating|adding|making|assigning|opening|logging|converting(?:\s+(?:this|that|it))?\s+(?:to|into))\s+(?:an?\s+)?(?:action(?:\s+item)?|task|work\s+item)\b/i.test(text)
    || /\b(?:not\s+an?|no)\s+(action|task|work item)\b/i.test(text)) return true;
  const owner = normalizeText(ownerEvidence), step = normalizeText(concreteNextStep);
  if (!owner || !step) return false;
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), escapedStep = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(/[;!?]+|\.(?=\s|$)/u).map(clause => normalizeText(clause.replace(/\b(should|must|can|could|would|need|do|does|did)n['’]t\b/gi, "$1 not").replace(/\bwon['’]t\b/gi, "will not"))).some(clause => new RegExp(`(?:^|\\s)${escapedOwner}\\s+(?:(?:should|must|will|can|could|would|need(?:s)?(?:\\s+to)?)\\s+not|(?:do|does|did)\\s+not\\s+need\\s+to)(?:\\s+[\\p{L}\\p{N}_-]+){0,5}\\s+${escapedStep}(?=\\s|$)`, "u").test(clause));
}

function isDeterministicNegativeCategory(text: string, concreteNextStep = "", includeCompletion = true): boolean {
  const [verb, ...object] = normalizeText(concreteNextStep).split(" ");
  const completedVerb = /^(?:sent|done|completed|fixed|resolved|upgraded|deployed|approved|investigated)$/.test(verb) ? verb : verb === "send" ? "sent" : verb === "do" ? "done" : verb ? `${verb}${verb.endsWith("e") ? "d" : "ed"}` : "";
  const historicalStep = `${completedVerb} ${object.join(" ")}`.trim();
  if (includeCompletion && /^(?:(?:ack|acknowledged|acknowledg(?:e)?ment|thanks|thank you)(?:\s*:|[.!]?\s*$)|(?!.*\bnot\b)(?!(?:(?:the\s+)?[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+){0,2}\s+)?(?:will|shall|should|would|could|may|might|must)\s+(?:be|have\s+been)\b)(?:(?:it['’]s|(?:the\s+)?[\p{L}\p{N}_-]+(?:\s+[\p{L}\p{N}_-]+){0,2})\s+)?(?:(?:is|was)\s+|(?:has|have)\s+been\s+)?(?:done|sent(?: it)?|completed|fixed|resolved|upgraded|deployed)(?:[.!]\s+.+)?[.!]?$)/iu.test(text.trim())) return true;
  return /(?<!\b(?:not|never|don['’]t)\s+(?:a\s+|an\s+)?)\b(routing\s*test|test\s*routing|fyi|for your information|got it|info\s*only|information\s*only|(?=[^?]*\?\s*$)(?:(?:needs?|wants?)\s+to\s+(?:know|understand|find\s+out)|(?:do|does)\s+(?:you|anyone|someone)\s+know)|just\s+sharing|just\s+an?\s+update|(?:this|it)\s+(?:is|was)\s+(?:(?:only|just)\s+)?a\s+test(?:\s+message)?|test\s*message)\b/i.test(text)
    || Boolean(includeCompletion && (/(?<!\b(?:not|never|don['’]t)\s)\balready\s+(?:done|sent|completed|fixed|resolved|upgraded|deployed)\b/i.test(text) || (historicalStep && new RegExp(`\\bshould have (?:been )?${historicalStep}\\b`, "u").test(normalizeText(text)) && (/\?/.test(text) || /\bconfirm\b/i.test(text)))))
    || /(?<!\b(?:not|never|don['’]t)\s+)^(?:test|testing)[\s/:-]/i.test(text.trim());
}

function isDeterministicExplicitActionRequest(text: string, concreteNextStep = ""): boolean {
  if (isNegatedActionRequest(text)) return false;
  if (isDeterministicNegativeCategory(text)) return false;
  const request = /\bcorgtex\b(?:[\s.,:;!]+(?:please|kindly|can you|could you|will you|would you|just)?)*\s*(create|add|make|assign|turn(?:\s+(?:this|that|it))?\s+into)\b(?:\s+[a-z]+){0,3}\s+(action(?: item)?|task|work item)\b/i.exec(text);
  if (!request || !concreteNextStep) return Boolean(request);
  const remainder = normalizeText(text.slice(request.index + request[0].length)).replace(/^(?:to|for)\s+/, "");
  return remainder === normalizeText(concreteNextStep) || remainder.startsWith(`${normalizeText(concreteNextStep)} `);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGroundedInCorpus(value: string, corpus: string): boolean {
  const normValue = normalizeText(value);
  if (!normValue || normValue === "unknown") return false;
  const paddedValue = ` ${normValue} `;
  const paddedCorpus = ` ${normalizeText(corpus)} `;
  return paddedCorpus.includes(paddedValue);
}
function splitAssignmentClauses(text: string) { return text.split(/[\n;!?]+|\.(?=\s|$)/u).map(normalizeText); }
function isOrganizationalRole(ownerEvidence: string) { return /^(?:legal|finance|operations|engineering|product|sales|support|security|(?:[\p{L}\p{N}_-]+\s+){0,2}(?:team|lead|manager|owner|counsel|department|group|committee|reviewer|approver))$/u.test(normalizeText(ownerEvidence)); }

function hasGroundedOwnerCue(ownerEvidence: string, concreteNextStep: string, threadTexts: string[], trustedUsers: Array<{ externalUserId: string; displayName: string | null }>): boolean {
  const owner = normalizeText(ownerEvidence), step = normalizeText(concreteNextStep);
  if (!owner || owner === "unknown" || !step) return false;
  const escapedOwner = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), escapedStep = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assigned = threadTexts.flatMap(splitAssignmentClauses).some(clause => new RegExp(`(?:^|\\s)${escapedOwner}\\s+(?:needs?\\s+to|should|must|will|please)\\s+${escapedStep}(?=\\s|$)`, "u").test(clause)
    || new RegExp(`(?:\\bhave\\s+${escapedOwner}\\s+(?:to\\s+)?${escapedStep}|^(?:please\\s+)?ask\\s+${escapedOwner}\\s+to\\s+${escapedStep})(?=\\s|$)`, "u").test(clause) || new RegExp(`\\b(?:assigned\\s+to|owner\\s+is)\\s+${escapedOwner}\\s+(?:(?:to|for)\\s+)?${escapedStep}(?=\\s|$)`, "u").test(clause));
  if (!assigned) return false;
  const identities = trustedUsers.map(user => ({ id: normalizeText(user.externalUserId), name: normalizeText(user.displayName || "") }));
  return isOrganizationalRole(owner) || identities.some(identity => identity.id === owner || (owner.includes(" ") && identity.name === owner)) || identities.filter(identity => identity.name.split(" ")[0] === owner).length === 1;
}

function normalizeProactiveExtraction(output: Record<string, unknown>) {
  const confidence = typeof output.confidence === "number" ? output.confidence : Number(output.confidence);
  const rawResolutionState = asString(output.resolutionState) || "unknown";
  const rawWorkDisposition = asString(output.workDisposition) || "unknown";

  const validResolutionStates = new Set(["answered", "open", "unknown"]);
  const validWorkDispositions = new Set(["action", "awareness", "information", "test", "ignore"]);

  return {
    resolutionState: validResolutionStates.has(rawResolutionState) ? rawResolutionState : "unknown",
    workDisposition: validWorkDispositions.has(rawWorkDisposition) ? rawWorkDisposition : "unknown",
    concreteNextStep: asString(output.concreteNextStep),
    ownerEvidence: asString(output.ownerEvidence),
    timingEvidence: asString(output.timingEvidence),
    explicitActionRequest: output.explicitActionRequest === true,
    hasExplicitNegativeCategoryFalse: output.negativeCategory === false,
    negativeCategory: output.negativeCategory === true,
    hasValidCouldNotArray: Array.isArray(output.couldNot) && output.couldNot.every(v => typeof v === "string" && v.trim().length > 0),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    title: asString(output.title),
    bodyMd: asString(output.bodyMd) || asString(output.body),
    updateMd: asString(output.updateMd),
    couldNot: Array.isArray(output.couldNot) ? output.couldNot.map((entry) => asString(entry)).filter(Boolean) : [],
    reason: asString(output.reason),
    followupDelayMultiplier: typeof output.followupDelayMultiplier === "number"
      ? Math.max(1, Math.min(4, Math.floor(output.followupDelayMultiplier)))
      : 1,
  };
}

function meetsActionPublicationPredicate(
  parsed: ReturnType<typeof normalizeProactiveExtraction>,
  botUserId: string | null,
  confidenceThreshold: number,
  sourceText: string,
  threadTexts: string[],
  trustedUsers: Array<{ externalUserId: string; displayName: string | null }>
): boolean {
  if (!botUserId) return false;
  if (parsed.resolutionState !== "open") return false;
  if (parsed.workDisposition !== "action") return false;
  const concreteStep = normalizeText(parsed.concreteNextStep);
  const threadCorpus = threadTexts.join("\n");
  if (!concreteStep || !isGroundedInCorpus(parsed.concreteNextStep, threadCorpus) || (!concreteStep.includes(" ") && !/^(?:deploy|approve|investigate)$/.test(concreteStep) && !/[^\x00-\x7F]/.test(parsed.concreteNextStep)) || /\b(something|anything|stuff|thing)\b/.test(concreteStep)) return false;
  if (!parsed.hasExplicitNegativeCategoryFalse) return false;
  if (parsed.negativeCategory) return false;
  if (!parsed.hasValidCouldNotArray) return false;
  if (parsed.couldNot.length > 0) return false;
  if (parsed.confidence < confidenceThreshold) return false;
  if (threadTexts.some(text => isNegatedActionRequest(text, parsed.concreteNextStep, parsed.ownerEvidence))) return false;
  if (threadTexts.some(text => isDeterministicNegativeCategory(text, parsed.concreteNextStep, false))) return false;

  const hasGroundedOwner = hasGroundedOwnerCue(parsed.ownerEvidence, parsed.concreteNextStep, threadTexts, trustedUsers);
  const isExplicitRequest = parsed.explicitActionRequest === true && (isDeterministicExplicitActionRequest(sourceText, parsed.concreteNextStep) || threadTexts.some(text => isDeterministicExplicitActionRequest(text, parsed.concreteNextStep)));
  if (!hasGroundedOwner && !isExplicitRequest) return false;
  const assignmentIndex = threadTexts.reduce((latest, text, index) => hasGroundedOwnerCue(parsed.ownerEvidence, parsed.concreteNextStep, [text], trustedUsers) || (parsed.explicitActionRequest && isDeterministicExplicitActionRequest(text, parsed.concreteNextStep)) ? index : latest, -1);
  if (threadTexts.slice(Math.max(0, assignmentIndex)).some(text => isDeterministicNegativeCategory(text, parsed.concreteNextStep))) return false;
  return true;
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
      "Extract normalized fields. resolutionState: answered | open | unknown. workDisposition: action | awareness | information | test | ignore.",
      "If there is no linked action, you may use workDisposition 'action' only if there is a concrete future deliverable and no negative category.",
      "If a linked action exists and a human reply gives a meaningful status, ownership, timing, or decision update, use workDisposition 'action' and provide updateMd grounded only in the thread.",
      "If they are waiting on another party or more time is needed, set followupDelayMultiplier to 2.",
      "Set explicitActionRequest to true if the text deterministically requests Corgtex to create/assign an action.",
      "Set negativeCategory to true for tests, FYIs, acknowledgements, information requests, already-completed tasks, or bot-directed messages.",
      "Populate concreteNextStep, ownerEvidence, and timingEvidence with grounded facts or leave empty.",
      "Use ignore when no Corgtex record update is useful, the request is unsafe, or the next step is unclear.",
    ].join(" "),
    schemaHint: "{ resolutionState: string, workDisposition: string, concreteNextStep: string, ownerEvidence: string, timingEvidence: string, explicitActionRequest: boolean, negativeCategory: boolean, confidence: number, reason: string, title: string, bodyMd: string, updateMd: string, followupDelayMultiplier: number, couldNot: string[] }",
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
}) {
  await prisma.communicationEntityLink.create({
    data: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: params.provider ?? "SLACK",
      messageId: params.messageId,
      externalUserId: params.externalUserId ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
    },
  });
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
  for (const candidate of candidates.filter((message) => looksUnanswered(message.text ?? "") && !isBotMentioned(message.text ?? "", installation.botUserId)).slice(0, 10)) {
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
        text: "This looks unanswered.",
      }, [{
        type: "section",
        text: { type: "mrkdwn", text: "This looks unanswered. I'm bringing it back into awareness." },
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
  let actions = 0, trustedUsers: Array<{ externalUserId: string; displayName: string | null }> | null = null;
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
        action: "proactive_unanswered_resolved",
      },
      select: { id: true },
    });
    if (terminalMarker) continue;

    const threadMessages = await fetchHumanThreadMessages({
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      source: candidate,
    });

    const latestThreadMessage = threadMessages[threadMessages.length - 1] ?? candidate;
    const shouldSkipReview = threadMessages.some(m => isBotMentioned(m.text || "", installation.botUserId)) || (!linkedAction && !threadMessages.some(m => looksWorkLike(m.text || "") || isDeterministicExplicitActionRequest(m.text || "")));
    if (shouldSkipReview) {
      if (!linkedAction) await recordProactiveMarker({
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: "CommunicationMessage",
        entityId: candidate.id,
        action: "proactive_unanswered_resolved",
      });
      continue;
    }
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
      const shouldPostUpdate = parsed.workDisposition === "action";
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
          action: parsed.followupDelayMultiplier > 1
            ? PROACTIVE_ACTION_WAITING_UPDATE
            : PROACTIVE_EXISTING_ACTION_UPDATE,
        });
      }
      continue;
    }

    const threadTexts = threadMessages.map(message => message.text || "");
    if (parsed.ownerEvidence && !isOrganizationalRole(parsed.ownerEvidence) && trustedUsers === null) trustedUsers = await prisma.communicationExternalUser.findMany({ where: { installationId: params.installationId, workspaceId: params.workspaceId, provider: "SLACK", isBot: false, isDeleted: false }, select: { externalUserId: true, displayName: true } });
    if (meetsActionPublicationPredicate(parsed, installation.botUserId, config.proactiveConfidenceThreshold, candidate.text, threadTexts, trustedUsers || [])) {
      const item = await createWorkItemFromCommunicationSource(agentActor, {
        workspaceId: params.workspaceId,
        provider: "SLACK",
        installationId: params.installationId,
        kind: "ACTION",
        title: parsed.concreteNextStep,
        bodyMd: threadMessages.map((message) => message.text).filter(Boolean).join("\n"),
        sourceMessageId: candidate.id,
        externalUserId: candidate.externalUserId,
        open: true,
      });

      await recordProactiveMarker({
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: item.entityType,
        entityId: item.entityId,
        action: "proactive_unanswered_action_created",
      });

      try {
        await sendSlackMessage(params.installationId, {
          channel: candidate.externalChannelId,
          threadTs: threadTsForMessage(candidate),
          text: `Created Corgtex action: ${parsed.concreteNextStep}`,
        }, [{
          type: "section",
          text: { type: "mrkdwn", text: `I created a Corgtex action because this still looked unresolved after 24 hours: <${item.webUrl}|${parsed.concreteNextStep}>.` },
        }]);
      } catch (error) {
        if (await markSlackInstallationReauthRequired({ ...params, error })) {
          return { skipped: true, reason: "slack_reauth_required" };
        }
        throw error;
      }
      actions += 1;
    } else {
      await recordProactiveMarker({
        installationId: params.installationId,
        workspaceId: params.workspaceId,
        messageId: candidate.id,
        externalUserId: candidate.externalUserId,
        entityType: "CommunicationMessage",
        entityId: candidate.id,
        action: "proactive_unanswered_resolved",
      });
    }
  }

  let followups = 0;
  const actionFollowupCutoff = new Date(now.getTime() - config.staleActionFollowupDelayMinutes * 60 * 1000);
  const waitingUpdateCutoff = new Date(now.getTime() - config.staleActionFollowupDelayMinutes * 2 * 60 * 1000);
  const actionLinks = await prisma.communicationEntityLink.findMany({
    where: {
      workspaceId: params.workspaceId,
      installationId: params.installationId,
      provider: "SLACK",
      action: "proactive_unanswered_action_created",
      entityType: "Action",
      createdAt: { lte: actionFollowupCutoff },
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
