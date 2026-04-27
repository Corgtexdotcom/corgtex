import { createHash } from "node:crypto";
import { prisma, randomOpaqueToken, sha256, env } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { ALL_SCOPES, type AgentScope } from "./agent-auth";

const MCP_CLIENT_PREFIX = "mcp_client_";
const MCP_CODE_PREFIX = "mcp_code_";
const MCP_ACCESS_TOKEN_PREFIX = "mcp_at_";
const MCP_REFRESH_TOKEN_PREFIX = "mcp_rt_";

export const MCP_CONNECTOR_DEFAULT_SCOPES: AgentScope[] = [
  "workspace:read",
  "brain:read",
  "governance:read",
  "meetings:read",
  "proposals:read",
  "actions:read",
  "tensions:read",
  "members:read",
  "circles:read",
  "cycles:read",
  "finance:read",
  "conversations:write",
];

export const MCP_CONNECTOR_READ_ONLY_SCOPES: AgentScope[] = MCP_CONNECTOR_DEFAULT_SCOPES.filter(
  (scope) => scope !== "conversations:write",
);

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

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(cleanString).filter((item): item is string => Boolean(item)))]
    : [];
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
  try {
    const host = new URL(env.APP_URL).hostname.toLowerCase();
    if (host.includes("crina")) return "crina";
  } catch {
    // Ignore malformed env here; APP_URL validation happens where the URL is used.
  }
  return "corgtex";
}

function defaultInstance(): McpConnectorInstance {
  const slug = inferDefaultInstanceSlug();
  return {
    slug,
    displayName: slug === "crina" ? "Crina" : "Corgtex",
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

function validateMcpScopes(scopes: string[] | undefined): AgentScope[] {
  const normalized = normalizeScopes(scopes);
  const effective = normalized.length > 0 ? normalized : MCP_CONNECTOR_DEFAULT_SCOPES;
  const unknown = effective.filter((scope) => !ALL_SCOPES.includes(scope as AgentScope));
  invariant(
    unknown.length === 0,
    400,
    "INVALID_INPUT",
    `Unknown MCP scope(s): ${unknown.join(", ")}.`,
  );
  return effective as AgentScope[];
}

function requestedScopes(scopes: string[] | undefined, allowedScopes: string[]) {
  const normalized = normalizeScopes(scopes);
  const effective = normalized.length > 0 ? normalized : allowedScopes;
  const forbidden = effective.filter((scope) => !allowedScopes.includes(scope));
  invariant(
    forbidden.length === 0,
    400,
    "INVALID_INPUT",
    `Requested MCP scope(s) are not allowed for this client: ${forbidden.join(", ")}.`,
  );
  return effective;
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

export function isAllowedMcpRedirectUri(registeredRedirectUris: string[], redirectUri: string) {
  return registeredRedirectUris.includes(redirectUri);
}

export function getMcpPublicUrl(origin?: string) {
  const base = env.MCP_PUBLIC_URL ?? `${(origin ?? env.APP_URL).replace(/\/$/, "")}/mcp`;
  return base.replace(/\/$/, "");
}

function normalizeMcpResource(resource: string) {
  const parsed = new URL(resource);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed.toString().replace(/\/$/, "");
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
    try {
      new URL(uri);
    } catch {
      throw new AppError(400, "INVALID_INPUT", `Invalid redirect URI: ${uri}`);
    }
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

export async function getMcpOAuthClientByClientId(clientId: string) {
  const client = await prisma.mcpOAuthClient.findUnique({
    where: { clientId },
  });

  if (!client || !client.isActive) {
    throw new AppError(404, "NOT_FOUND", "MCP OAuth client not found or inactive.");
  }

  return client;
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
  await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId });

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
  };
}
