import { NextResponse } from "next/server";
import { z } from "zod";
import { getBuildArtifact, updateBuildArtifact } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const updateArtifactSchema = z.object({
  repositoryOwner: z.string().min(1).optional(),
  repositoryName: z.string().min(1).optional(),
  pullRequestNumber: z.number().int().positive().optional().nullable(),
  pullRequestUrl: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  commitSha: z.string().optional().nullable(),
  mergeCommitSha: z.string().optional().nullable(),
  title: z.string().min(1).optional(),
  summaryMd: z.string().optional().nullable(),
  status: z.enum(["OPEN", "MERGED", "CLOSED"]).optional(),
  classification: z.enum(["OPEN_CORE", "INTERNAL", "CLIENT_PRIVATE"]).optional(),
  visibility: z.enum(["PRIVATE", "PUBLIC_REVIEW", "REVOKED"]).optional(),
  noPrivateDataConfirmed: z.boolean().optional(),
});

export const GET = withWorkspaceRoute(async (_request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const artifact = await getBuildArtifact(actor, {
    workspaceId,
    artifactId: params.artifactId,
  });
  return NextResponse.json(artifact);
});

export const PATCH = withWorkspaceRoute(async (request, { actor, workspaceId, params }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const parsed = await validateBody(request, updateArtifactSchema);
  const artifact = await updateBuildArtifact(actor, {
    workspaceId,
    artifactId: params.artifactId,
    ...parsed,
  });
  return NextResponse.json(artifact);
});
