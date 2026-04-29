import { NextRequest, NextResponse } from "next/server";
import { uploadMeetingTranscript } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      meetingId?: unknown;
      title?: unknown;
      source?: unknown;
      recordedAt?: unknown;
      transcript?: unknown;
      summaryMd?: unknown;
      participantIds?: unknown;
      participantEmails?: unknown;
    };

    const result = await uploadMeetingTranscript(actor, {
      workspaceId,
      meetingId: typeof body.meetingId === "string" ? body.meetingId : null,
      title: typeof body.title === "string" ? body.title : null,
      source: typeof body.source === "string" ? body.source : "transcript-upload",
      recordedAt: new Date(String(body.recordedAt ?? "")),
      transcript: String(body.transcript ?? ""),
      summaryMd: typeof body.summaryMd === "string" ? body.summaryMd : null,
      participantIds: Array.isArray(body.participantIds) ? body.participantIds.map((value) => String(value)) : [],
      participantEmails: Array.isArray(body.participantEmails) ? body.participantEmails.map((value) => String(value)) : [],
    });

    return NextResponse.json(result, { status: result.status === "needs_selection" ? 409 : 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
