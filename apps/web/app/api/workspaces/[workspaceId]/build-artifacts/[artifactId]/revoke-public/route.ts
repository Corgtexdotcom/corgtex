import { NextResponse } from "next/server";
import { z } from "zod";
import { revokeBuildArtifactPublicAccess } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const revokeSchema = z.object({
  reason: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const parsed = await validateBody(request, revokeSchema);
  const artifact = await revokeBuildArtifactPublicAccess(actor, {
    workspaceId,
    artifactId: params.artifactId,
    reason: parsed.reason,
  });
  return NextResponse.json(artifact);
});
