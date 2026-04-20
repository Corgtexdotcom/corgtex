import { NextRequest, NextResponse } from "next/server";
import { updateRole, deleteRole } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; roleId: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, roleId } = await params;
    const body = await request.json();
    const role = await updateRole(actor, {
      workspaceId,
      roleId,
      name: typeof body.name === "string" ? body.name : undefined,
      purposeMd: body.purposeMd !== undefined ? (typeof body.purposeMd === "string" ? body.purposeMd : null) : undefined,
      accountabilities: Array.isArray(body.accountabilities) ? body.accountabilities : undefined,
      artifacts: Array.isArray(body.artifacts) ? body.artifacts : undefined,
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
