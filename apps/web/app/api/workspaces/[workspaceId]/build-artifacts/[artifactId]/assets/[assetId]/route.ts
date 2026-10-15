import { NextResponse } from "next/server";
import { buildAssetResponseHeaders } from "@/lib/build-asset-response-headers";
import { getBuildArtifactAssetSignedUrl } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";
import { authorizedDownloadStream } from "@/lib/authorized-download-stream";
import { getSupportAuthorizationContext, runWithSupportOrigin } from "@corgtex/shared";

export const dynamic = "force-dynamic";

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const { file, mimeType, authorize, byteBinding } = await getBuildArtifactAssetSignedUrl(actor, {
    workspaceId,
    artifactId: params.artifactId,
    assetId: params.assetId,
  });
  const origin = getSupportAuthorizationContext()?.origin ?? (actor.kind === "agent" ? actor.supportOrigin : undefined);
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(file.data)); controller.close(); } });
  const body = await authorizedDownloadStream(source, () => origin ? runWithSupportOrigin(origin, authorize) : authorize(),
    request.signal, { authorizeEveryDelivery: true, byteBinding });
  return new NextResponse(body, { headers: buildAssetResponseHeaders(mimeType) });
});
