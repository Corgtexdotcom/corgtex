import { NextRequest, NextResponse } from "next/server";
import { createProposal, listProposals, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

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
    const body = (await request.json()) as { title?: unknown; summary?: unknown; bodyMd?: unknown };
    const proposal = await createProposal(actor, {
      workspaceId,
      title: String(body.title ?? ""),
      summary: typeof body.summary === "string" ? body.summary : null,
      bodyMd: String(body.bodyMd ?? ""),
    });
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
