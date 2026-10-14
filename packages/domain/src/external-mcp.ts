import { createHash, randomUUID } from "node:crypto";
import { assertMcpOriginActive, decryptSecret, encryptSecret, env, getMcpOrigin, mcpScopesHash, parseMcpOrigin, prisma } from "@corgtex/shared";
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

export type ExternalMcpConnectionRecord = {
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
      "get_file_content",
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

  // Progress frames are not a tool result. Multiple completions are ambiguous
  // and must not let a later frame silently replace earlier content.
  const completions = dataLines.map(parseJsonText).filter((frame) => {
    const record = asRecord(frame);
    return Object.hasOwn(record, "result") || Object.hasOwn(record, "error");
  });
  return completions.length === 1 ? completions[0] : null;
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
      providerKey: providerKey ?? { in: ["box", "notion"] },
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

async function callExternalMcpTool(connection: ExternalMcpConnectionRecord, toolName: string, args: Record<string, unknown>, strictResponse = false) {
  const activeConnection = await refreshExternalMcpConnectionIfNeeded(connection);
  const token = activeConnection.accessTokenEnc ? decryptSecret(activeConnection.accessTokenEnc) : null;
  if (!token) {
    throw new AppError(404, "NOT_CONNECTED", "External MCP connection is missing an access token.");
  }

  const requestId = `corgtex-${randomUUID()}`;
  const response = await fetch(activeConnection.serverUrl, {
    method: "POST",
    headers: {
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
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
  if (strictResponse && (payloadRecord.jsonrpc !== "2.0" || payloadRecord.id !== requestId
    || !Object.hasOwn(payloadRecord, "result") || !payloadRecord.result
    || typeof payloadRecord.result !== "object" || Array.isArray(payloadRecord.result))) {
    throw new AppError(502, "EXTERNAL_MCP_ERROR", "External MCP tool returned an unbound response.");
  }
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

/** The native live-response adapter admits only these exact, server-selected reads. */
export function externalMcpNativeReadRequest(providerKey: string, mode: "SEARCH" | "FETCH",
  value: { query?: string; limit?: number; externalId?: string }) {
  const provider = EXTERNAL_MCP_PROVIDERS[providerKey as ExternalMcpProviderKey];
  invariant(provider && (providerKey === "box" || providerKey === "notion"), 403, "SOURCE_RESTRICTED", "External MCP native read is unavailable.");
  if (mode === "SEARCH") {
    invariant(typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= 2000
      && Number.isInteger(value.limit) && value.limit! >= 1 && value.limit! <= 20,
    400, "INVALID_INPUT", "External MCP search requires a bounded query.");
    return { providerKey, serverUrl: provider.serverUrl, mode, toolName: provider.searchToolName!,
      arguments: externalSearchArgs(provider, value.query, value.limit!) };
  }
  invariant(mode === "FETCH" && typeof value.externalId === "string" && value.externalId.length > 0
    && value.externalId.length <= 2048, 400, "INVALID_INPUT", "External MCP fetch requires an item ID.");
  if (providerKey === "box") {
    invariant(!value.externalId.includes(":") || /^(file|folder):[^:]+$/.test(value.externalId),
      400, "INVALID_INPUT", "Box item ID must identify one file or folder.");
  }
  const args = externalFetchArgs(provider, value.externalId);
  const toolName = providerKey === "box" && "folder_id" in args ? "get_folder_details" : provider.fetchToolName!;
  return { providerKey, serverUrl: provider.serverUrl, mode, toolName, arguments: args };
}

/** Current same-user connection. Refresh occurs before the native input's original epoch capture. */
export async function loadExternalMcpNativeConnection(actor: AppActor, workspaceId: string, connectionId: string) {
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "External MCP content requires its connection owner.");
  await requireWorkspaceMembership({ actor, workspaceId });
  invariant(await prisma.member.findFirst({ where: { workspaceId, userId: actor.user.id, isActive: true }, select: { id: true } }),
    403, "SOURCE_RESTRICTED", "External MCP owner membership is unavailable.");
  const connection = await prisma.externalMcpConnection.findFirst({ where: { id: connectionId, workspaceId,
    userId: actor.user.id, status: "ACTIVE", providerKey: { in: ["box", "notion"] } } }) as ExternalMcpConnectionRecord | null;
  invariant(connection?.accessTokenEnc, 403, "SOURCE_RESTRICTED", "External MCP connection is unavailable.");
  const provider = EXTERNAL_MCP_PROVIDERS[connection.providerKey as ExternalMcpProviderKey];
  invariant(connection.serverUrl === provider.serverUrl && (connection.providerKey !== "box" || connection.providerAccountId),
    403, "SOURCE_RESTRICTED", "External MCP connection authority is unavailable.");
  const refreshed = await refreshExternalMcpConnectionIfNeeded(connection);
  invariant(refreshed.status === "ACTIVE" && refreshed.accessTokenEnc,
    403, "SOURCE_RESTRICTED", "External MCP connection is unavailable.");
  const current = await prisma.externalMcpConnection.findFirst({ where: { id: connectionId, workspaceId,
    userId: actor.user.id, status: "ACTIVE", providerKey: connection.providerKey } }) as ExternalMcpConnectionRecord | null;
  invariant(current?.accessTokenEnc && current.serverUrl === provider.serverUrl
    && externalMcpConnectionGrantHash(current) === externalMcpConnectionGrantHash(refreshed)
    && await prisma.member.findFirst({ where: { workspaceId, userId: actor.user.id, isActive: true }, select: { id: true } }),
  403, "SOURCE_RESTRICTED", "External MCP connection or owner membership changed during token refresh.");
  return current;
}

/** A human OAuth origin must own the token and consent to this data read before SDK access. */
export async function assertExternalMcpNativeReadOrigin(actor: AppActor, workspaceId: string,
  db: typeof prisma | Prisma.TransactionClient = prisma) {
  const ambient = getMcpOrigin();
  if (!ambient) return null;
  const origin = parseMcpOrigin(ambient);
  invariant(actor.kind === "user" && origin.kind === "oauth" && origin.workspaceId === workspaceId,
    403, "MCP_AUTHORIZATION_REVOKED", "External MCP read origin is unavailable.");
  await assertMcpOriginActive(db, { ...origin,
    requiredScopes: [...new Set([...(origin.requiredScopes ?? []), "external-tools:read"])] }, workspaceId);
  const token = await db.mcpOAuthAccessToken.findUnique({ where: { id: origin.id },
    select: { userId: true, workspaceId: true, scopes: true } });
  invariant(token?.userId === actor.user.id && token.workspaceId === workspaceId
    && mcpScopesHash(token.scopes) === origin.scopeHash && token.scopes.includes("external-tools:read"),
  403, "MCP_AUTHORIZATION_REVOKED", "External MCP read consent is unavailable.");
  return `${origin.kind}:${origin.id}:${origin.workspaceId}:${origin.scopeHash}:${origin.grantEpoch}`;
}

/** Return the complete consumed MCP tool result, before payload extraction or result limits. */
export async function readExternalMcpNativeToolResult(actor: AppActor, params: { workspaceId: string; connectionId: string;
  connectionGrantHash: string; providerKey: string; serverUrl: string; providerAccountId: string | null;
  mode: "SEARCH" | "FETCH"; toolName: string; arguments: Record<string, unknown> }) {
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "External MCP content requires its connection owner.");
  const originIdentity = await assertExternalMcpNativeReadOrigin(actor, params.workspaceId);
  const connection = await loadExternalMcpNativeConnection(actor, params.workspaceId, params.connectionId);
  const expected = params.mode === "SEARCH"
    ? externalMcpNativeReadRequest(params.providerKey, "SEARCH", { query: asString(params.arguments.query), limit: asNumber(params.arguments.limit) ?? undefined })
    : externalMcpNativeReadRequest(params.providerKey, "FETCH", { externalId: asString(params.arguments.file_id)
      || (asString(params.arguments.folder_id) ? `folder:${asString(params.arguments.folder_id)}` : "")
      || asString(params.arguments.id) });
  const canonical = (value: unknown) => JSON.stringify(value, Object.keys(asRecord(value)).sort());
  invariant(connection.userId === actor.user.id && connection.providerKey === params.providerKey
    && connection.serverUrl === params.serverUrl && connection.providerAccountId === params.providerAccountId
    && externalMcpConnectionGrantHash(connection) === params.connectionGrantHash
    && expected.toolName === params.toolName && canonical(expected.arguments) === canonical(params.arguments),
  403, "SOURCE_RESTRICTED", "External MCP read request or grant changed.");
  if (connection.providerKey === "box") {
    const identity = extractMcpPayload(await callExternalMcpTool(connection, "who_am_i", {}));
    invariant(asString(asRecord(identity).id) === connection.providerAccountId,
      403, "SOURCE_RESTRICTED", "External MCP account changed.");
  }
  const result = await callExternalMcpTool(connection, params.toolName, structuredClone(params.arguments), true);
  invariant(asRecord(result).isError !== true, 403, "SOURCE_RESTRICTED", "External MCP returned an unreadable result.");
  const after = await loadExternalMcpNativeConnection(actor, params.workspaceId, params.connectionId);
  invariant(after.providerAccountId === params.providerAccountId && externalMcpConnectionGrantHash(after) === params.connectionGrantHash,
    409, "SOURCE_CHANGED", "External MCP connection changed during the read.");
  invariant(await assertExternalMcpNativeReadOrigin(actor, params.workspaceId) === originIdentity,
    403, "MCP_AUTHORIZATION_REVOKED", "External MCP read consent changed during the read.");
  return structuredClone(result);
}

function requireExternalToolAllowed(provider: ExternalMcpProvider, toolName: string, operation: ExternalMcpOperation) {
  if (provider.providerKey !== "box") return;
  invariant(operation === "read" && provider.readToolNames.includes(toolName), 403, "BOX_WRITE_DISABLED", "Box write tools are disabled in Corgtex v1.");
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
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "External MCP search requires its connection owner.");
  invariant(!params.providerKey || CONNECTABLE_EXTERNAL_MCP_PROVIDER_KEYS.includes(params.providerKey as "box" | "notion"),
    403, "SOURCE_RESTRICTED", "External MCP search provider is unavailable.");
  const limit = Math.max(1, Math.min(params.limit ?? 5, 20));
  const { captureArtifactInputProof, isArtifactInputProofReadable } = await import("./source-lineage");
  const { captureExternalMcpResponseInput, registerExternalMcpResponseOutput } = await import("./external-mcp-response-input");
  // The virtual set input records even an empty connection enumeration at its original policy revision.
  const setRoots = await captureArtifactInputProof(actor, params.workspaceId,
    [{ kind: "ExternalMcpConnectionSet", id: actor.user.id }]);
  const connections = await activeUserConnections(actor, params.workspaceId, params.providerKey);
  const results = [];
  const errors = [];
  const roots = [...setRoots];

  for (const connection of connections) {
    const provider = providerForKey(connection.providerKey);
    try {
      const receipt = await captureExternalMcpResponseInput(actor, { workspaceId: params.workspaceId,
        connectionId: connection.id, mode: "SEARCH", query: params.query, limit });
      const nativeRoots = await captureArtifactInputProof(actor, params.workspaceId,
        [{ kind: "ExternalMcpResponseInput", id: receipt.input.id, snapshot: receipt.input }]);
      roots.push(...nativeRoots);
      const payload = extractMcpPayload(receipt.payload);
      await auditExternalMcpCall(actor, {
        workspaceId: params.workspaceId,
        connection,
        toolName: receipt.input.toolName,
        policyClass: "read",
        input: { query: params.query, limit },
        result: payload,
      });
      results.push(...normalizeSearchResults({ provider, connection, payload, limit }));
    } catch {
      const message = "External MCP search is unavailable.";
      errors.push({ providerKey: provider.providerKey, message });
      await auditExternalMcpCall(actor, {
        workspaceId: params.workspaceId,
        connection,
        toolName: provider.searchToolName ?? "search",
        policyClass: "read",
        input: { query: params.query, limit },
        error: message,
      });
    }
  }
  invariant(await isArtifactInputProofReadable(actor, params.workspaceId, roots),
    409, "SOURCE_CHANGED", "External MCP search authority changed during enumeration.");
  return registerExternalMcpResponseOutput(actor, params.workspaceId, { results: results.slice(0, limit), errors }, roots);
}

export async function fetchConnectedExternalMcpContext(actor: AppActor, params: {
  workspaceId: string;
  providerKey: ExternalMcpProviderKey;
  externalId: string;
}) {
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const { provider, connection } = await requireActiveConnection(actor, params);
  try {
    const { captureExternalMcpResponseInput, registerExternalMcpResponseOutput } = await import("./external-mcp-response-input");
    const { captureArtifactInputProof } = await import("./source-lineage");
    const receipt = await captureExternalMcpResponseInput(actor, { workspaceId: params.workspaceId,
      connectionId: connection.id, mode: "FETCH", externalId: params.externalId });
    const roots = await captureArtifactInputProof(actor, params.workspaceId,
      [{ kind: "ExternalMcpResponseInput", id: receipt.input.id, snapshot: receipt.input }]);
    const payload = extractMcpPayload(receipt.payload);
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: receipt.input.toolName,
      policyClass: "read",
      input: { externalId: params.externalId },
      result: payload,
    });
    return registerExternalMcpResponseOutput(actor, params.workspaceId, {
      providerKey: provider.providerKey,
      providerDisplayName: provider.displayName,
      externalId: params.externalId,
      content: payload,
    }, roots);
  } catch {
    const message = "External MCP fetch is unavailable.";
    await auditExternalMcpCall(actor, {
      workspaceId: params.workspaceId,
      connection,
      toolName: provider.fetchToolName ?? "fetch",
      policyClass: "read",
      input: { externalId: params.externalId },
      error: message,
    });
    throw new AppError(403, "SOURCE_RESTRICTED", message);
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

export async function callBoxExternalMcpReadToolForConnection(actor: AppActor, params: {
  workspaceId: string;
  connectionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}) {
  invariant(actor.kind === "user", 403, "SOURCE_RESTRICTED", "Selected Box reads require the connection owner.");
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
  const provider = providerForKey("box");
  requireExternalToolAllowed(provider, params.toolName, "read");
  const connection = await prisma.externalMcpConnection.findFirst({
    where: {
      id: params.connectionId,
      userId: actor.user.id,
      workspaceId: params.workspaceId,
      providerKey: "box",
      status: "ACTIVE",
    },
  }) as ExternalMcpConnectionRecord | null;
  invariant(actor.kind === "user" && connection?.userId === actor.user.id, 403, "SOURCE_RESTRICTED", "Selected Box content belongs to its connection owner.");
  invariant(connection?.accessTokenEnc, 404, "NOT_CONNECTED", "Box is not connected for the selected source.");
  invariant(await prisma.member.findFirst({ where: { workspaceId: params.workspaceId, userId: actor.user.id, isActive: true }, select: { id: true } }),
    403, "SOURCE_RESTRICTED", "External provider owner membership is unavailable.");
  try {
    const payload = await readBoxExternalMcpNativeResponse({ actor, connectionId: connection.id, workspaceId: params.workspaceId,
      connectionGrantHash: externalMcpConnectionGrantHash(connection), toolName: params.toolName, arguments: params.arguments });
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });
    invariant(await prisma.member.findFirst({ where: { workspaceId: params.workspaceId, userId: actor.user.id, isActive: true }, select: { id: true } }),
      403, "SOURCE_RESTRICTED", "External provider owner membership is unavailable.");
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

/** Stable authority identity; credential rotation never creates a broader audience. */
export function externalMcpConnectionGrantHash(connection: ExternalMcpConnectionRecord) {
  return createHash("sha256").update(JSON.stringify({ id: connection.id, workspaceId: connection.workspaceId,
    userId: connection.userId, providerKey: connection.providerKey, serverUrl: connection.serverUrl,
    providerAccountId: connection.providerAccountId, scopes: [...connection.scopes].sort() })).digest("hex");
}

const BOX_NATIVE_CONTENT_TOOLS = new Set(["get_file_details", "get_file_content", "get_folder_details",
  "list_folder_content_by_folder_id", "get_hub_details", "get_hub_items"]);
export function isBoxNativeContentRequest(sourceKind: string, externalId: string, toolName: string, args: Record<string, unknown>) {
  const expected = sourceKind === "FILE" ? ["file_id", ["get_file_details", "get_file_content"]]
    : sourceKind === "FOLDER" ? ["folder_id", ["get_folder_details", "list_folder_content_by_folder_id"]]
      : sourceKind === "HUB" ? ["hub_id", ["get_hub_details", "get_hub_items"]] : null;
  return !!expected && BOX_NATIVE_CONTENT_TOOLS.has(toolName) && (expected[1] as string[]).includes(toolName)
    && args[expected[0] as string] === externalId && Object.keys(args).every(key => [expected[0], "fields", "limit"].includes(key));
}

/** Internal transport for the authority module; callers must hold its opaque purpose capability. */
export async function readBoxExternalMcpNativeResponse(params: { actor: AppActor; connectionId: string; workspaceId: string;
  connectionGrantHash: string; toolName: string; arguments: Record<string, unknown> }) {
  params = Object.freeze({ ...params, arguments: structuredClone(params.arguments) });
  const { assertExternalProviderActorCurrent } = await import("./external-provider-authority");
  await assertExternalProviderActorCurrent(params.actor, params.workspaceId, params.connectionId);
  const current = await prisma.externalMcpConnection.findFirst({ where: { id: params.connectionId, workspaceId: params.workspaceId,
    providerKey: "box", status: "ACTIVE" } }) as ExternalMcpConnectionRecord | null;
  invariant(current?.accessTokenEnc && current.providerAccountId && current.serverUrl === EXTERNAL_MCP_PROVIDERS.box.serverUrl
    && externalMcpConnectionGrantHash(current) === params.connectionGrantHash && BOX_NATIVE_CONTENT_TOOLS.has(params.toolName),
  403, "SOURCE_RESTRICTED", "External provider authority is unavailable.");
  try {
    const identity = extractMcpPayload(await callExternalMcpTool(current, "who_am_i", {}));
    invariant(asString(asRecord(identity).id) === current.providerAccountId,
      403, "SOURCE_RESTRICTED", "External provider principal changed.");
    const response = await callExternalMcpTool(current, params.toolName, structuredClone(params.arguments));
    invariant(asRecord(response).isError !== true, 403, "SOURCE_RESTRICTED", "External provider did not return readable content.");
    const payload = extractMcpPayload(response);
    const after = await prisma.externalMcpConnection.findFirst({ where: { id: current.id, workspaceId: params.workspaceId, status: "ACTIVE" } }) as ExternalMcpConnectionRecord | null;
    invariant(after?.accessTokenEnc && externalMcpConnectionGrantHash(after) === params.connectionGrantHash,
      409, "SOURCE_CHANGED", "External provider authority changed during the read.");
    await assertExternalProviderActorCurrent(params.actor, params.workspaceId, params.connectionId);
    return structuredClone(payload);
  } catch {
    throw new AppError(403, "SOURCE_RESTRICTED", "External provider content is unavailable under its current authority.");
  }
}
