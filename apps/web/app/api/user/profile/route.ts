import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserProfile, updateUserProfile } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).optional(),
  bio: z.string().trim().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const workspaceId = request.headers.get("x-workspace-id") || ""; // We might need to pass this somehow or just skip member lookup if not provided
    
    // In the context of settings, they are in a workspace, but profile is global.
    // However, we want to show their workspace identity. We'll extract workspaceId from query string if available.
    const url = new URL(request.url);
    const wid = url.searchParams.get("workspaceId") || "";

    const profile = await getUserProfile(actor, wid);
    return NextResponse.json(profile);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await validateBody(request, updateProfileSchema);

    const updated = await updateUserProfile(actor, body);
    return NextResponse.json(updated);
  } catch (error) {
    return handleRouteError(error);
  }
}
