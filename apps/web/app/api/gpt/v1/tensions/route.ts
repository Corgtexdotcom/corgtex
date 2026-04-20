import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listTensions, createTension } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const result = await listTensions(actor, workspaceId, { take, skip });

    const simplified = result.items.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      author: t.author?.displayName ?? t.author?.email ?? "Unknown",
      createdAt: t.createdAt,
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

    const tension = await createTension(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd,
    });

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json({
      id: tension.id,
      status: tension.status,
      webUrl: `${origin}/workspaces/${workspaceId}/tensions`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
