import { NextRequest, NextResponse } from "next/server";
import { AppError, classifyUploadedTextForMeeting, intakeMeetingTranscript } from "@corgtex/domain";
import { extractTextFromFileBuffer, ingestFile } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { parseOptionalMeetingDateTimeInput } from "@/lib/meeting-timezone";

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
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File) || file.size === 0) {
      throw new AppError(400, "INVALID_INPUT", "file is required.");
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const extracted = await extractTextFromFileBuffer({
      fileBuffer,
      fileName: file.name,
      mimeType,
    });
    const userMessage = formString(formData, "message");
    const classification = classifyUploadedTextForMeeting({
      fileName: file.name,
      mimeType,
      textContent: extracted.textContent,
      userMessage,
    });

    if (classification.classification === "meeting_transcript" && extracted.textContent) {
      const recordedAt = parseOptionalMeetingDateTimeInput(
        formString(formData, "recordedAt"),
        formString(formData, "timeZone"),
        "Recorded at",
      );
      if (!recordedAt) {
        return NextResponse.json({
          status: "needs_meeting_details",
          requiredFields: ["recordedAt"],
          classification,
          message: "This looks like a meeting transcript. Add it from Meetings so you can set the meeting date/time and resolve duplicates.",
          webUrl: `/workspaces/${workspaceId}/add?kind=meeting_transcript`,
        });
      }

      const intake = await intakeMeetingTranscript(actor, {
        workspaceId,
        transcript: extracted.textContent,
        fileName: file.name,
        userMessage,
        meetingId: formString(formData, "meetingId"),
        title: formString(formData, "title"),
        source: formString(formData, "source") ?? "chat-transcript-upload",
        recordedAt,
        participantEmails: formList(formData, "participantEmails"),
      });

      return NextResponse.json({
        ...intake,
        classification,
        webUrl: intake.status === "needs_clarification" ? null : `/workspaces/${workspaceId}/meetings/${intake.meeting.id}`,
      });
    }

    const result = await ingestFile(actor, {
      workspaceId,
      fileBuffer,
      fileName: file.name,
      mimeType,
      uploadSource: "chat-upload",
      documentTitle: formString(formData, "title") ?? file.name,
    });

    return NextResponse.json({
      status: "document_uploaded",
      document: result.document,
      classification,
      message: `Uploaded "${result.document.title}" as a document. It is queued for document indexing.`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
