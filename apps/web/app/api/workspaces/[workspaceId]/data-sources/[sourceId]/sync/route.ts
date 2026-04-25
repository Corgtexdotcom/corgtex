import { NextResponse } from "next/server";
import { AppError, enqueueExternalDataSourceSync } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params, membership }) => {
  if (membership?.role !== "ADMIN") {
    throw new AppError(403, "FORBIDDEN", "Requires admin access");
  }

  const sourceId = params.sourceId;
  await enqueueExternalDataSourceSync(actor, { workspaceId, sourceId });

  return NextResponse.json({ success: true });
});
