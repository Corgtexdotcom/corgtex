import { resolveOAuthAccessToken } from "@corgtex/domain";
import { AppError } from "@corgtex/domain";
import { checkRateLimit, RATE_LIMITS } from "@corgtex/shared";
import { NextRequest } from "next/server";

/**
 * Validates a Bearer token from the Authorization header against the OAuthAccessToken table.
 * Returns the actor and workspace context if valid. Throws 401/403 AppError if missing/invalid/insufficient scopes.
 */
export async function requireGptAuth(request: NextRequest, requiredScope?: string) {
  const authHeader = request.headers.get("authorization");
  
  if (!authHeader?.toLowerCase().startsWith("bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "Missing or invalid Authorization header. Expected: Bearer <token>");
  }

  const token = authHeader.substring(7).trim();
  const session = await resolveOAuthAccessToken(token);

  if (!session) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid or expired access token.");
  }

  if (requiredScope && !session.scopes.includes(requiredScope)) {
    throw new AppError(403, "FORBIDDEN", `Missing required scope: ${requiredScope}`);
  }

  const rateLimit = await checkRateLimit(`ws:${session.workspaceId}:gpt-api`, RATE_LIMITS.API_PER_WORKSPACE);
  if (!rateLimit.allowed) {
    throw new AppError(429, "RATE_LIMITED", "GPT API rate limit exceeded.");
  }

  return session;
}
