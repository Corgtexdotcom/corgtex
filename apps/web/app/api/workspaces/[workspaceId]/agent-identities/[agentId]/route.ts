import { NextRequest, NextResponse } from "next/server";
import { getAgentIdentity, updateAgentIdentity, deactivateAgentIdentity } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type RouteParams = { params: Promise<{ workspaceId: string; agentId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const identity = await getAgentIdentity(actor, workspaceId, agentId);
    return NextResponse.json(identity);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const updated = await updateAgentIdentity(actor, {
      workspaceId,
      agentIdentityId: agentId,
      ...(body.displayName !== undefined && { displayName: String(body.displayName) }),
      ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl != null ? String(body.avatarUrl) : null }),
      ...(body.purposeMd !== undefined && { purposeMd: body.purposeMd != null ? String(body.purposeMd) : null }),
      ...(body.memberType !== undefined && { memberType: body.memberType as any }),
      ...(body.linkedCredentialId !== undefined && { linkedCredentialId: body.linkedCredentialId != null ? String(body.linkedCredentialId) : null }),
      ...(body.maxSpendPerRunCents !== undefined && { maxSpendPerRunCents: body.maxSpendPerRunCents != null ? Number(body.maxSpendPerRunCents) : null }),
      ...(body.maxRunsPerDay !== undefined && { maxRunsPerDay: body.maxRunsPerDay != null ? Number(body.maxRunsPerDay) : null }),
      ...(body.maxRunsPerHour !== undefined && { maxRunsPerHour: body.maxRunsPerHour != null ? Number(body.maxRunsPerHour) : null }),
      ...(body.isActive !== undefined && { isActive: Boolean(body.isActive) }),
    });
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, agentId } = await params;
    await deactivateAgentIdentity(actor, workspaceId, agentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
