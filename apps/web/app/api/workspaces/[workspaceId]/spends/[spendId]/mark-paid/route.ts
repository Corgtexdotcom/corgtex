import { NextRequest, NextResponse } from "next/server";
import { markSpendPaid } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; spendId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const body = (await request.json()) as { receiptUrl?: unknown };
    const spend = await markSpendPaid(actor, {
      workspaceId,
      spendId,
      receiptUrl: String(body.receiptUrl ?? ""),
    });
    return NextResponse.json({ spend }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
