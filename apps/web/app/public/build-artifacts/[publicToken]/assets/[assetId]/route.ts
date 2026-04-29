import { NextResponse } from "next/server";
import { resolvePublicBuildArtifactAsset } from "@corgtex/domain";
import { withRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (_request, { params }) => {
  const { publicToken, assetId } = await params;
  const { signedUrl } = await resolvePublicBuildArtifactAsset({
    publicToken,
    assetId,
  });
  return NextResponse.redirect(signedUrl, 302);
});
