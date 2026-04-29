import { NextRequest, NextResponse } from "next/server";
import { AppError, enqueueMeetingAgendaPreparation, importMeetingInvite } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      throw new AppError(400, "INVALID_INPUT", "Must be multipart/form-data.");
    }

    const formData = await request.formData();
    const file = formData.get("invite");
    if (!(file instanceof File) || file.size === 0) {
      throw new AppError(400, "INVALID_INPUT", "invite file is required.");
    }

    const result = await importMeetingInvite(actor, {
      workspaceId,
      icsText: await file.text(),
    });
    await enqueueMeetingAgendaPreparation(actor, { workspaceId });

    return NextResponse.json({ imported: result }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
