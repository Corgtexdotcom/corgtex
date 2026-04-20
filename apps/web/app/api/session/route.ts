import { NextRequest, NextResponse } from "next/server";
import { listActorWorkspaces } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const workspaces = await listActorWorkspaces(actor);

    return NextResponse.json({
      actor,
      workspaces,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
