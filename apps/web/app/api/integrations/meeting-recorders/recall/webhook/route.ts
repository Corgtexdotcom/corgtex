import { NextRequest, NextResponse } from "next/server";
import { processMeetingRecorderWebhook } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const result = await processMeetingRecorderWebhook("RECALL_AI", {
      headers: request.headers,
      rawBody,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
