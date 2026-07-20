import { NextRequest, NextResponse } from "next/server";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { ingestSource, intakeMeetingTranscript, requireWorkspaceMembership } from "@corgtex/domain";
import type { DuplicateGuardOptions, DuplicateGuardResolution } from "@corgtex/domain";
import type { BrainSourceType } from "@prisma/client";
import { parseOptionalMeetingDateTimeInput } from "@/lib/meeting-timezone";

const DUPLICATE_GUARD_RESOLUTIONS: DuplicateGuardResolution[] = [
  "use_existing",
  "update_existing",
  "create_new",
];

function duplicateGuardFromValues(resolution: unknown, targetEntityId: unknown): DuplicateGuardOptions | undefined {
  if (typeof resolution !== "string" || !DUPLICATE_GUARD_RESOLUTIONS.includes(resolution as DuplicateGuardResolution)) {
    return undefined;
  }
  return {
    resolution: resolution as DuplicateGuardResolution,
    targetEntityId: typeof targetEntityId === "string" && targetEntityId.trim() ? targetEntityId.trim() : null,
  };
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const membership = await requireWorkspaceMembership({ actor, workspaceId });
    
    const body = await request.json();
    const { title, sourceType, channel, content, recordedAt, ingestionGuidanceMd, timeZone, duplicateResolution, duplicateTargetEntityId } = body;
    const duplicateGuard = duplicateGuardFromValues(duplicateResolution, duplicateTargetEntityId);
    
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
        recordedAt: parseOptionalMeetingDateTimeInput(
          recordedAt ? String(recordedAt) : null,
          typeof timeZone === "string" ? timeZone : null,
          "Recorded at",
        ),
        ingestionGuidanceMd: typeof ingestionGuidanceMd === "string" ? ingestionGuidanceMd : null,
        duplicateGuard,
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
      duplicateGuard,
    });

    return NextResponse.json(source, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
