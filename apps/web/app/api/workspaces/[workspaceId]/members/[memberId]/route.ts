import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateMember, deactivateMember } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; memberId: string }> };
const updateMemberSchema = z.object({
  role: z.enum(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]).optional(),
  displayName: z.string().optional().nullable(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, memberId } = await params;
    const body = await validateBody(request, updateMemberSchema);
    const member = await updateMember(actor, {
      workspaceId,
      memberId,
      role: body.role,
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
