import { NextRequest, NextResponse } from "next/server";
import { addDiscussionComment } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string; threadId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, threadId } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const comment = await addDiscussionComment(actor, {
      workspaceId,
      threadId,
      bodyMd: String(body.bodyMd ?? ""),
    });
    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
