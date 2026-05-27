import { NextRequest, NextResponse } from "next/server";
import { normalizeMeetingTranscriptSourceProvider, runMeetingTranscriptSourceBackfill } from "@corgtex/domain";
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
    const result = await runMeetingTranscriptSourceBackfill(actor, { workspaceId, provider });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
