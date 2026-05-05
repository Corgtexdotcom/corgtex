import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getControlPlaneIntegrationStatus } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const integrations = await getControlPlaneIntegrationStatus(actor, instanceId);
    return NextResponse.json({ integrations });
  } catch (error) {
    return handleRouteError(error);
  }
}
