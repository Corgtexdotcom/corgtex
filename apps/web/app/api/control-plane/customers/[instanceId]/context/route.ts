import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getControlPlaneContextHealth } from "@corgtex/domain";
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
    const context = await getControlPlaneContextHealth(actor, instanceId);
    return NextResponse.json({ context });
  } catch (error) {
    return handleRouteError(error);
  }
}
