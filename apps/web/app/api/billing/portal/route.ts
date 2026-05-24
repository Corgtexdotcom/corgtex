import { createStripeBillingPortalSession } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { type NextRequest, NextResponse } from "next/server";

function workspaceIdFromRequest(request: NextRequest) {
  return request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
}

export async function GET(request: NextRequest) {
  try {
    const actor = await requirePageActor();
    const session = await createStripeBillingPortalSession(actor, workspaceIdFromRequest(request));
    if (!session.url) {
      return NextResponse.json({ error: "Stripe billing portal session did not include a URL." }, { status: 502 });
    }
    return NextResponse.redirect(session.url);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requirePageActor();
    const body = await request.json().catch(() => ({})) as { workspaceId?: string };
    const workspaceId = body.workspaceId?.trim() || workspaceIdFromRequest(request);
    const session = await createStripeBillingPortalSession(actor, workspaceId);
    return NextResponse.json(session);
  } catch (error) {
    return handleRouteError(error);
  }
}
