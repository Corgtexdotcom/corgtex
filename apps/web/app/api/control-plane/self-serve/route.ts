import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listSelfServeCustomerRegistry } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const url = new URL(request.url);
    const takeRaw = Number(url.searchParams.get("take"));
    const registry = await listSelfServeCustomerRegistry(actor, {
      take: Number.isFinite(takeRaw) ? takeRaw : undefined,
      status: url.searchParams.get("status"),
    });
    return NextResponse.json(registry);
  } catch (error) {
    return handleRouteError(error);
  }
}
