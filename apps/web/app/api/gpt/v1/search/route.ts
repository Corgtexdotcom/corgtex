import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { searchIndexedKnowledge } from "@corgtex/knowledge";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId } = sessionCtx;
    
    const query = request.nextUrl.searchParams.get("query");
    const limit = parseInt(request.nextUrl.searchParams.get("limit") || "5", 10);

    if (!query) {
      return NextResponse.json({ error: "Missing 'query' parameter" }, { status: 400 });
    }

    const results = await searchIndexedKnowledge({
      workspaceId,
      query,
      limit,
    });

    return NextResponse.json({ items: results });
  } catch (error) {
    return handleRouteError(error);
  }
}
