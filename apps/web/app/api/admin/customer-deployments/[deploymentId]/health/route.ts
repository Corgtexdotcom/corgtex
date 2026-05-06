import { type NextRequest, NextResponse } from "next/server";
import { probeCustomerDeploymentHealth } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { deploymentId } = await props.params;
    await probeCustomerDeploymentHealth(actor, deploymentId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
