import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listControlPlaneDeployments } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const deployments = await listControlPlaneDeployments(actor);
    return NextResponse.json({ deployments });
  } catch (error) {
    return handleRouteError(error);
  }
}
