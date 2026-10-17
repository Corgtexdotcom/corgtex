import { DigestReadRelease, invariant } from "@corgtex/domain";
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
    const search = new URL(request.url).searchParams;
    const readCursor = (name: string) => {
      const values = search.getAll(name);
      invariant(values.length <= 1, 400, "INVALID_INPUT", "A count family accepts only one continuation.");
      const value = values[0];
      invariant(value === undefined || (value.length > 0 && value.length <= 256
        && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
      400, "INVALID_INPUT", "Invalid workspace count continuation.");
      return value;
    };
    const proposalCursor = readCursor("proposalCursor");
    const actionCursor = readCursor("actionCursor");
    const tensionCursor = readCursor("tensionCursor");

    const [workspace, proposalCount, actionCount, tensionCount, memberCount] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, slug: true, name: true, description: true, createdAt: true },
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Proposal", cursor: proposalCursor, visit: () => {},
        loadPage: (cursor, take) => prisma.proposal.findMany({ where: { workspaceId, archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: "asc" }, take }),
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Action", cursor: actionCursor, visit: () => {},
        loadPage: (cursor, take) => prisma.action.findMany({ where: { workspaceId, archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: "asc" }, take }),
      }),
      scanReadableArtifactPages({ actor, workspaceId, release, kind: "Tension", cursor: tensionCursor, visit: () => {},
        loadPage: (cursor, take) => prisma.tension.findMany({ where: { workspaceId, archivedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: "asc" }, take }),
      }),
      prisma.member.count({ where: { workspaceId, isActive: true } }),
    ]);

    const origin = env.APP_URL.replace(/\/$/, "");

    return NextResponse.json(await release.finish({
      ...workspace,
      webUrl: `${origin}/workspaces/${workspaceId}`,
      counts: {
        proposals: !proposalCursor && proposalCount.complete ? proposalCount.count : null,
        actions: !actionCursor && actionCount.complete ? actionCount.count : null,
        tensions: !tensionCursor && tensionCount.complete ? tensionCount.count : null,
        members: memberCount,
      },
      countWindows: {
        proposals: { ...proposalCount, scope: "WINDOW" as const },
        actions: { ...actionCount, scope: "WINDOW" as const },
        tensions: { ...tensionCount, scope: "WINDOW" as const },
      },
    }));
  } catch (error) {
    return handleRouteError(error);
  }
}
