import type { BrainSourceType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { ingestSource, listSources } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const url = new URL(request.url);
    const absorbedParam = url.searchParams.get("absorbed");
    const absorbed = absorbedParam === "true" ? true : absorbedParam === "false" ? false : undefined;
    const take = Number(url.searchParams.get("take")) || undefined;
    const skip = Number(url.searchParams.get("skip")) || undefined;

    const result = await listSources(actor, { workspaceId, absorbed, take, skip });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = (await request.json()) as Record<string, unknown>;

    const source = await ingestSource(actor, {
      workspaceId,
      sourceType: String(body.sourceType ?? "DOC") as BrainSourceType,
      tier: typeof body.tier === "number" ? body.tier : 1,
      content: String(body.content ?? ""),
      title: typeof body.title === "string" ? body.title : null,
      externalId: typeof body.externalId === "string" ? body.externalId : null,
      channel: typeof body.channel === "string" ? body.channel : null,
      authorMemberId: typeof body.authorMemberId === "string" ? body.authorMemberId : null,
      metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
