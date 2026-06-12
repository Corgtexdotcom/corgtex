import { NextRequest, NextResponse } from "next/server";
import { createMeeting, listMeetings, requireWorkspaceMembership } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { parseMeetingDateTimeInput } from "@/lib/meeting-timezone";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const meetings = await listMeetings(workspaceId, { archiveFilter: archiveFilter ?? undefined });
    return NextResponse.json({ meetings });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      title?: unknown;
      source?: unknown;
      recordedAt?: unknown;
      transcript?: unknown;
      summaryMd?: unknown;
      participantIds?: unknown;
      participantEmails?: unknown;
      timeZone?: unknown;
    };

    const meeting = await createMeeting(actor, {
      workspaceId,
      title: typeof body.title === "string" ? body.title : null,
      source: String(body.source ?? ""),
      recordedAt: parseMeetingDateTimeInput(
        String(body.recordedAt ?? ""),
        typeof body.timeZone === "string" ? body.timeZone : null,
        "Recorded at",
      ),
      transcript: typeof body.transcript === "string" ? body.transcript : null,
      summaryMd: typeof body.summaryMd === "string" ? body.summaryMd : null,
      participantIds: Array.isArray(body.participantIds)
        ? body.participantIds.map((value) => String(value))
        : [],
      participantEmails: Array.isArray(body.participantEmails)
        ? body.participantEmails.map((value) => String(value))
        : [],
    });

    return NextResponse.json(meeting, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
