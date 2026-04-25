import { NextRequest, NextResponse } from "next/server";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { createOAuthApp, listOAuthApps, requireWorkspaceMembership } from "@corgtex/domain";
import { z } from "zod";

export async function GET(request: NextRequest, props: { params: Promise<{ workspaceId: string }> }) {
  try {
    const params = await props.params;
    const actor = await requirePageActor();
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

    const apps = await listOAuthApps(actor, params.workspaceId);
    return NextResponse.json({ items: apps });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ workspaceId: string }> }) {
  try {
    const params = await props.params;
    const actor = await requirePageActor();
    await requireWorkspaceMembership({ actor, workspaceId: params.workspaceId, allowedRoles: ["ADMIN"] });

    const jsBody = await request.json();
    const schema = z.object({
      name: z.string().min(1),
      redirectUris: z.array(z.string().url()).min(1),
    });
  
    const parsed = schema.safeParse(jsBody);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;

    const result = await createOAuthApp(actor, {
      workspaceId: params.workspaceId,
      name: body.name,
      redirectUris: body.redirectUris,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
