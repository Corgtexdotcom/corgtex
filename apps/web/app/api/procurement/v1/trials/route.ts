import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createProcurementTrial } from "@corgtex/domain";
import { handleRouteError, validateBody } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import {
  createTrialSchema,
  rateLimitProcurementTrialCreate,
  requiredIdempotencyKey,
} from "@/lib/procurement-api";

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, createTrialSchema);
    const idempotencyKey = requiredIdempotencyKey(request);
    const rateLimit = await rateLimitProcurementTrialCreate(request, {
      adminEmail: body.adminEmail,
      companyName: body.companyName,
    });
    if (rateLimit) {
      return rateLimit;
    }

    const response = await createProcurementTrial({
      input: body,
      idempotencyKey,
      origin: getPublicOrigin(request),
    });
    return NextResponse.json(response.body, { status: response.statusCode });
  } catch (error) {
    return handleRouteError(error);
  }
}
