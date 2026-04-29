import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchCustomerSupportSnapshot } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const snapshot = await fetchCustomerSupportSnapshot(actor, instanceId);
    return NextResponse.json({ snapshot });
  } catch (error) {
    return handleRouteError(error);
  }
}
