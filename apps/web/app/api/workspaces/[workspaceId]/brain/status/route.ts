import { NextRequest, NextResponse } from "next/server";
import { getBrainStatus } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const status = await getBrainStatus(actor, { workspaceId });
    return NextResponse.json(status);
  } catch (error) {
    return handleRouteError(error);
  }
}
