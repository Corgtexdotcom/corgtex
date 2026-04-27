import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { handleSlackInteraction, verifySlackRequest } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    verifySlackRequest(rawBody, request.headers);
    const form = new URLSearchParams(rawBody);
    const payloadRaw = form.get("payload");
    if (!payloadRaw) {
      return NextResponse.json({ error: "Missing payload" }, { status: 400 });
    }

    const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
    const response = await handleSlackInteraction(payload);
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
