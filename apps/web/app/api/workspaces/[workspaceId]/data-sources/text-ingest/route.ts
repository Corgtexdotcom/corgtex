import { NextRequest, NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { ingestSource, intakeMeetingTranscript, requireWorkspaceMembership } from "@corgtex/domain";
import type { BrainSourceType } from "@prisma/client";

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    
    const body = await request.json();
    const { title, sourceType, channel, content, recordedAt, ingestionGuidanceMd } = body;
    
    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: { message: "Content is required" } }, { status: 400 });
    }

    // Route MEETING sources through the meeting transcript intake pipeline
    // which creates a proper Meeting record and triggers the full meeting
    // intelligence pipeline (summary → insights → auto-apply → Slack post).
    if (String(sourceType || "ARTICLE") === "MEETING") {
      const result = await intakeMeetingTranscript(actor, {
        workspaceId,
        transcript: content,
        title: title ? String(title) : null,
        source: channel ? String(channel) : "text-paste",
        recordedAt: recordedAt ? String(recordedAt) : null,
        ingestionGuidanceMd: typeof ingestionGuidanceMd === "string" ? ingestionGuidanceMd : null,
      });

      if (result.status === "needs_clarification") {
        return NextResponse.json(result, { status: 409 });
      }

      return NextResponse.json(result, { status: 201 });
    }
    
    const authorMemberId = membership?.id === "global-operator" ? null : membership?.id ?? null;
    const source = await ingestSource(actor, {
      workspaceId,
      sourceType: String(sourceType || "ARTICLE") as BrainSourceType,
      tier: 1,
      content,
      title: title ? String(title) : undefined,
      channel: channel ? String(channel) : undefined,
      authorMemberId,
      ingestionGuidanceMd: typeof ingestionGuidanceMd === "string" ? ingestionGuidanceMd : null,
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
