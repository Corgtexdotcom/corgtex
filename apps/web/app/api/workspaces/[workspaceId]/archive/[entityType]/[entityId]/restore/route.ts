import { NextRequest, NextResponse } from "next/server";
import { restoreWorkspaceArtifact } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; entityType: string; entityId: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, entityType, entityId } = await params;
    const artifact = await restoreWorkspaceArtifact(actor, { workspaceId, entityType, entityId });
    return NextResponse.json({ artifact });
  } catch (error) {
    return handleRouteError(error);
  }
}
