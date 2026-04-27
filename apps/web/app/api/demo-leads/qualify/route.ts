import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { submitQualification } from "@corgtex/domain";
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
    
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    const companyName = typeof payload.companyName === "string" ? payload.companyName.trim() : "";
    const website = typeof payload.website === "string" ? payload.website.trim() : "";
    const aiExperience = typeof payload.aiExperience === "string" ? payload.aiExperience.trim() : "";
    const helpNeeded = typeof payload.helpNeeded === "string" ? payload.helpNeeded.trim() : "";
    const roleTitle = typeof payload.roleTitle === "string" ? payload.roleTitle.trim() : undefined;

    if (!token || !companyName || !website || !aiExperience || !helpNeeded) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const qualification = await submitQualification({
      token,
      companyName,
      website,
      roleTitle,
      aiExperience,
      helpNeeded,
    });

    return NextResponse.json({ ok: true, qualificationId: qualification.id });
  } catch (error) {
    return handleRouteError(error);
  }
}
