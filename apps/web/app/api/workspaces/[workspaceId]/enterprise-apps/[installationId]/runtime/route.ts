import { NextResponse } from "next/server";
import { z } from "zod";
import { preflightEnterpriseAppRuntime, provisionEnterpriseAppRuntime } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const dynamic = "force-dynamic";

const appSourceSchema = z.object({
  repo: z.string().trim().min(1),
  branch: z.string().trim().min(1).nullable().optional(),
  commitSha: z.string().trim().min(1).nullable().optional(),
  rootDirectory: z.string().trim().min(1).nullable().optional(),
  dockerfilePath: z.string().trim().min(1).nullable().optional(),
  startCommand: z.string().trim().min(1).nullable().optional(),
  builder: z.enum(["HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"]).nullable().optional(),
}).nullable().optional();

const runtimeOperationSchema = z.object({
  operation: z.enum(["provision", "preflight"]),
  runtimeMode: z.string().optional().nullable(),
  runtimeBaseUrl: z.string().optional().nullable(),
  runtimeHealthUrl: z.string().optional().nullable(),
  runtimeMcpUrl: z.string().optional().nullable(),
  environment: z.string().optional().nullable(),
  region: z.string().optional().nullable(),
  customDomain: z.string().optional().nullable(),
  secretsRef: z.string().optional().nullable(),
  releaseVersion: z.string().optional().nullable(),
  releaseImageTag: z.string().optional().nullable(),
  appImage: z.string().optional().nullable(),
  appSource: appSourceSchema,
  variables: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, runtimeOperationSchema);
  if (body.operation === "preflight") {
    const preflight = await preflightEnterpriseAppRuntime(actor, {
      workspaceId,
      appInstallationId: params.installationId,
      reason: body.reason,
    });
    return NextResponse.json(preflight);
  }

  const installation = await provisionEnterpriseAppRuntime(actor, {
    workspaceId,
    appInstallationId: params.installationId,
    runtimeMode: body.runtimeMode ?? "SHARED_MULTI_TENANT",
    runtimeBaseUrl: body.runtimeBaseUrl,
    runtimeHealthUrl: body.runtimeHealthUrl,
    runtimeMcpUrl: body.runtimeMcpUrl,
    environment: body.environment,
    region: body.region,
    customDomain: body.customDomain,
    secretsRef: body.secretsRef,
    releaseVersion: body.releaseVersion,
    releaseImageTag: body.releaseImageTag,
    appImage: body.appImage,
    appSource: body.appSource,
    variables: body.variables,
    reason: body.reason,
  });
  return NextResponse.json({ installation }, { status: 201 });
});
