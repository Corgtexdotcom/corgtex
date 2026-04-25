import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createProposal, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createProposalSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().optional().nullable(),
  bodyMd: z.string(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const proposals = await listProposals(actor, workspaceId);
    return NextResponse.json({ proposals });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createProposalSchema);
    const proposal = await createProposal(actor, {
      workspaceId,
      title: body.title,
      summary: body.summary ?? null,
      bodyMd: body.bodyMd,
    });
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
