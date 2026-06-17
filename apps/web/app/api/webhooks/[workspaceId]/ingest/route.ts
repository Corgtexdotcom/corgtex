import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import {
  AppError,
  processInboundWebhook,
  requireAgentScope,
  requireWorkspaceMembership,
  resolveAgentActorFromBearer,
} from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { rateLimitWebhookIngest } from "@/lib/rate-limit-middleware";

const INBOUND_WEBHOOK_SCOPE = "webhooks:write";

/**
 * Inbound webhook endpoint for external integrations (Slack, calendar, generic).
 *
 * Authentication: a valid agent credential token in the Authorization header
 * with the explicit inbound webhook write scope.
 *
 * POST /api/webhooks/:workspaceId/ingest?source=slack|calendar|generic
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    const { workspaceId } = await params;

    // Rate limit
    const rateLimited = await rateLimitWebhookIngest(request, workspaceId);
    if (rateLimited) return rateLimited;

    const source = request.nextUrl.searchParams.get("source") ?? "generic";

    // Validate workspace exists
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });

    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    // Authenticate via agent credential token
    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHENTICATED", "Missing authorization.");
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      throw new AppError(401, "UNAUTHENTICATED", "Missing authorization.");
    }

    const actor = await resolveAgentActorFromBearer(token);
    if (!actor || actor.kind !== "agent" || actor.authProvider !== "credential") {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid or expired credential.");
    }
    await requireWorkspaceMembership({ actor, workspaceId });
    requireAgentScope(actor, INBOUND_WEBHOOK_SCOPE);

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Process the inbound webhook
    const result = await processInboundWebhook({
      workspaceId,
      source,
      externalId: typeof payload.id === "string" ? payload.id : null,
      payload,
    });

    return NextResponse.json(result, { status: result.eventCreated ? 201 : 200 });
  } catch (error) {
    return handleRouteError(error);
  }
}
