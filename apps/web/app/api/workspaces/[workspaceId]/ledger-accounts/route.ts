import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createLedgerAccount, listLedgerAccounts, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const ledgerAccountSchema = z.object({
  name: z.string().trim().min(1),
  currency: z.string().trim().min(1),
  type: z.string().trim().min(1).optional().nullable(),
  balanceCents: z.coerce.number().int().optional(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const ledgerAccounts = await listLedgerAccounts(workspaceId);
    return NextResponse.json({ ledgerAccounts });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, ledgerAccountSchema);
    const ledgerAccount = await createLedgerAccount(actor, {
      workspaceId,
      name: body.name,
      currency: body.currency,
      type: body.type ?? null,
      balanceCents: body.balanceCents ?? 0,
    });
    return NextResponse.json({ ledgerAccount }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
