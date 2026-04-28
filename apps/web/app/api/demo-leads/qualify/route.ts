import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { submitQualification } from "@corgtex/domain";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

function corsHeaders(): Record<string, string> {
  const siteOrigin = (process.env.NEXT_PUBLIC_SITE_URL || "https://corgtex.com").replace(/\/$/, "");
  return {
    "Access-Control-Allow-Origin": siteOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders();
  try {
    const rateLimited = await rateLimitAuth(request);
    if (rateLimited) {
      for (const [key, value] of Object.entries(cors)) {
        rateLimited.headers.set(key, value);
      }
      return rateLimited;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400, headers: cors });
    }

    const payload = typeof body === "object" && body ? (body as Record<string, unknown>) : {};
    
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    const companyName = typeof payload.companyName === "string" ? payload.companyName.trim() : "";
    const website = typeof payload.website === "string" ? payload.website.trim() : "";
    const aiExperience = typeof payload.aiExperience === "string" ? payload.aiExperience.trim() : "";
    const helpNeeded = typeof payload.helpNeeded === "string" ? payload.helpNeeded.trim() : "";
    const roleTitle = typeof payload.roleTitle === "string" ? payload.roleTitle.trim() : undefined;

    if (!token || !companyName || !website || !aiExperience || !helpNeeded) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400, headers: cors });
    }

    const qualification = await submitQualification({
      token,
      companyName,
      website,
      roleTitle,
      aiExperience,
      helpNeeded,
    });

    return NextResponse.json({ ok: true, qualificationId: qualification.id }, { headers: cors });
  } catch (error) {
    const errResponse = handleRouteError(error);
    for (const [key, value] of Object.entries(cors)) {
      errResponse.headers.set(key, value);
    }
    return errResponse;
  }
}
