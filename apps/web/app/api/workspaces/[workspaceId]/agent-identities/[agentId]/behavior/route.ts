import { NextRequest, NextResponse } from "next/server";
import { getAgentIdentity, updateAgentBehavior } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteParams = { params: Promise<{ workspaceId: string; agentId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const identity = await getAgentIdentity(actor, workspaceId, agentId);
    return NextResponse.json({ behaviorMd: identity.behaviorMd ?? "" });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const updated = await updateAgentBehavior(actor, {
      workspaceId,
      agentIdentityId: agentId,
      behaviorMd: String(body.behaviorMd ?? ""),
    });
    return NextResponse.json({ behaviorMd: updated.behaviorMd ?? "" });
  } catch (error) {
    return handleRouteError(error);
  }
}
