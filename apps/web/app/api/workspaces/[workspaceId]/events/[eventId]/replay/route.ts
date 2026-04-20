import { NextRequest, NextResponse } from "next/server";
import { replayEvent } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; eventId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, eventId } = await params;
    const event = await replayEvent(actor, {
      workspaceId,
      eventId,
    });
    return NextResponse.json({ event }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
