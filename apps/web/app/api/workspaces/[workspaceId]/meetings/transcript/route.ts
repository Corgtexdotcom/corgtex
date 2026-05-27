import { NextRequest, NextResponse } from "next/server";
import { AppError, intakeMeetingTranscript } from "@corgtex/domain";
import { extractTextFromFileBuffer } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formList(formData: FormData, key: string) {
  return (formString(formData, key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      const pastedTranscript = formString(formData, "transcript");
      let transcript = pastedTranscript ?? "";
      let fileName: string | null = null;

      if (file instanceof File && file.size > 0) {
        const fileBuffer = Buffer.from(await file.arrayBuffer());
        fileName = file.name;
        const extracted = await extractTextFromFileBuffer({
          fileBuffer,
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
        });
        transcript = extracted.textContent ?? transcript;
      }

      if (!transcript.trim()) {
        throw new AppError(400, "INVALID_INPUT", "Transcript text or a readable transcript file is required.");
      }

      const result = await intakeMeetingTranscript(actor, {
        workspaceId,
        transcript,
        fileName,
        meetingId: formString(formData, "meetingId"),
        title: formString(formData, "title"),
        source: formString(formData, "source") ?? "transcript-upload",
        provider: formString(formData, "provider"),
        externalId: formString(formData, "externalId"),
        sourceUpdatedAt: formString(formData, "sourceUpdatedAt"),
        sourceUrl: formString(formData, "sourceUrl"),
        meetingUrl: formString(formData, "meetingUrl"),
        calendarExternalId: formString(formData, "calendarExternalId"),
        recordedAt: formString(formData, "recordedAt"),
        summaryMd: formString(formData, "summaryMd"),
        ingestionGuidanceMd: formString(formData, "ingestionGuidanceMd"),
        participantIds: formList(formData, "participantIds"),
        participantEmails: formList(formData, "participantEmails"),
      });

      return NextResponse.json(result, { status: result.status === "needs_clarification" ? 409 : 201 });
    }

    const body = (await request.json()) as {
      meetingId?: unknown;
      title?: unknown;
      source?: unknown;
      provider?: unknown;
      externalId?: unknown;
      sourceUpdatedAt?: unknown;
      sourceUrl?: unknown;
      meetingUrl?: unknown;
      calendarExternalId?: unknown;
      recordedAt?: unknown;
      transcript?: unknown;
      summaryMd?: unknown;
      ingestionGuidanceMd?: unknown;
      participantIds?: unknown;
      participantEmails?: unknown;
    };

    const result = await intakeMeetingTranscript(actor, {
      workspaceId,
      meetingId: typeof body.meetingId === "string" ? body.meetingId : null,
      title: typeof body.title === "string" ? body.title : null,
      source: typeof body.source === "string" ? body.source : "transcript-upload",
      provider: typeof body.provider === "string" ? body.provider : null,
      externalId: typeof body.externalId === "string" ? body.externalId : null,
      sourceUpdatedAt: typeof body.sourceUpdatedAt === "string" ? body.sourceUpdatedAt : null,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
      meetingUrl: typeof body.meetingUrl === "string" ? body.meetingUrl : null,
      calendarExternalId: typeof body.calendarExternalId === "string" ? body.calendarExternalId : null,
      recordedAt: typeof body.recordedAt === "string" ? body.recordedAt : null,
      transcript: String(body.transcript ?? ""),
      summaryMd: typeof body.summaryMd === "string" ? body.summaryMd : null,
      ingestionGuidanceMd: typeof body.ingestionGuidanceMd === "string" ? body.ingestionGuidanceMd : null,
      participantIds: Array.isArray(body.participantIds) ? body.participantIds.map((value) => String(value)) : [],
      participantEmails: Array.isArray(body.participantEmails) ? body.participantEmails.map((value) => String(value)) : [],
    });

    return NextResponse.json(result, { status: result.status === "needs_clarification" ? 409 : 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
