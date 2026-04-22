import { NextRequest, NextResponse } from "next/server";
import { createAgentIdentity, listAgentIdentities } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const identities = await listAgentIdentities(actor, workspaceId);
    return NextResponse.json({ identities });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const identity = await createAgentIdentity(actor, {
      workspaceId,
      agentKey: String(body.agentKey ?? ""),
      displayName: String(body.displayName ?? ""),
      memberType: body.memberType as any,
      avatarUrl: body.avatarUrl != null ? String(body.avatarUrl) : null,
      purposeMd: body.purposeMd != null ? String(body.purposeMd) : null,
      behaviorMd: body.behaviorMd != null ? String(body.behaviorMd) : null,
      linkedCredentialId: body.linkedCredentialId != null ? String(body.linkedCredentialId) : null,
      maxSpendPerRunCents: body.maxSpendPerRunCents != null ? Number(body.maxSpendPerRunCents) : null,
      maxRunsPerDay: body.maxRunsPerDay != null ? Number(body.maxRunsPerDay) : null,
      maxRunsPerHour: body.maxRunsPerHour != null ? Number(body.maxRunsPerHour) : null,
    });
    return NextResponse.json(identity, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
