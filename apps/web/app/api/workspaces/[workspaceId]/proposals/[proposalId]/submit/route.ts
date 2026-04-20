import { NextRequest, NextResponse } from "next/server";
import { submitProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; proposalId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const result = await submitProposal(actor, {
      workspaceId,
      proposalId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
