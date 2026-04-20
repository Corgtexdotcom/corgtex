import { NextRequest, NextResponse } from "next/server";
import { createAllocation, listAllocations, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; cycleId: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const allocations = await listAllocations(workspaceId, cycleId);
    return NextResponse.json({ allocations });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId } = await params;
    const body = (await request.json()) as {
      fromUserId?: unknown;
      toUserId?: unknown;
      points?: unknown;
      note?: unknown;
    };
    const allocation = await createAllocation(actor, {
      workspaceId,
      cycleId,
      fromUserId: typeof body.fromUserId === "string" ? body.fromUserId : null,
      toUserId: String(body.toUserId ?? ""),
      points: Number.parseInt(String(body.points ?? "0"), 10),
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ allocation }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
