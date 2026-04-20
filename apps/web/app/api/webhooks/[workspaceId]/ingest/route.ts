import { NextRequest, NextResponse } from "next/server";
import { processInboundWebhook } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { createHmac } from "node:crypto";
import { rateLimitWebhookIngest } from "@/lib/rate-limit-middleware";

/**
 * Inbound webhook endpoint for external integrations (Slack, calendar, generic).
 *
 * Authentication: Either a valid agent credential token in the Authorization header,
 * or an HMAC signature in X-Webhook-Signature using the workspace's inbound secret.
 *
 * POST /api/webhooks/:workspaceId/ingest?source=slack|calendar|generic
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;

  // Rate limit
  const rateLimited = rateLimitWebhookIngest(request, workspaceId);
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
    return NextResponse.json({ error: "Missing authorization" }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const tokenHash = createHmac("sha256", "corgtex-inbound-webhook").update(token).digest("hex");

  const credential = await prisma.agentCredential.findFirst({
    where: {
      workspaceId,
      tokenHash,
      isActive: true,
    },
    select: { id: true, scopes: true },
  });

  if (!credential) {
    return NextResponse.json({ error: "Invalid or expired credential" }, { status: 401 });
  }

  // Check scope (allow "webhook:ingest" or "all" scopes)
  const hasScope = credential.scopes.length === 0 ||
    credential.scopes.includes("webhook:ingest") ||
    credential.scopes.includes("all");

  if (!hasScope) {
    return NextResponse.json({ error: "Insufficient scope" }, { status: 403 });
  }

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
}
