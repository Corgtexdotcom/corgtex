import { NextResponse } from "next/server";
import { listCatalogItems } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const catalog = await listCatalogItems(actor, workspaceId);
  return NextResponse.json(catalog);
});
