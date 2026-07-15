import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { upgradeCustomerDeploymentRelease } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";

export const dynamic = "force-dynamic";

const upgradeReleaseSchema = z.object({
  releaseVersion: z.string().trim().min(1).nullable().optional(),
  releaseGitSha: z.string().trim().min(1).nullable().optional(),
  releaseImageTag: z.string().trim().min(1),
  webImage: z.string().trim().min(1).nullable().optional(),
  workerImage: z.string().trim().min(1).nullable().optional(),
  webSource: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable().optional(),
    commitSha: z.string().trim().min(1).nullable().optional(),
    rootDirectory: z.string().trim().min(1).nullable().optional(),
    dockerfilePath: z.string().trim().min(1).nullable().optional(),
    startCommand: z.string().trim().min(1).nullable().optional(),
    builder: z.enum(["HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"]).nullable().optional(),
  }).nullable().optional(),
  workerSource: z.object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).nullable().optional(),
    commitSha: z.string().trim().min(1).nullable().optional(),
    rootDirectory: z.string().trim().min(1).nullable().optional(),
    dockerfilePath: z.string().trim().min(1).nullable().optional(),
    startCommand: z.string().trim().min(1).nullable().optional(),
    builder: z.enum(["HEROKU", "NIXPACKS", "PAKETO", "RAILPACK"]).nullable().optional(),
  }).nullable().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await resolveRequestActor(request);
    const { deploymentId } = await props.params;
    const body = await validateBody(request, upgradeReleaseSchema);
    const deployment = await upgradeCustomerDeploymentRelease(actor, {
      deploymentId,
      ...body,
    });
    return NextResponse.json({ deployment });
  } catch (error) {
    return handleRouteError(error);
  }
}
