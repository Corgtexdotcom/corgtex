import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createTension, getWorkspacePermanentPathForEntity, listTensions, requireWorkspaceMembership } from "@corgtex/domain";
import type { ArchiveFilter } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { loadTensionWorkItemResponse, serializeTensionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

const createTensionSchema = z.object({
  title: z.string().trim().min(1),
  bodyMd: z.string().optional().nullable(),
  raisedByMemberId: z.string().optional().nullable(),
  assigneeMemberId: z.string().optional().nullable(),
  priority: z.union([z.number().int(), z.string()]).optional().nullable(),
  priorityLabel: z.string().optional().nullable(),
});

const MAX_LIST_TAKE = 100;

function optionalIntParam(request: NextRequest, name: string) {
  const value = request.nextUrl.searchParams.get(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return name === "take" ? Math.min(parsed, MAX_LIST_TAKE) : parsed;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const archiveFilter = request.nextUrl.searchParams.get("archiveFilter") as ArchiveFilter | null;
    const tensions = await listTensions(actor, workspaceId, {
      archiveFilter: archiveFilter ?? undefined,
      take: optionalIntParam(request, "take"),
      skip: optionalIntParam(request, "skip"),
    });
    return NextResponse.json({
      tensions: {
        ...tensions,
        items: tensions.items.map(serializeTensionWorkItem),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createTensionSchema);
    const tension = await createTension(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd ?? null,
      raisedByMemberId: body.raisedByMemberId ?? null,
      assigneeMemberId: body.assigneeMemberId ?? null,
      priority: workItemPriorityFromBody(body),
    });
    const origin = env.APP_URL.replace(/\/$/, "");
    const permanentPath = await getWorkspacePermanentPathForEntity({ workspaceId, entityType: "Tension", entityId: tension.id });
    const tensionForResponse = await loadTensionWorkItemResponse(workspaceId, tension.id) ?? tension;
    return NextResponse.json({
      tension: serializeTensionWorkItem(tensionForResponse),
      webUrl: `${origin}/workspaces/${workspaceId}/tensions/${tension.id}`,
      permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
    }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
