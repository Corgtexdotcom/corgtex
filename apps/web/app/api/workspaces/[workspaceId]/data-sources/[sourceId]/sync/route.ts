import { NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { enqueueJob } from "@corgtex/workflows";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (request, { workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;

  const source = await prisma.externalDataSource.findUnique({
    where: { id: sourceId, workspaceId },
  });

  if (!source) {
    throw new AppError(404, "NOT_FOUND", "Data source not found");
  }

  // Trigger immediate sync
  const ts = Date.now();
  await prisma.$transaction(async (tx) => {
    await enqueueJob(tx, {
      workspaceId,
      eventId: `manual-sync-${ts}`,
      type: "data-source.sync",
      payload: { sourceId },
      dedupeKey: `manual-sync-${sourceId}-${ts}`,
    });
  });

  return NextResponse.json({ success: true });
});
