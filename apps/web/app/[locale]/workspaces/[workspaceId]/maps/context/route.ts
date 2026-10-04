import { AppError, buildSelectedRegionContext } from "@corgtex/domain";
import type { NextRequest } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

// A GET keeps graph inspection available to demo readers without allowing server actions.
export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceFeature(workspaceId, "CONTEXT_MAPS");
    const query = new URL(request.url).searchParams;
    const objectIds = query.getAll("object");
    if (!objectIds.length || objectIds.length > 200) {
      throw new AppError(400, "INVALID_INPUT", "Select between 1 and 200 context graph objects.");
    }
    const context = await buildSelectedRegionContext(actor, {
      workspaceId, mapViewId: query.get("view"), objectIds, depth: 2,
    });
    return Response.json(context, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = handleRouteError(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
