import { NextResponse } from "next/server";
import { setCatalogFavorite } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const POST = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const result = await setCatalogFavorite(actor, {
    workspaceId,
    catalogItemId: params.catalogItemId,
    favorite: true,
  });
  return NextResponse.json(result);
});

export const DELETE = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "TOOL_LINKS");
  if (disabled) return disabled;

  const result = await setCatalogFavorite(actor, {
    workspaceId,
    catalogItemId: params.catalogItemId,
    favorite: false,
  });
  return NextResponse.json(result);
});
