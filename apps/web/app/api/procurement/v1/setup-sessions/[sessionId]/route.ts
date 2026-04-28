import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSelfServeSetupSessionStatus } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import { requiredSetupSessionToken } from "@/lib/procurement-api";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const response = await getSelfServeSetupSessionStatus({
      sessionId,
      token: requiredSetupSessionToken(request),
      origin: getPublicOrigin(request),
    });
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
