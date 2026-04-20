import type { BrainDiscussionTargetType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { createDiscussionThread, getArticle } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; slug: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const article = await getArticle(actor, { workspaceId, slug });
    return NextResponse.json({ discussions: article.discussions });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string; slug: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, slug } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const thread = await createDiscussionThread(actor, {
      workspaceId,
      slug,
      targetType: (typeof body.targetType === "string" ? body.targetType : "ARTICLE") as BrainDiscussionTargetType,
      targetRef: typeof body.targetRef === "string" ? body.targetRef : null,
      bodyMd: String(body.bodyMd ?? ""),
    });
    return NextResponse.json({ thread }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
