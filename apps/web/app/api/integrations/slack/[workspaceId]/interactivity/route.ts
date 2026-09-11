import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { handleSlackInteraction, verifySlackRequest, verifySlackWorkspaceInstallation } from "@corgtex/domain";

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const rawBody = await request.text();
    verifySlackRequest(rawBody, request.headers, workspaceId);
    const form = new URLSearchParams(rawBody);
    const payloadRaw = form.get("payload");
    if (!payloadRaw) {
      return NextResponse.json({ error: "Missing payload" }, { status: 400 });
    }

    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    await verifySlackWorkspaceInstallation(workspaceId, payload);
    const response = await handleSlackInteraction(payload);
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
