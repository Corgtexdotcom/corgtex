import { NextRequest, NextResponse } from "next/server";
import { checkQualificationLink } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": (process.env.NEXT_PUBLIC_SITE_URL || "https://corgtex.com").replace(/\/$/, ""),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// Token checks return availability only; they never create leads or qualifications.
export async function POST(request: NextRequest) {
  const cors = corsHeaders();
  try {
    const limited = await rateLimitAuth(request);
    if (limited) {
      for (const [key, value] of Object.entries(cors)) limited.headers.set(key, value);
      return limited;
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400, headers: cors });
    }
    const token = body && typeof body === "object" && "token" in body && typeof body.token === "string"
      ? body.token.trim() : "";
    if (!token || token.length > 128) {
      return NextResponse.json({ error: { code: "QUALIFICATION_LINK_UNAVAILABLE", message: "This qualification link is no longer available." } }, { status: 410, headers: cors });
    }
    return NextResponse.json(await checkQualificationLink(token), { headers: cors });
  } catch (error) {
    const response = handleRouteError(error);
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  }
}
