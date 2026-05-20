import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { listControlPlaneFeatureFlags, setControlPlaneFeatureFlag } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const setFeatureFlagSchema = z.object({
  flag: z.string().trim().min(1),
  enabled: z.boolean(),
  config: z.unknown().optional(),
  reason: z.string().trim().min(1),
}).strict();

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const featureFlags = await listControlPlaneFeatureFlags(actor, deploymentId);
    return NextResponse.json({ featureFlags });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, setFeatureFlagSchema);
    const featureFlag = await setControlPlaneFeatureFlag(actor, {
      deploymentId,
      flag: body.flag,
      enabled: body.enabled,
      ...(Object.prototype.hasOwnProperty.call(body, "config") ? { config: body.config } : {}),
      reason: body.reason,
    });
    return NextResponse.json({ featureFlag });
  } catch (error) {
    return handleRouteError(error);
  }
}
