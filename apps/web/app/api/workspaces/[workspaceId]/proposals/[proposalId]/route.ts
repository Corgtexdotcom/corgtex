import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateProposal, deleteProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };
const updateProposalSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().optional().nullable(),
  bodyMd: z.string().optional(),
  circleId: z.string().optional().nullable(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const body = await validateBody(request, updateProposalSchema);
    const proposal = await updateProposal(actor, {
      workspaceId,
      proposalId,
      title: body.title,
      summary: body.summary !== undefined ? (typeof body.summary === "string" ? body.summary : null) : undefined,
      bodyMd: body.bodyMd,
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
