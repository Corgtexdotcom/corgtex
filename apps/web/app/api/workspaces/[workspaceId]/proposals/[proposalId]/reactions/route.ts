import { NextRequest, NextResponse } from "next/server";
import { listProposalReactions, reactToProposal, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const reactions = await listProposalReactions(workspaceId, proposalId);
    return NextResponse.json({ reactions });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const body = (await request.json()) as { reaction?: unknown };
    const reaction = await reactToProposal(actor, {
      workspaceId,
      proposalId,
      reaction: String(body.reaction ?? ""),
    });
    return NextResponse.json({ reaction }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
