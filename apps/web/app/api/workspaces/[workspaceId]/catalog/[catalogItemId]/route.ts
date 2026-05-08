import { NextResponse } from "next/server";
import { getCatalogItem } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const item = await getCatalogItem(actor, {
    workspaceId,
    catalogItemId: params.catalogItemId,
  });
  return NextResponse.json(item);
});
