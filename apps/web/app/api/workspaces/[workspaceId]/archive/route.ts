import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { archiveWorkspaceArtifact, listArchivedWorkspaceArtifacts } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string }> };

const archiveArtifactSchema = z.object({
  entityType: z.string().trim().min(1),
  entityId: z.string().trim().min(1),
  reason: z.string().trim().optional().nullable(),
});

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const items = await listArchivedWorkspaceArtifacts(actor, {
      workspaceId,
      entityType: searchParams.get("entityType"),
      includeRestored: searchParams.get("includeRestored") === "true",
      includePurged: searchParams.get("includePurged") === "true",
      take: Number.parseInt(searchParams.get("take") ?? "100", 10),
      skip: Number.parseInt(searchParams.get("skip") ?? "0", 10),
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, archiveArtifactSchema);
    const artifact = await archiveWorkspaceArtifact(actor, {
      workspaceId,
      entityType: body.entityType,
      entityId: body.entityId,
      reason: body.reason ?? null,
    });
    return NextResponse.json({ artifact });
  } catch (error) {
    return handleRouteError(error);
  }
}
