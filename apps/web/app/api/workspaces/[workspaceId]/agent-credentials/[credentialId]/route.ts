import { NextRequest, NextResponse } from "next/server";
import { AppError, updateAgentCredentialScopes } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

/**
 * PATCH /api/workspaces/:workspaceId/agent-credentials/:credentialId
 *
 * Update the scope set on an existing credential without rotating the bearer
 * token. The connected client (Claude Desktop / ChatGPT / Cursor) keeps
 * working with its existing token and immediately gains access to the new
 * tools — no reconfiguration required.
 *
 * Request body: { scopes: string[] } — full replacement set, validated
 * against SCOPE_REGISTRY in @corgtex/domain.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; credentialId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, credentialId } = await params;
    const body = (await request.json()) as { scopes?: unknown };
    if (!Array.isArray(body.scopes) || body.scopes.some((value) => typeof value !== "string")) {
      throw new AppError(400, "INVALID_INPUT", "Request body must include scopes: string[].");
    }
    const credential = await updateAgentCredentialScopes(actor, {
      workspaceId,
      credentialId,
      scopes: body.scopes,
    });
    return NextResponse.json({ credential });
  } catch (error) {
    return handleRouteError(error);
  }
}
