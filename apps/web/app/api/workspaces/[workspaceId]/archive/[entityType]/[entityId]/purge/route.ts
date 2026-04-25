import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { purgeWorkspaceArtifact } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; entityType: string; entityId: string }> };

const purgeArtifactSchema = z.object({
  reason: z.string().trim().min(1),
});

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, entityType, entityId } = await params;
    const body = await validateBody(request, purgeArtifactSchema);
    const result = await purgeWorkspaceArtifact(actor, {
      workspaceId,
      entityType,
      entityId,
      reason: body.reason,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
