import { NextRequest, NextResponse } from "next/server";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    const limit = Number(url.searchParams.get("limit")) || 8;
    if (!query) {
      throw new AppError(400, "INVALID_INPUT", "Search query is required.");
    }

    await requireWorkspaceMembership({ actor, workspaceId });
    const results = await searchIndexedKnowledge({
      workspaceId,
      query,
      limit,
      sourceTypes: ["BRAIN_ARTICLE"],
    });
    return NextResponse.json({ results });
  } catch (error) {
    return handleRouteError(error);
  }
}
