import { NextRequest, NextResponse } from "next/server";
import { retryMeetingTranscriptImportBatch } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; batchId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, batchId } = await params;
    const result = await retryMeetingTranscriptImportBatch(actor, { workspaceId, batchId });
    return NextResponse.json(result, { status: result.batch.status === "FAILED" ? 422 : 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
