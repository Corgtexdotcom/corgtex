import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { updateControlPlaneCustomerMemberStatus } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const updateMemberStatusSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().trim().min(1),
}).strict();

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string; memberId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId, memberId } = await props.params;
    const body = await validateBody(request, updateMemberStatusSchema);
    const member = await updateControlPlaneCustomerMemberStatus(actor, {
      deploymentId,
      memberId,
      isActive: body.isActive,
      reason: body.reason,
    });
    return NextResponse.json({ member });
  } catch (error) {
    return handleRouteError(error);
  }
}
