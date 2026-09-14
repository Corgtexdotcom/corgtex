import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSupportSetup, updateSupportSetup, supportConnectorPreparationSchema } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

const input = z.object({
  expectedVersion: z.number().int().positive(),
  checklist: z.object({ configurationPrepared: z.boolean(), consentRequested: z.boolean(), handoffReady: z.boolean() }).strict(),
  connectors: supportConnectorPreparationSchema.optional(),
  expectedSetupRevision: z.number().int().nonnegative().optional(),
}).strict();
type Context = { params: Promise<{ workspaceId: string }> };

export async function GET(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    return NextResponse.json(await getSupportSetup(actor, workspaceId), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await context.params;
    return NextResponse.json(await updateSupportSetup(actor, { workspaceId, ...input.parse(await request.json()) }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleRouteError(error); }
}
