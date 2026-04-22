import { NextRequest, NextResponse } from "next/server";
import { updateProposal, deleteProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const body = await request.json();
    const proposal = await updateProposal(actor, {
      workspaceId,
      proposalId,
      title: typeof body.title === "string" ? body.title : undefined,
      summary: body.summary !== undefined ? (typeof body.summary === "string" ? body.summary : null) : undefined,
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : undefined,
      circleId: body.circleId !== undefined ? body.circleId : undefined,
    });
    return NextResponse.json({ proposal });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    await deleteProposal(actor, { workspaceId, proposalId });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleRouteError(error);
  }
}
