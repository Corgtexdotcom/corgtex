import { NextRequest, NextResponse } from "next/server";
import { AppError, importMeetingTranscriptSourceArtifacts, normalizeMeetingTranscriptSourceProvider } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { meetingTranscriptArtifactsFromFormData } from "@/lib/meeting-transcript-source-artifacts";

function safeLocalRedirect(value: string | null, requestUrl: string) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  return new URL(value, requestUrl);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; provider: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, provider: providerParam } = await params;
    const provider = normalizeMeetingTranscriptSourceProvider(providerParam);
    const contentType = request.headers.get("content-type") ?? "";
    const formData = contentType.includes("multipart/form-data") ? await request.formData() : null;
    const redirectValue = formData?.get("redirectTo");
    const redirectTo = typeof redirectValue === "string" ? redirectValue : null;
    const artifacts = formData
      ? await meetingTranscriptArtifactsFromFormData(formData)
      : ((await request.json()) as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts)) {
      throw new AppError(400, "INVALID_INPUT", "Upload transcript files or provide an artifacts array.");
    }
    const result = await importMeetingTranscriptSourceArtifacts(actor, {
      workspaceId,
      provider,
      sourceKind: contentType.includes("multipart/form-data") ? "manual_upload" : "api_upload",
      artifacts,
    });
    const redirectUrl = safeLocalRedirect(redirectTo, request.url);
    if (redirectUrl) {
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }
    return NextResponse.json(result, { status: result.batch.status === "FAILED" ? 422 : 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
