import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { ingestCommunicationEvent, verifySlackRequest } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    verifySlackRequest(rawBody, request.headers);
    const payload = JSON.parse(rawBody) as Record<string, unknown>;

    if (payload.type === "url_verification" && typeof payload.challenge === "string") {
      return new Response(payload.challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    await ingestCommunicationEvent("SLACK", payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
