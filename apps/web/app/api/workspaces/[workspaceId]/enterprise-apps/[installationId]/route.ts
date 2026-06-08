import { NextResponse } from "next/server";
import { z } from "zod";
import { updateEnterpriseAppInstallation } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const updateEnterpriseAppSchema = z.object({
  status: z.string().optional().nullable(),
  runtimeMode: z.string().optional().nullable(),
  runtimeStatus: z.string().optional().nullable(),
  runtimeBaseUrl: z.string().optional().nullable(),
  runtimeHealthUrl: z.string().optional().nullable(),
  runtimeMcpUrl: z.string().optional().nullable(),
  tenantExternalId: z.string().optional().nullable(),
  tenantMappingJson: z.record(z.string(), z.unknown()).optional().nullable(),
  launchPath: z.string().optional().nullable(),
  grantedScopes: z.array(z.string()).optional(),
  reason: z.string().optional().nullable(),
});

export const PATCH = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, updateEnterpriseAppSchema);
  const installation = await updateEnterpriseAppInstallation(actor, {
    workspaceId,
    appInstallationId: params.installationId,
    ...body,
  });
  return NextResponse.json({ installation });
});
