import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError, listControlPlaneWorkspaces } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const unavailable = requireControlPlaneDeploymentMode();
  if (unavailable) return unavailable;
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") ?? "all";
    if (scope !== "all" && scope !== "local" && scope !== "remote") {
      throw new AppError(400, "INVALID_INPUT", "Unknown workspace directory scope.");
    }
    const started = performance.now();
    const directory = await listControlPlaneWorkspaces(actor, {
      query: params.get("q") ?? undefined,
      cursor: params.get("cursor") ?? undefined,
      pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : 25,
      scope,
    });
    return NextResponse.json(directory, { headers: {
      "Cache-Control": "private, no-store",
      "Server-Timing": `workspace-directory;dur=${(performance.now() - started).toFixed(1)}`,
    } });
  } catch (error) {
    return handleRouteError(error);
  }
}
