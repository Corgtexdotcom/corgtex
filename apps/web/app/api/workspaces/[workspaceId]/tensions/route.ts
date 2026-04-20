import { NextRequest, NextResponse } from "next/server";
import { createTension, listTensions, requireWorkspaceMembership } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

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
    const body = (await request.json()) as { title?: unknown; bodyMd?: unknown };
    const tension = await createTension(actor, {
      workspaceId,
      title: String(body.title ?? ""),
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : null,
    });
    return NextResponse.json({ tension }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
