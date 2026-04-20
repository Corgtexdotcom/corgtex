import type { AppActor } from "@corgtex/shared";
import { env } from "@corgtex/shared";
import { resolveAgentActorFromBearer, describeScope } from "@corgtex/domain";
import { AppError } from "@corgtex/domain";

/**
 * Context attached to each MCP session after authentication.
 */
export type McpSessionContext = {
  actor: AppActor;
  workspaceId: string;
};

/**
 * Build the workspace settings deep-link the user should visit to fix a
 * scope problem. Falls back to a relative path when the public origin
 * env var is missing — clients still get something clickable.
 */
function settingsUrl(workspaceId: string): string {
  const origin = env.APP_URL.replace(/\/$/, "");
  return `${origin}/workspaces/${workspaceId}/settings?tab=general`;
}

/**
 * Extract a bearer token from an Authorization header value,
 * resolve it to an AppActor, and derive the workspace scope.
 *
 * Returns the session context that every MCP tool / resource handler receives.
 */
export async function authenticateMcpRequest(authorizationHeader: string | null): Promise<McpSessionContext> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHENTICATED", "Missing or invalid Authorization header. Use: Bearer <token>");
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new AppError(401, "UNAUTHENTICATED", "Empty bearer token.");
  }

  const actor = await resolveAgentActorFromBearer(token);
  if (!actor) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid or expired agent credential.");
  }

  if (actor.kind !== "agent") {
    throw new AppError(403, "FORBIDDEN", "MCP access requires an agent credential.");
  }

  // Agent credentials are scoped to exactly one workspace
  const workspaceId = actor.workspaceIds?.[0];
  if (!workspaceId) {
    throw new AppError(403, "FORBIDDEN", "Agent credential is not scoped to any workspace.");
  }

  return { actor, workspaceId };
}

/**
 * Check whether the session's credential has the required scope.
 * Bootstrap agents (AGENT_API_KEY) bypass scope checks.
 */
export function requireScope(ctx: McpSessionContext, scope: string): void {
  if (ctx.actor.kind !== "agent") {
    return;
  }

  // Bootstrap agents have no scope restrictions
  if (ctx.actor.authProvider === "bootstrap") {
    return;
  }

  // Credential agents must have the scope explicitly
  if (ctx.actor.scopes && !ctx.actor.scopes.includes(scope)) {
    const label = ctx.actor.label ?? "this credential";
    const url = settingsUrl(ctx.workspaceId);
    const purpose = describeScope(scope);
    throw new AppError(
      403,
      "FORBIDDEN",
      [
        `Agent credential is missing the required scope: ${scope} (${purpose})`,
        `Credential: "${label}".`,
        `An admin can grant this scope without you needing to reconnect — open ${url} and click "Grant missing".`,
      ].join(" "),
    );
  }
}
