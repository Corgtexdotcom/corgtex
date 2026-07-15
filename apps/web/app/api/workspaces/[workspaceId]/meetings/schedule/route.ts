import { NextRequest, NextResponse } from "next/server";
import { createMeetingSeries, enqueueMeetingAgendaPreparation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import {
  parseMeetingDateTimeInput,
  resolveMeetingEndFromDurationOrInput,
} from "@/lib/meeting-timezone";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      title?: unknown;
      description?: unknown;
      startsAt?: unknown;
      durationMinutes?: unknown;
      scheduledEndAt?: unknown;
      recurrenceRule?: unknown;
      meetingUrl?: unknown;
      participantIds?: unknown;
      participantEmails?: unknown;
      timeZone?: unknown;
    };
    const timeZone = typeof body.timeZone === "string" ? body.timeZone : null;
    const startsAt = parseMeetingDateTimeInput(String(body.startsAt ?? ""), timeZone, "Starts at");
    const scheduledEndAt = resolveMeetingEndFromDurationOrInput({
      start: startsAt,
      durationMinutes: typeof body.durationMinutes === "string" || typeof body.durationMinutes === "number"
        ? body.durationMinutes
        : null,
      scheduledEndAt: typeof body.scheduledEndAt === "string" ? body.scheduledEndAt : null,
      timeZone,
      durationLabel: "Duration",
      endLabel: "Scheduled end",
    });

    const result = await createMeetingSeries(actor, {
      workspaceId,
      title: String(body.title ?? ""),
      description: typeof body.description === "string" ? body.description : null,
      startsAt,
      scheduledEndAt,
      recurrenceRule: typeof body.recurrenceRule === "string" ? body.recurrenceRule : null,
      meetingUrl: typeof body.meetingUrl === "string" ? body.meetingUrl : null,
      participantIds: Array.isArray(body.participantIds) ? body.participantIds.map((value) => String(value)) : [],
      participantEmails: Array.isArray(body.participantEmails) ? body.participantEmails.map((value) => String(value)) : [],
    });
    await enqueueMeetingAgendaPreparation(actor, { workspaceId });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
