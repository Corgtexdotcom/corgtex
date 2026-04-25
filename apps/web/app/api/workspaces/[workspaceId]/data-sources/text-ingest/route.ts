import { NextRequest, NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { ingestSource, requireWorkspaceMembership } from "@corgtex/domain";
import type { BrainSourceType } from "@prisma/client";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    
    const body = await request.json();
    const { title, sourceType, channel, content } = body;
    
    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: { message: "Content is required" } }, { status: 400 });
    }
    
    const source = await ingestSource(actor, {
      workspaceId,
      sourceType: String(sourceType || "ARTICLE") as BrainSourceType,
      tier: 1,
      content,
      title: title ? String(title) : undefined,
      channel: channel ? String(channel) : undefined,
      authorMemberId: membership?.id ?? null,
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
