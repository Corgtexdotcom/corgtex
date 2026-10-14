import { NextRequest, NextResponse } from "next/server";
import { exportConversationAnswerToBrain } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  try {
    const { workspaceId, conversationId } = await context.params;
    const actor = await resolveRequestActor(request);
    const body = await request.json();
    const result = await exportConversationAnswerToBrain(actor, { workspaceId, conversationId,
      outputTurnId: body.outputTurnId, expectedOutputHash: body.expectedOutputHash, title: body.title,
      transcriptMode: body.transcriptMode, selectedTurns: body.selectedTurns, requestId: body.requestId });
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
