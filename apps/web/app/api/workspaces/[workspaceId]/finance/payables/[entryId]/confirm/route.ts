import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { confirmFinanceCashPayablePaid } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const confirmSchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; entryId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, entryId } = await params;
    const body = await validateBody(request, confirmSchema);
    const entry = await confirmFinanceCashPayablePaid(actor, {
      workspaceId,
      entryId,
      expectedVersion: body.expectedVersion,
    });
    return NextResponse.json({ entry });
  } catch (error) {
    return handleRouteError(error, { request, surface: "finance_payables" });
  }
}
