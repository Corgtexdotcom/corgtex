import { NextRequest, NextResponse } from "next/server";
import { archiveProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const proposal = await archiveProposal(actor, { workspaceId, proposalId });
    return NextResponse.json({ proposal });
  } catch (error) {
    return handleRouteError(error);
  }
}
