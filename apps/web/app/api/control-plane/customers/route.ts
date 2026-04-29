import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { listControlPlaneCustomers } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const customers = await listControlPlaneCustomers(actor);
    return NextResponse.json({ customers });
  } catch (error) {
    return handleRouteError(error);
  }
}
