import { NextRequest, NextResponse } from "next/server";
import { deleteSpend, updateSpend } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = await request.json();
    const spend = await updateSpend(actor, {
      workspaceId,
      spendId,
      amountCents: Number.isInteger(body.amountCents) ? body.amountCents : undefined,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      category: typeof body.category === "string" ? body.category : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      vendor: body.vendor !== undefined ? (typeof body.vendor === "string" ? body.vendor : null) : undefined,
      ledgerAccountId: body.ledgerAccountId !== undefined ? (typeof body.ledgerAccountId === "string" ? body.ledgerAccountId : null) : undefined,
    });
    return NextResponse.json({ spend });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    await deleteSpend(actor, { workspaceId, spendId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
