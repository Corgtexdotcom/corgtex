import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateAction, deleteAction } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { loadActionWorkItemResponse, serializeActionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

type Params = { params: Promise<{ workspaceId: string; actionId: string }> };
const actionDueAtSchema = z.string().refine(
  (value) => Number.isFinite(new Date(value).getTime()),
  { message: "Invalid due date." },
);
const updateActionSchema = z.object({
  title: z.string().trim().min(1).optional(),
  bodyMd: z.string().optional().nullable(),
  status: z.enum(["DRAFT", "OPEN", "IN_PROGRESS", "COMPLETED"]).optional(),
  circleId: z.string().optional().nullable(),
  assigneeMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
  dueAt: actionDueAtSchema.optional().nullable(),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, actionId } = await params;
    const body = await validateBody(request, updateActionSchema);
    const action = await updateAction(actor, {
      workspaceId,
      actionId,
      title: body.title,
      bodyMd: body.bodyMd !== undefined ? (typeof body.bodyMd === "string" ? body.bodyMd : null) : undefined,
      status: body.status,
      circleId: body.circleId !== undefined ? body.circleId : undefined,
      assigneeMemberId: body.assigneeMemberId !== undefined ? body.assigneeMemberId : undefined,
      priority: workItemPriorityFromBody(body),
      dueAt: body.dueAt === undefined ? undefined : body.dueAt === null ? null : new Date(body.dueAt),
      expectedVersion: body.expectedVersion,
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
