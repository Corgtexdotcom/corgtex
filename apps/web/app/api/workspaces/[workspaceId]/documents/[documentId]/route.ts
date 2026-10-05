import { NextRequest, NextResponse } from "next/server";
import { AppError, deleteDocument } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; documentId: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  let target: { workspaceId: string; documentId: string } | null = null;
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, documentId } = await params;
    target = { workspaceId, documentId };
    await deleteDocument(actor, { workspaceId, documentId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (target && error instanceof AppError
      && (error.code === "DOCUMENT_SOURCE_REMOVAL_REQUIRED" || error.code === "SOURCE_ARTICLE_IMPACT_REVIEW_REQUIRED")) {
      const { workspaceId, documentId } = target;
      const sources = await prisma.brainSource.findMany({ where: {
        workspaceId, archivedAt: null,
        metadata: { path: ["documentId"], equals: documentId },
      }, select: { id: true } });
      return NextResponse.json({ error: { code: error.code, message: error.message },
        reviewSources: sources.map((source) => ({ id: source.id,
          href: `/workspaces/${workspaceId}/brain/sources?review=${encodeURIComponent(source.id)}` })),
      }, { status: 409 });
    }
    return handleRouteError(error);
  }
}
