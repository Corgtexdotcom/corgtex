import { NextRequest, NextResponse } from "next/server";
import { listWebhookEndpoints, createWebhookEndpoint } from "@corgtex/domain";
import { withWorkspaceRoute } from "@/lib/route-handler";

export const GET = withWorkspaceRoute(async (_request: NextRequest, { actor, workspaceId }) => {
  const endpoints = await listWebhookEndpoints(actor, workspaceId);
  return NextResponse.json(endpoints);
});

export const POST = withWorkspaceRoute(async (request: NextRequest, { actor, workspaceId }) => {
  const body = await request.json();

  const endpoint = await createWebhookEndpoint(actor, {
    workspaceId,
    url: body.url,
    label: body.label,
    eventTypes: body.eventTypes,
  });

  return NextResponse.json(endpoint, { status: 201 });
});
