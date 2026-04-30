import { NextRequest, NextResponse } from "next/server";
import { AppError, intakeMeetingTranscript, uploadMeetingTranscript } from "@corgtex/domain";
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
        recordedAt: formString(formData, "recordedAt"),
        summaryMd: formString(formData, "summaryMd"),
        participantIds: formList(formData, "participantIds"),
        participantEmails: formList(formData, "participantEmails"),
      });

      return NextResponse.json(result, { status: result.status === "needs_clarification" ? 409 : 201 });
    }

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
