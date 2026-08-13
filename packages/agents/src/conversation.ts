import { prisma } from "@corgtex/shared";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { defaultModelGateway } from "@corgtex/models";
import { AppError, buildRoleOnboardingContextForConversation, checkBudget, loadRelevantMemories, storeAgentMemory } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import type { ChatMessage } from "@corgtex/models";
import { checkCalendarAvailabilityTool, scheduleMeetingTool, checkCalendarAvailability, scheduleMeeting } from "./tools/calendar";
import { createCorgtexScheduledMeetingTool, uploadMeetingTranscriptTool, createCorgtexScheduledMeeting, uploadMeetingTranscriptFromTool } from "./tools/meetings";
import { getWorkspaceOverviewTool, queryTensionsTool, queryActionsTool, queryProposalsTool, queryGoalsTool, queryOrgStructureTool, getWorkspaceOverview, queryTensions, queryActions, queryProposals, queryGoals, queryOrgStructure } from "./tools/workspace";
import {
  INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
  resolveInteractiveKnowledgeAccessDomains,
  searchBrainTool,
  searchBrain,
} from "./tools/knowledge";
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
  validateCrmWriteToolArgs,
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
  signal?: AbortSignal;
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

function isVersionedUpdateTool(toolName: string) {
  return toolName === "update_tension" || toolName === "update_action";
}

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

type ExecutedConversationToolResult = {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
};

type FailedConversationToolResult = {
  toolName: string;
  args: Record<string, unknown>;
  error: string;
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
    : INTERACTIVE_KNOWLEDGE_SOURCE_TYPES;

  try {
    const accessDomains = await resolveInteractiveKnowledgeAccessDomains(
      params.ctx.actor,
      params.ctx.workspaceId,
    );
    const results = await searchIndexedKnowledge({
      workspaceId: params.ctx.workspaceId,
      query,
      limit: params.limit,
      sourceTypes,
      accessDomains,
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
  const sourceLabel = search.sourceTypes?.includes("SLACK") ? "indexed public Slack knowledge" : "accessible indexed Brain knowledge";
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
  search_brain: async (actor, ctx, args) => searchBrain(actor, ctx.workspaceId, args.query, args.limit),
  get_workspace_overview: async (actor, ctx) => getWorkspaceOverview(ctx.workspaceId),
  query_tensions: async (actor, ctx, args) => queryTensions(ctx.workspaceId, args.status, args.assigneeId, args.tensionId, actor),
  query_actions: async (actor, ctx, args) => queryActions(ctx.workspaceId, args.status, args.assigneeId, args.actionId, actor),
  query_proposals: async (actor, ctx, args) => queryProposals(ctx.workspaceId, args.status),
  query_goals: async (actor, ctx, args) => queryGoals(actor, ctx.workspaceId, args.cadence, args.level, args.status),
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

function pendingNoticeAppendix(originalMessage: string, messageWithNotices: string) {
  if (messageWithNotices === originalMessage) return "";
  const trimmedOriginal = originalMessage.trim();
  if (trimmedOriginal && messageWithNotices.startsWith(trimmedOriginal)) {
    const appendix = messageWithNotices.slice(trimmedOriginal.length);
    const streamedTrailingNewlines = originalMessage.match(/\n+$/)?.[0].length ?? 0;
    if (streamedTrailingNewlines > 0 && appendix.startsWith("\n\n")) {
      return appendix.slice(Math.min(streamedTrailingNewlines, 2));
    }
    return appendix;
  }
  return messageWithNotices;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rawStringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownText(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+.!<>|])/g, "\\$1");
}

function emptyAssistantFallback() {
  return "The assistant did not return a natural-language response. Please retry or ask for a more specific summary.";
}

function publicToolFailureMessage() {
  return "The CRM request could not be completed. Please retry or contact support if it keeps failing.";
}

function parseToolArgs(rawArguments?: string) {
  if (!rawArguments) return {};
  try {
    const parsed = JSON.parse(rawArguments);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function effectiveToolArgs(toolName: string, ctx: ConversationContext, rawArguments?: string) {
  const args = parseToolArgs(rawArguments);
  if (
    toolName === "list_due_relationship_work"
    && args.accountId == null
    && ctx.pageContext?.surface === "crm"
    && ctx.pageContext.selectedIds.accountId
  ) {
    return { ...args, accountId: ctx.pageContext.selectedIds.accountId };
  }
  return args;
}

function crmAccountLabel(pageContext: ConversationContext["pageContext"], accountId: string) {
  if (!pageContext || pageContext.surface !== "crm") return escapeMarkdownText(accountId);
  const account = pageContext.visibleContext.accounts.find((candidate) => candidate.id === accountId);
  const accountName = stringValue(account?.name);
  return accountName
    ? `${escapeMarkdownText(accountName)} (${escapeMarkdownText(accountId)})`
    : escapeMarkdownText(accountId);
}

function crmVisibleAccountFallback(pageContext: ConversationContext["pageContext"]) {
  if (!pageContext || pageContext.surface !== "crm") return null;
  const selectedAccountId = pageContext.selectedIds.accountId;
  if (!selectedAccountId) return null;

  const accountLabel = crmAccountLabel(pageContext, selectedAccountId);
  const section = pageContext.section ? ` in the ${escapeMarkdownText(pageContext.section)} section` : "";
  return `You are viewing the CRM account ${accountLabel}${section}.`;
}

function isCrmCurrentAccountQuestion(message: string) {
  const standalone = message
    .replace(/^\s*use\s+the\s+current\s+crm\s+page\s+context[.:]?\s*/i, "")
    .replace(/\s*include\s+(?:this\s+exact\s+)?(?:crm\s+)?account\s+id(?:\s+if\s+available)?(?:\s*:\s*[A-Za-z0-9-]+)?\.?\s*$/i, "")
    .trim();
  return /^(?:what|which)\s+crm\s+account\s+(?:am\s+i\s+)?(?:viewing|looking\s+at|on)\??$/i.test(standalone)
    || /^(?:what|which)\s+(?:is\s+)?(?:the\s+)?(?:current|selected)\s+crm\s+account\??$/i.test(standalone);
}

function crmCurrentAccountAnswer(ctx: ConversationContext) {
  if (!ctx.pageContext || ctx.pageContext.surface !== "crm") return null;
  if (!isCrmCurrentAccountQuestion(ctx.userMessage)) return null;

  const visibleAccount = crmVisibleAccountFallback(ctx.pageContext);
  if (visibleAccount) return visibleAccount;

  return "I do not have a selected CRM account in the current CRM page context.";
}

function explicitCrmToolCommand(message: string) {
  if (/^\s*Use\s+list_due_relationship_work\s+for\s+selected\s+account\s+[A-Za-z0-9-]+\.\s+Reply\s+with\s+a\s+short\s+due-work\s+summary\.?\s*$/i.test(message)) {
    return "list_due_relationship_work";
  }
  if (/^\s*Prepare\s+a\s+pending\s+CRM\s+follow-up\s+by\s+calling\s+record_relationship_activity\s+now\./i.test(message)) {
    return "record_relationship_activity";
  }
  if (/^\s*Prepare\s+a\s+pending\s+completion\s+by\s+calling\s+complete_relationship_activity\s+now\b/i.test(message)) {
    return "complete_relationship_activity";
  }
  return null;
}

function labeledCrmCommandValue(message: string, label: string, nextLabels: string[] = []) {
  const nextPattern = nextLabels.length > 0
    ? `(?=\\.\\s*(?:${nextLabels.map(escapeRegExp).join("|")})\\s*:|\\.\\s*Return\\b|$)`
    : "(?=\\.\\s*Return\\b|$)";
  const pattern = new RegExp(`${escapeRegExp(label)}\\s*:\\s*([\\s\\S]*?)\\s*${nextPattern}`, "i");
  return stringValue(message.match(pattern)?.[1]);
}

function explicitCrmAccountId(message: string) {
  return rawStringValue(message.match(/\baccountId\s*:\s*([A-Za-z0-9-]+)/i)?.[1])
    ?? rawStringValue(message.match(/\bselected\s+account\s+([A-Za-z0-9-]+)/i)?.[1])
    ?? rawStringValue(message.match(/\baccount\s+([A-Za-z0-9-]+)/i)?.[1]);
}

function explicitCrmActivityId(message: string) {
  return rawStringValue(message.match(/\bactivityId\s*:\s*([A-Za-z0-9-]+)/i)?.[1])
    ?? rawStringValue(message.match(/\b(?:follow-up|followup|activity)\s+([A-Za-z0-9-]+)/i)?.[1]);
}

function explicitDueWorkArgs(ctx: ConversationContext) {
  const args = {
    accountId: explicitCrmAccountId(ctx.userMessage) ?? undefined,
    dueTo: labeledCrmCommandValue(ctx.userMessage, "dueTo") ?? undefined,
    take: 5,
  };
  return effectiveToolArgs("list_due_relationship_work", ctx, JSON.stringify(args));
}

function explicitRecordActivityArgs(ctx: ConversationContext) {
  return normalizeCrmWriteToolArgs("record_relationship_activity", ctx, {
    title: labeledCrmCommandValue(ctx.userMessage, "Title", ["Type", "accountId", "dueAt"]),
    type: labeledCrmCommandValue(ctx.userMessage, "Type", ["accountId", "dueAt"]),
    accountId: explicitCrmAccountId(ctx.userMessage) ?? undefined,
    dueAt: labeledCrmCommandValue(ctx.userMessage, "dueAt"),
  });
}

function explicitCompleteActivityArgs(ctx: ConversationContext) {
  return normalizeCrmWriteToolArgs("complete_relationship_activity", ctx, {
    activityId: explicitCrmActivityId(ctx.userMessage) ?? undefined,
    completedAt: labeledCrmCommandValue(ctx.userMessage, "completedAt"),
  });
}

async function handleExplicitCrmToolCommand(ctx: ConversationContext) {
  if (!ctx.pageContext || ctx.pageContext.surface !== "crm") return null;
  const toolName = explicitCrmToolCommand(ctx.userMessage);
  if (!toolName) return null;

  const actor = requireConversationToolActor(ctx);
  if (toolName === "list_due_relationship_work") {
    const args = explicitDueWorkArgs(ctx);
    const result = await listDueRelationshipWorkAction(actor, ctx, args);
    return crmDueWorkFallback(result, args, ctx.pageContext) ?? emptyAssistantFallback();
  }

  if (toolName === "record_relationship_activity") {
    const args = explicitRecordActivityArgs(ctx);
    validateCrmWriteToolArgs(toolName, args);
    const operation = await createPendingCrmOperation({ ctx, toolName, args });
    return crmPendingToolResult(operation).message;
  }

  if (toolName === "complete_relationship_activity") {
    const args = explicitCompleteActivityArgs(ctx);
    validateCrmWriteToolArgs(toolName, args);
    const operation = await createPendingCrmOperation({ ctx, toolName, args });
    return crmPendingToolResult(operation).message;
  }

  return null;
}

function dueToScope(value: unknown) {
  const dueTo = stringValue(value);
  if (!dueTo) return null;
  const parsed = new Date(dueTo);
  const label = Number.isNaN(parsed.getTime()) ? dueTo : parsed.toISOString();
  return `due by ${escapeMarkdownText(label)}`;
}

function joinScopeLabels(scopes: string[]) {
  if (scopes.length <= 2) return scopes.join(" and ");
  return `${scopes.slice(0, -1).join(", ")} and ${scopes[scopes.length - 1]}`;
}

function crmDueWorkScope(args: Record<string, unknown>, pageContext: ConversationContext["pageContext"]) {
  const scopes: string[] = [];
  const accountId = rawStringValue(args.accountId);
  if (accountId) scopes.push(`CRM account ${crmAccountLabel(pageContext, accountId)}`);

  const contactId = rawStringValue(args.contactId);
  if (contactId) scopes.push(`CRM contact ${escapeMarkdownText(contactId)}`);

  const dealId = rawStringValue(args.dealId);
  if (dealId) scopes.push(`CRM deal ${escapeMarkdownText(dealId)}`);

  const dueTo = dueToScope(args.dueTo);
  if (dueTo) scopes.push(dueTo);

  if (scopes.length > 0) return `for ${joinScopeLabels(scopes)}`;

  return "for the requested CRM scope";
}

function crmDueWorkFallback(
  toolResult: unknown,
  args: Record<string, unknown>,
  pageContext: ConversationContext["pageContext"],
) {
  if (!isRecord(toolResult)) return null;
  const total = typeof toolResult.total === "number" ? toolResult.total : null;
  const items = Array.isArray(toolResult.items) ? toolResult.items.filter(isRecord) : [];
  const scope = crmDueWorkScope(args, pageContext);
  const workKind = rawStringValue(args.dueTo) ? "open due CRM relationship work" : "open CRM relationship work";
  if (items.length === 0) {
    return total === 0
      ? `There is no ${workKind} ${scope}.`
      : `I could not find ${workKind} ${scope}.`;
  }

  const titles = items
    .map((item) => stringValue(item.title))
    .filter((title): title is string => Boolean(title))
    .map(escapeMarkdownText)
    .slice(0, 3);
  const totalText = total == null ? `${items.length}` : `${total}`;
  const titleText = titles.length > 0 ? `: ${titles.join("; ")}` : ".";
  return `There ${totalText === "1" ? "is" : "are"} ${totalText} ${workKind} ${totalText === "1" ? "item" : "items"} ${scope}${titleText}`;
}

function crmToolFallback(
  toolResults: ExecutedConversationToolResult[],
  pageContext: ConversationContext["pageContext"],
  toolFailures: FailedConversationToolResult[] = [],
) {
  const dueWorkResults = toolResults
    .filter((toolResult) => toolResult.toolName === "list_due_relationship_work")
    .map((toolResult) => crmDueWorkFallback(toolResult.result, toolResult.args, pageContext))
    .filter((fallback): fallback is string => Boolean(fallback));
  const dueWorkFailures = toolFailures
    .filter((toolFailure) => toolFailure.toolName === "list_due_relationship_work")
    .map((toolFailure) => {
      const scope = crmDueWorkScope(toolFailure.args, pageContext);
      return `I could not complete the CRM relationship-work request ${scope}. ${publicToolFailureMessage()}`;
    });
  const fallbacks = [...dueWorkResults, ...dueWorkFailures];
  return fallbacks.length > 0 ? fallbacks.join("\n") : null;
}

function ensureAssistantMessage(
  message: string,
  ctx: ConversationContext,
  toolResults: ExecutedConversationToolResult[],
  toolFailures: FailedConversationToolResult[] = [],
  toolExecutionAttempted = false,
) {
  if (message.trim()) return message;
  const toolFallback = crmToolFallback(toolResults, ctx.pageContext, toolFailures);
  if (toolFallback) return toolFallback;
  if (toolExecutionAttempted) return emptyAssistantFallback();
  return crmVisibleAccountFallback(ctx.pageContext) ?? emptyAssistantFallback();
}

function isBudgetExceededError(err: unknown) {
  return (err as { status?: number; code?: string } | null)?.status === 429
    && (err as { status?: number; code?: string } | null)?.code === "BUDGET_EXCEEDED";
}

async function canRunFollowupModelAfterTools(
  ctx: ConversationContext,
  pendingCrmOperations: Array<import("./pending-crm-operations").PendingOperationRecord>,
  allowBudgetFallback = false,
) {
  try {
    await assertWorkspaceModelBudget(ctx.workspaceId);
    return true;
  } catch (err) {
    if ((allowBudgetFallback || pendingCrmOperations.length > 0) && isBudgetExceededError(err)) {
      return false;
    }
    throw err;
  }
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
  if (isVersionedUpdateTool(toolName)) {
    throw new Error("Versioned updates require a preceding query result from this turn.");
  }
  if (isCrmWriteTool(toolName)) {
    const normalizedArgs = normalizeCrmWriteToolArgs(toolName, ctx, args);
    validateCrmWriteToolArgs(toolName, normalizedArgs);
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

async function executeVersionedFollowupTools(
  response: import("@corgtex/models").ChatCompletionResponse,
  actor: AppActor,
  ctx: ConversationContext,
  messages: ChatMessage[],
  executed: ExecutedConversationToolResult[],
  failed: FailedConversationToolResult[],
) {
  const calls = response.tool_calls ?? [];
  if (!calls.length) return "none" as const;
  if (!calls.some(({ function: tool }) => isVersionedUpdateTool(tool.name))) return "none" as const;
  const observed = new Map<string, number>();
  if (!executed.some(({ toolName }) => toolName === "update_action" || toolName === "update_tension")) {
    for (const read of executed) {
      const updateName = read.toolName === "query_actions" ? "update_action"
        : read.toolName === "query_tensions" ? "update_tension" : null;
      for (const item of Array.isArray(read.result) ? read.result : []) {
        if (updateName && typeof item?.id === "string" && Number.isInteger(item.version) && item.version > 0) {
          observed.set(`${updateName}:${item.id}`, item.version);
        }
      }
    }
  }
  const valid = calls.every(({ function: tool }) => {
    const args = parseToolArgs(tool.arguments);
    const id = tool.name === "update_action" ? args.actionId
      : tool.name === "update_tension" ? args.tensionId : null;
    return typeof id === "string" && observed.get(`${tool.name}:${id}`) === args.expectedVersion;
  });
  if (!valid || observed.size === 0) return "rejected" as const;
  messages.push({ role: "assistant", content: response.content || "", tool_calls: calls });
  for (const call of calls) {
    const toolName = call.function.name;
    const args = effectiveToolArgs(toolName, ctx, call.function.arguments);
    try {
      const result = await TOOL_HANDLERS[toolName]!(actor, ctx, args);
      executed.push({ toolName, args, result });
      messages.push({ role: "tool", content: JSON.stringify(result), name: toolName, tool_call_id: call.id });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ toolName, args, error });
      messages.push({ role: "tool", content: JSON.stringify({ error }), name: toolName, tool_call_id: call.id });
    }
  }
  return "executed" as const;
}

const UNSAFE_VERSIONED_FOLLOWUP = "I could not safely apply that update because the tool sequence did not use a matching observed version.";
const VERSIONED_UPDATE_SUMMARY_UNAVAILABLE = "The versioned update was processed, but I could not generate a final summary. Read the current item version before retrying.";
const VERSIONED_UPDATE_FAILED = "The versioned update could not be completed. Read the current item version before retrying.";

function versionedUpdateFailure(executed: ExecutedConversationToolResult[], failed: FailedConversationToolResult[]) {
  const instruction = executed.flatMap(({ toolName, result }) => (
    isVersionedUpdateTool(toolName) && isRecord(result) && typeof result.instruction === "string" ? [result.instruction] : []
  )).at(-1);
  return instruction ?? (failed.some(({ toolName }) => isVersionedUpdateTool(toolName)) ? VERSIONED_UPDATE_FAILED : null);
}

async function closeAsyncIterator<T, TReturn>(iterator: AsyncIterator<T, TReturn>) {
  if (typeof iterator.return !== "function") return;
  try {
    await iterator.return(undefined as TReturn);
  } catch {
  }
}

function throwIfConversationCanceled(ctx: ConversationContext, error?: unknown) {
  if (!ctx.signal?.aborted) return;
  const reason = ctx.signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  if (error instanceof Error) {
    throw error;
  }
  throw new Error("Conversation stream canceled.");
}

export async function processConversationTurn(ctx: ConversationContext): Promise<{
  assistantMessage: string;
  contextUsed: ConversationContextUsed;
}> {
  const pendingOperationResponse = await handleCrmPendingOperationIntent(ctx);
  if (pendingOperationResponse) {
    return {
      assistantMessage: pendingOperationResponse,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

  const directCrmAnswer = crmCurrentAccountAnswer(ctx);
  if (directCrmAnswer) {
    return {
      assistantMessage: directCrmAnswer,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

  const explicitCrmToolResponse = await handleExplicitCrmToolCommand(ctx);
  if (explicitCrmToolResponse) {
    return {
      assistantMessage: explicitCrmToolResponse,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

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
  const followupTools = await toolsForContext(ctx);
  const tools = followupTools.filter(({ function: tool }) => !isVersionedUpdateTool(tool.name));

  const response = await defaultModelGateway.chat({
    workspaceId: ctx.workspaceId,
    ...catalogUsageContext(ctx),
    model: env.MODEL_CHAT_CONVERSATION,
    taskType: "AGENT",
    messages,
    tools,
    signal: ctx.signal,
  });
  throwIfConversationCanceled(ctx);

  const initialMessage = response.content;
  let finalMessage = initialMessage;
  let mapGraphChanged = false;
  const pendingCrmOperations: Array<import("./pending-crm-operations").PendingOperationRecord> = [];
  const executedToolResults: ExecutedConversationToolResult[] = [];
  const failedToolResults: FailedConversationToolResult[] = [];
  const toolExecutionAttempted = Boolean(response.tool_calls?.length);

  // Execute tools if the LLM requests it
  if (response.tool_calls && response.tool_calls.length > 0) {
    messages.push({ role: "assistant", content: response.content || "", tool_calls: response.tool_calls });
    const actor = requireConversationToolActor(ctx);

    for (const call of response.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      const toolArgs = effectiveToolArgs(call.function.name, ctx, call.function.arguments);
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
          executedToolResults.push({ toolName: call.function.name, args: toolArgs, result: outcome.result });
          messages.push({ role: "tool", content: JSON.stringify(outcome.result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          const error = err instanceof Error ? err.message : String(err);
          failedToolResults.push({ toolName: call.function.name, args: toolArgs, error });
          messages.push({ role: "tool", content: JSON.stringify({ error }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        failedToolResults.push({ toolName: call.function.name, args: toolArgs, error: "Unknown capability" });
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    let followupMessage = "";
    if (await canRunFollowupModelAfterTools(ctx, pendingCrmOperations)) {
      const followup = await defaultModelGateway.chat({
        workspaceId: ctx.workspaceId,
        ...catalogUsageContext(ctx),
        model: env.MODEL_CHAT_CONVERSATION,
        taskType: "AGENT",
        messages,
        tools: followupTools,
        signal: ctx.signal,
      });
      throwIfConversationCanceled(ctx);

      followupMessage = followup.content;
      finalMessage = followupMessage;
      const followupState = await executeVersionedFollowupTools(followup, actor, ctx, messages, executedToolResults, failedToolResults);
      if (followupState === "rejected") {
        followupMessage = UNSAFE_VERSIONED_FOLLOWUP;
        finalMessage = followupMessage;
      } else if (followupState === "executed") {
        const updateFailure = versionedUpdateFailure(executedToolResults, failedToolResults);
        followupMessage = updateFailure ?? VERSIONED_UPDATE_SUMMARY_UNAVAILABLE;
        if (!updateFailure && await canRunFollowupModelAfterTools(ctx, pendingCrmOperations, true)) {
          try {
            const completed = await defaultModelGateway.chat({
              workspaceId: ctx.workspaceId, ...catalogUsageContext(ctx), model: env.MODEL_CHAT_CONVERSATION,
              taskType: "AGENT", messages, signal: ctx.signal,
            });
            throwIfConversationCanceled(ctx);
            followupMessage = completed.content || followupMessage;
          } catch (error) {
            throwIfConversationCanceled(ctx, error);
          }
        }
        finalMessage = followupMessage;
      }
    }
    if (!followupMessage.trim()) {
      const toolFallback = crmToolFallback(executedToolResults, ctx.pageContext, failedToolResults)
        ?? (pendingCrmOperations.length === 0 && toolExecutionAttempted ? emptyAssistantFallback() : null);
      if (toolFallback) {
        finalMessage = [initialMessage.trim(), toolFallback].filter(Boolean).join("\n\n");
      }
    }
    finalMessage = appendCrmPendingNotices(finalMessage, pendingCrmOperations);
  }
  finalMessage = ensureAssistantMessage(finalMessage, ctx, executedToolResults, failedToolResults, toolExecutionAttempted);
  throwIfConversationCanceled(ctx);

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

  const directCrmAnswer = crmCurrentAccountAnswer(ctx);
  if (directCrmAnswer) {
    yield directCrmAnswer;
    return {
      assistantMessage: directCrmAnswer,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

  const explicitCrmToolResponse = await handleExplicitCrmToolCommand(ctx);
  if (explicitCrmToolResponse) {
    yield explicitCrmToolResponse;
    return {
      assistantMessage: explicitCrmToolResponse,
      contextUsed: {
        pageContext: ctx.pageContext ?? undefined,
      },
    };
  }

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
  const followupTools = await toolsForContext(ctx);
  const tools = followupTools.filter(({ function: tool }) => !isVersionedUpdateTool(tool.name));

  let finalMessage = "";
  let mapGraphChanged = false;
  const pendingCrmOperations: Array<import("./pending-crm-operations").PendingOperationRecord> = [];
  const executedToolResults: ExecutedConversationToolResult[] = [];
  const failedToolResults: FailedConversationToolResult[] = [];
  let toolExecutionAttempted = false;

  const iterator = defaultModelGateway.chatStream({
    workspaceId: ctx.workspaceId,
    ...catalogUsageContext(ctx),
    model: env.MODEL_CHAT_CONVERSATION,
    taskType: "AGENT",
    messages,
    tools,
    signal: ctx.signal,
  })[Symbol.asyncIterator]();

  let firstResult: import("@corgtex/models").ChatCompletionResponse | null = null;
  let firstStreamDone = false;
  try {
    while (true) {
      const { done, value } = await iterator.next();
      if (done) {
        firstStreamDone = true;
        firstResult = value;
        break;
      }
      yield value;
      finalMessage += value;
    }
  } catch (error) {
    firstResult = null;
    throwIfConversationCanceled(ctx, error);
  } finally {
    if (!firstStreamDone) {
      await closeAsyncIterator(iterator);
    }
  }

  throwIfConversationCanceled(ctx);

  if (firstResult?.tool_calls && firstResult.tool_calls.length > 0) {
    toolExecutionAttempted = true;
    messages.push({ role: "assistant", content: firstResult.content || "", tool_calls: firstResult.tool_calls });
    const actor = requireConversationToolActor(ctx);

    for (const call of firstResult.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      const toolArgs = effectiveToolArgs(call.function.name, ctx, call.function.arguments);
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
          executedToolResults.push({ toolName: call.function.name, args: toolArgs, result: outcome.result });
          messages.push({ role: "tool", content: JSON.stringify(outcome.result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          const error = err instanceof Error ? err.message : String(err);
          failedToolResults.push({ toolName: call.function.name, args: toolArgs, error });
          messages.push({ role: "tool", content: JSON.stringify({ error }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        failedToolResults.push({ toolName: call.function.name, args: toolArgs, error: "Unknown capability" });
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    let followupMessage = "";
    let followupStreamFailed = false;
    let followupResult: import("@corgtex/models").ChatCompletionResponse | null = null;
    if (await canRunFollowupModelAfterTools(ctx, pendingCrmOperations)) {
      const followupIterator = defaultModelGateway.chatStream({
        workspaceId: ctx.workspaceId,
        ...catalogUsageContext(ctx),
        model: env.MODEL_CHAT_CONVERSATION,
        taskType: "AGENT",
        messages,
        tools: followupTools,
        signal: ctx.signal,
      })[Symbol.asyncIterator]();

      let followupStreamDone = false;
      try {
        while (true) {
          const { done, value } = await followupIterator.next();
          if (done) {
            followupStreamDone = true;
            followupResult = value;
            break;
          }
          followupMessage += value;
        }
      } catch (error) {
        followupStreamFailed = true;
        throwIfConversationCanceled(ctx, error);
      } finally {
        if (!followupStreamDone) {
          await closeAsyncIterator(followupIterator);
        }
      }
    }
    const followupState = followupResult ? await executeVersionedFollowupTools(
      followupResult, actor, ctx, messages, executedToolResults, failedToolResults,
    ) : "none";
    if (followupState === "none" && !followupStreamFailed && followupMessage) {
      yield followupMessage;
      finalMessage += followupMessage;
    } else if (followupState === "rejected") {
      followupMessage = UNSAFE_VERSIONED_FOLLOWUP;
      yield followupMessage;
      finalMessage += followupMessage;
    } else if (followupState === "executed") {
      const updateFailure = versionedUpdateFailure(executedToolResults, failedToolResults);
      followupMessage = updateFailure ?? VERSIONED_UPDATE_SUMMARY_UNAVAILABLE;
      let postToolModelRan = false;
      if (!updateFailure && await canRunFollowupModelAfterTools(ctx, pendingCrmOperations, true)) {
        try {
          postToolModelRan = true;
          followupMessage = "";
          for await (const chunk of defaultModelGateway.chatStream({
            workspaceId: ctx.workspaceId, ...catalogUsageContext(ctx), model: env.MODEL_CHAT_CONVERSATION,
            taskType: "AGENT", messages, signal: ctx.signal,
          })) {
            yield chunk;
            finalMessage += chunk;
            followupMessage += chunk;
          }
        } catch (error) {
          throwIfConversationCanceled(ctx, error);
        }
      }
      if (!postToolModelRan || !followupMessage) {
        followupMessage = updateFailure ?? VERSIONED_UPDATE_SUMMARY_UNAVAILABLE;
        yield followupMessage;
        finalMessage += followupMessage;
      }
      throwIfConversationCanceled(ctx);
    }
    if (!followupMessage.trim() || followupStreamFailed) {
      const toolFallback = crmToolFallback(executedToolResults, ctx.pageContext, failedToolResults)
        ?? (pendingCrmOperations.length === 0 && toolExecutionAttempted ? emptyAssistantFallback() : null);
      if (toolFallback) {
        const nextMessage = [finalMessage.trim(), toolFallback].filter(Boolean).join("\n\n");
        const toolFallbackAppendix = pendingNoticeAppendix(finalMessage, nextMessage);
        if (toolFallbackAppendix) {
          yield toolFallbackAppendix;
          finalMessage = nextMessage;
        }
      }
    }
    const finalMessageWithNotices = appendCrmPendingNotices(finalMessage, pendingCrmOperations);
    const noticeAppendix = pendingNoticeAppendix(finalMessage, finalMessageWithNotices);
    if (noticeAppendix) {
      yield noticeAppendix;
      finalMessage = finalMessageWithNotices;
    }
  }

  const ensuredFinalMessage = ensureAssistantMessage(finalMessage, ctx, executedToolResults, failedToolResults, toolExecutionAttempted);
  throwIfConversationCanceled(ctx);
  const fallbackAppendix = pendingNoticeAppendix(finalMessage, ensuredFinalMessage);
  if (fallbackAppendix) {
    yield fallbackAppendix;
    finalMessage = ensuredFinalMessage;
  }

  throwIfConversationCanceled(ctx);
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
