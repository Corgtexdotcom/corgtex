import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { prisma } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { requireWorkspaceMembership } from "@corgtex/domain";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;
    
    await requireWorkspaceMembership({ actor, workspaceId });

    const members = await prisma.member.findMany({
      where: { workspaceId, isActive: true },
      include: {
        user: { select: { email: true, displayName: true } }
      },
      orderBy: { role: 'desc' }
    });
    
    const simplified = members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      email: m.user.email,
      name: m.user.displayName,
      joinedAt: m.joinedAt,
    }));

    return NextResponse.json({ items: simplified });
  } catch (error) {
    return handleRouteError(error);
  }
}
