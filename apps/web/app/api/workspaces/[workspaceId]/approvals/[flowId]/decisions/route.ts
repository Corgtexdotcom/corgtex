import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordApprovalDecision } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const approvalDecisionSchema = z.object({
  choice: z.enum(["APPROVE", "REJECT", "ABSTAIN", "AGREE", "BLOCK"]),
  rationale: z.string().optional().nullable(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; flowId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, flowId } = await params;
    const body = await validateBody(request, approvalDecisionSchema);
    const result = await recordApprovalDecision(actor, {
      workspaceId,
      flowId,
      choice: body.choice,
      rationale: body.rationale ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
