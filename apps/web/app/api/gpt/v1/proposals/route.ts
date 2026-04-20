import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listProposals, createProposal } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const take = parseInt(request.nextUrl.searchParams.get("take") || "20", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const result = await listProposals(actor, workspaceId, { take, skip });

    const simplified = result.items.map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      summary: p.summary,
      author: p.author?.displayName ?? p.author?.email ?? "Unknown",
      createdAt: p.createdAt,
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

    if (!body.title || !body.bodyMd) {
      return NextResponse.json({ error: "Missing required fields (title, bodyMd)" }, { status: 400 });
    }

    const proposal = await createProposal(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd,
      summary: body.summary,
    });

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      webUrl: `${origin}/workspaces/${workspaceId}/proposals`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
