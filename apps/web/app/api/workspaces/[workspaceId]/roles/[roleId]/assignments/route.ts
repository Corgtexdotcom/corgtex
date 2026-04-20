import { NextRequest, NextResponse } from "next/server";
import { assignRole, unassignRole, listRoleAssignments } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

type Params = { params: Promise<{ workspaceId: string; roleId: string }> };

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
    const body = await request.json();
    const assignment = await assignRole(actor, {
      workspaceId,
      roleId,
      memberId: String(body.memberId),
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
    const body = await request.json();
    await unassignRole(actor, {
      workspaceId,
      roleId,
      memberId: String(body.memberId),
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
