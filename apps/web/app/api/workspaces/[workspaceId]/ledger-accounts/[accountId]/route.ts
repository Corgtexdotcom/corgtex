import { NextRequest, NextResponse } from "next/server";
import { updateLedgerAccount } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; accountId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, accountId } = await params;
    const body = (await request.json()) as {
      name?: unknown;
      currency?: unknown;
      type?: unknown;
    };
    const ledgerAccount = await updateLedgerAccount(actor, {
      workspaceId,
      accountId,
      name: typeof body.name === "string" ? body.name : undefined,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      type: body.type !== undefined ? (typeof body.type === "string" ? body.type : null) : undefined,
    });
    return NextResponse.json({ ledgerAccount });
  } catch (error) {
    return handleRouteError(error);
  }
}
