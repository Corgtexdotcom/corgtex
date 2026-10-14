import { NextRequest, NextResponse } from "next/server";
import { configureInformationCategory, classifyInformationSource } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
export async function POST(request: NextRequest, {params}: {params: Promise<{workspaceId: string}>}) {
  try {
    const actor = await resolveRequestActor(request), {workspaceId} = await params, body = await request.json();
    return NextResponse.json(await configureInformationCategory(actor, {workspaceId, category: body.category,
      isRestricted: body.isRestricted, allowedRoleIds: body.allowedRoleIds, allowedCircleIds: body.allowedCircleIds}));
  } catch (error) {return handleRouteError(error);}
}
export async function PATCH(request: NextRequest, {params}: {params: Promise<{workspaceId: string}>}) {
  try {
    const actor = await resolveRequestActor(request), {workspaceId} = await params, body = await request.json();
    return NextResponse.json(await classifyInformationSource(actor, {workspaceId, kind: body.kind, id: body.id, category: body.category}));
  } catch (error) {return handleRouteError(error);}
}
