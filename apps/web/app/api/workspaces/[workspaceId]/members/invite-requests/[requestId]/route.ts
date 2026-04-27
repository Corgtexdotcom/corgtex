import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approveMemberInviteRequest, rejectMemberInviteRequest } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; requestId: string }> };

const decideInviteRequestSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, requestId } = await params;
    const body = await validateBody(request, decideInviteRequestSchema);
    const result = body.decision === "APPROVE"
      ? await approveMemberInviteRequest(actor, { workspaceId, requestId })
      : await rejectMemberInviteRequest(actor, { workspaceId, requestId });
    return NextResponse.json({ result });
  } catch (error) {
    return handleRouteError(error);
  }
}
