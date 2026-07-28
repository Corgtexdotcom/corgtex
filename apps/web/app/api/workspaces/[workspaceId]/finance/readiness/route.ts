import { NextResponse, type NextRequest } from "next/server";
import { getFinanceReadiness } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const readiness = await getFinanceReadiness(actor, workspaceId);
    return NextResponse.json({ readiness });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_readiness" });
  }
}
