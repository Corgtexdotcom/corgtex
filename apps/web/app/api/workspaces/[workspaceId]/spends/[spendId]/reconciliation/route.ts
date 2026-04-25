import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normalizeReconciliationStatusInput, updateSpendReconciliation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; spendId: string }> };
const reconciliationSchema = z.object({
  status: z.enum(["PENDING", "STATEMENT_ATTACHED", "RECONCILED"]),
  note: z.string().optional().nullable(),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = await validateBody(request, reconciliationSchema);
    const spend = await updateSpendReconciliation(actor, {
      workspaceId,
      spendId,
      status: normalizeReconciliationStatusInput(body.status),
      note: body.note ?? null,
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
