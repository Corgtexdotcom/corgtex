import type { AgentTriggerType } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { answerKnowledgeQuestion, searchIndexedKnowledge } from "@corgtex/knowledge";
import {
  createWorkItemFromCommunicationSource,
  deleteAction,
  deleteProposal,
  deleteSource,
  deleteTension,
  deliverSlackAgentResponse,
  evaluateDelegatedActionPolicy,
  fetchSlackThreadMessages,
  listMembers,
  type SlackAgentDelivery,
  type SlackAgentJobPayload,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { HumanActor } from "@corgtex/shared";
import { executeAgentRun, asString } from "../runtime";

type SlackAgentIntent =
  | "brief"
  | "create_action"
  | "create_tension"
  | "create_proposal"
  | "capture_note"
  | "capabilities"
  | "answer_question"
  | "summarize_thread"
  | "undo_created_item"
  | "unsupported";

type SlackAgentExtraction = {
  intent: SlackAgentIntent;
  confidence: number;
  title: string;
  bodyMd: string;
  assigneeHint: string | null;
  dueDateISO: string | null;
  publish: boolean;
  answer: string | null;
  couldNot: string[];
  next: string | null;
};

const INTENTS = new Set<SlackAgentIntent>([
  "brief",
  "create_action",
  "create_tension",
  "create_proposal",
  "capture_note",
  "capabilities",
  "answer_question",
  "summarize_thread",
  "undo_created_item",
  "unsupported",
]);

const UNSUPPORTED_OPERATION_RE =
  /\b(delete|remove|archive|deactivate|invite|change role|grant|revoke|permission|submit spend|create spend|approve spend|pay|payment|reimburse|expense|notify everyone|broadcast|message everyone)\b/i;

const READ_ONLY_CONVERSATION_RE =
  /\b(who|what|where|when|why|how|how many|list|show|find|search|lookup|look up|account|member|members|user|users|email|role|roles|circle|circles|action|actions|tension|tensions|proposal|proposals|policy|policies|knowledge|brain|status|current|latest|summarize|summary)\b/i;

const MEMBER_LIST_RE = /\b(list|show|who|members?|users?|team|people)\b/i;
const ACCOUNT_LOOKUP_RE = /\b(my account|find my account|account now|who am i|me in corgtex|my corgtex)\b/i;
const MAX_SLACK_TEXT_LENGTH = 2900;
const SLACK_UNDO_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SLACK_UNDO_ENTITY_TYPES = ["Action", "Tension", "Proposal", "BrainSource"] as const;
const SLACK_UNDO_CREATE_ACTIONS = ["create_action", "create_tension", "create_proposal", "create_brain_note"];
type SlackUndoEntityType = typeof SLACK_UNDO_ENTITY_TYPES[number];

function clampConfidence(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeExtraction(output: Record<string, unknown>, fallbackPrompt: string): SlackAgentExtraction {
  const rawIntent = asString(output.intent) as SlackAgentIntent;
  const intent = INTENTS.has(rawIntent) ? rawIntent : "unsupported";
  const title = asString(output.title) || fallbackPrompt.slice(0, 120) || "Slack request";
  const bodyMd = asString(output.bodyMd) || asString(output.body) || fallbackPrompt;
  const couldNot = Array.isArray(output.couldNot)
    ? output.couldNot.map((entry) => asString(entry)).filter(Boolean)
    : [];

  return {
    intent,
    confidence: clampConfidence(output.confidence),
    title,
    bodyMd,
    assigneeHint: asString(output.assigneeHint) || null,
    dueDateISO: asString(output.dueDateISO) || null,
    publish: Boolean(output.publish ?? output.open),
    answer: asString(output.answer) || null,
    couldNot,
    next: asString(output.next) || null,
  };
}

function isUnsupportedOperation(prompt: string, extraction: SlackAgentExtraction) {
  if (UNSUPPORTED_OPERATION_RE.test(prompt)) return true;
  return extraction.intent === "unsupported" && !READ_ONLY_CONVERSATION_RE.test(prompt);
}

function shouldUseConversationMode(prompt: string, extraction: SlackAgentExtraction) {
  if (UNSUPPORTED_OPERATION_RE.test(prompt)) return false;
  if (extraction.intent === "answer_question") return true;
  if (extraction.intent !== "unsupported" && extraction.confidence >= 0.55) return false;
  return READ_ONLY_CONVERSATION_RE.test(prompt);
}

function undoEntityHint(prompt: string): SlackUndoEntityType | null {
  if (/\b(actions?|task|tasks|todo|todos)\b/i.test(prompt)) return "Action";
  if (/\b(tensions?|issue|issues|problem|problems)\b/i.test(prompt)) return "Tension";
  if (/\b(proposals?|proposal)\b/i.test(prompt)) return "Proposal";
  if (/\b(notes?|brain|source|sources)\b/i.test(prompt)) return "BrainSource";
  return null;
}

function isSlackUndoRequest(prompt: string) {
  const normalized = normalizeCapabilitiesPrompt(prompt);
  if (/\b(undo|revert)\b/.test(normalized)) return true;
  return /\b(delete|remove|archive|cancel)\b/.test(normalized)
    && /\b(that|last|latest|previous|recent|just|created)\b/.test(normalized);
}

function undoEntityLabel(entityType: SlackUndoEntityType) {
  if (entityType === "BrainSource") return "Brain note";
  return entityType;
}

function undoEntityUrl(workspaceId: string, entityType: SlackUndoEntityType, entityId: string) {
  const base = `/workspaces/${workspaceId}`;
  if (entityType === "Action") return `${base}/actions/${entityId}`;
  if (entityType === "Tension") return `${base}/tensions/${entityId}`;
  if (entityType === "Proposal") return `${base}/proposals/${entityId}`;
  return `${base}/brain`;
}

function normalizeCapabilitiesPrompt(prompt: string) {
  return prompt
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " ")
    .replace(/[?.!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isCapabilitiesPrompt(prompt: string) {
  const normalized = normalizeCapabilitiesPrompt(prompt);
  if (/^(help|commands?|capabilities|examples?)$/.test(normalized)) return true;
  if (/^(show|give|list|tell me|what are) (me )?(the )?(commands?|capabilities|examples?)( for (slack|corgtex|you))?$/.test(normalized)) {
    return true;
  }
  if (/^what can (you|corgtex) do( (from|in|on) slack)?( now| here)?$/.test(normalized)) return true;
  if (/^how (can|do) i use (you|corgtex)( (from|in|on) slack)?$/.test(normalized)) return true;
  return /^what does (this|the) slack integration do$/.test(normalized);
}

function renderCapabilitiesResponse() {
  return {
    done: [
      "I can turn plain Slack text into Corgtex work: actions, tensions, proposals, notes, briefs, questions, and thread summaries.",
      "Use `/corgtex ...`, mention `@Corgtex ...`, or use the message shortcut on a Slack message or thread.",
      "When confidence is high, I can create and open/publish supported Corgtex items; when it is lower, I create drafts or ask a clarifying question.",
    ],
    couldNot: [
      "I only undo items I just created from Slack. I do not run broad deletes, role changes, invites, permission changes, spend/payment actions, or broad notifications from Slack.",
    ],
    next: "Try `/corgtex Jan should follow up with Milan tomorrow`, `@Corgtex turn this thread into a proposal`, or `@Corgtex undo that proposal`.",
  };
}

function parseDueDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function rawProfileTimezone(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "UTC";
  const raw = value as Record<string, unknown>;
  return asString(raw.tz) || asString(raw.timezone) || "UTC";
}

function renderSlackResponse(params: {
  done: string[];
  couldNot: string[];
  next?: string | null;
}): SlackAgentDelivery {
  const done = params.done.length > 0 ? params.done : ["No changes made."];
  const couldNot = params.couldNot.length > 0 ? params.couldNot : ["Nothing."];
  const next = params.next?.trim() || "No follow-up needed.";
  const text = `Done:\n${done.map((item) => `- ${item}`).join("\n")}\n\nCould not:\n${couldNot.map((item) => `- ${item}`).join("\n")}\n\nNext:\n- ${next}`;

  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Done:*\n${done.map((item) => `- ${item}`).join("\n")}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Could not:*\n${couldNot.map((item) => `- ${item}`).join("\n")}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Next:*\n- ${next}` } },
    ],
  };
}

function truncateSlackText(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SLACK_TEXT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_SLACK_TEXT_LENGTH - 20).trimEnd()}\n\n...`;
}

function renderConversationResponse(text: string): SlackAgentDelivery {
  const safeText = truncateSlackText(text || "I do not have enough information to answer that yet.");
  return {
    text: safeText,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: safeText } },
    ],
  };
}

function renderUnsupportedResponse(): SlackAgentDelivery {
  return renderConversationResponse(
    "I cannot do that from Slack. I can answer workspace questions, summarize context, create bounded Corgtex actions, tensions, proposals, notes, and briefs, and undo items I just created from Slack. I do not run broad deletes, role or permission changes, invites, payments, or broad notifications from Slack.",
  );
}

function slackLink(url: string, label: string) {
  return `<${url}|${label.replace(/[<>|]/g, "")}>`;
}

async function loadUndoEntitySummary(workspaceId: string, entityType: SlackUndoEntityType, entityId: string) {
  const select = { id: true, title: true, archivedAt: true };
  if (entityType === "Action") {
    const record = await prisma.action.findFirst({ where: { id: entityId, workspaceId }, select });
    return record ? { title: record.title, archivedAt: record.archivedAt } : null;
  }
  if (entityType === "Tension") {
    const record = await prisma.tension.findFirst({ where: { id: entityId, workspaceId }, select });
    return record ? { title: record.title, archivedAt: record.archivedAt } : null;
  }
  if (entityType === "Proposal") {
    const record = await prisma.proposal.findFirst({ where: { id: entityId, workspaceId }, select });
    return record ? { title: record.title, archivedAt: record.archivedAt } : null;
  }
  const source = await prisma.brainSource.findFirst({
    where: { id: entityId, workspaceId },
    select: { id: true, title: true, archivedAt: true },
  });
  return source ? { title: source.title, archivedAt: source.archivedAt } : null;
}

async function findSlackUndoCandidate(params: SlackAgentJobPayload) {
  const hint = undoEntityHint(params.prompt);
  const entityTypes = hint ? [hint] : [...SLACK_UNDO_ENTITY_TYPES];
  const createdAfter = new Date(Date.now() - SLACK_UNDO_LOOKBACK_MS);
  const baseWhere = {
    installationId: params.installationId,
    workspaceId: params.workspaceId,
    provider: "SLACK" as const,
    externalUserId: params.externalUserId,
    action: { in: SLACK_UNDO_CREATE_ACTIONS },
    entityType: { in: entityTypes },
    createdAt: { gte: createdAfter },
  };

  const scopedQueries = [
    params.channelId && params.threadTs
      ? {
        ...baseWhere,
        message: {
          externalChannelId: params.channelId,
          OR: [
            { externalMessageId: params.threadTs },
            { threadExternalId: params.threadTs },
          ],
        },
      }
      : null,
    params.channelId
      ? {
        ...baseWhere,
        message: { externalChannelId: params.channelId },
      }
      : null,
    baseWhere,
  ].filter((query): query is typeof baseWhere => Boolean(query));

  for (const where of scopedQueries) {
    const links = await prisma.communicationEntityLink.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    });

    for (const link of links) {
      if (!SLACK_UNDO_ENTITY_TYPES.includes(link.entityType as SlackUndoEntityType)) continue;
      const entityType = link.entityType as SlackUndoEntityType;
      const entity = await loadUndoEntitySummary(params.workspaceId, entityType, link.entityId);
      if (entity && !entity.archivedAt) return { ...link, entityType, title: entity.title };
    }
  }

  return null;
}

async function archiveSlackUndoCandidate(actor: HumanActor, params: SlackAgentJobPayload, candidate: {
  action: string;
  entityType: SlackUndoEntityType;
  entityId: string;
  title: string | null;
}) {
  if (candidate.entityType === "Action") {
    await deleteAction(actor, { workspaceId: params.workspaceId, actionId: candidate.entityId });
  } else if (candidate.entityType === "Tension") {
    await deleteTension(actor, { workspaceId: params.workspaceId, tensionId: candidate.entityId });
  } else if (candidate.entityType === "Proposal") {
    await deleteProposal(actor, { workspaceId: params.workspaceId, proposalId: candidate.entityId });
  } else {
    await deleteSource(actor, { workspaceId: params.workspaceId, sourceId: candidate.entityId });
  }

  await prisma.communicationEntityLink.create({
    data: {
      installationId: params.installationId,
      workspaceId: params.workspaceId,
      provider: "SLACK",
      messageId: params.sourceMessageId ?? null,
      externalUserId: params.externalUserId,
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      action: `undo_${candidate.action}`,
    },
  });
}

async function undoLastSlackCreatedItem(actor: HumanActor, params: SlackAgentJobPayload) {
  const candidate = await findSlackUndoCandidate(params);
  if (!candidate) {
    return {
      done: [],
      couldNot: ["I could not find an active Slack-created item from you in the last 24 hours to undo."],
      next: "Reply with the item link or create a fresh correction request.",
      target: null,
    };
  }

  const label = undoEntityLabel(candidate.entityType);
  const title = candidate.title || candidate.entityId;
  try {
    await archiveSlackUndoCandidate(actor, params, candidate);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The archive request failed.";
    return {
      done: [],
      couldNot: [`I found ${label} ${title}, but could not archive it from Slack: ${reason}`],
      next: "Open the item in Corgtex to review permissions or archive it manually.",
      target: {
        entityType: candidate.entityType,
        entityId: candidate.entityId,
        title: candidate.title,
      },
    };
  }

  return {
    done: [`Archived ${label} ${slackLink(undoEntityUrl(params.workspaceId, candidate.entityType, candidate.entityId), title)}.`],
    couldNot: [],
    next: "No follow-up needed.",
    target: {
      entityType: candidate.entityType,
      entityId: candidate.entityId,
      title: candidate.title,
    },
  };
}

async function loadActor(workspaceId: string, userId: string): Promise<HumanActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, globalRole: true },
  });
  if (!user) return null;

  const member = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { id: true, isActive: true },
  });
  return member?.isActive ? { kind: "user", user } : null;
}

function matchMemberId(params: {
  assigneeHint: string | null;
  members: Awaited<ReturnType<typeof listMembers>>;
  externalUsers: Array<{
    externalUserId: string;
    userId: string | null;
    memberId: string | null;
    email: string | null;
    displayName: string | null;
  }>;
}) {
  const hint = params.assigneeHint?.trim();
  if (!hint) return { memberId: null, error: null };

  const slackMention = hint.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
  if (slackMention) {
    const external = params.externalUsers.find((user) => user.externalUserId === slackMention[1]);
    if (external?.memberId) return { memberId: external.memberId, error: null };
    if (external?.userId) {
      const member = params.members.find((entry) => entry.userId === external.userId);
      if (member) return { memberId: member.id, error: null };
    }
  }

  const normalized = hint.toLowerCase();
  const matches = params.members.filter((member) => {
    const displayName = member.user.displayName?.toLowerCase() ?? "";
    const email = member.user.email.toLowerCase();
    return member.id === hint || member.userId === hint || displayName === normalized || email === normalized;
  });

  if (matches.length === 1) return { memberId: matches[0].id, error: null };
  if (matches.length > 1) return { memberId: null, error: `Assignee "${hint}" matched more than one Corgtex member.` };
  return { memberId: null, error: `Assignee "${hint}" did not match a Corgtex member.` };
}

function formatMemberName(member: Awaited<ReturnType<typeof listMembers>>[number], opts?: { includeEmail?: boolean }) {
  const displayName = member.user.displayName || member.user.email;
  const role = "role" in member && typeof member.role === "string" ? member.role.toLowerCase().replace(/_/g, " ") : null;
  const email = opts?.includeEmail ? `, ${member.user.email}` : "";
  return role ? `${displayName}${email} (${role})` : `${displayName}${email}`;
}

function answerAccountLookup(params: {
  actor: HumanActor;
  members: Awaited<ReturnType<typeof listMembers>>;
  externalUsers: Array<{
    externalUserId: string;
    userId: string | null;
    memberId: string | null;
    email: string | null;
    displayName: string | null;
  }>;
  externalUserId: string;
}) {
  const member = params.members.find((entry) => entry.userId === params.actor.user.id);
  const slackUser = params.externalUsers.find((entry) => entry.externalUserId === params.externalUserId);
  const name = params.actor.user.displayName || slackUser?.displayName || params.actor.user.email;
  const role = member && "role" in member && typeof member.role === "string"
    ? member.role.toLowerCase().replace(/_/g, " ")
    : "member";
  const linkedBy = slackUser?.email ? ` Slack is linked to ${slackUser.email}.` : "";
  return `I found your Corgtex account: ${name} (${params.actor.user.email}). You are an active ${role} in this workspace.${linkedBy}`;
}

function answerMemberList(members: Awaited<ReturnType<typeof listMembers>>, prompt: string) {
  if (members.length === 0) return "I do not see any active members in this workspace.";
  const includeEmail = /\b(email|emails|address|account)\b/i.test(prompt);
  const lines = members
    .slice(0, 40)
    .map((member) => `- ${formatMemberName(member, { includeEmail })}`);
  const suffix = members.length > 40 ? `\n- ...and ${members.length - 40} more.` : "";
  return `I found ${members.length} active member${members.length === 1 ? "" : "s"} in this workspace:\n${lines.join("\n")}${suffix}`;
}

async function answerSlackConversation(params: {
  actor: HumanActor;
  prompt: string;
  workspaceId: string;
  workflowJobId?: string;
  agentRunId: string;
  model: string;
  members: Awaited<ReturnType<typeof listMembers>>;
  externalUsers: Array<{
    externalUserId: string;
    userId: string | null;
    memberId: string | null;
    email: string | null;
    displayName: string | null;
  }>;
  externalUserId: string;
  openActions: unknown;
  openTensions: unknown;
  openProposals: unknown;
  sourceMessage: unknown;
  threadMessages: unknown;
  channelMessages: unknown;
  contextSummaries: unknown;
}) {
  if (ACCOUNT_LOOKUP_RE.test(params.prompt)) {
    return answerAccountLookup({
      actor: params.actor,
      members: params.members,
      externalUsers: params.externalUsers,
      externalUserId: params.externalUserId,
    });
  }

  if (MEMBER_LIST_RE.test(params.prompt) && /\b(member|members|user|users|team|people)\b/i.test(params.prompt)) {
    return answerMemberList(params.members, params.prompt);
  }

  const knowledge = await answerKnowledgeQuestion({
    workspaceId: params.workspaceId,
    question: params.prompt,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
  }).catch(() => null);
  const slackKnowledge = await searchIndexedKnowledge({
    workspaceId: params.workspaceId,
    query: params.prompt,
    sourceTypes: ["SLACK"],
    limit: 5,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
  }).catch(() => []);

  const chat = await defaultModelGateway.chat({
    model: params.model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    taskType: "AGENT",
    messages: [
      {
        role: "system",
        content: [
          "You are Corgtex in Slack. Answer as a helpful conversation agent for the authenticated workspace member.",
          "Use only the supplied workspace context, Slack context, and knowledge answer. Do not invent private facts.",
          "Do not reveal secrets, tokens, raw credentials, bootstrap bundle content, private ops notes, or unrelated client data.",
          "Do not modify Corgtex data in this conversational answer path. If the user asks for a write, tell them what bounded Slack actions are supported.",
          "Be concise, direct, and natural. Do not use a Done/Could not/Next status template.",
        ].join(" "),
      },
      {
        role: "user",
        content: JSON.stringify({
          prompt: params.prompt,
          requester: {
            id: params.actor.user.id,
            displayName: params.actor.user.displayName,
            email: params.actor.user.email,
          },
          members: params.members.slice(0, 50).map((member) => ({
            memberId: member.id,
            userId: member.userId,
            displayName: member.user.displayName,
            role: "role" in member ? member.role : undefined,
          })),
          openActions: params.openActions,
          openTensions: params.openTensions,
          openProposals: params.openProposals,
          selectedMessage: params.sourceMessage,
          threadMessages: params.threadMessages,
          channelMessages: params.channelMessages,
          slackContextSummaries: params.contextSummaries,
          slackKnowledge,
          knowledgeAnswer: knowledge?.answer ?? null,
        }),
      },
    ],
  });

  return chat.content.trim() || knowledge?.answer || "I do not have enough information to answer that yet.";
}

async function deliverSafely(payload: SlackAgentJobPayload, response: SlackAgentDelivery) {
  try {
    await deliverSlackAgentResponse(payload, response);
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      error: error instanceof Error ? error.message : "Unknown Slack delivery error.",
    };
  }
}

export async function runSlackAgent(params: SlackAgentJobPayload & {
  workflowJobId?: string;
  triggerType?: AgentTriggerType;
}) {
  const triggerRef = params.inboundEventId ?? params.sourceMessageId ?? params.workflowJobId ?? `${params.source}:${params.messageTs ?? params.prompt}`;

  return executeAgentRun({
    agentKey: "slack-agent",
    workspaceId: params.workspaceId,
    triggerType: params.triggerType ?? "EVENT",
    triggerRef,
    goal: "Interpret a plain Slack request, execute bounded Corgtex work when confident, and reply with what changed.",
    payload: {
      source: params.source,
      prompt: params.prompt,
      channelId: params.channelId ?? null,
      threadTs: params.threadTs ?? null,
      messageTs: params.messageTs ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
    },
    plan: ["load-slack-context", "extract-intent", "execute-safe-work", "reply-in-slack"],
    buildContext: async (helpers) => helpers.tool("slack-context.load", {
      source: params.source,
      sourceMessageId: params.sourceMessageId ?? null,
    }, async () => {
      const actor = await loadActor(params.workspaceId, params.actorUserId);
      if (!actor) {
        return {
          actor: null,
          members: [],
          externalUsers: [],
          userTimezone: "UTC",
          openActions: [],
          openTensions: [],
          openProposals: [],
          sourceMessage: null,
          threadMessages: [],
          channelMessages: [],
          contextSummaries: [],
        };
      }

      const currentMessageDateRaw = params.messageTs ? new Date(Number(params.messageTs.split(".")[0]) * 1000) : null;
      const currentMessageDate = currentMessageDateRaw && Number.isFinite(currentMessageDateRaw.getTime())
        ? currentMessageDateRaw
        : null;

      const [
        members,
        externalUser,
        externalUsers,
        openActions,
        openTensions,
        openProposals,
        sourceMessage,
        fetchedThreadMessages,
        storedThreadMessages,
        channelMessagesDesc,
        contextSummaries,
      ] = await Promise.all([
        listMembers(params.workspaceId),
        prisma.communicationExternalUser.findUnique({
          where: { installationId_externalUserId: { installationId: params.installationId, externalUserId: params.externalUserId } },
          select: { rawProfile: true },
        }),
        prisma.communicationExternalUser.findMany({
          where: { installationId: params.installationId, workspaceId: params.workspaceId },
          select: { externalUserId: true, userId: true, memberId: true, email: true, displayName: true },
        }),
        prisma.action.findMany({
          where: { workspaceId: params.workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        prisma.tension.findMany({
          where: { workspaceId: params.workspaceId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        prisma.proposal.findMany({
          where: { workspaceId: params.workspaceId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: { id: true, title: true, status: true },
        }),
        params.sourceMessageId
          ? prisma.communicationMessage.findUnique({
            where: { id: params.sourceMessageId },
            select: { id: true, text: true, externalUserId: true, externalChannelId: true, externalMessageId: true, threadExternalId: true },
          })
          : Promise.resolve(null),
        params.channelId && params.threadTs
          ? fetchSlackThreadMessages(params.installationId, { channelId: params.channelId, threadTs: params.threadTs })
          : Promise.resolve([]),
        params.channelId && params.threadTs
          ? prisma.communicationMessage.findMany({
            where: {
              installationId: params.installationId,
              workspaceId: params.workspaceId,
              provider: "SLACK",
              externalChannelId: params.channelId,
              text: { not: null },
              textRedactedAt: null,
              isBot: false,
              isHidden: false,
              isDeleted: false,
              OR: [{ externalMessageId: params.threadTs }, { threadExternalId: params.threadTs }],
            },
            orderBy: { messageTs: "asc" },
            take: 80,
            select: { id: true, text: true, externalUserId: true, externalMessageId: true, threadExternalId: true, messageTs: true },
          })
          : Promise.resolve([]),
        params.channelId
          ? prisma.communicationMessage.findMany({
            where: {
              installationId: params.installationId,
              workspaceId: params.workspaceId,
              provider: "SLACK",
              externalChannelId: params.channelId,
              text: { not: null },
              textRedactedAt: null,
              isBot: false,
              isHidden: false,
              isDeleted: false,
              ...(currentMessageDate ? { messageTs: { lte: currentMessageDate } } : {}),
            },
            orderBy: { messageTs: "desc" },
            take: 40,
            select: { id: true, text: true, externalUserId: true, externalMessageId: true, threadExternalId: true, messageTs: true },
          })
          : Promise.resolve([]),
        params.channelId
          ? prisma.communicationContextSummary.findMany({
            where: {
              installationId: params.installationId,
              workspaceId: params.workspaceId,
              provider: "SLACK",
              externalChannelId: params.channelId,
              ...(params.threadTs ? { OR: [{ threadExternalId: params.threadTs }, { threadExternalId: null }] } : {}),
            },
            orderBy: { summaryDate: "desc" },
            take: 6,
            select: { title: true, summaryMd: true, threadExternalId: true, summaryDate: true, messageCount: true },
          })
          : Promise.resolve([]),
      ]);
      const threadMessages = storedThreadMessages.length > 0
        ? storedThreadMessages.map((message) => ({
          user: message.externalUserId,
          text: message.text,
          ts: message.externalMessageId,
          threadTs: message.threadExternalId,
        }))
        : fetchedThreadMessages;
      const channelMessages = channelMessagesDesc.reverse().map((message) => ({
        user: message.externalUserId,
        text: message.text,
        ts: message.externalMessageId,
        threadTs: message.threadExternalId,
      }));

      return {
        actor,
        members,
        externalUsers,
        userTimezone: rawProfileTimezone(externalUser?.rawProfile),
        openActions,
        openTensions,
        openProposals,
        sourceMessage,
        threadMessages,
        channelMessages,
        contextSummaries,
      };
    }),
    execute: async (context, helpers, runId, model) => {
      const actor = context.actor as HumanActor | null;
      if (!actor) {
        const response = renderConversationResponse(
          "I could not match your Slack user to an active Corgtex account in this workspace. Open Corgtex settings and confirm your Slack email matches your Corgtex account.",
        );
        const delivery = await helpers.tool("slack.reply", { reason: "missing_actor" }, () => deliverSafely(params, response));
        return { resultJson: { status: "NO_ACTOR", delivery } };
      }

      if (isCapabilitiesPrompt(params.prompt)) {
        const parts = renderCapabilitiesResponse();
        const response = renderSlackResponse(parts);
        const delivery = await helpers.tool("slack.reply", {
          reason: "capabilities",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response));

        return {
          resultJson: {
            intent: "capabilities",
            confidence: 1,
            created: [],
            ...parts,
            delivery,
          },
        };
      }

      if (isSlackUndoRequest(params.prompt)) {
        const undo = await helpers.tool("corgtex.undo", {
          source: params.source,
          channelId: params.channelId ?? null,
          threadTs: params.threadTs ?? null,
        }, () => undoLastSlackCreatedItem(actor, params));
        const response = renderSlackResponse(undo);
        const delivery = await helpers.tool("slack.reply", {
          reason: "undo_created_item",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response));

        return {
          resultJson: {
            intent: "undo_created_item",
            confidence: undo.target ? 1 : 0,
            created: [],
            done: undo.done,
            couldNot: undo.couldNot,
            next: undo.next,
            target: undo.target,
            delivery,
          },
        };
      }

      const extraction = await helpers.tool("model.extract", { prompt: params.prompt }, async () => defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId,
        agentRunId: runId,
        instruction: [
          "Classify a plain Slack request for Corgtex.",
          "Return JSON only with intent, confidence, title, bodyMd, assigneeHint, dueDateISO, publish, answer, couldNot, and next.",
          "Allowed intents: brief, create_action, create_tension, create_proposal, capture_note, capabilities, answer_question, summarize_thread, unsupported.",
          "Use unsupported for destructive, admin, financial, permission, invite, role, delete, archive, payment, or broad-notification requests.",
          "Use answer_question for read-only requests to list, find, search, or explain workspace members, accounts, roles, actions, proposals, tensions, current state, or workspace knowledge.",
          "Do not treat read-only member/account lookup as unsupported.",
          "For action due dates, resolve relative dates using the provided userTimezone and current time; otherwise use UTC.",
        ].join(" "),
        schemaHint: "{ intent: string, confidence: number, title: string, bodyMd: string, assigneeHint: string|null, dueDateISO: string|null, publish: boolean, answer: string|null, couldNot: string[], next: string|null }",
        input: JSON.stringify({
          now: new Date().toISOString(),
          userTimezone: context.userTimezone ?? "UTC",
          source: params.source,
          prompt: params.prompt,
          selectedMessage: context.sourceMessage ?? null,
          threadMessages: context.threadMessages ?? [],
          channelMessages: context.channelMessages ?? [],
          slackContextSummaries: context.contextSummaries ?? [],
          members: (context.members as Awaited<ReturnType<typeof listMembers>>).map((member) => ({
            memberId: member.id,
            userId: member.userId,
            displayName: member.user.displayName,
            email: member.user.email,
          })),
          openActions: context.openActions,
          openTensions: context.openTensions,
          openProposals: context.openProposals,
        }),
      }));

      const parsed = normalizeExtraction(extraction.output, params.prompt);
      const done: string[] = [];
      const couldNot = [...parsed.couldNot];
      let next = parsed.next;
      const created: Array<{ entityType: string; entityId: string; webUrl: string; opened: boolean }> = [];

      if (isUnsupportedOperation(params.prompt, parsed)) {
        const response = renderUnsupportedResponse();
        const delivery = await helpers.tool("slack.reply", {
          reason: "unsupported",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response));

        return {
          resultJson: {
            intent: parsed.intent,
            confidence: parsed.confidence,
            created,
            done,
            couldNot: ["Unsupported Slack operation."],
            next,
            delivery,
          },
        };
      } else if (shouldUseConversationMode(params.prompt, parsed)) {
        const answer = await helpers.tool("slack.conversation.answer", { prompt: params.prompt }, () => answerSlackConversation({
          actor,
          prompt: params.prompt,
          workspaceId: params.workspaceId,
          workflowJobId: params.workflowJobId,
          agentRunId: runId,
          model,
          members: context.members as Awaited<ReturnType<typeof listMembers>>,
          externalUsers: context.externalUsers as Array<{
            externalUserId: string;
            userId: string | null;
            memberId: string | null;
            email: string | null;
            displayName: string | null;
          }>,
          externalUserId: params.externalUserId,
          openActions: context.openActions,
          openTensions: context.openTensions,
          openProposals: context.openProposals,
          sourceMessage: context.sourceMessage,
          threadMessages: context.threadMessages,
          channelMessages: context.channelMessages,
          contextSummaries: context.contextSummaries,
        }));
        const response = renderConversationResponse(answer);
        const delivery = await helpers.tool("slack.reply", {
          reason: "conversation_answer",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response));

        return {
          resultJson: {
            intent: "answer_question",
            confidence: Math.max(parsed.confidence, 0.8),
            created,
            done: [answer],
            couldNot,
            next,
            delivery,
          },
        };
      } else if (parsed.confidence < 0.55) {
        couldNot.push("I was not confident enough to change Corgtex from that Slack message.");
        next = next ?? "Reply with the item type, owner, and expected outcome.";
      } else if (parsed.intent === "brief") {
        const actions = Array.isArray(context.openActions) ? context.openActions.length : 0;
        const tensions = Array.isArray(context.openTensions) ? context.openTensions.length : 0;
        const proposals = Array.isArray(context.openProposals) ? context.openProposals.length : 0;
        done.push(`Prepared a brief: ${actions} open actions, ${tensions} open tensions, and ${proposals} open proposals.`);
      } else if (parsed.intent === "answer_question") {
        const answer = await helpers.tool("knowledge.answer", { prompt: params.prompt }, () => answerKnowledgeQuestion({
          workspaceId: params.workspaceId,
          question: params.prompt,
          workflowJobId: params.workflowJobId,
          agentRunId: runId,
        }));
        done.push(answer.answer);
      } else if (parsed.intent === "capabilities") {
        const parts = renderCapabilitiesResponse();
        done.push(...parts.done);
        couldNot.push(...parts.couldNot);
        next = next ?? parts.next;
      } else if (parsed.intent === "summarize_thread") {
        const threadMessages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
        if (threadMessages.length === 0) {
          couldNot.push("I could not load thread context to summarize.");
        } else {
          const summary = await helpers.tool("model.chat", { purpose: "summarize_slack_thread" }, () => defaultModelGateway.chat({
            model,
            workspaceId: params.workspaceId,
            workflowJobId: params.workflowJobId,
            agentRunId: runId,
            taskType: "AGENT",
            messages: [
              { role: "system", content: "Summarize this Slack thread concisely for a Corgtex workspace operator. Include decisions, open questions, and action candidates when present." },
              { role: "user", content: JSON.stringify(threadMessages) },
            ],
          }));
          done.push(summary.content);
        }
      } else {
        const members = context.members as Awaited<ReturnType<typeof listMembers>>;
        const assignee = matchMemberId({
          assigneeHint: parsed.assigneeHint,
          members,
          externalUsers: context.externalUsers as Array<{
            externalUserId: string;
            userId: string | null;
            memberId: string | null;
            email: string | null;
            displayName: string | null;
          }>,
        });
        if (assignee.error) couldNot.push(assignee.error);

        const actionPolicy = evaluateDelegatedActionPolicy({
          toolName: parsed.intent,
          operation: "write",
          confidence: parsed.confidence,
          explicitUserIntent: false,
        });
        const open = actionPolicy.policyClass === "normal_write";
        const dueAt = parseDueDate(parsed.dueDateISO);
        const kind = parsed.intent === "create_action"
          ? "ACTION"
          : parsed.intent === "create_tension"
            ? "TENSION"
            : parsed.intent === "create_proposal"
              ? "PROPOSAL"
              : parsed.intent === "capture_note"
                ? "BRAIN_NOTE"
                : null;

        if (!kind) {
          couldNot.push("I could not map that request to a supported Slack-agent v1 action.");
        } else {
          const item = await helpers.tool("corgtex.create", {
            kind,
            title: parsed.title,
            open,
            assigneeMemberId: kind === "ACTION" ? assignee.memberId : null,
            raisedByMemberId: kind === "TENSION" ? assignee.memberId : null,
            dueDateISO: parsed.dueDateISO,
          }, () => createWorkItemFromCommunicationSource(actor, {
            workspaceId: params.workspaceId,
            provider: "SLACK",
            installationId: params.installationId,
            kind,
            title: parsed.title,
            bodyMd: parsed.bodyMd,
            sourceMessageId: params.sourceMessageId ?? null,
            externalUserId: params.externalUserId,
            assigneeMemberId: kind === "ACTION" ? assignee.memberId : null,
            raisedByMemberId: kind === "TENSION" ? assignee.memberId : null,
            dueAt,
            open,
          }));

          created.push(item);
          const state = kind === "BRAIN_NOTE"
            ? "captured"
            : item.opened
              ? "created and opened"
              : "created a private draft";
          done.push(`${state} ${item.entityType} ${slackLink(item.webUrl, parsed.title)}.`);
        }
      }

      const response = renderSlackResponse({ done, couldNot, next });
      const delivery = await helpers.tool("slack.reply", {
        source: params.source,
        channelId: params.channelId ?? null,
        responseUrl: Boolean(params.responseUrlEnc),
      }, () => deliverSafely(params, response));

      return {
        resultJson: {
          intent: parsed.intent,
          confidence: parsed.confidence,
          created,
          done,
          couldNot,
          next,
          delivery,
        },
      };
    },
  });
}
