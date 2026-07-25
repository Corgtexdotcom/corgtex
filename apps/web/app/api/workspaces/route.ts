import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createWorkspace, listActorWorkspaces } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { deploymentWorkspaceScopeSlug, filterWorkspacesForDeploymentScope } from "@/lib/deployment-workspace-scope";
import { handleRouteError, validateBody } from "@/lib/http";

const workspaceSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  description: z.string().optional().nullable(),
});

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const workspaces = filterWorkspacesForDeploymentScope(await listActorWorkspaces(actor));
    return NextResponse.json({ workspaces });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, workspaceSchema);
    const scopedSlug = deploymentWorkspaceScopeSlug();
    if (scopedSlug && body.slug.trim().toLowerCase() !== scopedSlug) {
      return NextResponse.json({
        error: {
          code: "WORKSPACE_SCOPE_MISMATCH",
          message: "Workspace creation is restricted to this deployment's configured workspace.",
        },
      }, { status: 403 });
    }
    const workspace = await createWorkspace(actor, {
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
    });
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
