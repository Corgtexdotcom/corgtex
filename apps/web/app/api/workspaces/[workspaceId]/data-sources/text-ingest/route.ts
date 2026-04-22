import { NextRequest, NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireWorkspaceMembership, appendEvents } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

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
    
    const source = await prisma.$transaction(async (tx) => {
      const src = await tx.brainSource.create({
        data: {
          workspaceId,
          sourceType: String(sourceType || "ARTICLE") as import("@prisma/client").BrainSourceType,
          tier: 1,
          content,
          title: title ? String(title) : undefined,
          channel: channel ? String(channel) : undefined,
          authorMemberId: membership?.id || null,
        },
      });

      await tx.auditLog.create({
        data: {
          workspaceId,
          actorUserId: actor.kind === "user" ? actor.user.id : null,
          action: "brain-source.created",
          entityType: "BrainSource",
          entityId: src.id,
          meta: { sourceType: src.sourceType, tier: src.tier },
        },
      });

      await appendEvents(tx, [
        {
          workspaceId,
          type: "brain-source.created",
          aggregateType: "BrainSource",
          aggregateId: src.id,
          payload: { sourceId: src.id },
        },
      ]);
      
      return src;
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
