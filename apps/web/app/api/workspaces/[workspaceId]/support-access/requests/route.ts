import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { decideSupportAccessRequest, listSupportAccessRequests } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { enforceDemoGuard } from "@/lib/demo-guard";

type Context = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };
const decision = z.object({ requestId: z.string().uuid(), approve: z.boolean() }).strict();
export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    return NextResponse.json(await listSupportAccessRequests(actor, workspaceId), { headers });
  } catch (error) { return handleRouteError(error); }
}
export async function POST(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    await enforceDemoGuard(workspaceId);
    const body = decision.parse(await request.json());
    return NextResponse.json(await decideSupportAccessRequest(actor, workspaceId, body.requestId, body.approve), { headers });
  } catch (error) { return handleRouteError(error); }
}
