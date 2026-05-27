import { NextRequest, NextResponse } from "next/server";
import { listMeetingTranscriptSourceState } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    return NextResponse.json(await listMeetingTranscriptSourceState(actor, workspaceId));
  } catch (error) {
    return handleRouteError(error);
  }
}
