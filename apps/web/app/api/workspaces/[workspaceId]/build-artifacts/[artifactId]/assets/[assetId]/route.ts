import { NextResponse } from "next/server";
import { getBuildArtifactAssetSignedUrl } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const { signedUrl, file } = await getBuildArtifactAssetSignedUrl(actor, {
    workspaceId,
    artifactId: params.artifactId,
    assetId: params.assetId,
  });
  if (file) return new NextResponse(new Uint8Array(file.data), { headers: {
    "Content-Type": "application/octet-stream", "Content-Disposition": "attachment",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
  if (!signedUrl) return new NextResponse(null, { status: 404 });
  return NextResponse.redirect(signedUrl, 302);
});
