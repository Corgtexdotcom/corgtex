import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateTension, deleteTension } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { loadTensionWorkItemResponse, serializeTensionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

type Params = { params: Promise<{ workspaceId: string; tensionId: string }> };
const updateTensionSchema = z.object({
  title: z.string().trim().min(1).optional(),
  bodyMd: z.string().optional().nullable(),
  status: z.enum(["DRAFT", "OPEN", "RESOLVED"]).optional(),
  resolvedVia: z.string().optional().nullable(),
  circleId: z.string().optional().nullable(),
  assigneeMemberId: z.string().optional().nullable(),
  raisedByMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
  expectedVersion: z.number().int().positive(),
}).strict();

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, tensionId } = await params;
    const body = await validateBody(request, updateTensionSchema);
    const tension = await updateTension(actor, {
      workspaceId,
      tensionId,
      title: body.title,
      bodyMd: body.bodyMd !== undefined ? (typeof body.bodyMd === "string" ? body.bodyMd : null) : undefined,
      status: body.status,
      resolvedVia: body.resolvedVia !== undefined ? body.resolvedVia : undefined,
      circleId: body.circleId !== undefined ? body.circleId : undefined,
      assigneeMemberId: body.assigneeMemberId !== undefined ? body.assigneeMemberId : undefined,
      raisedByMemberId: body.raisedByMemberId !== undefined ? body.raisedByMemberId : undefined,
      priority: workItemPriorityFromBody(body),
      expectedVersion: body.expectedVersion,
    });
    const tensionForResponse = await loadTensionWorkItemResponse(workspaceId, tension.id) ?? tension;
    return NextResponse.json({ tension: serializeTensionWorkItem(tensionForResponse) });
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
