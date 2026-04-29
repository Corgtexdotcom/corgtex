import { NextResponse } from "next/server";
import { z } from "zod";
import { listBuildArtifacts, upsertBuildArtifact } from "@corgtex/domain";
import { validateBody } from "@/lib/http";
import { withWorkspaceRoute } from "@/lib/route-handler";
import { disabledWorkspaceFeatureResponse } from "@/lib/workspace-feature-route";

export const dynamic = "force-dynamic";

const artifactSchema = z.object({
  artifactId: z.string().optional().nullable(),
  repositoryOwner: z.string().min(1),
  repositoryName: z.string().min(1),
  pullRequestNumber: z.number().int().positive().optional().nullable(),
  pullRequestUrl: z.string().optional().nullable(),
  branchName: z.string().optional().nullable(),
  commitSha: z.string().optional().nullable(),
  mergeCommitSha: z.string().optional().nullable(),
  title: z.string().min(1),
  summaryMd: z.string().optional().nullable(),
  status: z.enum(["OPEN", "MERGED", "CLOSED"]).optional(),
  classification: z.enum(["OPEN_CORE", "INTERNAL", "CLIENT_PRIVATE"]).optional(),
  visibility: z.enum(["PRIVATE", "PUBLIC_REVIEW", "REVOKED"]).optional(),
  noPrivateDataConfirmed: z.boolean().optional(),
});

export const GET = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const status = request.nextUrl.searchParams.get("status");
  const artifacts = await listBuildArtifacts(actor, {
    workspaceId,
    status: status === "OPEN" || status === "MERGED" || status === "CLOSED" ? status : undefined,
  });
  return NextResponse.json({ items: artifacts });
});

export const POST = withWorkspaceRoute(async (request, { actor, workspaceId }) => {
  const disabled = await disabledWorkspaceFeatureResponse(workspaceId, "BUILD_ARTIFACTS");
  if (disabled) return disabled;

  const parsed = await validateBody(request, artifactSchema);
  const artifact = await upsertBuildArtifact(actor, {
    workspaceId,
    ...parsed,
  });
  return NextResponse.json(artifact, { status: 201 });
});
