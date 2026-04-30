import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { suspendProcurementTrial } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const suspendSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ trialId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { trialId } = await params;
    const body = await validateBody(request, suspendSchema);
    const trial = await suspendProcurementTrial(actor, {
      trialId,
      reason: body.reason,
    });
    return NextResponse.json({ trial });
  } catch (error) {
    return handleRouteError(error);
  }
}
