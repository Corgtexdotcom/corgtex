import { NextRequest, NextResponse } from "next/server";
import { normalizeReconciliationStatusInput, updateSpendReconciliation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = (await request.json()) as {
      status?: unknown;
      note?: unknown;
    };
    const spend = await updateSpendReconciliation(actor, {
      workspaceId,
      spendId,
      status: normalizeReconciliationStatusInput(String(body.status ?? "")),
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
