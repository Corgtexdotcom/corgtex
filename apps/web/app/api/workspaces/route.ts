import { NextRequest, NextResponse } from "next/server";
import { createWorkspace, listActorWorkspaces } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const workspaces = await listActorWorkspaces(actor);
    return NextResponse.json({ workspaces });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await resolveRequestActor(request);
    const body = await request.json();
    const workspace = await createWorkspace(actor, {
      name: String(body.name ?? ""),
      slug: String(body.slug ?? ""),
      description: typeof body.description === "string" ? body.description : null,
    });
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
