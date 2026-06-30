import { NextResponse } from "next/server";
import { enqueueExternalContentSourceSync } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const item = await enqueueExternalContentSourceSync(actor, {
    workspaceId,
    sourceId: params.sourceId,
  });
  return NextResponse.json({ item });
});
