import { NextResponse } from "next/server";
import { buildAssetResponseHeaders } from "@/lib/build-asset-response-headers";
import { resolvePublicBuildArtifactAsset } from "@corgtex/domain";
import { withRoute } from "@/lib/route-handler";
import { authorizedDownloadStream } from "@/lib/authorized-download-stream";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (request, { params }) => {
  const { publicToken, assetId } = await params;
  const { file, mimeType, authorize, byteBinding } = await resolvePublicBuildArtifactAsset({
    publicToken,
    assetId,
  });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(file.data)); controller.close(); } });
  const body = await authorizedDownloadStream(source, authorize, request.signal, { authorizeEveryDelivery: true, byteBinding });
  return new NextResponse(body, { headers: buildAssetResponseHeaders(mimeType) });
});
