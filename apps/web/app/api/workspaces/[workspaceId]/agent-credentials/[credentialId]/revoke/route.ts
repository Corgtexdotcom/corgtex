import { NextRequest, NextResponse } from "next/server";
import { revokeAgentCredential } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; credentialId: string }> },
) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId, credentialId } = await params;
    const credential = await revokeAgentCredential(actor, {
      workspaceId,
      credentialId,
    });
    return NextResponse.json({ credential });
  } catch (error) {
    return handleRouteError(error);
  }
}
