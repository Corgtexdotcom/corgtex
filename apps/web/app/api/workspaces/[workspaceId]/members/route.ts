import { NextRequest, NextResponse } from "next/server";
import { createMember, listMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params;
    const actor = await resolveRequestActor(request);
    await requireWorkspaceMembership({ actor, workspaceId });
    const members = await listMembers(workspaceId);
    return NextResponse.json({ members });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as {
      email?: unknown;
      password?: unknown;
      displayName?: unknown;
      role?: unknown;
    };
    const member = await createMember(actor, {
      workspaceId,
      email: String(body.email ?? ""),
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      password: require("crypto").randomUUID(),
      role: String(body.role ?? "CONTRIBUTOR") as "CONTRIBUTOR" | "FACILITATOR" | "FINANCE_STEWARD" | "ADMIN",
    });
    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
