import { NextRequest, NextResponse } from "next/server";
import { listWebhookEndpoints, createWebhookEndpoint } from "@corgtex/domain";
import { resolveRequestActor } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const actor = await resolveRequestActor(request);

  const endpoints = await listWebhookEndpoints(actor, workspaceId);
  return NextResponse.json(endpoints);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const actor = await resolveRequestActor(request);
  const body = await request.json();

  const endpoint = await createWebhookEndpoint(actor, {
    workspaceId,
    url: body.url,
    label: body.label,
    eventTypes: body.eventTypes,
  });

  return NextResponse.json(endpoint, { status: 201 });
}
