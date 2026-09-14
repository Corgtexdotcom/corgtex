import { NextRequest, NextResponse } from "next/server";
import { listWorkspaceMcpConnections, revokeWorkspaceMcpConnection } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { z } from "zod";

type Context = { params: Promise<{ workspaceId: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { workspaceId } = await params;
    return NextResponse.json(await listWorkspaceMcpConnections(await resolveRequestActor(request), workspaceId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return handleRouteError(error); }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, z.object({ connectionId: z.string().min(1) }));
    await revokeWorkspaceMcpConnection(actor, workspaceId, body.connectionId);
    return new NextResponse(null, { status: 204 });
  } catch (error) { return handleRouteError(error); }
}
