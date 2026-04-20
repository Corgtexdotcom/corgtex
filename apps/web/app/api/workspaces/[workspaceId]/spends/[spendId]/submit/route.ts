import { NextRequest, NextResponse } from "next/server";
import { submitSpend } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; spendId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, spendId } = await params;
    const result = await submitSpend(actor, {
      workspaceId,
      spendId,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
