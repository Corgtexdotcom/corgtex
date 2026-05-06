import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchCustomerSupportSnapshot } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const snapshot = await fetchCustomerSupportSnapshot(actor, deploymentId);
    return NextResponse.json({ snapshot });
  } catch (error) {
    return handleRouteError(error);
  }
}
