import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { z } from "zod";
import { handleRouteError, validateBody } from "@/lib/http";
import { resetProcurementTrialCreateRateLimitsForHeaders } from "@/lib/procurement-api";

export const dynamic = "force-dynamic";

const resetSchema = z.object({
  adminEmail: z.string().email(),
  companyName: z.string().trim().min(1).max(180),
}).strict();

function bearerSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function requireSmokeSecret(request: NextRequest) {
  if (!env.SMOKE_EMAIL_CAPTURE_SECRET) {
    throw new AppError(503, "SMOKE_CAPTURE_NOT_CONFIGURED", "Smoke email capture is not configured.");
  }
  if (bearerSecret(request) !== env.SMOKE_EMAIL_CAPTURE_SECRET) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid smoke capture secret.");
  }
}

export async function POST(request: NextRequest) {
  try {
    requireSmokeSecret(request);
    const body = await validateBody(request, resetSchema);
    const reset = await resetProcurementTrialCreateRateLimitsForHeaders(request.headers, body);
    return NextResponse.json({ reset });
  } catch (error) {
    return handleRouteError(error);
  }
}
