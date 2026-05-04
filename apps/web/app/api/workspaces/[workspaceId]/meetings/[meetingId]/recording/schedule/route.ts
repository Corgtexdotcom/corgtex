import { NextRequest, NextResponse } from "next/server";
import type { MeetingRecorderProvider } from "@prisma/client";
import { scheduleMeetingRecording } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

function providerValue(value: unknown): MeetingRecorderProvider | null {
  return value === "RECALL_AI" || value === "MEETING_BAAS" ? value : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; meetingId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, meetingId } = await params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const recording = await scheduleMeetingRecording(actor, {
      workspaceId,
      meetingId,
      provider: providerValue(body.provider),
      mode: "manual",
    });
    return NextResponse.json({ recording }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
