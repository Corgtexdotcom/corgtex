import { NextRequest, NextResponse } from "next/server";
import { AppError, getWorkspaceSupportGrant, resolveKnowledgeAccessDomains } from "@corgtex/domain";
import { getSupportAuthorizationContext, prisma, runWithSupportOrigin } from "@corgtex/shared";
import { defaultStorage } from "@corgtex/storage";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { authorizedDownloadStream } from "@/lib/authorized-download-stream";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; sourceId: string }> }
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, sourceId } = await params;
    const accessDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
    const origin = getSupportAuthorizationContext()?.origin ?? (actor.kind === "agent" ? actor.supportOrigin : undefined);

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

    if (origin || (actor.kind === "user" && await getWorkspaceSupportGrant(actor, workspaceId))) {
      if (!origin || origin.workspaceId !== workspaceId || (actor.kind === "user" && origin.userId !== actor.user.id)) {
        throw new AppError(403, "SUPPORT_AUTHORIZATION_REVOKED", "Support authorization is unavailable.");
      }
      const file = await defaultStorage.getStream(source.fileStorageKey, { signal: request.signal });
      if (!file) throw new AppError(404, "NOT_FOUND", "File not found.");
      const body = await authorizedDownloadStream(file.body, () => runWithSupportOrigin(origin, async () => {
        const currentDomains = await resolveKnowledgeAccessDomains(actor, workspaceId);
        const currentSource = await prisma.brainSource.findFirst({
          where: { id: sourceId, workspaceId, fileStorageKey: source.fileStorageKey, accessDomain: { in: currentDomains } },
          select: { fileStorageKey: true },
        });
        if (!currentSource) throw new AppError(404, "NOT_FOUND", "File not found for this source.");
      }), request.signal);
      return new NextResponse(body, { headers: {
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
