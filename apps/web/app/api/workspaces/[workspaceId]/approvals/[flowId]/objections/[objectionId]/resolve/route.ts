import { NextRequest, NextResponse } from "next/server";
import { resolveObjection } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; flowId: string; objectionId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, flowId, objectionId } = await params;
    const result = await resolveObjection(actor, {
      workspaceId,
      flowId,
      objectionId,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
