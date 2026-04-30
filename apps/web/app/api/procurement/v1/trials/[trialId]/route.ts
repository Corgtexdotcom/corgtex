import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getProcurementTrialStatus } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ trialId: string }> },
) {
  try {
    const { trialId } = await params;
    const response = await getProcurementTrialStatus(trialId, getPublicOrigin(request));
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
