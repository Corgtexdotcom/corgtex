import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listActions, createAction } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const result = await listActions(actor, workspaceId, { take, skip });

    const simplified = result.items.map((a) => ({
      id: a.id,
      title: a.title,
      status: a.status,
      author: a.author?.displayName ?? a.author?.email ?? "Unknown",
      assignee: a.assigneeMember?.user?.displayName ?? a.assigneeMember?.user?.email ?? null,
      dueAt: (a as Record<string, unknown>).dueAt ?? null,
      createdAt: a.createdAt,
    }));

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

    const action = await createAction(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd,
    });

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json({
      id: action.id,
      status: action.status,
      webUrl: `${origin}/workspaces/${workspaceId}/actions`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
