import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getControlPlaneContextHealth, runControlPlaneContextOperation } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const contextOperationSchema = z.object({
  operation: z.enum(["sync_all", "sync_source", "disable_source"]),
  sourceId: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
}).strict();

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const context = await getControlPlaneContextHealth(actor, deploymentId);
    return NextResponse.json({ context });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, contextOperationSchema);
    const operation = await runControlPlaneContextOperation(actor, {
      deploymentId,
      operation: body.operation,
      sourceId: body.sourceId,
      reason: body.reason,
    });
    return NextResponse.json({ operation });
  } catch (error) {
    return handleRouteError(error);
  }
}
