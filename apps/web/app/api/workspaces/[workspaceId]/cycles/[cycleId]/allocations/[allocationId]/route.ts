import { NextRequest, NextResponse } from "next/server";
import { deleteAllocation, updateAllocation } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; cycleId: string; allocationId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId, allocationId } = await params;
    const body = (await request.json()) as {
      toUserId?: unknown;
      points?: unknown;
      note?: unknown;
    };
    const allocation = await updateAllocation(actor, {
      workspaceId,
      cycleId,
      allocationId,
      toUserId: typeof body.toUserId === "string" ? body.toUserId : undefined,
      points: body.points !== undefined ? Number.parseInt(String(body.points), 10) : undefined,
      note: body.note !== undefined ? (typeof body.note === "string" ? body.note : null) : undefined,
    });
    return NextResponse.json({ allocation });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, cycleId, allocationId } = await params;
    const result = await deleteAllocation(actor, {
      workspaceId,
      cycleId,
      allocationId,
    });
    return NextResponse.json({ allocation: result });
  } catch (error) {
    return handleRouteError(error);
  }
}
