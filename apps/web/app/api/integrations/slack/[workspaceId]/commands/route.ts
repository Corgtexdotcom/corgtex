import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { handleSlackCommand, verifySlackRequest, verifySlackWorkspaceInstallation } from "@corgtex/domain";

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const rawBody = await request.text();
    verifySlackRequest(rawBody, request.headers, workspaceId);
    const payload = new URLSearchParams(rawBody);
    await verifySlackWorkspaceInstallation(workspaceId, Object.fromEntries(payload));
    const response = await handleSlackCommand(payload);
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
