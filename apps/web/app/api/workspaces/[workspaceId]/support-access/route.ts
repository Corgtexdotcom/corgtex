import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { changeWorkspaceSupportGrant, listWorkspaceSupportGrants } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { checkApiDemoGuard } from "@/lib/demo-guard";

const input = z.object({
  email: z.email(), role: z.enum(["SETUP", "FULL"]).default("SETUP"),
  isActive: z.boolean(), expectedVersion: z.number().int().min(0),
}).strict();
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    return NextResponse.json(await listWorkspaceSupportGrants(actor, workspaceId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    await checkApiDemoGuard(workspaceId);
    const body = input.parse(await request.json());
    return NextResponse.json(await changeWorkspaceSupportGrant(actor, { workspaceId, ...body }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
