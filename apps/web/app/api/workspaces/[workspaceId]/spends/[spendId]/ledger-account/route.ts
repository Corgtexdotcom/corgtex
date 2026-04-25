import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { linkSpendLedgerAccount } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };
const ledgerAccountLinkSchema = z.object({
  ledgerAccountId: z.string().optional().nullable(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = await validateBody(request, ledgerAccountLinkSchema);
    const spend = await linkSpendLedgerAccount(actor, {
      workspaceId,
      spendId,
      ledgerAccountId: body.ledgerAccountId ?? null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
