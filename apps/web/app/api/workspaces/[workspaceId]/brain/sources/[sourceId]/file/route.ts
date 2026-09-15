import { NextRequest, NextResponse } from "next/server";
import { AppError, getWorkspaceSupportGrant, resolveKnowledgeAccessDomains, requireWorkspaceMembership } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { defaultStorage } from "@corgtex/storage";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; sourceId: string }> }
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, sourceId } = await params;
    const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);

    const source = await prisma.brainSource.findFirst({
      where: {
        id: sourceId,
        workspaceId,
        accessDomain: { in: accessDomains },
      },
      select: {
        fileStorageKey: true,
      },
    });

    if (!source || !source.fileStorageKey) {
      throw new AppError(404, "NOT_FOUND", "File not found for this source.");
    }

    if ((actor.kind === "user" && await getWorkspaceSupportGrant(actor, workspaceId)) || (actor.kind === "agent" && actor.supportOrigin)) {
      const file = await defaultStorage.get(source.fileStorageKey, { maxBytes: 64 * 1024 * 1024 });
      if (!file) throw new AppError(404, "NOT_FOUND", "File not found.");
      await requireWorkspaceMembership({ actor, workspaceId });
      return new NextResponse(new Uint8Array(file.data), { headers: {
        "Content-Type": "application/octet-stream", "Content-Disposition": "attachment",
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    const downloadUrl = await defaultStorage.getSignedUrl(source.fileStorageKey, 3600);

    return NextResponse.redirect(downloadUrl, 302);
  } catch (error) {
    return handleRouteError(error);
  }
}
