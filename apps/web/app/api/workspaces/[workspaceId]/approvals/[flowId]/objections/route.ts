import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createObjection } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const objectionSchema = z.object({
  bodyMd: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; flowId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, flowId } = await params;
    const body = await validateBody(request, objectionSchema);
    const result = await createObjection(actor, {
      workspaceId,
      flowId,
      bodyMd: body.bodyMd,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
