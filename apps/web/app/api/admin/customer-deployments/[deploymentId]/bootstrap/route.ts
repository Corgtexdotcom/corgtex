import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { triggerCustomerDeploymentBootstrap } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const triggerBootstrapSchema = z.object({
  token: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
});

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, triggerBootstrapSchema);
    const deployment = await triggerCustomerDeploymentBootstrap(actor, {
      deploymentId,
      token: body.token,
      expiresAt: new Date(body.expiresAt),
    });
    return NextResponse.json({ deployment });
  } catch (error) {
    return handleRouteError(error);
  }
}
