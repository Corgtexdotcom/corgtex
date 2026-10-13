import type { AgentTriggerType, Action, Tension, Proposal, CommunicationMessage, CommunicationContextSummary } from "@prisma/client";
import { defaultModelGateway } from "@corgtex/models";
import { getKnowledgeSearchInputRoots, searchIndexedKnowledge } from "@corgtex/knowledge";
import {
  createWorkItemFromCommunicationSource,
  deleteAction,
  deleteProposal,
  deleteSource,
  deleteTension,
  deliverSlackAgentResponse,
  evaluateDelegatedActionPolicy,
  fetchAndPersistReadableSlackThreadMessages,
  isHumanMemberIdentity,
  listMembers,
  captureArtifactInputProof,
  captureReadableDigestInputs,
  isArtifactInputProofReadable,
  isArtifactInputProofPubliclyShareable,
  mergeArtifactInputProofs,
  invariant,
  validateSlackPostTarget,
  type LineageKind,
  type LineageRoot,
  type SlackAgentDelivery,
  type SlackAgentJobPayload,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import type { HumanActor } from "@corgtex/shared";
import { executeAgentRun, asString, type AgentHelpers, type AgentInputReceipt } from "../runtime";

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
  const where = { id: entityId, workspaceId, archivedAt: null };
  if (entityType === "Action") return prisma.action.findFirst({ where });
  if (entityType === "Tension") return prisma.tension.findFirst({ where });
  if (entityType === "Proposal") return prisma.proposal.findFirst({ where });
  return prisma.brainSource.findFirst({ where });
}

async function findSlackUndoCandidate(actor: HumanActor, params: SlackInputPayload,
  proof: SlackProofContext, collectInputs: (roots: LineageRoot[]) => Promise<void>) {
  const hint = undoEntityHint(params.prompt);
  const entityTypes = hint ? [hint] : [...SLACK_UNDO_ENTITY_TYPES];
  const baseWhere = { installationId: params.installationId, workspaceId: params.workspaceId,
    provider: "SLACK" as const, externalUserId: params.externalUserId,
    action: { in: SLACK_UNDO_CREATE_ACTIONS }, entityType: { in: entityTypes },
    createdAt: { gte: new Date(Date.now() - SLACK_UNDO_LOOKBACK_MS) } };
  const scopes = [
    params.channelId && params.threadTs ? { ...baseWhere, message: { externalChannelId: params.channelId,
      OR: [{ externalMessageId: params.threadTs! }, { threadExternalId: params.threadTs }] } } : null,
    params.channelId ? { ...baseWhere, message: { externalChannelId: params.channelId } } : null,
    baseWhere,
  ].filter((where): where is typeof baseWhere => !!where);
  for (const where of scopes) {
    for (let skip = 0; skip < 5_000; skip += 50) {
      const links = await prisma.communicationEntityLink.findMany({ where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 50, skip });
      const permittedLinks = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId,
        kind: "CommunicationEntityLink", records: links });
      for (const link of permittedLinks.records) {
        if (!SLACK_UNDO_ENTITY_TYPES.includes(link.entityType as SlackUndoEntityType)) continue;
        const entityType = link.entityType as SlackUndoEntityType;
        const entity = await loadUndoEntitySummary(params.workspaceId, entityType, link.entityId);
        if (!entity) continue;
        const captured = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId,
          kind: entityType, records: [entity] });
        if (!captured.records.length) continue;
        const roots = mergeArtifactInputProofs(permittedLinks.proofs.get(link.id)!, captured.roots);
        if (proof.publicReply && !await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, roots)) continue;
        await collectInputs(roots);
        return { ...link, entityType, title: entity.title };
      }
      if (links.length < 50) break;
      invariant(skip + 50 < 5_000, 503, "INPUT_SCAN_LIMIT", "Slack undo candidates need a lineage rebuild.");
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

async function undoLastSlackCreatedItem(actor: HumanActor, params: SlackInputPayload, proof: SlackProofContext,
  collectInputs: (roots: LineageRoot[]) => Promise<void>, archive: (candidate: {
    action: string; entityType: SlackUndoEntityType; entityId: string; title: string | null;
  }) => Promise<void>) {
  const candidate = await findSlackUndoCandidate(actor, params, proof, collectInputs);
  if (!candidate) return { archived: false, done: [],
    couldNot: ["I could not undo an item from this request."], next: "Open the item in Corgtex to review it." };
  try {
    await archive(candidate);
    return { archived: true, done: ["I undid the Slack-created item."], couldNot: [], next: "No follow-up needed." };
  } catch {
    return { archived: false, done: [], couldNot: ["I could not complete this undo request."],
      next: "Open the item in Corgtex to review it." };
  }
}

async function loadActor(workspaceId: string, userId: string): Promise<HumanActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, globalRole: true },
  });
  if (!user) return null;

  const member = await prisma.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { user: { select: { id: true, email: true, displayName: true } } },
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
    if (external?.memberId) {
      const member = params.members.find((entry) => entry.id === external.memberId);
      if (member) return { memberId: member.id, error: null };
    }
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
  collectInputs: (roots: LineageRoot[]) => Promise<void>;
  tool: AgentHelpers["tool"];
  behavior: string | null;
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

  const knowledge = await searchIndexedKnowledge({
    actor: params.actor, workspaceId: params.workspaceId, query: params.prompt,
    workflowJobId: params.workflowJobId, agentRunId: params.agentRunId,
  });
  await params.collectInputs(await getKnowledgeSearchInputRoots(params.actor, params.workspaceId, knowledge));

  const chat = await params.tool("model.conversation", { purpose: "workspace_question" }, () => defaultModelGateway.chat({
    model: params.model,
    workspaceId: params.workspaceId,
    workflowJobId: params.workflowJobId,
    agentRunId: params.agentRunId,
    taskType: "AGENT",
    messages: [
      {
        role: "system",
        content: [
          params.behavior ?? "",
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
          knowledge,
        }),
      },
    ],
  }));

  return chat.content.trim() || "I do not have enough information to answer that yet.";
}

type SlackInputPayload = SlackAgentJobPayload & { requestInputId?: string | null };
type SlackProofContext = { actor: HumanActor; prompt: string; roots: LineageRoot[]; publicReply: boolean;
  sourceMessageId?: string; threadTs?: string };

async function loadSlackRequest(params: SlackInputPayload): Promise<SlackProofContext | null> {
  const actor = await loadActor(params.workspaceId, params.actorUserId);
  if (!actor) return null;
  const mapping = await prisma.communicationExternalUser.findUnique({ where: {
    installationId_externalUserId: { installationId: params.installationId, externalUserId: params.externalUserId },
  } });
  invariant(mapping && mapping.workspaceId === params.workspaceId && mapping.provider === "SLACK"
    && !mapping.isDeleted && !mapping.isBot && mapping.userId === actor.user.id,
  409, "SOURCE_RESTRICTED", "The Slack requester mapping is unavailable.");
  const channel = await prisma.communicationChannel.findFirst({ where: {
    workspaceId: params.workspaceId, installationId: params.installationId, provider: "SLACK",
    externalChannelId: params.channelId ?? "", kind: "PUBLIC", isIngestEnabled: true, isArchived: false,
  } });
  invariant(channel, 409, "SOURCE_RESTRICTED", "The original public Slack channel is unavailable.");
  const member = await prisma.member.findUnique({ where: { workspaceId_userId: { workspaceId: params.workspaceId, userId: actor.user.id } },
    include: { user: { select: { id: true, email: true, displayName: true } } } });
  invariant(member?.isActive && (!mapping.memberId || mapping.memberId === member.id), 409, "SOURCE_RESTRICTED", "The Slack requester membership changed.");
  const base = await captureArtifactInputProof(actor, params.workspaceId, [
    { kind: "CommunicationChannel", id: channel.id, snapshot: channel },
    { kind: "CommunicationExternalUser", id: mapping.id, snapshot: mapping },
    { kind: "Member", id: member.id, snapshot: member },
    { kind: "User", id: actor.user.id, snapshot: actor.user },
  ]);
  let prompt: string;
  let requestRoots: LineageRoot[];
  let sourceMessageId: string | undefined;
  let threadTs: string | undefined;
  if (params.source === "app_mention") {
    invariant(params.messageTs, 409, "UNKNOWN_LINEAGE", "The original Slack request timestamp is unavailable.");
    const message = await prisma.communicationMessage.findFirst({ where: {
      workspaceId: params.workspaceId, installationId: params.installationId, provider: "SLACK",
      ...(params.sourceMessageId ? { id: params.sourceMessageId } : {}), externalChannelId: channel.externalChannelId,
      externalMessageId: params.messageTs, externalUserId: params.externalUserId,
      isHidden: false, isDeleted: false, textRedactedAt: null, text: { not: null },
    } });
    invariant(message && typeof message.text === "string" && message.text.trim() && (!params.threadTs || (message.threadExternalId || message.externalMessageId) === params.threadTs),
      409, "UNKNOWN_LINEAGE", "The original Slack request is unavailable.");
    prompt = message.text.trim();
    sourceMessageId = message.id;
    threadTs = message.threadExternalId || message.externalMessageId;
    requestRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "CommunicationMessage", id: message.id, snapshot: message }]);
  } else {
    invariant(params.requestInputId, 409, "UNKNOWN_LINEAGE", "This Slack request has no immutable authored input.");
    const request = await prisma.agentRequestInput.findFirst({ where: {
      id: params.requestInputId, workspaceId: params.workspaceId, userId: actor.user.id, agentKey: "slack-agent",
    } });
    invariant(request && request.prompt.trim(), 409, "UNKNOWN_LINEAGE", "The authored Slack request is unavailable.");
    prompt = request.prompt;
    requestRoots = await captureArtifactInputProof(actor, params.workspaceId, [{ kind: "AgentRequestInput", id: request.id, snapshot: request }]);
    if (params.source === "message_shortcut") {
      invariant(params.sourceMessageId && params.messageTs, 409, "UNKNOWN_LINEAGE", "The selected native Slack source is unavailable.");
      const selected = await prisma.communicationMessage.findFirst({ where: {
        id: params.sourceMessageId, workspaceId: params.workspaceId, installationId: params.installationId, provider: "SLACK",
        externalChannelId: channel.externalChannelId, externalMessageId: params.messageTs,
        isHidden: false, isDeleted: false, textRedactedAt: null, text: { not: null },
      } });
      invariant(selected && (!params.threadTs || (selected.threadExternalId || selected.externalMessageId) === params.threadTs),
        409, "UNKNOWN_LINEAGE", "The selected Slack source changed before execution.");
      sourceMessageId = selected.id;
      threadTs = selected.threadExternalId || selected.externalMessageId;
      requestRoots = mergeArtifactInputProofs(requestRoots, await captureArtifactInputProof(actor, params.workspaceId,
        [{ kind: "CommunicationMessage", id: selected.id, snapshot: selected }]));
    }
  }
  const roots = mergeArtifactInputProofs(base, requestRoots);
  const publicReply = params.source === "app_mention";
  invariant(!publicReply || await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, roots),
    409, "SOURCE_RESTRICTED", "The request cannot be shared in this public Slack channel.");
  return { actor, prompt, roots, publicReply, sourceMessageId, threadTs };
}

/** Bound raw scans, then apply source and public-audience gates before sampling. */
async function loadSlackReadableRows<T extends { id: string }>(params: {
  proof: SlackProofContext; workspaceId: string; kind: LineageKind; limit: number;
  load: (take: number, skip: number) => Promise<T[]>;
}) {
  const records: T[] = [];
  const roots: LineageRoot[][] = [];
  const seen = new Set<string>();
  const take = 50;
  for (let skip = 0; skip < 5_000 && records.length < params.limit; skip += take) {
    const batch = await params.load(take, skip);
    const captured = await captureReadableDigestInputs({ actor: params.proof.actor, workspaceId: params.workspaceId, kind: params.kind, records: batch });
    for (const row of captured.records) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const proof = captured.proofs.get(row.id)!;
      if (params.proof.publicReply && !await isArtifactInputProofPubliclyShareable(params.proof.actor, params.workspaceId, proof)) continue;
      records.push(row); roots.push(proof);
      if (records.length === params.limit) break;
    }
    if (batch.length < take || records.length === params.limit) return { records, roots: mergeArtifactInputProofs(...roots) };
  }
  invariant(records.length === params.limit, 503, "INPUT_SCAN_LIMIT", "Slack context needs a lineage rebuild before collection can complete.");
  return { records, roots: mergeArtifactInputProofs(...roots) };
}

async function deliverSafely(payload: SlackInputPayload, response: SlackAgentDelivery, proof: SlackProofContext, roots: LineageRoot[]) {
  invariant(await isArtifactInputProofReadable(proof.actor, payload.workspaceId, roots), 409, "SOURCE_CHANGED", "Slack inputs changed before delivery.");
  const mapping = await prisma.communicationExternalUser.findUnique({ where: {
    installationId_externalUserId: { installationId: payload.installationId, externalUserId: payload.externalUserId },
  } });
  invariant(mapping && !mapping.isDeleted && mapping.userId === proof.actor.user.id, 409, "SOURCE_RESTRICTED", "The Slack requester mapping changed.");
  if (proof.publicReply) {
    invariant(!payload.responseUrlEnc && await isArtifactInputProofPubliclyShareable(proof.actor, payload.workspaceId, roots),
      409, "SOURCE_RESTRICTED", "These inputs cannot be published to Slack.");
  }
  const target = await validateSlackPostTarget(payload.installationId, payload.channelId ?? "", { requirePublic: true });
  invariant(target.ok && target.channelId === payload.channelId, 409, "SOURCE_RESTRICTED", "The original Slack destination changed.");
  invariant(await isArtifactInputProofReadable(proof.actor, payload.workspaceId, roots)
    && (!proof.publicReply || await isArtifactInputProofPubliclyShareable(proof.actor, payload.workspaceId, roots)),
  409, "SOURCE_CHANGED", "Slack inputs changed during destination validation.");
  try {
    await deliverSlackAgentResponse(payload, response);
    return { delivered: true };
  } catch {
    return { delivered: false, error: "Slack delivery failed." };
  }
}

export async function runSlackAgent(input: SlackInputPayload & {
  workflowJobId?: string;
  triggerType?: AgentTriggerType;
}) {
  const proof = await loadSlackRequest(input);
  if (!proof) return { skipped: true, reason: "requester_unavailable" };
  const params = { ...input, prompt: proof.prompt, sourceMessageId: proof.sourceMessageId ?? input.sourceMessageId,
    threadTs: proof.threadTs ?? input.threadTs, responseUrlEnc: proof.publicReply ? null : input.responseUrlEnc };
  const triggerRef = params.source === "app_mention" ? params.sourceMessageId ?? params.messageTs!
    : params.requestInputId!;

  return executeAgentRun({
    agentKey: "slack-agent",
    lineageActor: proof.actor, lineageRoots: proof.roots,
    contextLineageRoots: context => context.lineageRoots,
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
    buildContext: async () => {
      const actor = proof.actor;
      const currentMessageDate = params.messageTs ? new Date(Number(params.messageTs.split(".")[0]) * 1000) : null;
      const commonMessageWhere = { installationId: params.installationId, workspaceId: params.workspaceId,
        provider: "SLACK" as const, externalChannelId: params.channelId!, text: { not: null },
        textRedactedAt: null, isBot: false, isHidden: false, isDeleted: false };
      const rowParams = { proof, workspaceId: params.workspaceId };
      const freshThread = params.threadTs ? await fetchAndPersistReadableSlackThreadMessages(actor, {
        workspaceId: params.workspaceId, installationId: params.installationId, channelId: params.channelId!, threadTs: params.threadTs, limit: 200,
      }) : [];
      const [memberRows, externalRows, actions, tensions, proposals, messages, channel, summaries, selected] = await Promise.all([
        listMembers(params.workspaceId),
        prisma.communicationExternalUser.findMany({ where: { installationId: params.installationId, workspaceId: params.workspaceId, provider: "SLACK", isDeleted: false, isBot: false } }),
        loadSlackReadableRows<Action>({ ...rowParams, kind: "Action", limit: 5, load: (take, skip) => prisma.action.findMany({ where: { workspaceId: params.workspaceId, status: { in: ["OPEN", "IN_PROGRESS"] }, archivedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take, skip }) }),
        loadSlackReadableRows<Tension>({ ...rowParams, kind: "Tension", limit: 5, load: (take, skip) => prisma.tension.findMany({ where: { workspaceId: params.workspaceId, status: "OPEN", archivedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take, skip }) }),
        loadSlackReadableRows<Proposal>({ ...rowParams, kind: "Proposal", limit: 5, load: (take, skip) => prisma.proposal.findMany({ where: { workspaceId: params.workspaceId, status: "OPEN", archivedAt: null }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take, skip }) }),
        loadSlackReadableRows<CommunicationMessage>({ ...rowParams, kind: "CommunicationMessage", limit: 80,
          load: async (take, skip) => freshThread.slice(skip, skip + take) }),
        loadSlackReadableRows<CommunicationMessage>({ ...rowParams, kind: "CommunicationMessage", limit: 40, load: (take, skip) => prisma.communicationMessage.findMany({ where: { ...commonMessageWhere, ...(currentMessageDate && Number.isFinite(currentMessageDate.getTime()) ? { messageTs: { lte: currentMessageDate } } : {}) }, orderBy: [{ messageTs: "desc" }, { id: "asc" }], take, skip }) }),
        loadSlackReadableRows<CommunicationContextSummary>({ ...rowParams, kind: "CommunicationContextSummary", limit: 6, load: (take, skip) => prisma.communicationContextSummary.findMany({ where: { workspaceId: params.workspaceId, installationId: params.installationId, provider: "SLACK", externalChannelId: params.channelId!, ...(params.threadTs ? { OR: [{ threadExternalId: params.threadTs }, { threadExternalId: null }] } : {}) }, orderBy: [{ summaryDate: "desc" }, { id: "asc" }], take, skip }) }),
        params.sourceMessageId ? prisma.communicationMessage.findFirst({ where: { ...commonMessageWhere, id: params.sourceMessageId! } }) : Promise.resolve(null),
      ]);
      const members = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "Member", records: memberRows.map(member => ({ ...member, user: { id: member.user.id, email: member.user.email, displayName: member.user.displayName } })) });
      const users = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "User", records: memberRows.map(member => member.user) });
      const userIds = new Set(users.records.map(user => user.id));
      const permittedMembers = members.records.filter(member => userIds.has(member.user.id));
      const external = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "CommunicationExternalUser", records: externalRows });
      const selectedInputs = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId, kind: "CommunicationMessage", records: selected ? [selected] : [] });
      const selectedMessage = selectedInputs.records[0] ?? null;
      const lineageRoots = mergeArtifactInputProofs(proof.roots, actions.roots, tensions.roots, proposals.roots,
        messages.roots, channel.roots, summaries.roots, selectedInputs.roots,
        ...permittedMembers.map(member => members.proofs.get(member.id)!), ...users.proofs.values(), ...external.proofs.values());
      invariant(!proof.publicReply || await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, lineageRoots), 409, "SOURCE_RESTRICTED", "Slack context cannot be shared publicly.");
      const projectMessage = (message: CommunicationMessage) => ({ user: message.externalUserId, text: message.text, ts: message.externalMessageId, threadTs: message.threadExternalId });
      return { actor, members: permittedMembers, externalUsers: external.records,
        userTimezone: rawProfileTimezone(external.records.find(row => row.externalUserId === params.externalUserId)?.rawProfile),
        openActions: actions.records.map(({ id, title, status }) => ({ id, title, status })),
        openTensions: tensions.records.map(({ id, title, status }) => ({ id, title, status })),
        openProposals: proposals.records.map(({ id, title, status }) => ({ id, title, status })),
        sourceMessage: selectedMessage ? projectMessage(selectedMessage) : null,
        threadMessages: messages.records.map(projectMessage), channelMessages: channel.records.reverse().map(projectMessage),
        contextSummaries: summaries.records.map(({ title, summaryMd, threadExternalId, summaryDate, messageCount }) => ({ title, summaryMd, threadExternalId, summaryDate, messageCount })), lineageRoots };
    },
    execute: async (context, helpers, runId, model) => {
      const actor = context.actor as HumanActor;
      let roots = mergeArtifactInputProofs(context.lineageRoots, [...helpers.behaviorLineageRoots]);
      let receipt: AgentInputReceipt = await helpers.captureInputs(roots);
      const collectInputs = async (added: LineageRoot[]) => {
        roots = mergeArtifactInputProofs(roots, added);
        invariant(!proof.publicReply || await isArtifactInputProofPubliclyShareable(proof.actor, params.workspaceId, roots), 409, "SOURCE_RESTRICTED", "Knowledge context cannot be shared in Slack.");
        receipt = await helpers.captureInputs(roots);
      };
      const tool: AgentHelpers["tool"] = (name, input, work) => helpers.tool(name, input, async () => {
        invariant(await isArtifactInputProofReadable(proof.actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Slack inputs changed before execution.");
        const result = await work();
        invariant(await isArtifactInputProofReadable(proof.actor, params.workspaceId, roots), 409, "SOURCE_CHANGED", "Slack inputs changed during execution.");
        return result;
      }, { receipt });

      if (isCapabilitiesPrompt(params.prompt)) {
        const parts = renderCapabilitiesResponse();
        const response = renderSlackResponse(parts);
        const delivery = await tool("slack.reply", {
          reason: "capabilities",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response, proof, roots));

        return {
          lineageReceipt: receipt,
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
        const undo = await undoLastSlackCreatedItem(actor, params, proof, collectInputs, async candidate => {
          invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots)
            && (!proof.publicReply || await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, roots)),
          409, "SOURCE_CHANGED", "Undo inputs changed before archival.");
          await helpers.tool("corgtex.undo", { purpose: "archive_requested_slack_item" },
            () => archiveSlackUndoCandidate(actor, params, candidate), { receipt });
        });
        if (undo.archived) {
          // The archived target invalidates the earlier context. A deterministic
          // acknowledgment reveals no target data and uses only the still-current
          // original request. The whole run intentionally remains unproven.
          const requestReceipt = await helpers.captureInputs(proof.roots);
          const delivery = await helpers.tool("slack.reply.undo_ack", { status: "acknowledged" },
            () => deliverSafely(params, renderConversationResponse("I undid the Slack-created item."), proof, proof.roots),
            { receipt: requestReceipt });
          return { resultJson: { intent: "undo_created_item", status: "ACKNOWLEDGED", delivery } };
        }
        const delivery = await tool("slack.reply", { reason: "undo_unavailable" },
          () => deliverSafely(params, renderSlackResponse(undo), proof, roots));
        return { lineageReceipt: receipt, resultJson: { intent: "undo_created_item", done: undo.done,
          couldNot: undo.couldNot, next: undo.next, delivery } };
      }

      const extraction = await tool("model.extract", { prompt: params.prompt }, async () => defaultModelGateway.extract({
        model,
        workspaceId: params.workspaceId,
        workflowJobId: params.workflowJobId,
        agentRunId: runId,
        instruction: [
          helpers.behaviorContext ?? "",
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
      let privateResult = false;
      let unknownResult = false;

      if (isUnsupportedOperation(params.prompt, parsed)) {
        const response = renderUnsupportedResponse();
        const delivery = await tool("slack.reply", {
          reason: "unsupported",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response, proof, roots));

        return {
          lineageReceipt: receipt,
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
        const answer = await answerSlackConversation({
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
          collectInputs, tool, behavior: helpers.behaviorContext,
        });
        const response = renderConversationResponse(answer);
        const delivery = await tool("slack.reply", {
          reason: "conversation_answer",
          source: params.source,
          channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc),
        }, () => deliverSafely(params, response, proof, roots));

        return {
          lineageReceipt: receipt,
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
          const summary = await tool("model.chat", { purpose: "summarize_slack_thread" }, () => defaultModelGateway.chat({
            model,
            workspaceId: params.workspaceId,
            workflowJobId: params.workflowJobId,
            agentRunId: runId,
            taskType: "AGENT",
            messages: [
              { role: "system", content: [helpers.behaviorContext, "Summarize this Slack thread concisely for a Corgtex workspace operator. Include decisions, open questions, and action candidates when present."].filter(Boolean).join("\n\n") },
              { role: "user", content: JSON.stringify(threadMessages) },
            ],
          }));
          done.push(summary.content);
        }
      } else {
        const members = context.members as Awaited<ReturnType<typeof listMembers>>;
        const assignee = matchMemberId({
          assigneeHint: parsed.assigneeHint,
          members: parsed.intent === "create_action" ? members.filter(isHumanMemberIdentity) : members,
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
        const open = actionPolicy.policyClass === "normal_write" && (kind !== "ACTION" || Boolean(assignee.memberId));
        if (kind === "ACTION" && !assignee.memberId) {
          next = "Assign an active Corgtex member to the private draft in Corgtex before opening it.";
        }

        if (!kind) {
          couldNot.push("I could not map that request to a supported Slack-agent v1 action.");
        } else {
          const item = await tool("corgtex.create", {
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
            lineageRoots: roots,
            sourceMessageId: params.sourceMessageId ?? null,
            externalUserId: params.externalUserId,
            assigneeMemberId: kind === "ACTION" ? assignee.memberId : null,
            raisedByMemberId: kind === "TENSION" ? assignee.memberId : null,
            dueAt,
            open,
          }));

          created.push(item);
          const entityType = item.entityType as SlackUndoEntityType;
          const stored = SLACK_UNDO_ENTITY_TYPES.includes(entityType)
            ? await loadUndoEntitySummary(params.workspaceId, entityType, item.entityId) : null;
          const captured = await captureReadableDigestInputs({ actor, workspaceId: params.workspaceId,
            kind: entityType, records: stored ? [stored] : [] });
          if (captured.records.length) {
            roots = mergeArtifactInputProofs(roots, captured.roots);
            receipt = await helpers.captureInputs(roots);
          } else unknownResult = true;
          privateResult = unknownResult || (proof.publicReply && (!item.opened
            || !await isArtifactInputProofPubliclyShareable(actor, params.workspaceId, roots)));
          const state = kind === "BRAIN_NOTE"
            ? "captured"
            : item.opened
              ? "created and opened"
              : "created a private draft";
          done.push(`${state} ${item.entityType} ${slackLink(item.webUrl, parsed.title)}.`);
        }
      }

      const response = privateResult
        ? renderConversationResponse("I completed the request. Review the result in Corgtex.")
        : renderSlackResponse({ done, couldNot, next });
      const delivery = privateResult
        ? await helpers.tool("slack.reply.private_result_ack", { status: "acknowledged" },
          () => deliverSafely(params, response, proof, proof.roots), { receipt: await helpers.captureInputs(proof.roots) })
        : await tool("slack.reply", { source: params.source, channelId: params.channelId ?? null,
          responseUrl: Boolean(params.responseUrlEnc) }, () => deliverSafely(params, response, proof, roots));

      return {
        ...(unknownResult ? {} : { lineageReceipt: receipt }),
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
