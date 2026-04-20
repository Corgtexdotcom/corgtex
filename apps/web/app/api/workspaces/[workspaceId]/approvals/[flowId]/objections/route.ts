import { NextRequest, NextResponse } from "next/server";
import { createObjection } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; flowId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, flowId } = await params;
    const body = (await request.json()) as { bodyMd?: unknown };
    const result = await createObjection(actor, {
      workspaceId,
      flowId,
      bodyMd: String(body.bodyMd ?? ""),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
