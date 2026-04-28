import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createSelfServeWorkspace } from "@corgtex/domain";
import { handleRouteError, validateBody } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import {
  createWorkspaceSchema,
  rateLimitProcurementWorkspaceCreate,
  requiredIdempotencyKey,
} from "@/lib/procurement-api";

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, createWorkspaceSchema);
    const rateLimit = await rateLimitProcurementWorkspaceCreate(request, {
      adminEmail: body.adminEmail,
      companyName: body.companyName,
      slug: body.slug,
    });
    if (rateLimit) {
      return rateLimit;
    }

    const response = await createSelfServeWorkspace({
      input: body,
      idempotencyKey: requiredIdempotencyKey(request),
      origin: getPublicOrigin(request),
    });
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
