import { NextRequest, NextResponse } from "next/server";
import { linkSpendLedgerAccount } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = (await request.json()) as { ledgerAccountId?: unknown };
    const spend = await linkSpendLedgerAccount(actor, {
      workspaceId,
      spendId,
      ledgerAccountId: typeof body.ledgerAccountId === "string" ? body.ledgerAccountId : null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
