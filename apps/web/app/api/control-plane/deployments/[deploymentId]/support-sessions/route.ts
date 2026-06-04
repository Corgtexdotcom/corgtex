import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createSelfServeSupportSession } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const supportSessionSchema = z.object({
  workspaceId: z.string().trim().min(1).nullable().optional(),
  targetMemberId: z.string().trim().min(1).nullable().optional(),
  reason: z.string().trim().min(1),
}).strict();

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, supportSessionSchema);
    const supportSession = await createSelfServeSupportSession(actor, {
      deploymentId,
      workspaceId: body.workspaceId,
      targetMemberId: body.targetMemberId,
      reason: body.reason,
    });
    return NextResponse.json({ supportSession }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
