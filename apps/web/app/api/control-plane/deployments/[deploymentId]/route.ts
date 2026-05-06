import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getControlPlaneDeployment } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const deployment = await getControlPlaneDeployment(actor, deploymentId);
    return NextResponse.json({ deployment });
  } catch (error) {
    return handleRouteError(error);
  }
}
