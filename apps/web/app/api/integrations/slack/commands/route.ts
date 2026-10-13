import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { handleSlackCommand, captureSlackSignedIngress } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signedIngress = captureSlackSignedIngress(rawBody, request.headers);
    const payload = new URLSearchParams(rawBody);
    const response = await handleSlackCommand(payload, signedIngress);
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
