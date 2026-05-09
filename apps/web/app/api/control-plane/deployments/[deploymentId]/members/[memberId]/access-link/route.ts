import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { resendControlPlaneCustomerMemberAccessLink } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const resendAccessLinkSchema = z.object({
  reason: z.string().trim().min(1),
}).strict();

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string; memberId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId, memberId } = await props.params;
    const body = await validateBody(request, resendAccessLinkSchema);
    const result = await resendControlPlaneCustomerMemberAccessLink(actor, {
      deploymentId,
      memberId,
      reason: body.reason,
    });
    return NextResponse.json({ result });
  } catch (error) {
    return handleRouteError(error);
  }
}
