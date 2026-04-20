import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { prisma, env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId } = sessionCtx;

    const [workspace, proposalCount, actionCount, tensionCount, memberCount] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, slug: true, name: true, description: true, createdAt: true },
      }),
      prisma.proposal.count({ where: { workspaceId } }),
      prisma.action.count({ where: { workspaceId } }),
      prisma.tension.count({ where: { workspaceId } }),
      prisma.member.count({ where: { workspaceId, isActive: true } }),
    ]);

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json({
      ...workspace,
      webUrl: `${origin}/workspaces/${workspaceId}`,
      counts: { proposals: proposalCount, actions: actionCount, tensions: tensionCount, members: memberCount },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
