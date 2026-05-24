import { handleStripeWebhook } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const result = await handleStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
