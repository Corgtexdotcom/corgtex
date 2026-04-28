import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { upgradeHostedInstanceRelease } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const upgradeReleaseSchema = z.object({
  releaseVersion: z.string().trim().min(1).nullable().optional(),
  releaseImageTag: z.string().trim().min(1),
  webImage: z.string().trim().min(1),
  workerImage: z.string().trim().min(1),
  variables: z.record(z.string(), z.string()).optional(),
});

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ instanceId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { instanceId } = await props.params;
    const body = await validateBody(request, upgradeReleaseSchema);
    const instance = await upgradeHostedInstanceRelease(actor, {
      instanceId,
      ...body,
    });
    return NextResponse.json({ instance });
  } catch (error) {
    return handleRouteError(error);
  }
}
