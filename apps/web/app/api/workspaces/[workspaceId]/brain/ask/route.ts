import { NextRequest, NextResponse } from "next/server";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { answerKnowledgeQuestion } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const question = String(body.question ?? "").trim();
    const limit = typeof body.limit === "number" ? body.limit : 4;
    if (!question) {
      throw new AppError(400, "INVALID_INPUT", "Question is required.");
    }

    await requireWorkspaceMembership({ actor, workspaceId });
    const result = await answerKnowledgeQuestion({
      workspaceId,
      question,
      limit,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
