import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveProposal } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; proposalId: string }> };

const resolveProposalSchema = z.object({
  outcome: z.enum(["ADOPTED", "NOT_ADOPTED", "WITHDRAWN"]),
  decisionMd: z.string().trim().min(1),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, proposalId } = await params;
    const body = await validateBody(request, resolveProposalSchema);
    const proposal = await resolveProposal(actor, {
      workspaceId,
      proposalId,
      outcome: body.outcome,
      decisionMd: body.decisionMd,
    });
    return NextResponse.json({ proposal });
  } catch (error) {
    return handleRouteError(error);
  }
}
