import { prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";

const DEFAULT_GPT_OAUTH_SCOPES = ["chat", "read", "write"];
const GPT_OAUTH_SCOPES = new Set(DEFAULT_GPT_OAUTH_SCOPES);
const CHATGPT_PLACEHOLDER_REDIRECT_URI = "https://chatgpt.com/aip/g-PLACEHOLDER/oauth/callback";
const CHATGPT_CALLBACK_PATTERN = /^https:\/\/chatgpt\.com\/aip\/g-[A-Za-z0-9_-]+\/oauth\/callback$/;

function normalizeScopes(scopes: string[] | undefined) {
  return [...new Set((scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
}

function normalizeConfiguredScopes(scopes: string[] | undefined) {
  const normalized = normalizeScopes(scopes);
  const effectiveScopes = normalized.length > 0 ? normalized : DEFAULT_GPT_OAUTH_SCOPES;
  const unknownScopes = effectiveScopes.filter((scope) => !GPT_OAUTH_SCOPES.has(scope));

  invariant(
    unknownScopes.length === 0,
    400,
    "INVALID_INPUT",
    `Unknown OAuth scope(s): ${unknownScopes.join(", ")}.`,
  );

  return effectiveScopes;
}

function normalizeRequestedScopes(scopes: string[] | undefined, allowedScopes: string[]) {
  const normalized = normalizeScopes(scopes);
  const effectiveScopes = normalized.length > 0 ? normalized : allowedScopes;
  const forbiddenScopes = effectiveScopes.filter((scope) => !allowedScopes.includes(scope));

  invariant(
    forbiddenScopes.length === 0,
    400,
    "INVALID_INPUT",
    `Requested scope(s) are not allowed for this OAuth app: ${forbiddenScopes.join(", ")}.`,
  );

  return effectiveScopes;
}

export function isAllowedOAuthRedirectUri(registeredRedirectUris: string[], redirectUri: string) {
  if (registeredRedirectUris.includes(redirectUri)) {
    return true;
  }

  return registeredRedirectUris.includes(CHATGPT_PLACEHOLDER_REDIRECT_URI) &&
    CHATGPT_CALLBACK_PATTERN.test(redirectUri);
}

/**
 * Custom GPTs interact with Corgtex via OAuth.
 * This module manages the OAuth provider domain models:
 * - OAuthApp (the Custom GPT registration)
 * - OAuthAuthorizationCode (temporary, exchanged for access tokens)
 * - OAuthAccessToken (the bearer token matching a user to a workspace)
 */

export async function createOAuthApp(actor: AppActor, params: {
  workspaceId: string;
  name: string;
  redirectUris: string[];
  scopes?: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const name = params.name.trim();
  invariant(name.length > 0, 400, "INVALID_INPUT", "App name is required.");

  const redirectUris = params.redirectUris.map(uri => uri.trim()).filter(Boolean);
  invariant(redirectUris.length > 0, 400, "INVALID_INPUT", "At least one redirect URI is required.");

  // For ChatGPT Custom GPTs, default requested scopes usually mirror the MCP
  const scopes = normalizeConfiguredScopes(params.scopes);

  const clientId = `client_${randomOpaqueToken().substring(0, 24)}`;
  const clientSecret = randomOpaqueToken();

  const app = await prisma.oAuthApp.create({
    data: {
      workspaceId: params.workspaceId,
      clientId,
      clientSecret: sha256(clientSecret),
      name,
      redirectUris,
      scopes,
      isActive: true,
    },
  });

  return {
    app,
    clientId: app.clientId,
    clientSecret, // only returned once
  };
}

export async function listOAuthApps(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.oAuthApp.findMany({
    where: { workspaceId, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getOAuthAppByClientId(clientId: string) {
  const app = await prisma.oAuthApp.findUnique({
    where: { clientId },
  });

  if (!app || !app.isActive) {
    throw new AppError(404, "NOT_FOUND", "OAuth app not found or inactive.");
  }

  return app;
}

export async function issueAuthorizationCode(actor: AppActor, params: {
  clientId: string;
  workspaceId: string;
  redirectUri: string;
  scopes: string[];
}) {
  if (actor.kind !== "user") {
    throw new AppError(403, "FORBIDDEN", "Only users can complete OAuth flows");
  }

  const app = await getOAuthAppByClientId(params.clientId);

  // Technically, we could allow cross-workspace auth but for Corgtex Custom GPTs
  // we enforce that the user is authenticating to the workspace where the app is installed.
  if (app.workspaceId !== params.workspaceId) {
    throw new AppError(400, "INVALID_INPUT", "Client ID is not associated with this workspace.");
  }

  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
  });

  if (!isAllowedOAuthRedirectUri(app.redirectUris, params.redirectUri)) {
    throw new AppError(400, "INVALID_INPUT", "Redirect URI is not registered for this app.");
  }

  const scopes = normalizeRequestedScopes(params.scopes, app.scopes);

  const code = `code_${randomOpaqueToken()}`;

  const authCode = await prisma.oAuthAuthorizationCode.create({
    data: {
      appId: app.id,
      userId: actor.user.id,
      workspaceId: params.workspaceId,
      code: sha256(code),
      redirectUri: params.redirectUri,
      scopes,
      // Short expiry (10 mins) as per OAuth best practices
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  return code;
}

export async function exchangeAuthorizationCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}) {
  const app = await getOAuthAppByClientId(params.clientId);

  if (app.clientSecret !== sha256(params.clientSecret)) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid client secret.");
  }

  const codeHash = sha256(params.code);
  const authCode = await prisma.oAuthAuthorizationCode.findUnique({
    where: { code: codeHash },
  });

  if (!authCode) {
    throw new AppError(400, "INVALID_INPUT", "Invalid authorization code.");
  }

  if (authCode.usedAt) {
    // Standard OAuth 2.0 security: if a code is used twice, we should
    // ideally revoke all tokens issued by that code. Keeping it simple below.
    throw new AppError(400, "INVALID_INPUT", "Authorization code already used.");
  }

  if (new Date() > authCode.expiresAt) {
    throw new AppError(400, "INVALID_INPUT", "Authorization code expired.");
  }

  if (authCode.appId !== app.id) {
    throw new AppError(400, "INVALID_INPUT", "Authorization code not issued for this client.");
  }

  if (authCode.redirectUri !== params.redirectUri) {
    throw new AppError(400, "INVALID_INPUT", "Redirect URI mismatch.");
  }

  // Mark code as used
  await prisma.oAuthAuthorizationCode.update({
    where: { id: authCode.id },
    data: { usedAt: new Date() },
  });

  const accessTokenToken = `at_${randomOpaqueToken()}`;
  const refreshTokenToken = `rt_${randomOpaqueToken()}`;

  // 1 hour for access token, 30 days for refresh token
  const expiresInSeconds = 3600;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const tokenParams = {
    appId: app.id,
    userId: authCode.userId,
    workspaceId: authCode.workspaceId,
    tokenHash: sha256(accessTokenToken),
    refreshHash: sha256(refreshTokenToken),
    scopes: authCode.scopes,
    expiresAt,
    refreshExpiresAt,
  };

  // Find any existing token for this user+app+workspace combination and update or create new
  const existingToken = await prisma.oAuthAccessToken.findFirst({
    where: {
      appId: app.id,
      userId: authCode.userId,
      workspaceId: authCode.workspaceId,
    },
  });

  if (existingToken) {
    await prisma.oAuthAccessToken.update({
      where: { id: existingToken.id },
      data: tokenParams,
    });
  } else {
    await prisma.oAuthAccessToken.create({
      data: tokenParams,
    });
  }

  return {
    access_token: accessTokenToken,
    token_type: "bearer",
    expires_in: expiresInSeconds,
    refresh_token: refreshTokenToken,
    scope: authCode.scopes.join(" "),
  };
}

export async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}) {
  const app = await getOAuthAppByClientId(params.clientId);

  // OpenAI doesn't always send client_secret during refresh (it's optional in spec
  // for public clients but we treat our GPT integrations as confidential).
  if (params.clientSecret && app.clientSecret !== sha256(params.clientSecret)) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid client secret.");
  }

  const token = await prisma.oAuthAccessToken.findUnique({
    where: { refreshHash: sha256(params.refreshToken) },
  });

  if (!token || token.revokedAt) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid or revoked refresh token.");
  }

  if (token.refreshExpiresAt && new Date() > token.refreshExpiresAt) {
    throw new AppError(401, "UNAUTHENTICATED", "Refresh token expired.");
  }

  if (token.appId !== app.id) {
    throw new AppError(400, "INVALID_INPUT", "Token not issued for this client.");
  }

  const accessTokenToken = `at_${randomOpaqueToken()}`;
  const refreshTokenToken = `rt_${randomOpaqueToken()}`; // Optional: rotating refresh tokens

  const expiresInSeconds = 3600;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.oAuthAccessToken.update({
    where: { id: token.id },
    data: {
      tokenHash: sha256(accessTokenToken),
      refreshHash: sha256(refreshTokenToken),
      expiresAt,
      refreshExpiresAt,
    },
  });

  return {
    access_token: accessTokenToken,
    token_type: "bearer",
    expires_in: expiresInSeconds,
    refresh_token: refreshTokenToken,
    scope: token.scopes.join(" "),
  };
}

export async function resolveOAuthAccessToken(tokenString: string) {
  const baseToken = await prisma.oAuthAccessToken.findFirst({
    where: { tokenHash: sha256(tokenString) },
  });

  if (!baseToken || baseToken.revokedAt) {
    return null;
  }

  const app = await prisma.oAuthApp.findUnique({
    where: { id: baseToken.appId },
  });

  if (!app) return null;

  const token = { ...baseToken, app };

  if (new Date() > token.expiresAt) {
    return null;
  }

  if (!token.app.isActive) {
    return null;
  }

  // Convert to an AppActor so we can reuse our existing permission logic.
  // We represent them as a user since they are authenticating on behalf of a user.
  // But we could add scopes or oauth properties if needed.
  const user = await prisma.user.findUnique({
    where: { id: token.userId },
  });

  if (!user) return null;

  const actor: AppActor = {
    kind: "user",
    user,
  };

  return {
    actor,
    workspaceId: token.workspaceId,
    scopes: token.scopes,
  };
}
