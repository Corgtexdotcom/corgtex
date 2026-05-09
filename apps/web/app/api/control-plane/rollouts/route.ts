import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listControlPlaneReleaseRolloutJobs } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const url = new URL(request.url);
    const rollouts = await listControlPlaneReleaseRolloutJobs(actor, {
      deploymentId: url.searchParams.get("deploymentId"),
      take: Number(url.searchParams.get("take") ?? 50),
    });
    return NextResponse.json({ rollouts });
  } catch (error) {
    return handleRouteError(error);
  }
}
