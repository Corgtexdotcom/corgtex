import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSpend, listSpends, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createSpendSchema = z.object({
  amountCents: z.coerce.number().int().positive(),
  currency: z.string().trim().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  vendor: z.string().optional().nullable(),
  proposalId: z.string().optional().nullable(),
  ledgerAccountId: z.string().optional().nullable(),
  requesterEmail: z.string().optional().nullable(),
});

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
    const body = await validateBody(request, createSpendSchema);
    const spend = await createSpend(actor, {
      workspaceId,
      amountCents: body.amountCents,
      currency: body.currency,
      category: body.category,
      description: body.description,
      vendor: body.vendor ?? null,
      proposalId: body.proposalId ?? null,
      ledgerAccountId: body.ledgerAccountId ?? null,
      requesterEmail: body.requesterEmail ?? null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
