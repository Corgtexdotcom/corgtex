import { NextResponse } from "next/server";
import { buildAssetResponseHeaders } from "@/lib/build-asset-response-headers";
import { resolvePublicBuildArtifactAsset } from "@corgtex/domain";
import { withRoute } from "@/lib/route-handler";
import { authorizedOwnedDownloadStream } from "@/lib/authorized-download-stream";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (request, { params }) => {
  const { publicToken, assetId } = await params;
  const { file, mimeType, authorize, byteBinding } = await resolvePublicBuildArtifactAsset({
    publicToken,
    assetId,
  });
  const body = await authorizedOwnedDownloadStream(file.data, authorize, request.signal, byteBinding);
  return new NextResponse(body, { headers: buildAssetResponseHeaders(mimeType) });
});
