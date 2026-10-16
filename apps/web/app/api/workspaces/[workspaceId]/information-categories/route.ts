import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { configureInformationCategory, classifyInformationSource } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const category = z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/);
const audience = z.array(z.string().min(1)).max(100);
const policyBody = z.object({
  category,
  isRestricted: z.boolean(),
  allowedRoleIds: audience,
  allowedCircleIds: audience,
});
const sourceBody = z.object({
  kind: z.enum(["BrainSource", "Document", "Meeting"]),
  id: z.string().min(1),
  category,
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, policyBody);
    return NextResponse.json(await configureInformationCategory(actor, { workspaceId, ...body }));
  } catch (error) { return handleRouteError(error); }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, sourceBody);
    return NextResponse.json(await classifyInformationSource(actor, { workspaceId, ...body }));
  } catch (error) { return handleRouteError(error); }
}
