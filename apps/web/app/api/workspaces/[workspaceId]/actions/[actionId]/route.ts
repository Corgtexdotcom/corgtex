import { NextRequest, NextResponse } from "next/server";
import { updateAction, deleteAction } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { loadActionWorkItemResponse, serializeActionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

type Params = { params: Promise<{ workspaceId: string; actionId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, actionId } = await params;
    const body = await request.json();
    const action = await updateAction(actor, {
      workspaceId,
      actionId,
      title: typeof body.title === "string" ? body.title : undefined,
      bodyMd: body.bodyMd !== undefined ? (typeof body.bodyMd === "string" ? body.bodyMd : null) : undefined,
      status: body.status ?? undefined,
      circleId: body.circleId !== undefined ? body.circleId : undefined,
      assigneeMemberId: body.assigneeMemberId !== undefined ? body.assigneeMemberId : undefined,
      priority: workItemPriorityFromBody(body),
      dueAt: body.dueAt ? new Date(body.dueAt) : body.dueAt === null ? null : undefined,
    });
    const actionForResponse = await loadActionWorkItemResponse(workspaceId, action.id) ?? action;
    return NextResponse.json({ action: serializeActionWorkItem(actionForResponse) });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, actionId } = await params;
    await deleteAction(actor, { workspaceId, actionId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
