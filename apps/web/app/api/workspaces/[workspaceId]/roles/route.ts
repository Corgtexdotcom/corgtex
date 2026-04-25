import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRole, listRoles, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createRoleSchema = z.object({
  circleId: z.uuid(),
  name: z.string().trim().min(1),
  purposeMd: z.string().optional().nullable(),
  accountabilities: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  coreRoleType: z.string().optional().nullable(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const roles = await listRoles(workspaceId);
    return NextResponse.json({ roles });
  } catch (error) {
    console.error("[RolesAPI GET]", error);
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createRoleSchema);

    const role = await createRole(actor, {
      workspaceId,
      circleId: body.circleId,
      name: body.name,
      purposeMd: body.purposeMd ?? null,
      accountabilities: body.accountabilities ?? [],
      artifacts: body.artifacts ?? [],
      coreRoleType: body.coreRoleType ?? null,
    });

    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    console.error("[RolesAPI POST]", error);
    return handleRouteError(error);
  }
}
