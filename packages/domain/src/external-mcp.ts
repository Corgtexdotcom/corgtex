import { decryptSecret, encryptSecret, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { Prisma } from "@prisma/client";
import { evaluateDelegatedActionPolicy } from "./action-policy";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";

export type ExternalMcpProviderKey = "notion";

type ExternalMcpProvider = {
  providerKey: ExternalMcpProviderKey;
  displayName: string;
  serverUrl: string;
  authMode: "oauth";
  searchToolName: string;
  fetchToolName: string;
};

export type ExternalMcpConnectionSummary = {
  providerKey: ExternalMcpProviderKey;
  displayName: string;
  serverUrl: string;
  authMode: "oauth";
  status: "connected" | "needs_connection" | "error" | "disconnected";
  connectionId: string | null;
  connectionOwnerUserId: string | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  supportsSearch: boolean;
  supportsFetch: boolean;
  searchToolName: string | null;
  fetchToolName: string | null;
  lastError: string | null;
};

type ExternalMcpConnectionRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  providerKey: string;
  displayName: string;
  serverUrl: string;
  accessTokenEnc: string | null;
  refreshTokenEnc?: string | null;
  scopes: string[];
  capabilities: Prisma.JsonValue | null;
  status: "ACTIVE" | "DISCONNECTED" | "ERROR";
  lastError: string | null;
};

const EXTERNAL_MCP_PROVIDERS: Record<ExternalMcpProviderKey, ExternalMcpProvider> = {
  notion: {
    providerKey: "notion",
    displayName: "Notion",
    serverUrl: "https://mcp.notion.com/mcp",
    authMode: "oauth",
    searchToolName: "notion-search",
    fetchToolName: "notion-fetch",
  },
};

function actorUserId(actor: AppActor) {
  return actor.kind === "user" ? actor.user.id : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function providerForKey(providerKey: string) {
  const provider = EXTERNAL_MCP_PROVIDERS[providerKey as ExternalMcpProviderKey];
  invariant(provider, 404, "NOT_FOUND", `Unknown external MCP provider: ${providerKey}`);
  return provider;
}

function connectionStatus(connection: ExternalMcpConnectionRecord | null): ExternalMcpConnectionSummary["status"] {
  if (!connection) return "needs_connection";
  if (connection.status === "ERROR") return "error";
  if (connection.status === "DISCONNECTED") return "disconnected";
  return "connected";
}

function summarizeForAudit(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      type: "object",
      keys: Object.keys(record).sort(),
    };
  }
  return { type: typeof value };
}

function parseJsonText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseMcpResponseText(value: string): unknown {
  const trimmed = value.trim();
  const direct = parseJsonText(trimmed);
  if (direct) return direct;

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]");

  for (const line of [...dataLines].reverse()) {
    const parsed = parseJsonText(line);
    if (parsed) return parsed;
  }

  return null;
}

function extractMcpPayload(result: unknown) {
  const record = asRecord(result);
  if (record.structuredContent) return record.structuredContent;
  const content = Array.isArray(record.content) ? record.content : [];
  for (const entry of content) {
    const text = asString(asRecord(entry).text);
    if (!text) continue;
    const parsed = parseJsonText(text);
    if (parsed) return parsed;
  }
  return result;
}

function normalizeSearchResults(params: {
  provider: ExternalMcpProvider;
  connection: ExternalMcpConnectionRecord;
  payload: unknown;
  limit: number;
}) {
  const payloadRecord = asRecord(params.payload);
  const candidates = Array.isArray(payloadRecord.results)
    ? payloadRecord.results
    : Array.isArray(payloadRecord.items)
      ? payloadRecord.items
      : [];

  return candidates.slice(0, params.limit).map((raw, index) => {
    const item = asRecord(raw);
    const externalId = asString(item.id) || asString(item.url) || asString(item.pageId) || `${params.connection.id}:${index}`;
    return {
      id: `${params.provider.providerKey}:${externalId}`,
      source: "external_mcp",
      providerKey: params.provider.providerKey,
      providerDisplayName: params.provider.displayName,
      externalId,
      title: asString(item.title) || asString(item.name) || asString(item.url) || `${params.provider.displayName} result`,
      text: asString(item.text) || asString(item.snippet) || asString(item.content),
      url: asString(item.url) || null,
      metadata: {
        connectionId: params.connection.id,
      },
    };
  });
}

async function activeUserConnections(actor: AppActor, workspaceId: string, providerKey?: string) {
  const userId = actorUserId(actor);
  if (!userId) return [];
  return prisma.externalMcpConnection.findMany({
    where: {
      workspaceId,
      userId,
      ...(providerKey ? { providerKey } : {}),
      status: "ACTIVE",
    },
    orderBy: { updatedAt: "desc" },
  }) as Promise<ExternalMcpConnectionRecord[]>;
}

async function requireActiveConnection(actor: AppActor, params: {
  workspaceId: string;
  providerKey: string;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "External MCP connections use same-user delegated OAuth. Sign in as a user to connect external tools.");
  const provider = providerForKey(params.providerKey);
  const connection = await prisma.externalMcpConnection.findFirst({
    where: {
      workspaceId: params.workspaceId,
      userId: actor.user.id,
      providerKey: provider.providerKey,
      status: "ACTIVE",
    },
  }) as ExternalMcpConnectionRecord | null;
  invariant(connection?.accessTokenEnc, 404, "NOT_CONNECTED", `${provider.displayName} is not connected for this user.`);
  return { provider, connection };
}

async function callExternalMcpTool(connection: ExternalMcpConnectionRecord, toolName: string, args: Record<string, unknown>) {
  const token = connection.accessTokenEnc ? decryptSecret(connection.accessTokenEnc) : null;
  if (!token) {
    throw new AppError(404, "NOT_CONNECTED", "External MCP connection is missing an access token.");
  }

  const response = await fetch(connection.serverUrl, {
    method: "POST",
    headers: {
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `corgtex-${Date.now()}`,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new AppError(response.status, "EXTERNAL_MCP_ERROR", `External MCP call failed with HTTP ${response.status}.`);
  }

  const responseText = await response.text();
  const payload = parseMcpResponseText(responseText);
  if (!payload) {
    throw new AppError(502, "EXTERNAL_MCP_ERROR", "External MCP tool returned an unreadable response.");
  }
  const payloadRecord = asRecord(payload);
  const payloadError = asRecord(payloadRecord.error);
  if (payloadRecord.error) {
    throw new AppError(502, "EXTERNAL_MCP_ERROR", asString(payloadError.message) || "External MCP tool returned an error.");
  }
  return payloadRecord.result ?? payload;
}

function externalCapabilitySummary(provider: ExternalMcpProvider, connection: ExternalMcpConnectionRecord | null) {
  const capabilities = asRecord(connection?.capabilities);
  const searchToolName = asString(capabilities.searchToolName) || provider.searchToolName;
  const fetchToolName = asString(capabilities.fetchToolName) || provider.fetchToolName;
  return {
    capabilities: {
      searchToolName,
      fetchToolName,
      ...capabilities,
    },
    supportsSearch: Boolean(searchToolName),
    supportsFetch: Boolean(fetchToolName),
    searchToolName: searchToolName || null,
    fetchToolName: fetchToolName || null,
  };
}

function externalToolName(provider: ExternalMcpProvider, connection: ExternalMcpConnectionRecord, feature: "search" | "fetch") {
  const summary = externalCapabilitySummary(provider, connection);
  return feature === "search"
    ? summary.searchToolName ?? provider.searchToolName
    : summary.fetchToolName ?? provider.fetchToolName;
}

async function auditExternalMcpCall(actor: AppActor, params: {
  workspaceId: string;
  connection: ExternalMcpConnectionRecord;
  toolName: string;
  policyClass: string;
  confidence?: number | null;
  input: unknown;
  result?: unknown;
  error?: string | null;
}) {
  await prisma.$transaction(async (tx) => {
    await recordAudit(tx, actor, {
      workspaceId: params.workspaceId,
      action: "external_mcp.tool_called",
      entityType: "ExternalMcpConnection",
      entityId: params.connection.id,
      meta: {
        providerKey: params.connection.providerKey,
        toolName: params.toolName,
        policyClass: params.policyClass,
        confidence: params.confidence ?? null,
        inputSummary: summarizeForAudit(params.input),
        resultSummary: params.error ? null : summarizeForAudit(params.result),
        error: params.error ?? null,
      },
    });
  });
}

export function listExternalMcpProviders() {
  return Object.values(EXTERNAL_MCP_PROVIDERS);
}

export async function listExternalMcpConnections(actor: AppActor, workspaceId: string): Promise<ExternalMcpConnectionSummary[]> {
  await requireWorkspaceMembership({ actor, workspaceId });
  const userId = actorUserId(actor);
  const connections = userId
    ? await prisma.externalMcpConnection.findMany({
      where: { workspaceId, userId },
      orderBy: { updatedAt: "desc" },
    }) as ExternalMcpConnectionRecord[]
    : [];
  const byProvider = new Map(connections.map((connection) => [connection.providerKey, connection]));

  return listExternalMcpProviders().map((provider) => {
    const connection = byProvider.get(provider.providerKey) ?? null;
    const capabilities = externalCapabilitySummary(provider, connection);
    return {
      providerKey: provider.providerKey,
      displayName: connection?.displayName ?? provider.displayName,
      serverUrl: connection?.serverUrl ?? provider.serverUrl,
      authMode: provider.authMode,
      status: connectionStatus(connection),
      connectionId: connection?.id ?? null,
      connectionOwnerUserId: connection?.userId ?? null,
      scopes: connection?.scopes ?? [],
      capabilities: capabilities.capabilities,
      supportsSearch: capabilities.supportsSearch,
      supportsFetch: capabilities.supportsFetch,
      searchToolName: capabilities.searchToolName,
      fetchToolName: capabilities.fetchToolName,
      lastError: connection?.lastError ?? null,
    };
  });
}

export async function upsertExternalMcpConnection(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
  accessToken: string;
  refreshToken?: string | null;
  scopes?: string[];
  capabilities?: Record<string, unknown>;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can connect external MCP providers.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = providerForKey(params.providerKey);
  return prisma.externalMcpConnection.upsert({
    where: {
      workspaceId_userId_providerKey: {
        workspaceId: params.workspaceId,
        userId: actor.user.id,
        providerKey: provider.providerKey,
      },
    },
    update: {
      displayName: provider.displayName,
      serverUrl: provider.serverUrl,
      accessTokenEnc: encryptSecret(params.accessToken),
      refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null,
      scopes: params.scopes ?? [],
      capabilities: params.capabilities ? params.capabilities as Prisma.InputJsonObject : Prisma.DbNull,
      status: "ACTIVE",
      lastError: null,
    },
    create: {
      workspaceId: params.workspaceId,
      userId: actor.user.id,
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      serverUrl: provider.serverUrl,
      accessTokenEnc: encryptSecret(params.accessToken),
      refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null,
      scopes: params.scopes ?? [],
      capabilities: params.capabilities ? params.capabilities as Prisma.InputJsonObject : Prisma.DbNull,
      status: "ACTIVE",
    },
  });
}

export async function searchConnectedExternalMcpContext(actor: AppActor, params: {
  workspaceId: string;
  query: string;
  providerKey?: ExternalMcpProviderKey;
  limit?: number;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
  const connections = await activeUserConnections(actor, params.workspaceId, params.providerKey);
  const results = [];
  const errors = [];

  for (const connection of connections) {
    const provider = providerForKey(connection.providerKey);
    const searchToolName = externalToolName(provider, connection, "search");
    try {
      const remote = await callExternalMcpTool(connection, searchToolName, {
        query: params.query,
        limit,
      });
      const payload = extractMcpPayload(remote);
      await auditExternalMcpCall(actor, {
        workspaceId: params.workspaceId,
        connection,
        toolName: searchToolName,
        policyClass: "read",
        input: { query: params.query, limit },
        result: payload,
      });
      results.push(...normalizeSearchResults({ provider, connection, payload, limit }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "External MCP search failed.";
      errors.push({ providerKey: provider.providerKey, message });
      await auditExternalMcpCall(actor, {
        workspaceId: params.workspaceId,
        connection,
        toolName: searchToolName,
        policyClass: "read",
        input: { query: params.query, limit },
        error: message,
      });
    }
  }

  return { results: results.slice(0, limit), errors };
}

export async function fetchConnectedExternalMcpContext(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
  externalId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { provider, connection } = await requireActiveConnection(actor, params);
  const fetchToolName = externalToolName(provider, connection, "fetch");
  try {
    const remote = await callExternalMcpTool(connection, fetchToolName, {
      id: params.externalId,
    });
    const payload = extractMcpPayload(remote);
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: fetchToolName,
      policyClass: "read",
      input: { externalId: params.externalId },
      result: payload,
    });
    return {
      providerKey: provider.providerKey,
      providerDisplayName: provider.displayName,
      externalId: params.externalId,
      content: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "External MCP fetch failed.";
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: fetchToolName,
      policyClass: "read",
      input: { externalId: params.externalId },
      error: message,
    });
    throw error;
  }
}

export async function executeExternalMcpTool(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
  toolName: string;
  arguments: Record<string, unknown>;
  confidence?: number | null;
  explicitUserIntent?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const policy = evaluateDelegatedActionPolicy({
    toolName: params.toolName,
    operation: params.toolName.includes("search") || params.toolName.includes("fetch") || params.toolName.includes("get") ? "read" : "write",
    confidence: params.confidence,
    explicitUserIntent: params.explicitUserIntent ?? true,
  });

  if (!policy.autoRunAllowed) {
    return { skipped: true, policy };
  }

  const { provider, connection } = await requireActiveConnection(actor, params);
  try {
    const remote = await callExternalMcpTool(connection, params.toolName, params.arguments);
    const payload = extractMcpPayload(remote);
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: params.toolName,
      policyClass: policy.policyClass,
      confidence: params.confidence,
      input: params.arguments,
      result: payload,
    });
    return {
      skipped: false,
      providerKey: provider.providerKey,
      providerDisplayName: provider.displayName,
      toolName: params.toolName,
      policy,
      result: payload,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "External MCP execution failed.";
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: params.toolName,
      policyClass: policy.policyClass,
      confidence: params.confidence,
      input: params.arguments,
      error: message,
    });
    throw error;
  }
}
