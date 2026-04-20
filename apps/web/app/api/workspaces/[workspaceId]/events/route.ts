import { NextRequest, NextResponse } from "next/server";
import { listRuntimeEvents } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const take = Number.parseInt(request.nextUrl.searchParams.get("take") ?? "25", 10);
    const events = await listRuntimeEvents(actor, workspaceId, { take });
    return NextResponse.json({ events });
  } catch (error) {
    return handleRouteError(error);
  }
}
