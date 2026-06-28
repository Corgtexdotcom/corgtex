import { decryptSecret, encryptSecret, env, prisma } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { Prisma } from "@prisma/client";
import { evaluateDelegatedActionPolicy } from "./action-policy";
import { recordAudit } from "./audit-trail";
import { requireWorkspaceMembership } from "./auth";
import { AppError, invariant } from "./errors";

export const EXTERNAL_MCP_PROVIDER_KEYS = ["box", "notion", "atlassian", "miro"] as const;
export const CONNECTABLE_EXTERNAL_MCP_PROVIDER_KEYS = ["box", "notion"] as const;

export type ExternalMcpProviderKey = typeof EXTERNAL_MCP_PROVIDER_KEYS[number];
export type ExternalMcpOperation = "read" | "write";

type ExternalMcpProvider = {
  providerKey: ExternalMcpProviderKey;
  displayName: string;
  serverUrl: string;
  authMode: "oauth";
  connectionEnabled: boolean;
  searchToolName: string | null;
  fetchToolName: string | null;
  readToolNames: string[];
  genericExecutionEnabled: boolean;
  tokenRefreshUrl?: string;
  sourceUrl: string;
  adminNotes: string;
};

export type ExternalMcpConnectionSummary = {
  providerKey: ExternalMcpProviderKey;
  displayName: string;
  serverUrl: string;
  authMode: "oauth";
  connectionEnabled: boolean;
  status: "connected" | "needs_connection" | "error" | "disconnected";
  connectionId: string | null;
  connectionOwnerUserId: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  expiresAt: Date | null;
  scopes: string[];
  capabilities: Record<string, unknown>;
  supportsSearch: boolean;
  supportsFetch: boolean;
  searchToolName: string | null;
  fetchToolName: string | null;
  sourceUrl: string;
  adminNotes: string;
  lastError: string | null;
};

type ExternalMcpConnectionRecord = {
  id: string;
  workspaceId: string;
  userId: string;
  providerKey: string;
  displayName: string;
  serverUrl: string;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc?: string | null;
  expiresAt?: Date | null;
  scopes: string[];
  capabilities: Prisma.JsonValue | null;
  status: "ACTIVE" | "DISCONNECTED" | "ERROR";
  lastError: string | null;
};

const EXTERNAL_MCP_PROVIDERS: Record<ExternalMcpProviderKey, ExternalMcpProvider> = {
  box: {
    providerKey: "box",
    displayName: "Box",
    serverUrl: "https://mcp.box.com",
    authMode: "oauth",
    connectionEnabled: true,
    searchToolName: "search_files_keyword",
    fetchToolName: "get_file_details",
    readToolNames: [
      "who_am_i",
      "get_file_details",
      "get_folder_details",
      "list_folder_content_by_folder_id",
      "search_files_keyword",
      "search_files_metadata",
      "search_folders_by_name",
      "list_file_comments",
      "list_item_collaborations",
      "list_tasks",
      "ai_extract_freeform",
      "ai_extract_structured",
      "ai_extract_structured_from_fields",
      "ai_extract_structured_from_metadata_template",
      "ai_qa_hub",
      "ai_qa_multi_file",
      "ai_qa_single_file",
      "get_hub_details",
      "get_hub_items",
      "list_hubs",
      "get_docgen_template_by_id",
      "list_docgen_templates",
    ],
    genericExecutionEnabled: false,
    tokenRefreshUrl: "https://api.box.com/oauth2/token",
    sourceUrl: "https://developer.box.com/guides/box-mcp/",
    adminNotes: "Official hosted MCP is enabled for read/search/AI context. Box writes remain disabled in Corgtex until customer policy is explicit.",
  },
  notion: {
    providerKey: "notion",
    displayName: "Notion",
    serverUrl: "https://mcp.notion.com/mcp",
    authMode: "oauth",
    connectionEnabled: true,
    searchToolName: "notion-search",
    fetchToolName: "notion-fetch",
    readToolNames: ["notion-search", "notion-fetch"],
    genericExecutionEnabled: true,
    sourceUrl: "https://developers.notion.com/guides/mcp/overview",
    adminNotes: "Token-backed pilot provider. Replace token-post setup with user-facing OAuth before broad release.",
  },
  atlassian: {
    providerKey: "atlassian",
    displayName: "Atlassian",
    serverUrl: "https://mcp.atlassian.com/v1/mcp/authv2",
    authMode: "oauth",
    connectionEnabled: false,
    searchToolName: null,
    fetchToolName: null,
    readToolNames: [],
    genericExecutionEnabled: false,
    sourceUrl: "https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/",
    adminNotes: "Rovo MCP requires Atlassian site/admin authorization before Corgtex can safely expose connection.",
  },
  miro: {
    providerKey: "miro",
    displayName: "Miro",
    serverUrl: "https://mcp.miro.com/mcp",
    authMode: "oauth",
    connectionEnabled: false,
    searchToolName: null,
    fetchToolName: null,
    readToolNames: [],
    genericExecutionEnabled: false,
    sourceUrl: "https://developers.miro.com/changelog/its-here-the-miro-mcp-server-is-now-in-public-beta",
    adminNotes: "Miro MCP is beta and Enterprise-admin gated; keep request-only until a workspace is explicitly enabled.",
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

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerForKey(providerKey: string) {
  const provider = EXTERNAL_MCP_PROVIDERS[providerKey as ExternalMcpProviderKey];
  invariant(provider, 404, "NOT_FOUND", `Unknown external MCP provider: ${providerKey}`);
  return provider;
}

function requireConnectableProvider(provider: ExternalMcpProvider) {
  invariant(provider.connectionEnabled, 400, "NOT_READY", `${provider.displayName} MCP setup is not enabled in Corgtex yet.`);
  invariant(provider.searchToolName && provider.fetchToolName, 400, "NOT_READY", `${provider.displayName} MCP tools are not allowlisted in Corgtex yet.`);
}

function classifyExternalMcpOperation(
  provider: ExternalMcpProvider,
  toolName: string,
  operation?: ExternalMcpOperation | null,
): ExternalMcpOperation {
  if (operation === "read" || operation === "write") return operation;
  if ((provider.searchToolName && toolName === provider.searchToolName) || (provider.fetchToolName && toolName === provider.fetchToolName)) return "read";
  if (provider.readToolNames.includes(toolName)) return "read";
  return "write";
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

function boxAppUrl(itemType: string, externalId: string) {
  if (itemType === "folder") return `https://app.box.com/folder/${encodeURIComponent(externalId)}`;
  if (itemType === "web_link") return `https://app.box.com/web_link/${encodeURIComponent(externalId)}`;
  return `https://app.box.com/file/${encodeURIComponent(externalId)}`;
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
      : Array.isArray(payloadRecord.entries)
        ? payloadRecord.entries
        : [];

  return candidates.slice(0, params.limit).map((raw, index) => {
    const rawRecord = asRecord(raw);
    const nestedItem = rawRecord.item && typeof rawRecord.item === "object" && !Array.isArray(rawRecord.item)
      ? asRecord(rawRecord.item)
      : null;
    const item = nestedItem ?? rawRecord;
    const itemType = asString(item.type) || asString(rawRecord.type);
    const sharedLink = asRecord(item.shared_link);
    const externalId = asString(item.id) || asString(item.url) || asString(item.pageId) || `${params.connection.id}:${index}`;
    const url = asString(rawRecord.accessible_via_shared_link)
      || asString(sharedLink.url)
      || asString(item.url)
      || (params.provider.providerKey === "box" ? boxAppUrl(itemType, externalId) : null);
    return {
      id: `${params.provider.providerKey}:${externalId}`,
      source: "external_mcp",
      providerKey: params.provider.providerKey,
      providerDisplayName: params.provider.displayName,
      externalId,
      title: asString(item.title) || asString(item.name) || asString(item.url) || `${params.provider.displayName} result`,
      text: asString(item.text) || asString(item.snippet) || asString(item.content),
      url,
      metadata: {
        connectionId: params.connection.id,
        resourceType: itemType || null,
      },
    };
  });
}

function connectionNeedsRefresh(connection: ExternalMcpConnectionRecord) {
  return Boolean(connection.expiresAt && connection.expiresAt.getTime() - Date.now() < 5 * 60 * 1000);
}

function boxClientCredentials() {
  const clientId = env.BOX_CLIENT_ID;
  const clientSecret = env.BOX_CLIENT_SECRET;
  invariant(clientId && clientSecret, 500, "BOX_NOT_CONFIGURED", "Box OAuth is not configured in Corgtex.");
  return { clientId, clientSecret };
}

async function refreshExternalMcpConnectionIfNeeded(connection: ExternalMcpConnectionRecord) {
  if (!connectionNeedsRefresh(connection)) return connection;
  const provider = providerForKey(connection.providerKey);
  if (provider.providerKey !== "box") return connection;

  const refreshToken = connection.refreshTokenEnc ? decryptSecret(connection.refreshTokenEnc) : null;
  if (!refreshToken) {
    const lastError = "Box OAuth token expired and no refresh token is available.";
    await prisma.externalMcpConnection.update({
      where: { id: connection.id },
      data: { status: "ERROR", lastError },
    });
    throw new AppError(401, "BOX_RECONNECT_REQUIRED", lastError);
  }

  const { clientId, clientSecret } = boxClientCredentials();
  const response = await fetch(provider.tokenRefreshUrl ?? "https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = asString(asRecord(data).error_description) || asString(asRecord(data).error) || "Failed to refresh Box OAuth token.";
    await prisma.externalMcpConnection.update({
      where: { id: connection.id },
      data: { status: "ERROR", lastError: message },
    });
    throw new AppError(401, "BOX_RECONNECT_REQUIRED", message);
  }

  const accessToken = asString(asRecord(data).access_token);
  invariant(accessToken, 502, "BOX_TOKEN_REFRESH_FAILED", "Box token refresh did not return an access token.");
  const nextRefreshToken = asString(asRecord(data).refresh_token) || refreshToken;
  const expiresIn = asNumber(asRecord(data).expires_in);
  const updated = await prisma.externalMcpConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptSecret(accessToken),
      refreshTokenEnc: nextRefreshToken ? encryptSecret(nextRefreshToken) : null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      status: "ACTIVE",
      lastError: null,
    },
  }) as ExternalMcpConnectionRecord;
  return updated;
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
  requireConnectableProvider(provider);
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
  const activeConnection = await refreshExternalMcpConnectionIfNeeded(connection);
  const token = activeConnection.accessTokenEnc ? decryptSecret(activeConnection.accessTokenEnc) : null;
  if (!token) {
    throw new AppError(404, "NOT_CONNECTED", "External MCP connection is missing an access token.");
  }

  const response = await fetch(activeConnection.serverUrl, {
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
  const searchToolName = asString(capabilities.searchToolName) || provider.searchToolName || "";
  const fetchToolName = asString(capabilities.fetchToolName) || provider.fetchToolName || "";
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
  requireConnectableProvider(provider);
  const summary = externalCapabilitySummary(provider, connection);
  const toolName = feature === "search"
    ? summary.searchToolName ?? provider.searchToolName
    : summary.fetchToolName ?? provider.fetchToolName;
  invariant(toolName, 400, "NOT_READY", `${provider.displayName} ${feature} tool is not configured.`);
  return toolName;
}

function externalSearchArgs(provider: ExternalMcpProvider, query: string, limit: number) {
  if (provider.providerKey === "box") {
    return {
      query,
      limit,
      fields: ["id", "type", "name", "description", "modified_at", "size", "extension", "shared_link", "file_version", "etag"],
    };
  }
  return { query, limit };
}

function externalFetchArgs(provider: ExternalMcpProvider, externalId: string) {
  if (provider.providerKey === "box") {
    const [resourceType, id] = externalId.includes(":") ? externalId.split(":", 2) : ["file", externalId];
    if (resourceType === "folder") return { folder_id: id };
    return { file_id: id };
  }
  return { id: externalId };
}

function requireExternalToolAllowed(provider: ExternalMcpProvider, toolName: string, operation: ExternalMcpOperation) {
  if (provider.providerKey !== "box") return;
  invariant(operation === "read" && provider.readToolNames.includes(toolName), 403, "BOX_WRITE_DISABLED", "Box write and raw content tools are disabled in Corgtex v1.");
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
      connectionEnabled: provider.connectionEnabled,
      status: connectionStatus(connection),
      connectionId: connection?.id ?? null,
      connectionOwnerUserId: connection?.userId ?? null,
      providerAccountId: connection?.providerAccountId ?? null,
      providerEmail: connection?.providerEmail ?? null,
      expiresAt: connection?.expiresAt ?? null,
      scopes: connection?.scopes ?? [],
      capabilities: capabilities.capabilities,
      supportsSearch: capabilities.supportsSearch,
      supportsFetch: capabilities.supportsFetch,
      searchToolName: capabilities.searchToolName,
      fetchToolName: capabilities.fetchToolName,
      sourceUrl: provider.sourceUrl,
      adminNotes: provider.adminNotes,
      lastError: connection?.lastError ?? null,
    };
  });
}

export async function upsertExternalMcpConnection(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  expiresIn?: number | null;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  scopes?: string[];
  capabilities?: Record<string, unknown>;
}) {
  invariant(actor.kind === "user", 403, "FORBIDDEN", "Only users can connect external MCP providers.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = providerForKey(params.providerKey);
  requireConnectableProvider(provider);
  const refreshTokenUpdate = params.refreshToken !== undefined
    ? { refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null }
    : {};
  const expiresAt = params.expiresAt ?? (params.expiresIn ? new Date(Date.now() + params.expiresIn * 1000) : null);
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
      providerAccountId: params.providerAccountId?.trim() || null,
      providerEmail: params.providerEmail?.trim() || null,
      accessTokenEnc: encryptSecret(params.accessToken),
      ...refreshTokenUpdate,
      expiresAt,
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
      providerAccountId: params.providerAccountId?.trim() || null,
      providerEmail: params.providerEmail?.trim() || null,
      accessTokenEnc: encryptSecret(params.accessToken),
      refreshTokenEnc: params.refreshToken ? encryptSecret(params.refreshToken) : null,
      expiresAt,
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
      const remote = await callExternalMcpTool(connection, searchToolName, externalSearchArgs(provider, params.query, limit));
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
    const remote = await callExternalMcpTool(connection, fetchToolName, externalFetchArgs(provider, params.externalId));
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

export async function getExternalMcpConnectionAccessToken(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { provider, connection } = await requireActiveConnection(actor, params);
  const refreshed = await refreshExternalMcpConnectionIfNeeded(connection);
  const accessToken = refreshed.accessTokenEnc ? decryptSecret(refreshed.accessTokenEnc) : null;
  invariant(accessToken, 404, "NOT_CONNECTED", `${provider.displayName} is not connected for this user.`);
  return {
    provider,
    connection: refreshed,
    accessToken,
  };
}

export async function callBoxExternalMcpReadTool(actor: AppActor, params: {
  workspaceId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = providerForKey("box");
  requireExternalToolAllowed(provider, params.toolName, "read");
  const { connection } = await requireActiveConnection(actor, {
    workspaceId: params.workspaceId,
    providerKey: "box",
  });
  try {
    const remote = await callExternalMcpTool(connection, params.toolName, params.arguments);
    const payload = extractMcpPayload(remote);
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: params.toolName,
      policyClass: "read",
      input: params.arguments,
      result: payload,
    });
    return payload;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Box MCP read failed.";
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: params.toolName,
      policyClass: "read",
      input: params.arguments,
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
  operation?: ExternalMcpOperation | null;
  confidence?: number | null;
  explicitUserIntent?: boolean;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = providerForKey(params.providerKey);
  const operation = classifyExternalMcpOperation(provider, params.toolName, params.operation);
  requireExternalToolAllowed(provider, params.toolName, operation);
  invariant(provider.genericExecutionEnabled, 403, "EXTERNAL_TOOL_EXECUTION_DISABLED", `${provider.displayName} generic tool execution is disabled in Corgtex v1.`);
  const policy = evaluateDelegatedActionPolicy({
    toolName: params.toolName,
    operation,
    confidence: params.confidence,
    explicitUserIntent: params.explicitUserIntent === true,
  });

  if (!policy.autoRunAllowed) {
    return { skipped: true, policy };
  }

  const { connection } = await requireActiveConnection(actor, params);
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
