import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listMemberInviteRequests, requestMemberInvite } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createInviteRequestSchema = z.object({
  email: z.string().trim().min(1),
  displayName: z.string().optional().nullable(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const requests = await listMemberInviteRequests(actor, { workspaceId, status: "PENDING" });
    return NextResponse.json({ requests });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createInviteRequestSchema);
    const inviteRequest = await requestMemberInvite(actor, {
      workspaceId,
      email: body.email,
      displayName: body.displayName ?? null,
    });
    return NextResponse.json({ inviteRequest }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
