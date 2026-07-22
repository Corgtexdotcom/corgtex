import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { prisma, randomOpaqueToken, sha256, env } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { ALL_SCOPES, type AgentScope } from "./agent-auth";
import type { AiWorkspaceProviderKey } from "./ai-workspaces";

const MCP_CLIENT_PREFIX = "mcp_client_";
const MCP_CODE_PREFIX = "mcp_code_";
const MCP_ACCESS_TOKEN_PREFIX = "mcp_at_";
const MCP_REFRESH_TOKEN_PREFIX = "mcp_rt_";
const MCP_OAUTH_PROVIDER_HOSTS: Array<{ providerKey: McpOAuthProviderKey; hosts: string[] }> = [
  { providerKey: "openwork", hosts: ["openworklabs.com"] },
  { providerKey: "chatgpt", hosts: ["chatgpt.com", "chat.openai.com", "openai.com"] },
  { providerKey: "claude", hosts: ["claude.ai", "anthropic.com"] },
  { providerKey: "copilot", hosts: ["github.com", "githubcopilot.com", "visualstudio.com"] },
  { providerKey: "gemini", hosts: ["google.com", "googleusercontent.com", "gemini.google.com"] },
  { providerKey: "cursor", hosts: ["cursor.com", "anysphere.co"] },
];

const MCP_OAUTH_PROVIDER_NAME_MATCHERS: Array<{ providerKey: McpOAuthProviderKey; pattern: RegExp }> = [
  { providerKey: "openwork", pattern: /\bopen\s*work\b|\bopenwork\b/i },
  { providerKey: "chatgpt", pattern: /\bchatgpt\b|\bopenai\b/i },
  { providerKey: "claude", pattern: /\bclaude\b|\banthropic\b/i },
  { providerKey: "copilot", pattern: /\bcopilot\b|\bgithub\b|\bvs\s*code\b|\bvisual\s*studio\b/i },
  { providerKey: "gemini", pattern: /\bgemini\b|\bgoogle\b/i },
  { providerKey: "cursor", pattern: /\bcursor\b|\banysphere\b/i },
];

export type McpOAuthProviderKey = Extract<
  AiWorkspaceProviderKey,
  "openwork" | "chatgpt" | "claude" | "copilot" | "gemini" | "cursor" | "generic_mcp"
>;

export type McpOAuthConnectionStatus = {
  providerKey: McpOAuthProviderKey;
  connected: boolean;
  connectedAt: Date | null;
  source: "mcp_oauth" | null;
  clientName: string | null;
};

export const MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES: AgentScope[] = [
  "workspace:read",
  "brain:read",
  "governance:read",
  "meetings:read",
  "proposals:read",
  "actions:read",
  "tensions:read",
  "members:read",
  "circles:read",
  "finance:read",
  "conversations:write",
];

const MCP_CONNECTOR_PRE_ACTION_PROPOSAL_WRITE_DEFAULT_SCOPES: AgentScope[] = [
  "workspace:read",
  "brain:read",
  "governance:read",
  "context-graph:read",
  "proposals:read",
  "actions:read",
  "tensions:read",
  "goals:read",
  "members:read",
  "meetings:read",
  "circles:read",
  "tools:read",
  "conversations:write",
];

export const MCP_CONNECTOR_DEFAULT_SCOPES: AgentScope[] = [
  "workspace:read",
  "brain:read",
  "governance:read",
  "context-graph:read",
  "proposals:read",
  "proposals:write",
  "actions:read",
  "actions:write",
  "tensions:read",
  "goals:read",
  "members:read",
  "meetings:read",
  "circles:read",
  "tools:read",
  "conversations:write",
];

export const MCP_CONNECTOR_READ_ONLY_SCOPES: AgentScope[] = MCP_CONNECTOR_DEFAULT_SCOPES.filter(
  (scope) => !scope.endsWith(":write"),
);

export const MCP_OAUTH_PROTOCOL_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

const MCP_OAUTH_PROTOCOL_SCOPE_SET = new Set<string>(MCP_OAUTH_PROTOCOL_SCOPES);

const MCP_USER_DELEGATION_FORBIDDEN_SCOPES = new Set<AgentScope>([
  "context-graph:approve",
  "support:write",
  "tools:credentials:read",
  "webhooks:write",
]);

const CIMD_METADATA_TIMEOUT_MS = 3_000;
const CIMD_METADATA_MAX_BYTES = 64 * 1024;

type InstanceStatus = "active" | "disabled";

export type McpConnectorInstance = {
  slug: string;
  displayName: string;
  baseUrl: string;
  workspaceIds: string[];
  workspaceSlugs: string[];
  status: InstanceStatus;
};

type RegistryEntry = {
  slug?: unknown;
  displayName?: unknown;
  baseUrl?: unknown;
  workspaceIds?: unknown;
  workspaceSlugs?: unknown;
  status?: unknown;
};

type McpConnectionClientSnapshot = {
  name: string;
  redirectUris: string[];
  isActive: boolean;
};

type McpConnectionTokenSnapshot = {
  userId: string;
  workspaceId: string;
  instanceSlug: string;
  refreshHash: string | null;
  refreshExpiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client: McpConnectionClientSnapshot;
};

type McpConnectionTokenWithClient = McpConnectionTokenSnapshot & {
  client: McpConnectionClientSnapshot & {
    clientId?: string | null;
  };
};

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(cleanString).filter((item): item is string => Boolean(item)))]
    : [];
}

function uriMatchesHost(uri: string, host: string) {
  try {
    const hostname = new URL(uri).hostname.toLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return uri.toLowerCase().includes(host);
  }
}

export function inferMcpOAuthProviderKey(client: McpConnectionClientSnapshot): McpOAuthProviderKey {
  const name = client.name.trim();
  for (const matcher of MCP_OAUTH_PROVIDER_NAME_MATCHERS) {
    if (matcher.pattern.test(name)) return matcher.providerKey;
  }

  for (const entry of MCP_OAUTH_PROVIDER_HOSTS) {
    if (client.redirectUris.some((uri) => entry.hosts.some((host) => uriMatchesHost(uri, host)))) {
      return entry.providerKey;
    }
  }

  return "generic_mcp";
}

function isRefreshableActiveToken(token: McpConnectionTokenSnapshot, params: {
  userId: string;
  workspaceId: string;
  now: Date;
}) {
  return token.userId === params.userId &&
    token.workspaceId === params.workspaceId &&
    token.client.isActive &&
    !token.revokedAt &&
    token.refreshHash !== null &&
    (!token.refreshExpiresAt || token.refreshExpiresAt > params.now) &&
    Boolean(getMcpConnectorInstance(token.instanceSlug));
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function inferDefaultInstanceSlug() {
  if (env.MCP_DEFAULT_INSTANCE_SLUG) return env.MCP_DEFAULT_INSTANCE_SLUG;
  if (env.WORKSPACE_SLUG) return env.WORKSPACE_SLUG;
  return "corgtex";
}

function defaultInstance(): McpConnectorInstance {
  const slug = inferDefaultInstanceSlug();
  return {
    slug,
    displayName: slug.charAt(0).toUpperCase() + slug.slice(1),
    baseUrl: normalizeBaseUrl(env.APP_URL),
    workspaceIds: [],
    workspaceSlugs: env.WORKSPACE_SLUG ? [env.WORKSPACE_SLUG] : [],
    status: "active",
  };
}

function normalizeRegistryEntry(entry: RegistryEntry): McpConnectorInstance | null {
  const slug = cleanString(entry.slug);
  const baseUrl = cleanString(entry.baseUrl);
  if (!slug || !baseUrl) return null;

  const status = entry.status === "disabled" ? "disabled" : "active";
  return {
    slug,
    displayName: cleanString(entry.displayName) ?? slug,
    baseUrl: normalizeBaseUrl(baseUrl),
    workspaceIds: cleanStringArray(entry.workspaceIds),
    workspaceSlugs: cleanStringArray(entry.workspaceSlugs),
    status,
  };
}

export function listMcpConnectorInstances(): McpConnectorInstance[] {
  const raw = env.MCP_INSTANCE_REGISTRY;
  if (!raw) {
    return [defaultInstance()];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(500, "INVALID_MCP_INSTANCE_REGISTRY", "MCP_INSTANCE_REGISTRY must be valid JSON.");
  }

  const entries = Array.isArray(parsed) ? parsed : [];
  const normalized = entries
    .map((entry) => normalizeRegistryEntry(entry as RegistryEntry))
    .filter((entry): entry is McpConnectorInstance => Boolean(entry));

  return normalized.length > 0 ? normalized : [defaultInstance()];
}

export function getMcpConnectorInstance(slug: string) {
  return listMcpConnectorInstances().find((instance) => instance.slug === slug && instance.status === "active") ?? null;
}

export async function listMcpOAuthConnectionStatuses(params: {
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<McpOAuthConnectionStatus[]> {
  const now = params.now ?? new Date();
  const tokens = await prisma.mcpOAuthAccessToken.findMany({
    where: {
      userId: params.userId,
      workspaceId: params.workspaceId,
      revokedAt: null,
      refreshHash: { not: null },
      OR: [
        { refreshExpiresAt: null },
        { refreshExpiresAt: { gt: now } },
      ],
    },
    select: {
      userId: true,
      workspaceId: true,
      instanceSlug: true,
      refreshHash: true,
      refreshExpiresAt: true,
      revokedAt: true,
      createdAt: true,
      updatedAt: true,
      client: {
        select: {
          clientId: true,
          name: true,
          redirectUris: true,
          isActive: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  }) as McpConnectionTokenWithClient[];

  const byProvider = new Map<McpOAuthProviderKey, McpOAuthConnectionStatus>();
  for (const token of tokens) {
    if (!isRefreshableActiveToken(token, {
      userId: params.userId,
      workspaceId: params.workspaceId,
      now,
    })) {
      continue;
    }

    const providerKey = inferMcpOAuthProviderKey(token.client);
    if (byProvider.has(providerKey)) continue;

    byProvider.set(providerKey, {
      providerKey,
      connected: true,
      connectedAt: token.updatedAt ?? token.createdAt ?? null,
      source: "mcp_oauth",
      clientName: token.client.name || null,
    });
  }

  return [...byProvider.values()];
}

export async function getMcpOAuthConnectionStatus(params: {
  userId: string;
  workspaceId: string;
  providerKey: McpOAuthProviderKey;
  now?: Date;
}): Promise<McpOAuthConnectionStatus> {
  const statuses = await listMcpOAuthConnectionStatuses(params);
  return statuses.find((status) => status.providerKey === params.providerKey) ?? {
    providerKey: params.providerKey,
    connected: false,
    connectedAt: null,
    source: null,
    clientName: null,
  };
}

export async function getClaudeMcpConnectionStatus(params: {
  userId: string;
  workspaceId: string;
  now?: Date;
}): Promise<{ connected: boolean; connectedAt: Date | null }> {
  const connection = await getMcpOAuthConnectionStatus({ ...params, providerKey: "claude" });
  return {
    connected: connection.connected,
    connectedAt: connection.connectedAt,
  };
}

export async function resolveMcpConnectorInstanceForWorkspace(workspaceId: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, slug: true },
  });
  if (!workspace) {
    throw new AppError(404, "NOT_FOUND", "Workspace not found.");
  }

  const instances = listMcpConnectorInstances().filter((instance) => instance.status === "active");
  const explicit = instances.find((instance) => {
    return instance.workspaceIds.includes(workspace.id) || instance.workspaceSlugs.includes(workspace.slug);
  });
  if (explicit) return explicit;

  const unrestrictedDefault = instances.find(
    (instance) => instance.workspaceIds.length === 0 && instance.workspaceSlugs.length === 0,
  );
  if (unrestrictedDefault) return unrestrictedDefault;

  throw new AppError(403, "FORBIDDEN", "This workspace is not registered for the Corgtex connector.");
}

function normalizeScopes(scopes: string[] | undefined) {
  return [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
}

function normalizeMcpPermissionScopes(
  scopes: string[] | undefined,
  fallbackScopes: AgentScope[] = MCP_CONNECTOR_DEFAULT_SCOPES,
): AgentScope[] {
  const normalized = normalizeScopes(scopes);
  const permissionScopes = normalized.filter((scope) => !MCP_OAUTH_PROTOCOL_SCOPE_SET.has(scope));
  const effective = permissionScopes.length > 0 ? permissionScopes : fallbackScopes;
  const unknown = effective.filter((scope) => !ALL_SCOPES.includes(scope as AgentScope));
  invariant(
    unknown.length === 0,
    400,
    "INVALID_INPUT",
    `Unknown MCP scope(s): ${unknown.join(", ")}.`,
  );
  const forbidden = effective.filter((scope) => MCP_USER_DELEGATION_FORBIDDEN_SCOPES.has(scope as AgentScope));
  invariant(
    forbidden.length === 0,
    400,
    "INVALID_INPUT",
    `MCP OAuth user delegation cannot request sensitive/support-only scope(s): ${forbidden.join(", ")}.`,
  );
  return effective as AgentScope[];
}

function validateMcpScopes(scopes: string[] | undefined): AgentScope[] {
  return normalizeMcpPermissionScopes(scopes);
}

function hasSameScopeSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((scope) => rightSet.has(scope));
}

export function resolveMcpClientAllowedScopes(scopes: string[]): AgentScope[] {
  const normalized = normalizeMcpPermissionScopes(scopes, MCP_CONNECTOR_DEFAULT_SCOPES);
  const matchesHistoricalDefault = [
    MCP_CONNECTOR_LEGACY_DEFAULT_SCOPES,
    MCP_CONNECTOR_PRE_ACTION_PROPOSAL_WRITE_DEFAULT_SCOPES,
  ].some((defaultScopes) => hasSameScopeSet(normalized, defaultScopes));

  const allowed = matchesHistoricalDefault ? MCP_CONNECTOR_DEFAULT_SCOPES : (normalized as AgentScope[]);
  return allowed.filter((scope) => !MCP_USER_DELEGATION_FORBIDDEN_SCOPES.has(scope));
}

function requestedScopes(scopes: string[] | undefined, allowedScopes: string[]) {
  const effectiveAllowedScopes = resolveMcpClientAllowedScopes(allowedScopes);
  const effective = normalizeMcpPermissionScopes(scopes, effectiveAllowedScopes);
  const canStepUpFromBaseline = hasSameScopeSet(effectiveAllowedScopes, MCP_CONNECTOR_DEFAULT_SCOPES);
  const forbidden = canStepUpFromBaseline
    ? []
    : effective.filter((scope) => !effectiveAllowedScopes.includes(scope as AgentScope));
  invariant(
    forbidden.length === 0,
    400,
    "INVALID_INPUT",
    `Requested MCP scope(s) are not allowed for this client: ${forbidden.join(", ")}.`,
  );
  return effective;
}

function normalizedHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isLoopbackHostname(hostname: string) {
  const normalized = normalizedHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isLoopbackRedirectUrl(url: URL) {
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

function validateMcpRedirectUri(uri: string) {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new AppError(400, "INVALID_INPUT", `Invalid redirect URI: ${uri}`);
  }

  if (parsed.hash) {
    throw new AppError(400, "INVALID_INPUT", `Redirect URI must not include a fragment: ${uri}`);
  }

  if (parsed.protocol === "https:" || isLoopbackRedirectUrl(parsed)) {
    return parsed.toString();
  }

  throw new AppError(400, "INVALID_INPUT", `Redirect URI must use HTTPS or localhost HTTP: ${uri}`);
}

function isBlockedIpv4Address(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function isBlockedIpv6Address(address: string) {
  const normalized = normalizedHostname(address);
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }

  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return mappedIpv4 ? isBlockedIpv4Address(mappedIpv4) : false;
}

function isBlockedNetworkAddress(address: string) {
  const normalized = normalizedHostname(address);
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isBlockedIpv4Address(normalized);
  if (ipVersion === 6) return isBlockedIpv6Address(normalized);
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

function parseCimdClientId(clientId: string) {
  let parsed: URL;
  try {
    parsed = new URL(clientId);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" || parsed.hash || parsed.username || parsed.password) {
    return null;
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    return null;
  }
  return parsed;
}

export function isCimdMcpClientId(clientId: string) {
  return Boolean(parseCimdClientId(clientId));
}

async function assertSafeCimdMetadataUrl(url: URL) {
  if (isBlockedNetworkAddress(url.hostname)) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata URL must not target localhost or private networks.");
  }

  const hostname = normalizedHostname(url.hostname);
  if (isIP(hostname)) return;

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata host could not be resolved.");
  }

  if (records.length === 0 || records.some((record) => isBlockedNetworkAddress(record.address))) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata host resolves to localhost or a private network.");
  }
}

async function readLimitedResponseText(response: Response, maxBytes: number) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document is too large.");
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchCimdMetadataDocument(clientId: string) {
  const parsedUrl = parseCimdClientId(clientId);
  if (!parsedUrl) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client_id must be an HTTPS metadata document URL with a path.");
  }
  const url = parsedUrl;
  await assertSafeCimdMetadataUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CIMD_METADATA_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Accept": "application/json, application/*+json",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      throw new AppError(400, "INVALID_INPUT", "CIMD client metadata redirects are not allowed.");
    }
    if (!response.ok) {
      throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document could not be fetched.");
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("json")) {
      throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document must be JSON.");
    }

    const text = await readLimitedResponseText(response, CIMD_METADATA_MAX_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document is not valid JSON.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document could not be fetched.");
  } finally {
    clearTimeout(timeout);
  }
}

type CimdMetadataDocument = {
  client_id?: unknown;
  client_name?: unknown;
  redirect_uris?: unknown;
  scope?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
};

function optionalMetadataStringArray(value: unknown, label: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AppError(400, "INVALID_INPUT", `CIMD client metadata ${label} must be an array of strings.`);
  }
  return cleanStringArray(value);
}

function validateCimdMetadata(clientId: string, metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata document must be a JSON object.");
  }

  const document = metadata as CimdMetadataDocument;
  if (cleanString(document.client_id) !== clientId) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata client_id must exactly match the metadata URL.");
  }

  const redirectUris = cleanStringArray(document.redirect_uris);
  if (redirectUris.length === 0) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata must include at least one redirect URI.");
  }
  for (const uri of redirectUris) {
    validateMcpRedirectUri(uri);
  }

  const grantTypes = optionalMetadataStringArray(document.grant_types, "grant_types");
  if (grantTypes.length > 0 && !grantTypes.includes("authorization_code")) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata must support the authorization_code grant.");
  }

  const responseTypes = optionalMetadataStringArray(document.response_types, "response_types");
  if (responseTypes.length > 0 && !responseTypes.includes("code")) {
    throw new AppError(400, "INVALID_INPUT", "CIMD client metadata must support the code response type.");
  }

  const tokenEndpointAuthMethod = cleanString(document.token_endpoint_auth_method) ?? "none";
  if (tokenEndpointAuthMethod !== "none") {
    throw new AppError(400, "INVALID_INPUT", "CIMD clients must use token_endpoint_auth_method \"none\" in this release.");
  }

  const scope = cleanString(document.scope);
  return {
    name: cleanString(document.client_name) ?? "MCP metadata client",
    redirectUris,
    scopes: validateMcpScopes(scope ? scope.split(/\s+/) : undefined),
    tokenEndpointAuthMethod,
  };
}

function pkceS256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function verifyPkce(params: {
  verifier: string;
  challenge: string;
  method: string;
}) {
  if (params.method !== "S256") {
    throw new AppError(400, "INVALID_INPUT", "Only S256 PKCE is supported for MCP connector clients.");
  }
  if (pkceS256(params.verifier) !== params.challenge) {
    throw new AppError(400, "INVALID_INPUT", "Invalid PKCE code verifier.");
  }
}

async function hasActiveMcpWorkspaceMembership(params: {
  userId: string;
  workspaceId: string;
}) {
  const membership = await prisma.member.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: params.workspaceId,
        userId: params.userId,
      },
    },
    select: {
      id: true,
      isActive: true,
    },
  });

  return Boolean(membership?.isActive);
}

async function requireActiveMcpWorkspaceMembership(params: {
  userId: string;
  workspaceId: string;
}) {
  if (!(await hasActiveMcpWorkspaceMembership(params))) {
    throw new AppError(403, "NOT_A_MEMBER", "You are not an active member of this workspace.");
  }
}

export function isAllowedMcpRedirectUri(registeredRedirectUris: string[], redirectUri: string) {
  if (registeredRedirectUris.includes(redirectUri)) return true;

  let requested: URL;
  try {
    requested = new URL(redirectUri);
  } catch {
    return false;
  }

  return registeredRedirectUris.some((uri) => {
    try {
      const registered = new URL(uri);
      if (!isLoopbackRedirectUrl(registered) || !isLoopbackRedirectUrl(requested)) return false;
      return registered.protocol === requested.protocol &&
        registered.hostname === requested.hostname &&
        registered.pathname === requested.pathname &&
        registered.search === requested.search;
    } catch {
      return false;
    }
  });
}

export function getMcpPublicUrl(origin?: string) {
  const base = env.MCP_PUBLIC_URL ?? `${(origin ?? env.APP_URL).replace(/\/$/, "")}/mcp`;
  return base.replace(/\/$/, "");
}

function normalizeMcpResource(resource: string) {
  try {
    const parsed = new URL(resource);
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new AppError(400, "INVALID_INPUT", "MCP OAuth resource must be a valid URL.");
  }
}

export function areEquivalentMcpResources(storedResource: string, requestedResource: string) {
  const stored = normalizeMcpResource(storedResource);
  const requested = normalizeMcpResource(requestedResource);
  if (stored === requested) return true;

  const storedUrl = new URL(stored);
  const requestedUrl = new URL(requested);
  const mcpPaths = new Set(["/mcp", "/api/mcp"]);
  return storedUrl.origin === requestedUrl.origin &&
    mcpPaths.has(storedUrl.pathname) &&
    mcpPaths.has(requestedUrl.pathname);
}

export async function registerMcpOAuthClient(params: {
  name?: string;
  redirectUris: string[];
  scopes?: string[];
}) {
  const redirectUris = params.redirectUris.map((uri) => uri.trim()).filter(Boolean);
  invariant(redirectUris.length > 0, 400, "INVALID_INPUT", "At least one redirect URI is required.");
  for (const uri of redirectUris) {
    validateMcpRedirectUri(uri);
  }

  const clientId = `${MCP_CLIENT_PREFIX}${randomOpaqueToken(18)}`;
  const client = await prisma.mcpOAuthClient.create({
    data: {
      clientId,
      name: params.name?.trim() || "Corgtex connector client",
      redirectUris,
      scopes: validateMcpScopes(params.scopes),
      tokenEndpointAuthMethod: "none",
      isActive: true,
    },
  });

  return {
    client,
    client_id: client.clientId,
    client_name: client.name,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scopes.join(" "),
  };
}

async function getOrCreateCimdMcpOAuthClient(clientId: string) {
  const metadata = await fetchCimdMetadataDocument(clientId);
  const validated = validateCimdMetadata(clientId, metadata);

  const client = await prisma.mcpOAuthClient.upsert({
    where: { clientId },
    create: {
      clientId,
      name: validated.name,
      redirectUris: validated.redirectUris,
      scopes: validated.scopes,
      tokenEndpointAuthMethod: "none",
      isActive: true,
    },
    update: {
      name: validated.name,
      redirectUris: validated.redirectUris,
      scopes: validated.scopes,
      tokenEndpointAuthMethod: "none",
    },
  });

  if (!client.isActive) {
    throw new AppError(404, "NOT_FOUND", "MCP OAuth client not found or inactive.");
  }

  return client;
}

export async function getMcpOAuthClientByClientId(clientId: string) {
  const client = await prisma.mcpOAuthClient.findUnique({
    where: { clientId },
  });

  if (client?.isActive) {
    return client;
  }

  if (client) {
    throw new AppError(404, "NOT_FOUND", "MCP OAuth client not found or inactive.");
  }

  if (isCimdMcpClientId(clientId)) {
    return getOrCreateCimdMcpOAuthClient(clientId);
  }

  throw new AppError(404, "NOT_FOUND", "MCP OAuth client not found or inactive.");
}

export async function issueMcpAuthorizationCode(actor: AppActor, params: {
  clientId: string;
  workspaceId: string;
  redirectUri: string;
  scopes?: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string | null;
}) {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "Only users can complete MCP connector OAuth flows.");
  }

  const client = await getMcpOAuthClientByClientId(params.clientId);
  await requireActiveMcpWorkspaceMembership({ userId: actor.user.id, workspaceId: params.workspaceId });

  if (!isAllowedMcpRedirectUri(client.redirectUris, params.redirectUri)) {
    throw new AppError(400, "INVALID_INPUT", "Redirect URI is not registered for this MCP client.");
  }

  invariant(params.codeChallenge.length > 0, 400, "INVALID_INPUT", "PKCE code_challenge is required.");
  invariant(params.codeChallengeMethod === "S256", 400, "INVALID_INPUT", "PKCE code_challenge_method must be S256.");

  const instance = await resolveMcpConnectorInstanceForWorkspace(params.workspaceId);
  const resource = params.resource ? normalizeMcpResource(params.resource) : getMcpPublicUrl();
  const scopes = requestedScopes(params.scopes, client.scopes);
  const code = `${MCP_CODE_PREFIX}${randomOpaqueToken()}`;

  await prisma.mcpOAuthAuthorizationCode.create({
    data: {
      clientId: client.id,
      userId: actor.user.id,
      workspaceId: params.workspaceId,
      instanceSlug: instance.slug,
      code: sha256(code),
      redirectUri: params.redirectUri,
      scopes,
      resource,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  return code;
}

export async function exchangeMcpAuthorizationCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string | null;
}) {
  const client = await getMcpOAuthClientByClientId(params.clientId);
  const authCode = await prisma.mcpOAuthAuthorizationCode.findUnique({
    where: { code: sha256(params.code) },
  });

  if (!authCode) {
    throw new AppError(400, "INVALID_INPUT", "Invalid authorization code.");
  }
  if (authCode.usedAt) {
    throw new AppError(400, "INVALID_INPUT", "Authorization code already used.");
  }
  if (new Date() > authCode.expiresAt) {
    throw new AppError(400, "INVALID_INPUT", "Authorization code expired.");
  }
  if (authCode.clientId !== client.id) {
    throw new AppError(400, "INVALID_INPUT", "Authorization code not issued for this client.");
  }
  if (authCode.redirectUri !== params.redirectUri) {
    throw new AppError(400, "INVALID_INPUT", "Redirect URI mismatch.");
  }
  if (params.resource && authCode.resource && !areEquivalentMcpResources(authCode.resource, params.resource)) {
    throw new AppError(400, "INVALID_INPUT", "Resource parameter mismatch.");
  }

  verifyPkce({
    verifier: params.codeVerifier,
    challenge: authCode.codeChallenge,
    method: authCode.codeChallengeMethod,
  });

  const instance = getMcpConnectorInstance(authCode.instanceSlug);
  if (!instance) {
    throw new AppError(403, "FORBIDDEN", "The target Corgtex instance is no longer registered.");
  }
  await requireActiveMcpWorkspaceMembership({ userId: authCode.userId, workspaceId: authCode.workspaceId });

  await prisma.mcpOAuthAuthorizationCode.update({
    where: { id: authCode.id },
    data: { usedAt: new Date() },
  });

  const accessToken = `${MCP_ACCESS_TOKEN_PREFIX}${randomOpaqueToken()}`;
  const refreshToken = `${MCP_REFRESH_TOKEN_PREFIX}${randomOpaqueToken()}`;
  const expiresInSeconds = 3600;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const existingToken = await prisma.mcpOAuthAccessToken.findFirst({
    where: {
      clientId: client.id,
      userId: authCode.userId,
      workspaceId: authCode.workspaceId,
      instanceSlug: authCode.instanceSlug,
    },
  });

  const tokenParams = {
    clientId: client.id,
    userId: authCode.userId,
    workspaceId: authCode.workspaceId,
    instanceSlug: authCode.instanceSlug,
    tokenHash: sha256(accessToken),
    refreshHash: sha256(refreshToken),
    scopes: authCode.scopes,
    resource: authCode.resource,
    expiresAt,
    refreshExpiresAt,
    revokedAt: null,
  };

  if (existingToken) {
    await prisma.mcpOAuthAccessToken.update({
      where: { id: existingToken.id },
      data: tokenParams,
    });
  } else {
    await prisma.mcpOAuthAccessToken.create({
      data: tokenParams,
    });
  }

  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: expiresInSeconds,
    refresh_token: refreshToken,
    scope: authCode.scopes.join(" "),
  };
}

export async function refreshMcpAccessToken(params: {
  refreshToken: string;
  clientId: string;
}) {
  const client = await getMcpOAuthClientByClientId(params.clientId);
  const token = await prisma.mcpOAuthAccessToken.findUnique({
    where: { refreshHash: sha256(params.refreshToken) },
  });

  if (!token || token.revokedAt) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid or revoked refresh token.");
  }
  if (token.clientId !== client.id) {
    throw new AppError(400, "INVALID_INPUT", "Token not issued for this client.");
  }
  if (token.refreshExpiresAt && new Date() > token.refreshExpiresAt) {
    throw new AppError(401, "UNAUTHENTICATED", "Refresh token expired.");
  }
  if (!getMcpConnectorInstance(token.instanceSlug)) {
    throw new AppError(403, "FORBIDDEN", "The target Corgtex instance is no longer registered.");
  }
  await requireActiveMcpWorkspaceMembership({ userId: token.userId, workspaceId: token.workspaceId });

  const accessToken = `${MCP_ACCESS_TOKEN_PREFIX}${randomOpaqueToken()}`;
  const refreshToken = `${MCP_REFRESH_TOKEN_PREFIX}${randomOpaqueToken()}`;
  const expiresInSeconds = 3600;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.mcpOAuthAccessToken.update({
    where: { id: token.id },
    data: {
      tokenHash: sha256(accessToken),
      refreshHash: sha256(refreshToken),
      expiresAt,
      refreshExpiresAt,
      revokedAt: null,
    },
  });

  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: expiresInSeconds,
    refresh_token: refreshToken,
    scope: token.scopes.join(" "),
  };
}

export async function revokeMcpToken(params: {
  token: string;
  clientId?: string;
}) {
  const tokenHash = sha256(params.token);
  const token = await prisma.mcpOAuthAccessToken.findFirst({
    where: {
      OR: [{ tokenHash }, { refreshHash: tokenHash }],
    },
  });

  if (!token) return;
  if (params.clientId) {
    const client = await getMcpOAuthClientByClientId(params.clientId);
    if (token.clientId !== client.id) return;
  }

  await prisma.mcpOAuthAccessToken.update({
    where: { id: token.id },
    data: { revokedAt: new Date() },
  });
}

export async function resolveMcpOAuthAccessToken(tokenString: string, expectedResource?: string | null) {
  const token = await prisma.mcpOAuthAccessToken.findUnique({
    where: { tokenHash: sha256(tokenString) },
    include: {
      client: true,
      user: true,
    },
  });

  if (!token || token.revokedAt || !token.client.isActive) {
    return null;
  }
  if (new Date() > token.expiresAt) {
    return null;
  }
  if (expectedResource && token.resource && !areEquivalentMcpResources(token.resource, expectedResource)) {
    return null;
  }
  if (!getMcpConnectorInstance(token.instanceSlug)) {
    return null;
  }
  if (!(await hasActiveMcpWorkspaceMembership({ userId: token.userId, workspaceId: token.workspaceId }))) {
    return null;
  }

  return {
    actor: {
      kind: "user" as const,
      user: {
        id: token.user.id,
        email: token.user.email,
        displayName: token.user.displayName,
        globalRole: token.user.globalRole,
      },
    },
    workspaceId: token.workspaceId,
    scopes: token.scopes,
    instanceSlug: token.instanceSlug,
    resource: token.resource,
    clientId: token.client.clientId,
    clientName: token.client.name,
    providerKey: inferMcpOAuthProviderKey(token.client),
  };
}
