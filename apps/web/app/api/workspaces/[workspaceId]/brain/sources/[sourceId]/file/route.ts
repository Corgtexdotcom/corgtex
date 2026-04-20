import { NextRequest, NextResponse } from "next/server";
import { AppError, requireWorkspaceMembership } from "@corgtex/domain";
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

    await requireWorkspaceMembership({ actor, workspaceId });

    const source = await prisma.brainSource.findFirst({
      where: {
        id: sourceId,
        workspaceId,
      },
      select: {
        fileStorageKey: true,
      },
    });

    if (!source || !source.fileStorageKey) {
      throw new AppError(404, "NOT_FOUND", "File not found for this source.");
    }

    const downloadUrl = await defaultStorage.getSignedUrl(source.fileStorageKey, 3600);
    
    return NextResponse.redirect(downloadUrl, 302);
  } catch (error) {
    return handleRouteError(error);
  }
}
