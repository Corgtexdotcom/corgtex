import { NextRequest, NextResponse } from "next/server";
import type { MeetingRecorderProvider } from "@prisma/client";
import { getMeetingRecorderConfig, updateMeetingRecorderConfig } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";

function providerValue(value: unknown): MeetingRecorderProvider | undefined {
  return value === "RECALL_AI" || value === "MEETING_BAAS" ? value : undefined;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const config = await getMeetingRecorderConfig(actor, workspaceId);
    return NextResponse.json(config);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const body = await request.json() as Record<string, unknown>;
    const config = await updateMeetingRecorderConfig(actor, {
      workspaceId,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      defaultProvider: providerValue(body.defaultProvider),
      fallbackProvider: body.fallbackProvider === null ? null : providerValue(body.fallbackProvider),
      botName: typeof body.botName === "string" ? body.botName : undefined,
      entryMessage: typeof body.entryMessage === "string" ? body.entryMessage : body.entryMessage === null ? null : undefined,
      autoRecordEnabled: typeof body.autoRecordEnabled === "boolean" ? body.autoRecordEnabled : undefined,
      monthlyMinuteCap: typeof body.monthlyMinuteCap === "number" ? body.monthlyMinuteCap : undefined,
      providerSettings: body.providerSettings === undefined ? undefined : body.providerSettings as never,
    });
    return NextResponse.json({ config });
  } catch (error) {
    return handleRouteError(error);
  }
}
