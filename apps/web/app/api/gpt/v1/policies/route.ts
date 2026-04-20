import { NextRequest, NextResponse } from "next/server";
import { requireGptAuth } from "@/lib/gpt-auth";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const sessionCtx = await requireGptAuth(request, "read");
    const { workspaceId, actor } = sessionCtx;
    
    await requireWorkspaceMembership({ actor, workspaceId });

    const take = parseInt(request.nextUrl.searchParams.get("take") || "50", 10);
    const skip = parseInt(request.nextUrl.searchParams.get("skip") || "0", 10);

    const policies = await prisma.policyCorpus.findMany({
      where: { workspaceId },
      include: {
        circle: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });

    const total = await prisma.policyCorpus.count({ where: { workspaceId } });

    const simplified = policies.map((p) => ({
      id: p.id,
      title: p.title,
      bodyMd: p.bodyMd,
      circleScope: p.circle?.name || "Global",
      acceptedAt: p.acceptedAt,
    }));

    return NextResponse.json({ items: simplified, total });
  } catch (error) {
    return handleRouteError(error);
  }
}
