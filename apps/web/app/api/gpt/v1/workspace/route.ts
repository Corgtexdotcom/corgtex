import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { prisma, env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { readableArtifactIds } from "@corgtex/domain";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;

    const [workspace, proposals, actionCount, tensionCount, memberCount] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, slug: true, name: true, description: true, createdAt: true },
      }),
      prisma.proposal.findMany({ where: { workspaceId, archivedAt: null } }),
      prisma.action.count({ where: { workspaceId } }),
      prisma.tension.count({ where: { workspaceId } }),
      prisma.member.count({ where: { workspaceId, isActive: true } }),
    ]);
    const proposalCount = (await readableArtifactIds(actor, workspaceId, "Proposal", proposals)).size;

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
