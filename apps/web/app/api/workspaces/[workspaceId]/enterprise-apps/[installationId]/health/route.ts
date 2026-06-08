import { NextResponse } from "next/server";
import { z } from "zod";
import { probeEnterpriseAppInstallationHealth } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const healthProbeSchema = z.object({
  reason: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, healthProbeSchema);
  const probe = await probeEnterpriseAppInstallationHealth(actor, {
    workspaceId,
    appInstallationId: params.installationId,
    reason: body.reason,
  });
  return NextResponse.json(probe);
});
