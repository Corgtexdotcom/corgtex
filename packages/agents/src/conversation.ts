import { prisma } from "@corgtex/shared";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { defaultModelGateway } from "@corgtex/models";
import { AppError, buildRoleOnboardingContextForConversation, checkBudget, loadRelevantMemories, storeAgentMemory } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import type { ChatMessage } from "@corgtex/models";
import { checkCalendarAvailabilityTool, scheduleMeetingTool, checkCalendarAvailability, scheduleMeeting } from "./tools/calendar";
import { createCorgtexScheduledMeetingTool, uploadMeetingTranscriptTool, createCorgtexScheduledMeeting, uploadMeetingTranscriptFromTool } from "./tools/meetings";
import { getWorkspaceOverviewTool, queryTensionsTool, queryActionsTool, queryProposalsTool, queryGoalsTool, queryOrgStructureTool, getWorkspaceOverview, queryTensions, queryActions, queryProposals, queryGoals, queryOrgStructure } from "./tools/workspace";
import { searchBrainTool, searchBrain } from "./tools/knowledge";
import { createTensionTool, updateTensionTool, createActionTool, updateActionTool, createProposalTool, createGoalTool, createTensionAction, updateTensionAction, createActionItemAction, updateActionItemAction, createProposalAction, createGoalAction } from "./tools/mutations";
import { saveToBrainTool, saveToBrainAction } from "./tools/brain-save";
import {
  listMembersTool,
  getMemberProfileTool,
  updateMemberTool,
  assignRoleTool,
  unassignRoleTool,
  listMembersAction,
  getMemberProfileAction,
  updateMemberAction,
  assignRoleAction,
  unassignRoleAction
} from "./tools/members";
import {
  archiveToolLinkAction,
  archiveToolLinkTool,
  listToolLinksAction,
  listToolLinksTool,
  revealToolLinkCredentialAction,
  revealToolLinkCredentialTool,
  upsertToolLinkAction,
  upsertToolLinkTool,
} from "./tools/tool-links";
import {
  executeExternalToolAction,
  executeExternalToolTool,
  fetchConnectedContextAction,
  fetchConnectedContextTool,
  listConnectedToolsAction,
  listConnectedToolsTool,
  searchConnectedContextAction,
  searchConnectedContextTool,
} from "./tools/external-mcp";
import { contextMapToolHandlers, contextMapTools, isContextMapAiAvailable } from "./tools/context-map";
import {
  CRM_WRITE_TOOL_NAMES,
  completeRelationshipActivityAction,
  createCommunicationSuggestionAction,
  crmTools,
  listDueRelationshipWorkAction,
  normalizeCrmWriteToolArgs,
  recordRelationshipActivityAction,
} from "./tools/crm";
import {
  beginCrmPendingOperationExecution,
  cancelCrmPendingOperation,
  createPendingCrmOperation,
  crmPendingOperationCancelNotice,
  crmPendingOperationExpiredNotice,
  crmPendingOperationFailedNotice,
  crmPendingOperationIntent,
  crmPendingOperationNotice,
  crmPendingOperationResultNotice,
  findCrmPendingOperationForIntent,
  markCrmPendingOperationExecuted,
  markCrmPendingOperationFailed,
} from "./pending-crm-operations";
import { formatConversationPageContextForModel, type ConversationPageContext } from "./page-context";
import type { AppActor } from "@corgtex/shared";
import type { KnowledgeSourceType } from "@prisma/client";

const MAX_HISTORY_TURNS = 20;
const KNOWLEDGE_SEARCH_LIMIT = 4;

async function assertWorkspaceModelBudget(workspaceId: string) {
  const budget = await checkBudget(workspaceId);
  if (!budget.allowed) {
    throw new AppError(429, "BUDGET_EXCEEDED", "Workspace model usage budget has been reached.");
  }
}

const SYSTEM_PROMPTS: Record<string, string> = {
  assistant: `You are Corgtex, an AI governance assistant for a self-managing organization. You help team members:
- Draft proposals and tensions
- Answer questions about workspace knowledge (policies, meetings, documents)
- Brainstorm ideas and provide organizational guidance
- Summarize meeting notes and extract action items
- Find time and schedule meetings among team members
- Create and update tensions, actions, proposals, and goals directly

You have full read AND write access to the workspace through your tools:
READ TOOLS:
- 'get_workspace_overview' — high-level summary of org state
- 'query_tensions', 'query_actions', 'query_proposals', 'query_goals' — exact, filtered lists
- 'query_org_structure' — circles, roles, and members
- 'search_brain' — semantic search across all indexed knowledge
- 'list_tool_links' — shared workspace tools, access notes, and credential presence
- 'list_connected_tools' — same-user external MCP tools connected to this workspace
- 'search_connected_context', 'fetch_connected_context' — live search/fetch from Corgtex and connected tools such as Box or Notion, with provenance
- Premium context-map tools, when enabled — read the current map, fetch selected-region context, create pending graph diffs, and apply graph diffs through the audited review/apply path
- CRM tools — summarize visible CRM page context and list due relationship work

WRITE TOOLS:
- 'create_tension', 'create_action' — create new items
- 'update_tension', 'update_action' — update status, assignments, content
- 'create_proposal' — draft and create a new governance proposal
- 'create_goal' — create a goal in the Goals tab with cadence and optional key results
- 'upsert_tool_link', 'archive_tool_link', 'reveal_tool_link_credential' — manage and use the shared Tools directory
- 'execute_external_tool' — run a same-user delegated external MCP tool such as Notion when the user explicitly asks or confidence is high
- 'create_context_map_diff' and 'apply_context_map_diff', when enabled — propose or directly apply context-map graph changes without bypassing graph audit
- CRM write tools — 'record_relationship_activity', 'complete_relationship_activity', and 'create_communication_suggestion'

When asked about current state, ALWAYS use a query tool instead of guessing.
When asked to create or update something, execute the write tool immediately — do not ask for confirmation, except for CRM write tools. Report what you did clearly after executing.
CRM write tools use a pending-operation approval contract. When the user asks for a CRM write, call the CRM write tool once with the exact title, due date, entity IDs, and operation you intend to perform. The server will store those exact args as a pending operation and return a pendingOperationId without executing the write. Ask the user to confirm or cancel that pendingOperationId. After the user confirms, the server executes the stored operation directly; do not regenerate CRM write arguments from natural language. CRM tools may draft, suggest, record, or mark tracked work complete, but they must not send email directly.
Every write action is fully audited and traceable.
For context map work, use CURRENT PAGE CONTEXT only as a pointer to the map/view/selection. Fetch bounded map details with 'get_context_map_info' or 'get_selected_context_map_region' before proposing or applying graph changes. If the user asks for an ambiguous change, ask a clarifying question instead of guessing. If the user confirms with "yes", "do it", or similar, use the prior chat turns plus CURRENT PAGE CONTEXT to carry out the last clear map-change intent. For merge requests, ask which item survives if unclear; otherwise update the survivor, re-point absorbed relationships, archive the absorbed item, and preserve evidence refs on the survivor where available.
Tool credential reveals are sensitive and audited. Use them only when the user asks to access or reveal a saved tool credential.
Use live retrieval from connected tools first when the user needs current external context. Corgtex Brain may also contain selected Box snapshots with sourceType EXTERNAL_CONTENT; distinguish those synced snapshots from live Box context. Do not save Notion, Box, or other external content into Corgtex Brain unless the user explicitly asks you to save, upload, store, remember, or sync selected sources.
When answering from connected tools, say whether the context came from Corgtex Brain, a Corgtex-synced Box snapshot, or the live external provider.

Be concise, direct, and action-oriented. When relevant, cite workspace knowledge.
If the user wants to create something (proposal, tension, action, or goal), use the appropriate workspace tool directly. If they say "add it to the goals tab" or "put it in goals", create goals rather than tensions, actions, or proposals.
If the user asks to turn, convert, or process an existing tension into a proposal, first use 'query_tensions' to identify the tension, then create the proposal with 'sourceTensionId' set. Treat action items as optional related implementation work; only pass 'relatedActionIds' when the user clearly names existing actions that belong with the proposal. Do not turn an action into a proposal unless the user explicitly asks for that exact action-to-proposal conversion.
If the user asks to upload or ingest meeting minutes or a transcript, use 'upload_meeting_transcript' when transcript text is present. If the transcript is attached in chat, the application will process the attachment before this message reaches you; report the result and ask only for missing meeting date/time if needed.
If the user asks to create a meeting in Corgtex Upcoming Meetings, use 'create_corgtex_scheduled_meeting'. Use 'schedule_meeting' only when the user wants an external calendar invite.
For generic non-meeting files, instruct them to use the attachment icon (+) in the chat input.
If the user explicitly asks you to save, upload, store, or remember content (e.g., "save this transcript", "upload this to the brain", "remember this for later"), invoke 'save_to_brain' immediately with the relevant content. You do NOT need to save regular conversation — that happens automatically in the nightly batch. Only use this tool when the user explicitly requests immediate storage.
MEMBER MANAGEMENT TOOLS (permission-aware — mirrors your access level):
- 'list_members' — full member list with emails, roles, and assignments
- 'get_member_profile' — detailed profile for a specific member
- 'update_member' — change a member's workspace role or deactivate (ADMIN only)
- 'assign_role' — assign a member to a governance role in a circle (FACILITATOR/ADMIN)
- 'unassign_role' — remove a member from a governance role (FACILITATOR/ADMIN)

If the user wants a calendar invite or availability check, invoke 'check_calendar_availability' first using full ISO 8601 UTC dates (e.g., 2026-04-10T09:00:00Z). If availability allows, invoke 'schedule_meeting'. If they only want it listed in Corgtex Upcoming Meetings, use 'create_corgtex_scheduled_meeting' instead.`,

  "proposal-drafting": `You are a proposal drafting assistant for a self-managing organization. Help the user:
- Clarify their governance need or operational change
- Research relevant workspace knowledge for context
- Structure a clear proposal with title, summary, and detailed body
- Consider potential objections and address them proactively

When you have enough information, format the proposal clearly with markdown.`,

  "knowledge-qa": `You are a workspace knowledge assistant. Answer questions using the organization's indexed knowledge base (policies, meeting notes, documents, proposals). Always cite your sources when possible. If you don't have enough information, say so clearly.`,

  "role-onboarding": `You are Corgtex role onboarding for a self-managing organization.
Help the assigned person understand the role they are stepping into. Start from the supplied ROLE ONBOARDING CONTEXT and explain:
- what the role is accountable for
- how the role fits into its circle
- what current commitments, tensions, policies, and meetings matter
- what the person should inspect or ask about next

Answer follow-up questions conversationally. Stay grounded in the supplied role context and workspace tools. If context is missing, say what is missing and suggest where the person can clarify it.`,
};

type ConversationContext = {
  workspaceId: string;
  sessionId: string;
  userId: string;
  agentKey: string;
  userMessage: string;
  systemPrompt?: string | null;
  actor?: AppActor;
  pageContext?: ConversationPageContext | null;
};

type ConversationContextUsed = {
  knowledgeResults?: unknown[];
  knowledgeSearch?: {
    query: string;
    sourceTypes?: KnowledgeSourceType[];
    hitCount: number;
    error?: string;
  };
  memories?: unknown[];
  pageContext?: ConversationPageContext;
  mapGraphChanged?: boolean;
  roleOnboardingContext?: string;
};

const BASE_TOOLS = [
  checkCalendarAvailabilityTool,
  scheduleMeetingTool,
  createCorgtexScheduledMeetingTool,
  uploadMeetingTranscriptTool,
  searchBrainTool,
  getWorkspaceOverviewTool,
  queryTensionsTool,
  queryActionsTool,
  queryProposalsTool,
  queryGoalsTool,
  queryOrgStructureTool,
  createTensionTool,
  updateTensionTool,
  createActionTool,
  updateActionTool,
  createProposalTool,
  createGoalTool,
  saveToBrainTool,
  listMembersTool,
  getMemberProfileTool,
  updateMemberTool,
  assignRoleTool,
  unassignRoleTool,
  listToolLinksTool,
  upsertToolLinkTool,
  archiveToolLinkTool,
  revealToolLinkCredentialTool,
  listConnectedToolsTool,
  searchConnectedContextTool,
  fetchConnectedContextTool,
  executeExternalToolTool,
  ...crmTools,
];

async function toolsForContext(ctx: ConversationContext) {
  if (await isContextMapAiAvailable(ctx.workspaceId)) {
    return [...BASE_TOOLS, ...contextMapTools];
  }
  return BASE_TOOLS;
}

const CONTEXT_MAP_MUTATION_TOOLS = new Set(["create_context_map_diff", "apply_context_map_diff"]);

function isContextMapMutationTool(toolName: string) {
  return CONTEXT_MAP_MUTATION_TOOLS.has(toolName);
}

type PriorConversationTurn = {
  sequenceNumber: number;
  userMessage: string;
  assistantMessage: string;
};

function compactForSearch(value: string | null | undefined, maxLength = 500) {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isShortFollowUp(message: string) {
  const trimmed = message.trim();
  if (!trimmed) return false;
  const terms = trimmed.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
  return trimmed.length <= 40 || terms.length <= 5 || /\b(too|also|that|this|them|it|name|names|who|which|where)\b/i.test(trimmed);
}

function userMentionsSlack(message: string) {
  return /\bslack\b/i.test(message);
}

function pageContextSearchHint(pageContext: ConversationPageContext | null | undefined) {
  if (!pageContext) return "";
  return compactForSearch(formatConversationPageContextForModel(pageContext), 900);
}

function buildKnowledgeSearchQuery(params: {
  userMessage: string;
  priorTurns: PriorConversationTurn[];
  pageContext?: ConversationPageContext | null;
}) {
  const current = compactForSearch(params.userMessage, 700);
  const parts = [current];
  if (isShortFollowUp(params.userMessage)) {
    const recent = params.priorTurns.slice(-4).map((turn) => [
      `User: ${compactForSearch(turn.userMessage, 300)}`,
      `Assistant: ${compactForSearch(turn.assistantMessage, 300)}`,
    ].join(" ")).join(" ");
    if (recent) {
      parts.push(`Recent conversation context: ${recent}`);
    }
  }
  const pageHint = pageContextSearchHint(params.pageContext);
  if (pageHint) {
    parts.push(`Current page context: ${pageHint}`);
  }
  return parts.filter(Boolean).join("\n");
}

async function loadKnowledgeForConversation(params: {
  ctx: ConversationContext;
  priorTurns: PriorConversationTurn[];
  limit: number;
}) {
  const query = buildKnowledgeSearchQuery({
    userMessage: params.ctx.userMessage,
    priorTurns: params.priorTurns,
    pageContext: params.ctx.pageContext,
  });
  if (!query) {
    return { results: [] as unknown[], search: undefined };
  }

  const sourceTypes = userMentionsSlack(params.ctx.userMessage)
    ? (["SLACK"] as KnowledgeSourceType[])
    : undefined;

  try {
    const results = await searchIndexedKnowledge({
      workspaceId: params.ctx.workspaceId,
      query,
      limit: params.limit,
      sourceTypes,
    });
    return {
      results: Array.isArray(results) ? results : [],
      search: {
        query,
        sourceTypes,
        hitCount: Array.isArray(results) ? results.length : 0,
      },
    };
  } catch (error) {
    return {
      results: [] as unknown[],
      search: {
        query,
        sourceTypes,
        hitCount: 0,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function knowledgeSearchInstruction(search: ConversationContextUsed["knowledgeSearch"]) {
  if (!search) return null;
  const sourceLabel = search.sourceTypes?.includes("SLACK") ? "indexed public Slack knowledge" : "indexed workspace knowledge";
  if (search.error) {
    return `Knowledge retrieval attempted against ${sourceLabel}, but it failed. Do not claim that you checked or searched that source unless you call a tool successfully in this turn. Error: ${search.error}`;
  }
  if (search.hitCount === 0) {
    return `Knowledge retrieval already searched ${sourceLabel} for this turn and found no matching indexed chunks. Do not claim that you found or checked a source unless you use the supplied results or call a tool successfully.`;
  }
  return `Knowledge retrieval already searched ${sourceLabel} for this turn. Use the supplied results when answering from workspace context, cite them when relevant, and do not claim to have checked any other source unless a tool result is present.`;
}

const TOOL_HANDLERS: Partial<Record<string, (actor: AppActor, ctx: ConversationContext, args: any) => Promise<unknown>>> = {
  check_calendar_availability: async (actor, ctx, args) => checkCalendarAvailability(ctx.userId, ctx.workspaceId, args.emails, args.timeMin, args.timeMax),
  schedule_meeting: async (actor, ctx, args) => scheduleMeeting(ctx.userId, ctx.workspaceId, args.title, args.description, args.startTime, args.endTime, args.attendeeEmails),
  create_corgtex_scheduled_meeting: async (actor, ctx, args) => createCorgtexScheduledMeeting(actor, ctx.workspaceId, args),
  upload_meeting_transcript: async (actor, ctx, args) => uploadMeetingTranscriptFromTool(actor, ctx.workspaceId, args),
  search_brain: async (actor, ctx, args) => searchBrain(ctx.workspaceId, args.query, args.limit),
  get_workspace_overview: async (actor, ctx) => getWorkspaceOverview(ctx.workspaceId),
  query_tensions: async (actor, ctx, args) => queryTensions(ctx.workspaceId, args.status, args.assigneeId),
  query_actions: async (actor, ctx, args) => queryActions(ctx.workspaceId, args.status, args.assigneeId),
  query_proposals: async (actor, ctx, args) => queryProposals(ctx.workspaceId, args.status),
  query_goals: async (actor, ctx, args) => queryGoals(ctx.workspaceId, args.cadence, args.level, args.status),
  query_org_structure: async (actor, ctx) => queryOrgStructure(ctx.workspaceId),
  create_tension: createTensionAction,
  update_tension: updateTensionAction,
  create_action: createActionItemAction,
  update_action: updateActionItemAction,
  create_proposal: createProposalAction,
  create_goal: createGoalAction,
  save_to_brain: async (actor, ctx, args) => saveToBrainAction(actor, ctx, args),
  list_members: async (actor, ctx) => listMembersAction(actor, ctx),
  get_member_profile: async (actor, ctx, args) => getMemberProfileAction(actor, ctx, args),
  update_member: async (actor, ctx, args) => updateMemberAction(actor, ctx, args),
  assign_role: async (actor, ctx, args) => assignRoleAction(actor, ctx, args),
  unassign_role: async (actor, ctx, args) => unassignRoleAction(actor, ctx, args),
  list_tool_links: async (actor, ctx) => listToolLinksAction(actor, ctx),
  upsert_tool_link: async (actor, ctx, args) => upsertToolLinkAction(actor, ctx, args),
  archive_tool_link: async (actor, ctx, args) => archiveToolLinkAction(actor, ctx, args),
  reveal_tool_link_credential: async (actor, ctx, args) => revealToolLinkCredentialAction(actor, ctx, args),
  list_connected_tools: async (actor, ctx) => listConnectedToolsAction(actor, ctx),
  search_connected_context: async (actor, ctx, args) => searchConnectedContextAction(actor, ctx, args),
  fetch_connected_context: async (actor, ctx, args) => fetchConnectedContextAction(actor, ctx, args),
  execute_external_tool: async (actor, ctx, args) => executeExternalToolAction(actor, ctx, args),
  list_due_relationship_work: async (actor, ctx, args) => listDueRelationshipWorkAction(actor, ctx, args),
  record_relationship_activity: async (actor, ctx, args) => recordRelationshipActivityAction(actor, ctx, args),
  complete_relationship_activity: async (actor, ctx, args) => completeRelationshipActivityAction(actor, ctx, args),
  create_communication_suggestion: async (actor, ctx, args) => createCommunicationSuggestionAction(actor, ctx, args),
  ...contextMapToolHandlers,
};

function isCrmWriteTool(toolName: string) {
  return CRM_WRITE_TOOL_NAMES.has(toolName);
}

function crmPendingToolResult(operation: import("./pending-crm-operations").PendingOperationRecord) {
  return {
    status: "PENDING_CONFIRMATION",
    pendingOperationId: operation.id,
    toolName: operation.toolName,
    args: operation.argsJson,
    idempotencyKey: operation.idempotencyKey,
    relatedEntity: operation.relatedEntityType && operation.relatedEntityId
      ? { type: operation.relatedEntityType, id: operation.relatedEntityId }
      : null,
    riskLabel: operation.riskLabel,
    expiresAt: operation.expiresAt.toISOString(),
    message: crmPendingOperationNotice(operation),
  };
}

function requireConversationToolActor(ctx: ConversationContext): AppActor {
  if (!ctx.actor) {
    throw new Error("Authenticated actor is required for Corgtex tool execution.");
  }

  return ctx.actor;
}

function catalogUsageContext(ctx: ConversationContext) {
  if (ctx.actor?.kind === "agent" && ctx.actor.authProvider === "credential") {
    return {
      catalogItemId: ctx.actor.catalogItemId ?? undefined,
      agentCredentialId: ctx.actor.credentialId,
    };
  }

  return {};
}

function appendCrmPendingNotices(message: string, operations: Array<import("./pending-crm-operations").PendingOperationRecord>) {
  const missingNotices = operations
    .map((operation) => crmPendingOperationNotice(operation))
    .filter((notice) => !message.includes(notice));
  if (missingNotices.length === 0) return message;
  return [message.trim(), ...missingNotices].filter(Boolean).join("\n\n");
}

async function handleCrmPendingOperationIntent(ctx: ConversationContext) {
  const intent = crmPendingOperationIntent(ctx.userMessage);
  if (!intent) return null;

  const operation = await findCrmPendingOperationForIntent(ctx, intent);
  if (!operation) return null;

  if (intent.kind === "cancel") {
    const canceled = await cancelCrmPendingOperation(operation);
    return canceled.status === "CANCELED"
      ? crmPendingOperationCancelNotice(canceled)
      : crmPendingOperationFailedNotice(canceled);
  }

  const actor = requireConversationToolActor(ctx);
  const begin = await beginCrmPendingOperationExecution(operation);
  if (begin.state === "expired") return crmPendingOperationExpiredNotice(begin.operation);
  if (begin.state === "already-executed") return crmPendingOperationResultNotice(begin.operation, begin.operation.resultJson);
  if (begin.state !== "ready") return crmPendingOperationFailedNotice(begin.operation);

  const handler = TOOL_HANDLERS[begin.operation.toolName];
  if (!handler) {
    const failed = await markCrmPendingOperationFailed(begin.operation, new Error(`Unknown CRM operation ${begin.operation.toolName}.`));
    return crmPendingOperationFailedNotice(failed);
  }

  try {
    const result = await handler(actor, { ...ctx, pageContext: null }, begin.operation.argsJson);
    const executed = await markCrmPendingOperationExecuted(begin.operation, result);
    return crmPendingOperationResultNotice(executed, result);
  } catch (error) {
    const failed = await markCrmPendingOperationFailed(begin.operation, error);
    return crmPendingOperationFailedNotice(failed);
  }
}

async function executeConversationToolCall({
  actor,
  ctx,
  toolName,
  rawArguments,
  handler,
}: {
  actor: AppActor;
  ctx: ConversationContext;
  toolName: string;
  rawArguments?: string;
  handler: (actor: AppActor, ctx: ConversationContext, args: any) => Promise<unknown>;
}) {
  const args = rawArguments ? JSON.parse(rawArguments) : {};
  if (isCrmWriteTool(toolName)) {
    const normalizedArgs = normalizeCrmWriteToolArgs(toolName, ctx, args);
    const operation = await createPendingCrmOperation({
      ctx,
      toolName,
      args: normalizedArgs,
    });
    return {
      result: crmPendingToolResult(operation),
      pendingOperation: operation,
      mapGraphChanged: false,
    };
  }

  const result = await handler(actor, ctx, args);
  return {
    result,
    pendingOperation: null,
    mapGraphChanged: isContextMapMutationTool(toolName),
  };
}

export async function processConversationTurn(ctx: ConversationContext): Promise<{
  assistantMessage: string;
  contextUsed: ConversationContextUsed;
}> {
  await assertWorkspaceModelBudget(ctx.workspaceId);

  const effectiveHistoryTurns = ctx.userMessage.length > 10_000 ? 5 : MAX_HISTORY_TURNS;

  const priorTurnsDesc = await prisma.conversationTurn.findMany({
    where: { conversationId: ctx.sessionId },
    orderBy: { sequenceNumber: "desc" },
    take: effectiveHistoryTurns,
    select: {
      sequenceNumber: true,
      userMessage: true,
      assistantMessage: true,
    },
  });
  const priorTurns = [...priorTurnsDesc].reverse();
  const turnCount = priorTurns.at(-1)?.sequenceNumber ?? 0;
  const pendingOperationResponse = await handleCrmPendingOperationIntent(ctx);
  if (pendingOperationResponse) {
    return {
      assistantMessage: pendingOperationResponse,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

  let knowledgeResults: unknown[] = [];
  let knowledgeSearch: ConversationContextUsed["knowledgeSearch"] | undefined;
  const effectiveKnowledgeLimit = ctx.userMessage.length > 10_000 ? 2 : KNOWLEDGE_SEARCH_LIMIT;
  const loadedKnowledge = await loadKnowledgeForConversation({
    ctx,
    priorTurns,
    limit: effectiveKnowledgeLimit,
  });
  knowledgeResults = loadedKnowledge.results;
  knowledgeSearch = loadedKnowledge.search;

  // Load agent memories for context
  let memories: unknown[] = [];
  try {
    memories = await loadRelevantMemories({
      workspaceId: ctx.workspaceId,
      agentKey: ctx.agentKey,
      limit: 5,
    });
  } catch {
    // Memories are best-effort
  }

  // Load user's personal profile for personalization
  let userProfile: string | null = null;
  try {
    const profileArticle = await prisma.brainArticle.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: ctx.workspaceId,
          slug: `person-${ctx.userId}`,
        },
      },
      select: { bodyMd: true },
    });
    if (profileArticle) {
      userProfile = profileArticle.bodyMd;
    }
  } catch {
    // Profile loading is best-effort
  }

  // Build messages array
  const systemContent = ctx.systemPrompt || SYSTEM_PROMPTS[ctx.agentKey] || SYSTEM_PROMPTS.assistant;
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
  ];

  // Add user profile context if available
  if (userProfile) {
    messages.push({
      role: "system",
      content: `USER PROFILE (adapt your tone, style, and approach based on this):\n${userProfile}`,
    });
  }

  // Add knowledge context if available
  if (knowledgeResults.length > 0) {
    messages.push({
      role: "system",
      content: `Relevant workspace knowledge:\n${JSON.stringify(knowledgeResults, null, 2)}`,
    });
  }
  const knowledgeInstruction = knowledgeSearchInstruction(knowledgeSearch);
  if (knowledgeInstruction) {
    messages.push({
      role: "system",
      content: knowledgeInstruction,
    });
  }

  // Add memory context if available
  if (memories.length > 0) {
    const memoryTexts = (memories as Array<{ content: string; memoryType: string }>).map(
      (m) => `[${m.memoryType}] ${m.content}`
    );
    messages.push({
      role: "system",
      content: `Agent memories:\n${memoryTexts.join("\n")}`,
    });
  }

  if (ctx.pageContext) {
    messages.push({
      role: "system",
      content: formatConversationPageContextForModel(ctx.pageContext),
    });
  }

  let roleOnboardingContext: string | null = null;
  if (ctx.agentKey === "role-onboarding") {
    roleOnboardingContext = await buildRoleOnboardingContextForConversation({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.sessionId,
      userId: ctx.userId,
    });
    if (roleOnboardingContext) {
      messages.push({
        role: "system",
        content: roleOnboardingContext,
      });
    }
  }

  // Add conversation history
  for (const turn of priorTurns) {
    messages.push({ role: "user", content: turn.userMessage });
    messages.push({ role: "assistant", content: turn.assistantMessage });
  }

  // Add current user message
  messages.push({ role: "user", content: ctx.userMessage });
  const tools = await toolsForContext(ctx);

  const response = await defaultModelGateway.chat({
    workspaceId: ctx.workspaceId,
    ...catalogUsageContext(ctx),
    model: env.MODEL_CHAT_CONVERSATION,
    taskType: "AGENT",
    messages,
    tools,
  });

  let finalMessage = response.content;
  let mapGraphChanged = false;
  const pendingCrmOperations: Array<import("./pending-crm-operations").PendingOperationRecord> = [];

  // Execute tools if the LLM requests it
  if (response.tool_calls && response.tool_calls.length > 0) {
    messages.push({ role: "assistant", content: response.content || "", tool_calls: response.tool_calls });
    const actor = requireConversationToolActor(ctx);

    for (const call of response.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      if (handler) {
        try {
          const outcome = await executeConversationToolCall({
            actor,
            ctx,
            toolName: call.function.name,
            rawArguments: call.function.arguments,
            handler,
          });
          if (outcome.mapGraphChanged) {
            mapGraphChanged = true;
          }
          if (outcome.pendingOperation) {
            pendingCrmOperations.push(outcome.pendingOperation);
          }
          messages.push({ role: "tool", content: JSON.stringify(outcome.result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          messages.push({ role: "tool", content: JSON.stringify({ error: err.message }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    await assertWorkspaceModelBudget(ctx.workspaceId);
    const followup = await defaultModelGateway.chat({
      workspaceId: ctx.workspaceId,
      ...catalogUsageContext(ctx),
      model: env.MODEL_CHAT_CONVERSATION,
      taskType: "AGENT",
      messages,
      tools,
    });
    
    finalMessage = followup.content;
    finalMessage = appendCrmPendingNotices(finalMessage, pendingCrmOperations);
  }

  // Store observation as memory if the conversation reveals something useful
  if (turnCount > 0 && turnCount % 5 === 0) {
    try {
      await storeAgentMemory({
        workspaceId: ctx.workspaceId,
        agentKey: ctx.agentKey,
        memoryType: "conversation_observation",
        content: `User discussed: ${ctx.userMessage.slice(0, 200)}. Key topics from conversation with ${turnCount} turns.`,
        metadata: {
          sessionId: ctx.sessionId,
          turnCount,
        },
      });
    } catch {
      // Memory storage is best-effort
    }
  }

  return {
    assistantMessage: finalMessage,
    contextUsed: {
      knowledgeResults: knowledgeResults.length > 0 ? knowledgeResults : undefined,
      knowledgeSearch,
      memories: memories.length > 0 ? memories : undefined,
      pageContext: ctx.pageContext ?? undefined,
      mapGraphChanged: mapGraphChanged || undefined,
      roleOnboardingContext: roleOnboardingContext ?? undefined,
    },
  };
}

export async function* processConversationTurnStream(ctx: ConversationContext): AsyncGenerator<string, {
  assistantMessage: string;
  contextUsed: ConversationContextUsed;
}> {
  await assertWorkspaceModelBudget(ctx.workspaceId);

  const effectiveHistoryTurns = ctx.userMessage.length > 10_000 ? 5 : MAX_HISTORY_TURNS;

  const priorTurnsDesc = await prisma.conversationTurn.findMany({
    where: { conversationId: ctx.sessionId },
    orderBy: { sequenceNumber: "desc" },
    take: effectiveHistoryTurns,
    select: {
      sequenceNumber: true,
      userMessage: true,
      assistantMessage: true,
    },
  });
  const priorTurns = [...priorTurnsDesc].reverse();
  const turnCount = priorTurns.at(-1)?.sequenceNumber ?? 0;
  const pendingOperationResponse = await handleCrmPendingOperationIntent(ctx);
  if (pendingOperationResponse) {
    yield pendingOperationResponse;
    return {
      assistantMessage: pendingOperationResponse,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

  let knowledgeResults: unknown[] = [];
  let knowledgeSearch: ConversationContextUsed["knowledgeSearch"] | undefined;
  const effectiveKnowledgeLimit = ctx.userMessage.length > 10_000 ? 2 : KNOWLEDGE_SEARCH_LIMIT;
  const loadedKnowledge = await loadKnowledgeForConversation({
    ctx,
    priorTurns,
    limit: effectiveKnowledgeLimit,
  });
  knowledgeResults = loadedKnowledge.results;
  knowledgeSearch = loadedKnowledge.search;

  let memories: unknown[] = [];
  try {
    memories = await loadRelevantMemories({
      workspaceId: ctx.workspaceId,
      agentKey: ctx.agentKey,
      limit: 5,
    });
  } catch {
  }

  const systemContent = ctx.systemPrompt || SYSTEM_PROMPTS[ctx.agentKey] || SYSTEM_PROMPTS.assistant;
  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
  ];

  if (knowledgeResults.length > 0) {
    messages.push({
      role: "system",
      content: `Relevant workspace knowledge:\n${JSON.stringify(knowledgeResults, null, 2)}`,
    });
  }
  const knowledgeInstruction = knowledgeSearchInstruction(knowledgeSearch);
  if (knowledgeInstruction) {
    messages.push({
      role: "system",
      content: knowledgeInstruction,
    });
  }

  if (memories.length > 0) {
    const memoryTexts = (memories as Array<{ content: string; memoryType: string }>).map(
      (m) => `[${m.memoryType}] ${m.content}`
    );
    messages.push({
      role: "system",
      content: `Agent memories:\n${memoryTexts.join("\n")}`,
    });
  }

  if (ctx.pageContext) {
    messages.push({
      role: "system",
      content: formatConversationPageContextForModel(ctx.pageContext),
    });
  }

  let roleOnboardingContext: string | null = null;
  if (ctx.agentKey === "role-onboarding") {
    roleOnboardingContext = await buildRoleOnboardingContextForConversation({
      workspaceId: ctx.workspaceId,
      conversationId: ctx.sessionId,
      userId: ctx.userId,
    });
    if (roleOnboardingContext) {
      messages.push({
        role: "system",
        content: roleOnboardingContext,
      });
    }
  }

  for (const turn of priorTurns) {
    messages.push({ role: "user", content: turn.userMessage });
    messages.push({ role: "assistant", content: turn.assistantMessage });
  }

  messages.push({ role: "user", content: ctx.userMessage });
  const tools = await toolsForContext(ctx);

  let finalMessage = "";
  let mapGraphChanged = false;
  const pendingCrmOperations: Array<import("./pending-crm-operations").PendingOperationRecord> = [];

  const iterator = defaultModelGateway.chatStream({
    workspaceId: ctx.workspaceId,
    ...catalogUsageContext(ctx),
    model: env.MODEL_CHAT_CONVERSATION,
    taskType: "AGENT",
    messages,
    tools,
  })[Symbol.asyncIterator]();

  let firstResult: import("@corgtex/models").ChatCompletionResponse;
  while (true) {
    const { done, value } = await iterator.next();
    if (done) {
      firstResult = value;
      break;
    }
    yield value;
    finalMessage += value;
  }

  if (firstResult.tool_calls && firstResult.tool_calls.length > 0) {
    messages.push({ role: "assistant", content: firstResult.content || "", tool_calls: firstResult.tool_calls });
    const actor = requireConversationToolActor(ctx);

    for (const call of firstResult.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      if (handler) {
        try {
          const outcome = await executeConversationToolCall({
            actor,
            ctx,
            toolName: call.function.name,
            rawArguments: call.function.arguments,
            handler,
          });
          if (outcome.mapGraphChanged) {
            mapGraphChanged = true;
          }
          if (outcome.pendingOperation) {
            pendingCrmOperations.push(outcome.pendingOperation);
          }
          messages.push({ role: "tool", content: JSON.stringify(outcome.result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          messages.push({ role: "tool", content: JSON.stringify({ error: err.message }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    await assertWorkspaceModelBudget(ctx.workspaceId);
    const followupIterator = defaultModelGateway.chatStream({
      workspaceId: ctx.workspaceId,
      ...catalogUsageContext(ctx),
      model: env.MODEL_CHAT_CONVERSATION,
      taskType: "AGENT",
      messages,
      tools,
    })[Symbol.asyncIterator]();

    while (true) {
      const { done, value } = await followupIterator.next();
      if (done) {
        break;
      }
      yield value;
      finalMessage += value;
    }
    const finalMessageWithNotices = appendCrmPendingNotices(finalMessage, pendingCrmOperations);
    const noticeAppendix = finalMessageWithNotices.slice(finalMessage.length);
    if (noticeAppendix) {
      yield noticeAppendix;
      finalMessage = finalMessageWithNotices;
    }
  }

  if (turnCount > 0 && turnCount % 5 === 0) {
    try {
      await storeAgentMemory({
        workspaceId: ctx.workspaceId,
        agentKey: ctx.agentKey,
        memoryType: "conversation_observation",
        content: `User discussed: ${ctx.userMessage.slice(0, 200)}. Key topics from conversation with ${turnCount} turns.`,
        metadata: {
          sessionId: ctx.sessionId,
          turnCount,
        },
      });
    } catch {
    }
  }

  return {
    assistantMessage: finalMessage,
    contextUsed: {
      knowledgeResults: knowledgeResults.length > 0 ? knowledgeResults : undefined,
      knowledgeSearch,
      memories: memories.length > 0 ? memories : undefined,
      pageContext: ctx.pageContext ?? undefined,
      mapGraphChanged: mapGraphChanged || undefined,
      roleOnboardingContext: roleOnboardingContext ?? undefined,
    },
  };
}
