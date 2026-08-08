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
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
  reportImportsEnabled: z.boolean().optional(),
  expectedConfigIdentity: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  reason: z.string().trim().min(1),
}).strict().superRefine((value, context) => {
  const has = (key: keyof typeof value) => Object.prototype.hasOwnProperty.call(value, key);
  const reportImports = has("reportImportsEnabled");
  const financeConfig = value.flag === "FINANCE" && (has("config") || reportImports);
  if ((!reportImports && !has("enabled")) || (reportImports && (has("enabled") || has("config") || value.flag !== "FINANCE"))) {
    context.addIssue({ code: "custom", message: "Choose exactly one supported feature-flag mutation mode." });
  }
  if ((financeConfig && !has("expectedConfigIdentity")) || (has("expectedConfigIdentity") && !financeConfig)) {
    context.addIssue({ code: "custom", message: "Finance config writes require expectedConfigIdentity." });
  }
});

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
      ...(Object.prototype.hasOwnProperty.call(body, "enabled") ? { enabled: body.enabled } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "config") ? { config: body.config } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "reportImportsEnabled") ? { reportImportsEnabled: body.reportImportsEnabled } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "expectedConfigIdentity") ? { expectedConfigIdentity: body.expectedConfigIdentity } : {}),
      reason: body.reason,
    });
    return NextResponse.json({ featureFlag });
  } catch (error) {
    return handleRouteError(error);
  }
}
