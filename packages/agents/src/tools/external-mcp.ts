import type { ModelTool } from "@corgtex/models";
import type { AppActor } from "@corgtex/shared";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import {
  executeExternalMcpTool,
  fetchConnectedExternalMcpContext,
  listExternalMcpConnections,
  searchConnectedExternalMcpContext,
} from "@corgtex/domain";
import {
  INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
  resolveInteractiveKnowledgeAccessDomains,
} from "./knowledge";

type ToolContext = {
  workspaceId: string;
};

function parseArgumentsJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export const listConnectedToolsTool: ModelTool = {
  type: "function",
  function: {
    name: "list_connected_tools",
    description: "List same-user delegated external MCP tools connected to this workspace, such as Box or Notion. Does not reveal OAuth tokens.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

export const searchConnectedContextTool: ModelTool = {
  type: "function",
  function: {
    name: "search_connected_context",
    description: "Search live connected context across Corgtex Brain and same-user external MCP sources such as Box or Notion. Use this when the user asks for data that may live outside Corgtex.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        limit: { type: "number", description: "Max combined results to return (default: 5, max: 10)" },
        includeCorgtex: { type: "boolean", description: "Whether to include Corgtex Brain results (default true)" },
        providerKey: { type: "string", enum: ["box", "notion"], description: "Optional provider key to limit external search" },
      },
      required: ["query"],
    },
  },
};

export const fetchConnectedContextTool: ModelTool = {
  type: "function",
  function: {
    name: "fetch_connected_context",
    description: "Fetch detail for one live external MCP search result. Does not ingest the result into Corgtex Brain.",
    parameters: {
      type: "object",
      properties: {
        providerKey: { type: "string", enum: ["box", "notion"] },
        externalId: { type: "string" },
      },
      required: ["providerKey", "externalId"],
    },
  },
};

export const executeExternalToolTool: ModelTool = {
  type: "function",
  function: {
    name: "execute_external_tool",
    description: "Execute a same-user delegated external MCP tool, such as a Notion tool. Normal writes auto-run when the user asked explicitly or confidence is high.",
    parameters: {
      type: "object",
      properties: {
        providerKey: { type: "string", enum: ["notion"] },
        toolName: { type: "string" },
        argumentsJson: { type: "string", description: "JSON object string containing the external MCP tool arguments" },
        operation: { type: "string", enum: ["read", "write"], description: "Set explicitly when known; unknown tools default to write." },
        confidence: { type: "number", description: "Model confidence from 0 to 1 when available" },
        explicitUserIntent: { type: "boolean", description: "Only true when the user explicitly asked for this external execution." },
      },
      required: ["providerKey", "toolName"],
    },
  },
};

export async function listConnectedToolsAction(actor: AppActor, ctx: ToolContext) {
  const items = await listExternalMcpConnections(actor, ctx.workspaceId);
  return { items };
}

export async function searchConnectedContextAction(actor: AppActor, ctx: ToolContext, args: any) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 10));
  const corgtexResults = [];

  if (args.includeCorgtex !== false) {
    const accessDomains = await resolveInteractiveKnowledgeAccessDomains(actor, ctx.workspaceId);
    const results = await searchIndexedKnowledge({
      workspaceId: ctx.workspaceId,
      query: args.query,
      limit,
      sourceTypes: INTERACTIVE_KNOWLEDGE_SOURCE_TYPES,
      accessDomains,
    });
    corgtexResults.push(...results.map((result) => ({
      id: `corgtex:${result.chunkId}`,
      source: "corgtex",
      providerKey: "corgtex",
      providerDisplayName: "Corgtex Brain",
      externalId: result.chunkId,
      title: result.title ?? `${result.sourceType} ${result.sourceId}`,
      text: result.snippet,
      metadata: {
        sourceType: result.sourceType,
        sourceId: result.sourceId,
        chunkIndex: result.chunkIndex,
        score: result.score,
      },
    })));
  }

  const external = await searchConnectedExternalMcpContext(actor, {
    workspaceId: ctx.workspaceId,
    query: args.query,
    providerKey: args.providerKey,
    limit,
  });

  return {
    results: [...corgtexResults, ...external.results].slice(0, limit),
    externalErrors: external.errors,
  };
}

export async function fetchConnectedContextAction(actor: AppActor, ctx: ToolContext, args: any) {
  return fetchConnectedExternalMcpContext(actor, {
    workspaceId: ctx.workspaceId,
    providerKey: args.providerKey,
    externalId: args.externalId,
  });
}

export async function executeExternalToolAction(actor: AppActor, ctx: ToolContext, args: any) {
  return executeExternalMcpTool(actor, {
    workspaceId: ctx.workspaceId,
    providerKey: args.providerKey,
    toolName: args.toolName,
    arguments: parseArgumentsJson(args.argumentsJson ?? args.arguments),
    operation: args.operation === "read" || args.operation === "write" ? args.operation : undefined,
    confidence: typeof args.confidence === "number" ? args.confidence : undefined,
    explicitUserIntent: args.explicitUserIntent === true,
  });
}
