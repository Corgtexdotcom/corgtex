import { NextRequest, NextResponse } from "next/server";
import { updateTension, deleteTension } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; tensionId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, tensionId } = await params;
    const body = await request.json();
    const tension = await updateTension(actor, {
      workspaceId,
      tensionId,
      title: typeof body.title === "string" ? body.title : undefined,
      bodyMd: body.bodyMd !== undefined ? (typeof body.bodyMd === "string" ? body.bodyMd : null) : undefined,
      status: body.status ?? undefined,
      circleId: body.circleId !== undefined ? body.circleId : undefined,
      assigneeMemberId: body.assigneeMemberId !== undefined ? body.assigneeMemberId : undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
    });
    return NextResponse.json({ tension });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, tensionId } = await params;
    await deleteTension(actor, { workspaceId, tensionId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
