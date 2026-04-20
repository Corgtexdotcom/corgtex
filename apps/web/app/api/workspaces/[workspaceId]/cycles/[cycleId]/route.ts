import { NextRequest, NextResponse } from "next/server";
import { getCycle, requireWorkspaceMembership, updateCycle } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; cycleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const cycle = await getCycle(workspaceId, cycleId);
    return NextResponse.json({ cycle });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    const body = (await request.json()) as {
      name?: unknown;
      cadence?: unknown;
      status?: unknown;
      startDate?: unknown;
      endDate?: unknown;
      pointsPerUser?: unknown;
    };
    const cycle = await updateCycle(actor, {
      workspaceId,
      cycleId,
      name: typeof body.name === "string" ? body.name : undefined,
      cadence: typeof body.cadence === "string" ? body.cadence : undefined,
      status: typeof body.status === "string" ? body.status as "PLANNED" | "OPEN_UPDATES" | "OPEN_ALLOCATIONS" | "REVIEW" | "FINALIZED" : undefined,
      startDate: typeof body.startDate === "string" ? new Date(body.startDate) : undefined,
      endDate: typeof body.endDate === "string" ? new Date(body.endDate) : undefined,
      pointsPerUser: body.pointsPerUser !== undefined ? Number.parseInt(String(body.pointsPerUser), 10) : undefined,
    });
    return NextResponse.json({ cycle });
  } catch (error) {
    return handleRouteError(error);
  }
}
