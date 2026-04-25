import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteLedgerAccount, updateLedgerAccount } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; accountId: string }> };
const updateLedgerAccountSchema = z.object({
  name: z.string().trim().min(1).optional(),
  currency: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional().nullable(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, accountId } = await params;
    const body = await validateBody(request, updateLedgerAccountSchema);
    const ledgerAccount = await updateLedgerAccount(actor, {
      workspaceId,
      accountId,
      name: body.name,
      currency: body.currency,
      type: body.type !== undefined ? body.type : undefined,
    });
    return NextResponse.json({ ledgerAccount });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, accountId } = await params;
    await deleteLedgerAccount(actor, { workspaceId, accountId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
