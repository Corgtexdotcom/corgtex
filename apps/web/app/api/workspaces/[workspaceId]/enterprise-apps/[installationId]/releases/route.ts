import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createEnterpriseAppRelease,
  promoteEnterpriseAppRelease,
  rollbackEnterpriseAppRelease,
  upgradeEnterpriseAppRuntimeRelease,
} from "@corgtex/domain";
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

const releaseOperationSchema = z.object({
  operation: z.enum(["create", "promote", "rollback", "upgrade"]),
  releaseId: z.string().trim().min(1).optional().nullable(),
  version: z.string().trim().min(1).optional().nullable(),
  gitSha: z.string().trim().min(1).optional().nullable(),
  imageTag: z.string().trim().min(1).optional().nullable(),
  manifestVersion: z.string().trim().min(1).optional().nullable(),
  manifestJson: z.unknown().optional(),
  appImage: z.string().trim().min(1).optional().nullable(),
  appSource: appSourceSchema,
  variables: z.record(z.string(), z.string()).optional(),
  reason: z.string().optional().nullable(),
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const body = await validateBody(request, releaseOperationSchema);
  if (body.operation === "create") {
    const release = await createEnterpriseAppRelease(actor, {
      workspaceId,
      appInstallationId: params.installationId,
      version: body.version ?? "",
      gitSha: body.gitSha,
      imageTag: body.imageTag,
      manifestVersion: body.manifestVersion,
      manifestJson: body.manifestJson,
    });
    return NextResponse.json(release, { status: 201 });
  }

  if (body.operation === "promote") {
    const installation = await promoteEnterpriseAppRelease(actor, {
      workspaceId,
      appInstallationId: params.installationId,
      releaseId: body.releaseId ?? "",
      reason: body.reason,
    });
    return NextResponse.json({ installation });
  }

  if (body.operation === "rollback") {
    const installation = await rollbackEnterpriseAppRelease(actor, {
      workspaceId,
      appInstallationId: params.installationId,
      releaseId: body.releaseId ?? "",
      reason: body.reason,
    });
    return NextResponse.json({ installation });
  }

  const upgrade = await upgradeEnterpriseAppRuntimeRelease(actor, {
    workspaceId,
    appInstallationId: params.installationId,
    releaseId: body.releaseId ?? "",
    appImage: body.appImage,
    appSource: body.appSource,
    variables: body.variables,
    reason: body.reason,
  });
  return NextResponse.json(upgrade);
});
