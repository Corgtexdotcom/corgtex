import { NextRequest, NextResponse } from "next/server";
import { recordApprovalDecision } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; flowId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, flowId } = await params;
    const body = (await request.json()) as { choice?: unknown; rationale?: unknown };
    const result = await recordApprovalDecision(actor, {
      workspaceId,
      flowId,
      choice: String(body.choice ?? "") as "APPROVE" | "REJECT" | "ABSTAIN" | "AGREE" | "BLOCK",
      rationale: typeof body.rationale === "string" ? body.rationale : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
