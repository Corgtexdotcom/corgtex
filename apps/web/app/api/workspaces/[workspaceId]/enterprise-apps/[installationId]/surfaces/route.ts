import { NextResponse } from "next/server";
import { z } from "zod";
import { assignEnterpriseAppSurface } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const surfaceSchema = z.object({
  surface: z.string().min(1),
  enabled: z.boolean().optional(),
  reason: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, surfaceSchema);
  const surface = await assignEnterpriseAppSurface(actor, {
    workspaceId,
    appInstallationId: params.installationId,
    surface: body.surface,
    enabled: body.enabled,
    reason: body.reason,
  });
  return NextResponse.json({ surface });
});
