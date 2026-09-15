import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;
  try {
    await resolveControlPlaneRequestActor(request);
    return NextResponse.json({
      error: "One-time support sessions are retired. Use your named account with a workspace owner-managed support grant.",
      code: "SUPPORT_SESSION_RETIRED",
    }, { status: 410 });
  } catch (error) {
    return handleRouteError(error);
  }
}
