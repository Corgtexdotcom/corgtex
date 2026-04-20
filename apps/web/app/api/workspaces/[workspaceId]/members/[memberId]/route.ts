import { NextRequest, NextResponse } from "next/server";
import { updateMember, deactivateMember } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; memberId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, memberId } = await params;
    const body = await request.json();
    const member = await updateMember(actor, {
      workspaceId,
      memberId,
      role: body.role ?? undefined,
      displayName: body.displayName !== undefined ? body.displayName : undefined,
    });
    return NextResponse.json({ member });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, memberId } = await params;
    await deactivateMember(actor, { workspaceId, memberId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
