import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getControlPlaneReleaseStatus, runControlPlaneReleaseOperation } from "@corgtex/domain";
import { resolveControlPlaneRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const releaseOperationSchema = z.object({
  operation: z.enum(["prepare_upgrade"]),
  targetReleaseImageTag: z.string().trim().min(1),
  targetReleaseVersion: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1),
}).strict();

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const releases = await getControlPlaneReleaseStatus(actor, instanceId);
    return NextResponse.json({ releases });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveControlPlaneRequestActor(request);
    const { instanceId } = await props.params;
    const body = await validateBody(request, releaseOperationSchema);
    const operation = await runControlPlaneReleaseOperation(actor, {
      instanceId,
      operation: body.operation,
      targetReleaseImageTag: body.targetReleaseImageTag,
      targetReleaseVersion: body.targetReleaseVersion,
      reason: body.reason,
    });
    return NextResponse.json({ operation });
  } catch (error) {
    return handleRouteError(error);
  }
}
