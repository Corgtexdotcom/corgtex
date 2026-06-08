import { NextResponse } from "next/server";
import { z } from "zod";
import { installEnterpriseApp, listWorkspaceEnterpriseApps } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const installEnterpriseAppSchema = z.object({
  appKey: z.string().min(1),
  catalogItemId: z.string().optional().nullable(),
  surface: z.string().optional().nullable(),
  runtimeMode: z.string().optional().nullable(),
  runtimeStatus: z.string().optional().nullable(),
  runtimeBaseUrl: z.string().optional().nullable(),
  runtimeHealthUrl: z.string().optional().nullable(),
  runtimeMcpUrl: z.string().optional().nullable(),
  tenantExternalId: z.string().optional().nullable(),
  tenantMappingJson: z.record(z.string(), z.unknown()).optional().nullable(),
  launchPath: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  grantedScopes: z.array(z.string()).optional(),
  reason: z.string().optional().nullable(),
});

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId }) => {
  const apps = await listWorkspaceEnterpriseApps(actor, workspaceId);
  return NextResponse.json(apps);
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const body = await validateBody(request, installEnterpriseAppSchema);
  const installation = await installEnterpriseApp(actor, {
    workspaceId,
    ...body,
  });
  return NextResponse.json({ installation }, { status: 201 });
});
