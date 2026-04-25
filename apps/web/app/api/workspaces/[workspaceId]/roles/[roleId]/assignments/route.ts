import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assignRole, unassignRole, listRoleAssignments } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; roleId: string }> };
const roleAssignmentSchema = z.object({
  memberId: z.uuid(),
});

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const assignments = await listRoleAssignments(workspaceId);
    return NextResponse.json({ assignments });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, roleId } = await params;
    const body = await validateBody(request, roleAssignmentSchema);
    const assignment = await assignRole(actor, {
      workspaceId,
      roleId,
      memberId: body.memberId,
    });
    return NextResponse.json({ assignment }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, roleId } = await params;
    const body = await validateBody(request, roleAssignmentSchema);
    await unassignRole(actor, {
      workspaceId,
      roleId,
      memberId: body.memberId,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
