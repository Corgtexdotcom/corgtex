import { prisma } from "@corgtex/shared";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { defaultModelGateway } from "@corgtex/models";
import { loadRelevantMemories, storeAgentMemory } from "@corgtex/domain";
import type { ChatMessage } from "@corgtex/models";
import { checkCalendarAvailabilityTool, scheduleMeetingTool, checkCalendarAvailability, scheduleMeeting } from "./tools/calendar";
import { getWorkspaceOverviewTool, queryTensionsTool, queryActionsTool, queryProposalsTool, queryOrgStructureTool, getWorkspaceOverview, queryTensions, queryActions, queryProposals, queryOrgStructure } from "./tools/workspace";
import { searchBrainTool, searchBrain } from "./tools/knowledge";
import { createTensionTool, updateTensionTool, createActionTool, updateActionTool, createProposalTool, createTensionAction, updateTensionAction, createActionItemAction, updateActionItemAction, createProposalAction } from "./tools/mutations";
import { saveToBrainTool, saveToBrainAction } from "./tools/brain-save";
import type { AppActor } from "@corgtex/shared";

const MAX_HISTORY_TURNS = 20;
const KNOWLEDGE_SEARCH_LIMIT = 4;

const SYSTEM_PROMPTS: Record<string, string> = {
  assistant: `You are Corgtex, an AI governance assistant for a self-managing organization. You help team members:
- Draft proposals and tensions
- Answer questions about workspace knowledge (policies, meetings, documents)
- Brainstorm ideas and provide organizational guidance
- Summarize meeting notes and extract action items
- Find time and schedule meetings among team members
- Create and update tensions, actions, and proposals directly

You have full read AND write access to the workspace through your tools:
READ TOOLS:
- 'get_workspace_overview' — high-level summary of org state
- 'query_tensions', 'query_actions', 'query_proposals' — exact, filtered lists
- 'query_org_structure' — circles, roles, and members
- 'search_brain' — semantic search across all indexed knowledge

WRITE TOOLS:
- 'create_tension', 'create_action' — create new items
- 'update_tension', 'update_action' — update status, assignments, content
- 'create_proposal' — draft and create a new governance proposal

When asked about current state, ALWAYS use a query tool instead of guessing.
When asked to create or update something, execute the write tool immediately — do not ask for confirmation. Report what you did clearly after executing.
Every write action is fully audited and traceable.

Be concise, direct, and action-oriented. When relevant, cite workspace knowledge.
If the user wants to create something (proposal, tension, action), help them draft it and suggest they use the appropriate workspace tool to submit it.
If the user asks to upload or ingest a file (e.g. meeting minutes, feedback), instruct them to use the attachment icon (+) in the chat input. When a user message contains '[Attached file: ...]', acknowledge that it has been queued for Brain absorption and answer based on the provided text if available.
If the user explicitly asks you to save, upload, store, or remember content (e.g., "save this transcript", "upload this to the brain", "remember this for later"), invoke 'save_to_brain' immediately with the relevant content. You do NOT need to save regular conversation — that happens automatically in the nightly batch. Only use this tool when the user explicitly requests immediate storage.
If the user wants to schedule a meeting or find availability, ALWAYS invoke the 'check_calendar_availability' tool first using full ISO 8601 UTC dates (e.g., 2026-04-10T09:00:00Z) based on their local time/date request. If availability allows, automatically invoke 'schedule_meeting' to book it natively!`,

  "proposal-drafting": `You are a proposal drafting assistant for a self-managing organization. Help the user:
- Clarify their governance need or operational change
- Research relevant workspace knowledge for context
- Structure a clear proposal with title, summary, and detailed body
- Consider potential objections and address them proactively

When you have enough information, format the proposal clearly with markdown.`,

  "knowledge-qa": `You are a workspace knowledge assistant. Answer questions using the organization's indexed knowledge base (policies, meeting notes, documents, proposals). Always cite your sources when possible. If you don't have enough information, say so clearly.`,
};

type ConversationContext = {
  workspaceId: string;
  sessionId: string;
  userId: string;
  agentKey: string;
  userMessage: string;
  systemPrompt?: string | null;
};

const TOOLS = [
  checkCalendarAvailabilityTool,
  scheduleMeetingTool,
  searchBrainTool,
  getWorkspaceOverviewTool,
  queryTensionsTool,
  queryActionsTool,
  queryProposalsTool,
  queryOrgStructureTool,
  createTensionTool,
  updateTensionTool,
  createActionTool,
  updateActionTool,
  createProposalTool,
  saveToBrainTool,
];

const TOOL_HANDLERS: Record<string, (actor: AppActor, ctx: ConversationContext, args: any) => Promise<unknown>> = {
  check_calendar_availability: async (actor, ctx, args) => checkCalendarAvailability(ctx.userId, ctx.workspaceId, args.emails, args.timeMin, args.timeMax),
  schedule_meeting: async (actor, ctx, args) => scheduleMeeting(ctx.userId, ctx.workspaceId, args.title, args.description, args.startTime, args.endTime, args.attendeeEmails),
  search_brain: async (actor, ctx, args) => searchBrain(ctx.workspaceId, args.query, args.limit),
  get_workspace_overview: async (actor, ctx) => getWorkspaceOverview(ctx.workspaceId),
  query_tensions: async (actor, ctx, args) => queryTensions(ctx.workspaceId, args.status, args.assigneeId),
  query_actions: async (actor, ctx, args) => queryActions(ctx.workspaceId, args.status, args.assigneeId),
  query_proposals: async (actor, ctx, args) => queryProposals(ctx.workspaceId, args.status),
  query_org_structure: async (actor, ctx) => queryOrgStructure(ctx.workspaceId),
  create_tension: createTensionAction,
  update_tension: updateTensionAction,
  create_action: createActionItemAction,
  update_action: updateActionItemAction,
  create_proposal: createProposalAction,
  save_to_brain: async (actor, ctx, args) => saveToBrainAction(actor, ctx, args),
};


export async function processConversationTurn(ctx: ConversationContext): Promise<{
  assistantMessage: string;
  contextUsed: {
    knowledgeResults?: unknown[];
    memories?: unknown[];
  };
}> {
  const priorTurnsDesc = await prisma.conversationTurn.findMany({
    where: { conversationId: ctx.sessionId },
    orderBy: { sequenceNumber: "desc" },
    take: MAX_HISTORY_TURNS,
    select: {
      sequenceNumber: true,
      userMessage: true,
      assistantMessage: true,
    },
  });
  const priorTurns = [...priorTurnsDesc].reverse();
  const turnCount = priorTurns.at(-1)?.sequenceNumber ?? 0;

  // Search knowledge if the message looks like a question or references workspace concepts
  let knowledgeResults: unknown[] = [];
  if (ctx.userMessage.length > 10) {
    try {
      const results = await searchIndexedKnowledge({
        workspaceId: ctx.workspaceId,
        query: ctx.userMessage,
        limit: KNOWLEDGE_SEARCH_LIMIT,
      });
      knowledgeResults = Array.isArray(results) ? results : [];
    } catch {
      // Knowledge search is best-effort
    }
  }

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

  // Add conversation history
  for (const turn of priorTurns) {
    messages.push({ role: "user", content: turn.userMessage });
    messages.push({ role: "assistant", content: turn.assistantMessage });
  }

  // Add current user message
  messages.push({ role: "user", content: ctx.userMessage });

  const response = await defaultModelGateway.chat({
    workspaceId: ctx.workspaceId,
    taskType: "AGENT",
    messages,
    tools: TOOLS,
  });

  let finalMessage = response.content;

  // Execute tools if the LLM requests it
  if (response.tool_calls && response.tool_calls.length > 0) {
    messages.push({ role: "assistant", content: response.content || "", tool_calls: response.tool_calls });
    
    const actor: AppActor = {
      kind: "agent",
      authProvider: "bootstrap",
      label: "chat-agent",
      workspaceIds: [ctx.workspaceId],
    };

    for (const call of response.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      if (handler) {
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await handler(actor, ctx, args);
          messages.push({ role: "tool", content: JSON.stringify(result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          messages.push({ role: "tool", content: JSON.stringify({ error: err.message }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    const followup = await defaultModelGateway.chat({
      workspaceId: ctx.workspaceId,
      taskType: "AGENT",
      messages,
      tools: TOOLS,
    });
    
    finalMessage = followup.content;
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
      memories: memories.length > 0 ? memories : undefined,
    },
  };
}

export async function* processConversationTurnStream(ctx: ConversationContext): AsyncGenerator<string, {
  assistantMessage: string;
  contextUsed: {
    knowledgeResults?: unknown[];
    memories?: unknown[];
  };
}> {
  const priorTurnsDesc = await prisma.conversationTurn.findMany({
    where: { conversationId: ctx.sessionId },
    orderBy: { sequenceNumber: "desc" },
    take: MAX_HISTORY_TURNS,
    select: {
      sequenceNumber: true,
      userMessage: true,
      assistantMessage: true,
    },
  });
  const priorTurns = [...priorTurnsDesc].reverse();
  const turnCount = priorTurns.at(-1)?.sequenceNumber ?? 0;

  let knowledgeResults: unknown[] = [];
  if (ctx.userMessage.length > 10) {
    try {
      const results = await searchIndexedKnowledge({
        workspaceId: ctx.workspaceId,
        query: ctx.userMessage,
        limit: KNOWLEDGE_SEARCH_LIMIT,
      });
      knowledgeResults = Array.isArray(results) ? results : [];
    } catch {
    }
  }

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

  if (memories.length > 0) {
    const memoryTexts = (memories as Array<{ content: string; memoryType: string }>).map(
      (m) => `[${m.memoryType}] ${m.content}`
    );
    messages.push({
      role: "system",
      content: `Agent memories:\n${memoryTexts.join("\n")}`,
    });
  }

  for (const turn of priorTurns) {
    messages.push({ role: "user", content: turn.userMessage });
    messages.push({ role: "assistant", content: turn.assistantMessage });
  }

  messages.push({ role: "user", content: ctx.userMessage });

  let finalMessage = "";

  const iterator = defaultModelGateway.chatStream({
    workspaceId: ctx.workspaceId,
    taskType: "AGENT",
    messages,
    tools: TOOLS,
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
    
    const actor: AppActor = {
      kind: "agent",
      authProvider: "bootstrap",
      label: "chat-agent",
      workspaceIds: [ctx.workspaceId],
    };

    for (const call of firstResult.tool_calls) {
      const handler = TOOL_HANDLERS[call.function.name];
      if (handler) {
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await handler(actor, ctx, args);
          messages.push({ role: "tool", content: JSON.stringify(result), name: call.function.name, tool_call_id: call.id });
        } catch (err: any) {
          messages.push({ role: "tool", content: JSON.stringify({ error: err.message }), name: call.function.name, tool_call_id: call.id });
        }
      } else {
        messages.push({ role: "tool", content: JSON.stringify({ error: "Unknown capability" }), name: call.function.name, tool_call_id: call.id });
      }
    }

    const followupIterator = defaultModelGateway.chatStream({
      workspaceId: ctx.workspaceId,
      taskType: "AGENT",
      messages,
      tools: TOOLS,
    })[Symbol.asyncIterator]();

    while (true) {
      const { done, value } = await followupIterator.next();
      if (done) {
        break;
      }
      yield value;
      finalMessage += value;
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
      memories: memories.length > 0 ? memories : undefined,
    },
  };
}
