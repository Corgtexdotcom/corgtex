import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { listCircles } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;
    
    const circles = await listCircles(workspaceId);

    const simplified = circles.map((c) => ({
      id: c.id,
      name: c.name,
      parentCircleId: c.parentCircleId,
      purpose: c.purposeMd || null,
      roles: c.roles.map(r => ({
        id: r.id,
        name: r.name,
      })),
    }));

    return NextResponse.json({ items: simplified });
  } catch (error) {
    return handleRouteError(error);
  }
}
