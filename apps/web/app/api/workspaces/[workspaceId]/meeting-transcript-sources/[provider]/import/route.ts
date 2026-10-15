import { NextRequest, NextResponse } from "next/server";
import { AppError, captureManualTranscriptSourceArtifact, requireWorkspaceMembership, importMeetingTranscriptSourceArtifacts, normalizeMeetingTranscriptSourceProvider } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";
import { meetingTranscriptArtifactsFromFormData, transcriptArtifactByteBudget } from "@/lib/meeting-transcript-source-artifacts";

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
    await requireWorkspaceMembership({ actor, workspaceId });
    await checkApiDemoGuard(workspaceId);
    const provider = normalizeMeetingTranscriptSourceProvider(providerParam);
    const contentType = request.headers.get("content-type") ?? "";
    const formData = contentType.includes("multipart/form-data") ? await request.formData() : null;
    const redirectValue = formData?.get("redirectTo");
    const redirectTo = typeof redirectValue === "string" ? redirectValue : null;
    const rawRequestText = formData ? null : await request.text();
    if (rawRequestText && Buffer.byteLength(rawRequestText) > 5 * 1024 * 1024) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript request exceeds its byte limit.");
    let artifacts: unknown;
    if (formData) artifacts = await meetingTranscriptArtifactsFromFormData(formData);
    else {
      let payload: unknown;
      try { payload = JSON.parse(rawRequestText || "{}"); }
      catch { throw new AppError(400, "INVALID_INPUT", "Transcript request must contain valid JSON."); }
      artifacts = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { artifacts?: unknown }).artifacts : undefined;
    }
    if (!Array.isArray(artifacts) || artifacts.some(artifact =>
      artifact === null || typeof artifact !== "object" || Array.isArray(artifact))) {
      throw new AppError(400, "INVALID_INPUT", "Upload transcript files or provide an array of artifact objects.");
    }
    const originalRequestBytes = rawRequestText ? transcriptArtifactByteBudget(rawRequestText, 20 * 1024 * 1024) + 64 : 0;
    let admitted = 0;
    for (const artifact of artifacts) {
      admitted += transcriptArtifactByteBudget(artifact, 20 * 1024 * 1024 - admitted);
      if (rawRequestText) {
        admitted += originalRequestBytes;
        if (admitted > 20 * 1024 * 1024) throw new AppError(413, "TRANSCRIPT_TOO_LARGE", "Transcript import exceeds its aggregate custody byte limit.");
        artifact.rawRequestText = rawRequestText;
      }
    }
    for (const artifact of artifacts) await captureManualTranscriptSourceArtifact(actor, { workspaceId, provider, artifact });
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
