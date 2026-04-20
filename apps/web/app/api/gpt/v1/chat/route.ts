import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { processConversationTurn } from "@corgtex/agents";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "chat");
    const { workspaceId, actor } = sessionCtx;
    const body = await request.json();

    if (!body.message || typeof body.message !== "string") {
      return NextResponse.json({ error: "Invalid request, missing 'message' string" }, { status: 400 });
    }

    const userId = actor.kind === "user" ? actor.user.id : "gpt-user";

    const result = await processConversationTurn({
      workspaceId,
      sessionId: `gpt-${workspaceId}-${userId}`,
      userId,
      agentKey: "assistant",
      userMessage: body.message,
    });

    return NextResponse.json({ assistantMessage: result.assistantMessage });
  } catch (error) {
    return handleRouteError(error);
  }
}
