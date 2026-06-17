import { NextRequest, NextResponse } from "next/server";
import {
  enableMeetingTranscriptSourcesForWorkspace,
  getMeetingTranscriptSourcesFeatureState,
  getV1MeetingTranscriptProviderCatalog,
  listMeetingTranscriptSourceState,
} from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";
import { checkApiDemoGuard } from "@/lib/demo-guard";
import { handleRouteError } from "@/lib/http";

const V1_PROVIDER_ORDER = ["READ_AI", "FATHOM", "FIREFLIES", "MANUAL_UPLOAD"];

async function transcriptSourcePayload(actor: Awaited<ReturnType<typeof resolveRequestActor>>, workspaceId: string) {
  const [feature, state] = await Promise.all([
    getMeetingTranscriptSourcesFeatureState(actor, workspaceId),
    listMeetingTranscriptSourceState(actor, workspaceId),
  ]);
  const providerSet = new Set(V1_PROVIDER_ORDER);
  return {
    featureEnabled: feature.featureEnabled,
    catalog: getV1MeetingTranscriptProviderCatalog(),
    connections: state.connections.filter((connection) => providerSet.has(connection.provider)),
    batches: state.batches.filter((batch) => providerSet.has(batch.provider)),
    records: state.records.filter((record) => providerSet.has(record.provider)),
  };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    return NextResponse.json(await transcriptSourcePayload(actor, workspaceId));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const actor = await resolveRequestActor(request);
    const { workspaceId } = await params;
    await checkApiDemoGuard(workspaceId);
    const body = await request.json().catch(() => ({})) as { enabled?: unknown };
    await enableMeetingTranscriptSourcesForWorkspace(actor, {
      workspaceId,
      enabled: body.enabled !== false,
    });
    return NextResponse.json(await transcriptSourcePayload(actor, workspaceId));
  } catch (error) {
    return handleRouteError(error);
  }
}
