import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listTensions, createTension, getWorkspacePermanentPathForEntity } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { serializeTensionWorkItem, workItemPriorityFromBody } from "@/lib/work-item-api";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const result = await listTensions(actor, workspaceId, { take, skip });

    const simplified = result.items.map((t) => {
      const item = serializeTensionWorkItem(t);
      return {
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        priorityLabel: item.priorityLabel,
        author: t.author?.displayName ?? t.author?.email ?? "Unknown",
        assigneeMemberId: item.assigneeMemberId,
        assigneeMemberName: item.assigneeMemberName,
        responsibleMemberId: item.responsibleMemberId,
        responsibleMemberName: item.responsibleMemberName,
        responsiblePerson: item.responsiblePerson,
        raisedByMemberId: item.raisedByMemberId,
        raisedByMemberName: item.raisedByMemberName,
        raisedBy: item.raisedBy,
        createdAt: t.createdAt,
      };
    });

    return NextResponse.json({ items: simplified, total: result.total });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "write");
    const { workspaceId, actor } = sessionCtx;
    const body = await request.json();

    if (!body.title) {
      return NextResponse.json({ error: "Missing required fields (title)" }, { status: 400 });
    }

    const tension = await createTension(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd,
      raisedByMemberId: body.raisedByMemberId ?? null,
      assigneeMemberId: body.assigneeMemberId ?? null,
      priority: workItemPriorityFromBody(body),
    });
    const item = serializeTensionWorkItem(tension);

    const origin = env.APP_URL.replace(/\/$/, "");
    const permanentPath = await getWorkspacePermanentPathForEntity({
      workspaceId,
      entityType: "Tension",
      entityId: tension.id,
    });

    return NextResponse.json({
      id: tension.id,
      priority: item.priority,
      priorityLabel: item.priorityLabel,
      assigneeMemberId: item.assigneeMemberId,
      assigneeMemberName: item.assigneeMemberName,
      responsibleMemberId: item.responsibleMemberId,
      responsibleMemberName: item.responsibleMemberName,
      status: tension.status,
      webUrl: `${origin}/workspaces/${workspaceId}/tensions/${tension.id}`,
      permanentUrl: permanentPath ? `${origin}${permanentPath}` : null,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
