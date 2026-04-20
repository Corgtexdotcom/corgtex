import { NextRequest, NextResponse } from "next/server";
import { updateCircle, deleteCircle } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; circleId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, circleId } = await params;
    const body = await request.json();
    const circle = await updateCircle(actor, {
      workspaceId,
      circleId,
      name: typeof body.name === "string" ? body.name : undefined,
      purposeMd: body.purposeMd !== undefined ? (typeof body.purposeMd === "string" ? body.purposeMd : null) : undefined,
      domainMd: body.domainMd !== undefined ? (typeof body.domainMd === "string" ? body.domainMd : null) : undefined,
      parentCircleId: body.parentCircleId !== undefined ? body.parentCircleId : undefined,
      maturityStage: typeof body.maturityStage === "string" ? body.maturityStage : undefined,
    });
    return NextResponse.json({ circle });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, circleId } = await params;
    await deleteCircle(actor, { workspaceId, circleId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
