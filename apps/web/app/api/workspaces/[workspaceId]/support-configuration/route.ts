import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { changeSupportConfiguration, getSupportConfiguration, supportConfigurationCommand } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { enforceDemoGuard } from "@/lib/demo-guard";

const input = z.object({ expectedVersion: z.number().int().positive(), command: supportConfigurationCommand }).strict();
type Context = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    return NextResponse.json(await getSupportConfiguration(actor, workspaceId), { headers });
  } catch (error) { return handleRouteError(error); }
}
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    await enforceDemoGuard(workspaceId);
    const body = input.parse(await request.json());
    return NextResponse.json(await changeSupportConfiguration(actor, workspaceId, body.expectedVersion, body.command), { headers });
  } catch (error) { return handleRouteError(error); }
}
