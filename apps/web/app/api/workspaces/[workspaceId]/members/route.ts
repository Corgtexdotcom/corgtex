import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createMember, listMembers, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const memberRoleSchema = z.enum(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD", "ADMIN"]);
const createMemberSchema = z.object({
  email: z.string().trim().min(1),
  displayName: z.string().optional().nullable(),
  role: memberRoleSchema.optional(),
});

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
    const body = await validateBody(request, createMemberSchema);
    const member = await createMember(actor, {
      workspaceId,
      email: body.email,
      displayName: body.displayName ?? null,
      role: body.role ?? "CONTRIBUTOR",
    });
    return NextResponse.json(member, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
