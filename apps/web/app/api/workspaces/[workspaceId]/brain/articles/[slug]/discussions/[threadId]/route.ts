import { NextRequest, NextResponse } from "next/server";
import { markThreadAbsorbed, resolveDiscussionThread } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; slug: string; threadId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, threadId } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const action = body.action as string | undefined;
    if (action !== "resolve" && action !== "absorb") {
      return NextResponse.json(
        { error: "INVALID_ACTION", message: "Action must be 'resolve' or 'absorb'" },
        { status: 400 },
      );
    }

    const thread = action === "absorb"
      ? await markThreadAbsorbed(actor, { workspaceId, threadId })
      : await resolveDiscussionThread(actor, { workspaceId, threadId });
    return NextResponse.json({ thread });
  } catch (error) {
    return handleRouteError(error);
  }
}
