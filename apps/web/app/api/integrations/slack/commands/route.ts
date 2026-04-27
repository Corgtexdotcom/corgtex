import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { handleSlackCommand, verifySlackRequest } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    verifySlackRequest(rawBody, request.headers);
    const payload = new URLSearchParams(rawBody);
    const response = await handleSlackCommand(payload);
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
