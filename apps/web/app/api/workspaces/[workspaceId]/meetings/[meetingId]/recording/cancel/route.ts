import { NextRequest, NextResponse } from "next/server";
import { cancelMeetingRecording } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; meetingId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, meetingId } = await params;
    const recording = await cancelMeetingRecording(actor, { workspaceId, meetingId });
    return NextResponse.json({ recording });
  } catch (error) {
    return handleRouteError(error);
  }
}
