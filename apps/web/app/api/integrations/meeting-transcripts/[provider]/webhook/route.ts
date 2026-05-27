import { NextRequest, NextResponse } from "next/server";
import { AppError, normalizeMeetingTranscriptSourceProvider, processMeetingTranscriptSourceWebhook } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    const { provider: providerParam } = await params;
    const provider = normalizeMeetingTranscriptSourceProvider(providerParam);
    const workspaceId = request.nextUrl.searchParams.get("workspaceId");
    if (!workspaceId) {
      throw new AppError(400, "WORKSPACE_REQUIRED", "workspaceId is required.");
    }
    const rawBody = await request.text();
    const result = await processMeetingTranscriptSourceWebhook({
      provider,
      workspaceId,
      rawBody,
      headers: request.headers,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
