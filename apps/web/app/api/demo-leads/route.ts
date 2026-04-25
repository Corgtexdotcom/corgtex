import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { captureDemoLead } from "@corgtex/domain";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = await rateLimitAuth(request);
    if (rateLimited) return rateLimited;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const payload = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
    const email = typeof payload.email === "string" ? payload.email.trim() : "";

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    await captureDemoLead({ email });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
