import { NextRequest, NextResponse } from "next/server";
import { exportConversationAnswerToBrain } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { z } from "zod";

// Validate transport shape here; the domain retains consent, selection, hash,
// request identity and source-authority validation.
const exportAnswerSchema = z.object({
  outputTurnId: z.string(),
  expectedOutputHash: z.string(),
  title: z.string(),
  transcriptMode: z.enum(["NONE", "PARTIAL", "FULL"]),
  selectedTurns: z.array(z.object({ id: z.string(), hash: z.string() })),
  requestId: z.string(),
});

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string; conversationId: string }> }) {
  try {
    const { workspaceId, conversationId } = await context.params;
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, exportAnswerSchema);
    const result = await exportConversationAnswerToBrain(actor, { workspaceId, conversationId,
      outputTurnId: body.outputTurnId, expectedOutputHash: body.expectedOutputHash, title: body.title,
      transcriptMode: body.transcriptMode, selectedTurns: body.selectedTurns, requestId: body.requestId });
    return NextResponse.json(result, { status: 201 });
  } catch (error) { return handleRouteError(error); }
}
