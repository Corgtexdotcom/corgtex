import { NextResponse } from "next/server";
import { getBuildArtifactAssetSignedUrl } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const { signedUrl } = await getBuildArtifactAssetSignedUrl(actor, {
    workspaceId,
    artifactId: params.artifactId,
    assetId: params.assetId,
  });
  return NextResponse.redirect(signedUrl, 302);
});
