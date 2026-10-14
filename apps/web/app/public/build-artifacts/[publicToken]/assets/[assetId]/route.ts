import { NextResponse } from "next/server";
import { resolvePublicBuildArtifactAsset } from "@corgtex/domain";
import { withRoute } from "@/lib/route-handler";
import { authorizedDownloadStream } from "@/lib/authorized-download-stream";

export const dynamic = "force-dynamic";

export const GET = withRoute(async (request, { params }) => {
  const { publicToken, assetId } = await params;
  const { file, authorize } = await resolvePublicBuildArtifactAsset({
    publicToken,
    assetId,
  });
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(file.data)); controller.close(); } });
  const body = await authorizedDownloadStream(source, authorize, request.signal, { authorizeEveryDelivery: true });
  return new NextResponse(body, { headers: {
    "Content-Type": "application/octet-stream", "Content-Disposition": "attachment",
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
});
