import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { approveReviewGatedProcurementTrial } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const approveSchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trialId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { trialId } = await params;
    const body = await validateBody(request, approveSchema);
    const trial = await approveReviewGatedProcurementTrial(actor, {
      trialId,
      reason: body.reason,
    });
    return NextResponse.json({ trial }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
