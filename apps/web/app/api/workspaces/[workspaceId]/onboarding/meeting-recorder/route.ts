import { NextRequest, NextResponse } from "next/server";
import { getMeetingRecorderConfig, updateMeetingRecorderConfig } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

function recorderPayload(config: Awaited<ReturnType<typeof getMeetingRecorderConfig>>) {
  return {
    featureEnabled: config.featureEnabled,
    enabled: Boolean(config.config.enabled),
    autoRecordEnabled: Boolean(config.config.autoRecordEnabled),
    defaultProvider: config.config.defaultProvider,
    fallbackProvider: config.config.fallbackProvider,
    botName: config.config.botName,
    monthlyMinuteCap: config.config.monthlyMinuteCap,
    usedMinutes: config.usage.usedMinutes,
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    const config = await getMeetingRecorderConfig(actor, workspaceId);
    return NextResponse.json(recorderPayload(config));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
    const body = await request.json() as { enabled?: unknown; autoRecordEnabled?: unknown };
    await updateMeetingRecorderConfig(actor, {
      workspaceId,
      enabled: body.enabled === true,
      autoRecordEnabled: body.autoRecordEnabled === true,
    });
    const config = await getMeetingRecorderConfig(actor, workspaceId);
    return NextResponse.json(recorderPayload(config));
  } catch (error) {
    return handleRouteError(error);
  }
}

