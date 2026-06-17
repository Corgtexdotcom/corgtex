import { NextRequest, NextResponse } from "next/server";
import { connectMeetingTranscriptSource, normalizeMeetingTranscriptSourceProvider } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; provider: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, provider: providerParam } = await params;
    const provider = normalizeMeetingTranscriptSourceProvider(providerParam);
    const body = await request.json() as Record<string, unknown>;
    const result = await connectMeetingTranscriptSource(actor, {
      workspaceId,
      provider,
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : null,
      accessToken: typeof body.accessToken === "string" ? body.accessToken : null,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : null,
      webhookSecret: typeof body.webhookSecret === "string" ? body.webhookSecret : null,
      webhookUrl: typeof body.webhookUrl === "string" ? body.webhookUrl : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
