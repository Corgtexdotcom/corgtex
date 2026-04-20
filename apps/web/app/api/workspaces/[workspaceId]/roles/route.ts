import { NextRequest, NextResponse } from "next/server";
import { createRole, listRoles, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

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
    const body = (await request.json()) as {
      circleId?: unknown;
      name?: unknown;
      purposeMd?: unknown;
      accountabilities?: unknown;
      artifacts?: unknown;
      coreRoleType?: unknown;
    };

    const role = await createRole(actor, {
      workspaceId,
      circleId: String(body.circleId ?? ""),
      name: String(body.name ?? ""),
      purposeMd: typeof body.purposeMd === "string" ? body.purposeMd : null,
      accountabilities: Array.isArray(body.accountabilities)
        ? body.accountabilities.map((value) => String(value))
        : [],
      artifacts: Array.isArray(body.artifacts)
        ? body.artifacts.map((value) => String(value))
        : [],
      coreRoleType: typeof body.coreRoleType === "string" ? body.coreRoleType : null,
    });

    return NextResponse.json(role, { status: 201 });
  } catch (error) {
    console.error("[RolesAPI POST]", error);
    return handleRouteError(error);
  }
}
