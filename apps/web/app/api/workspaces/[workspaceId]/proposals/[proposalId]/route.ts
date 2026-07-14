import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateProposal, deleteProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { serializeProposalWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };
const updateProposalSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().optional().nullable(),
  bodyMd: z.string().optional(),
  circleId: z.string().optional().nullable(),
  ownerMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
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
      ownerMemberId: body.ownerMemberId !== undefined ? body.ownerMemberId : undefined,
      priority: workItemPriorityFromBody(body),
    });
    return NextResponse.json({ proposal: serializeProposalWorkItem(proposal) });
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
