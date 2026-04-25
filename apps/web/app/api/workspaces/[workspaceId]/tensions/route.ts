import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createTension, listTensions, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError, validateBody } from "@/lib/http";

const createTensionSchema = z.object({
  title: z.string().trim().min(1),
  bodyMd: z.string().optional().nullable(),
});

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await requireWorkspaceMembership({ actor, workspaceId });
    const tensions = await listTensions(actor, workspaceId);
    return NextResponse.json({ tensions });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await validateBody(request, createTensionSchema);
    const tension = await createTension(actor, {
      workspaceId,
      title: body.title,
      bodyMd: body.bodyMd ?? null,
    });
    return NextResponse.json({ tension }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
