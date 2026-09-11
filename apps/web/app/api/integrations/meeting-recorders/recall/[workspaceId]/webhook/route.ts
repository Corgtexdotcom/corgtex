import { NextRequest, NextResponse } from "next/server";
import { processMeetingRecorderWebhook } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest, context: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await context.params;
    const result = await processMeetingRecorderWebhook("RECALL_AI", {
      workspaceId,
      headers: request.headers,
      rawBody: await request.text(),
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
