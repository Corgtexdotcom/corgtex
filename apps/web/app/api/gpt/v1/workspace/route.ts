import { DigestReadRelease } from "@corgtex/domain";
import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { prisma, env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";
import { scanReadableArtifactPages } from "@/lib/readable-artifact-pages";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;
    const release = new DigestReadRelease(actor, workspaceId);

    const [workspace, proposalCount, actionCount, tensionCount, memberCount] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, slug: true, name: true, description: true, createdAt: true },
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Proposal", visit: () => {},
        loadPage: (cursor, take) => prisma.proposal.findMany({ where: { workspaceId, archivedAt: null },
          orderBy: { id: "asc" }, take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Action", visit: () => {},
        loadPage: (cursor, take) => prisma.action.findMany({ where: { workspaceId },
          orderBy: { id: "asc" }, take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Tension", visit: () => {},
        loadPage: (cursor, take) => prisma.tension.findMany({ where: { workspaceId },
          orderBy: { id: "asc" }, take, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
      }),
      prisma.member.count({ where: { workspaceId, isActive: true } }),
    ]);

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json(await release.finish({
      ...workspace,
      webUrl: `${origin}/workspaces/${workspaceId}`,
      counts: { proposals: proposalCount, actions: actionCount, tensions: tensionCount, members: memberCount },
    }));
  } catch (error) {
    return handleRouteError(error);
  }
}
