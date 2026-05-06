import { type NextRequest, NextResponse } from "next/server";
import { suspendCustomerDeployment } from "@corgtex/domain";
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
    const deployment = await suspendCustomerDeployment(actor, deploymentId);
    return NextResponse.json({ deployment });
  } catch (error) {
    return handleRouteError(error);
  }
}
