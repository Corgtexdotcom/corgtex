import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { markSpendPaid } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const markSpendPaidSchema = z.object({
  receiptUrl: z.string().optional().nullable(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; spendId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = await validateBody(request, markSpendPaidSchema);
    const spend = await markSpendPaid(actor, {
      workspaceId,
      spendId,
      receiptUrl: body.receiptUrl ?? "",
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
