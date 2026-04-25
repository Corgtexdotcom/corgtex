import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateRole, deleteRole } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; roleId: string }> };
const updateRoleSchema = z.object({
  name: z.string().trim().min(1).optional(),
  purposeMd: z.string().optional().nullable(),
  accountabilities: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  coreRoleType: z.string().optional().nullable(),
});

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, roleId } = await params;
    const body = await validateBody(request, updateRoleSchema);
    const role = await updateRole(actor, {
      workspaceId,
      roleId,
      name: body.name,
      purposeMd: body.purposeMd !== undefined ? (typeof body.purposeMd === "string" ? body.purposeMd : null) : undefined,
      accountabilities: body.accountabilities,
      artifacts: body.artifacts,
      coreRoleType: body.coreRoleType !== undefined ? (typeof body.coreRoleType === "string" ? body.coreRoleType : null) : undefined,
    });
    return NextResponse.json({ role });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, roleId } = await params;
    await deleteRole(actor, { workspaceId, roleId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
