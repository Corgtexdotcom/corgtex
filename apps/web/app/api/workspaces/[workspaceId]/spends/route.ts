import { NextRequest, NextResponse } from "next/server";
import { createSpend, listSpends, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const spends = await listSpends(workspaceId);
    return NextResponse.json({ spends });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      amountCents?: unknown;
      currency?: unknown;
      category?: unknown;
      description?: unknown;
      vendor?: unknown;
      proposalId?: unknown;
      ledgerAccountId?: unknown;
      requesterEmail?: unknown;
    };
    const spend = await createSpend(actor, {
      workspaceId,
      amountCents: Number.parseInt(String(body.amountCents ?? "0"), 10),
      currency: String(body.currency ?? ""),
      category: String(body.category ?? ""),
      description: String(body.description ?? ""),
      vendor: typeof body.vendor === "string" ? body.vendor : null,
      proposalId: typeof body.proposalId === "string" ? body.proposalId : null,
      ledgerAccountId: typeof body.ledgerAccountId === "string" ? body.ledgerAccountId : null,
      requesterEmail: typeof body.requesterEmail === "string" ? body.requesterEmail : null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
