import { disconnectOAuthConnection } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { type NextRequest, NextResponse } from "next/server";

async function workspaceIdFromRequest(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await request.json().catch(() => ({})) as { workspaceId?: string };
    return body.workspaceId?.trim() ?? "";
  }
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    return String(form.get("workspaceId") ?? "").trim();
  }
  return request.nextUrl.searchParams.get("workspaceId")?.trim() ?? "";
}

export async function POST(request: NextRequest, props: { params: Promise<{ connectionId: string }> }) {
  try {
    const actor = await requirePageActor();
    const params = await props.params;
    const workspaceId = await workspaceIdFromRequest(request);
    await disconnectOAuthConnection(actor, {
      workspaceId,
      connectionId: params.connectionId,
    });
    if (request.headers.get("accept")?.includes("text/html")) {
      return NextResponse.redirect(new URL(`/workspaces/${workspaceId}/settings?success=integration_disconnected`, request.url));
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
