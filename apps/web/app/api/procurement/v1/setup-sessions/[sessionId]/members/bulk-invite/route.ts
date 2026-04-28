import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { bulkInviteSelfServeSetupMembers } from "@corgtex/domain";
import { handleRouteError, validateBody } from "@/lib/http";
import {
  bulkInviteSchema,
  rateLimitProcurementBulkInvite,
  requiredIdempotencyKey,
  requiredSetupSessionToken,
} from "@/lib/procurement-api";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const { sessionId } = await params;
    const body = await validateBody(request, bulkInviteSchema);
    const rateLimit = await rateLimitProcurementBulkInvite(sessionId);
    if (rateLimit) {
      return rateLimit;
    }

    const response = await bulkInviteSelfServeSetupMembers({
      sessionId,
      token: requiredSetupSessionToken(request),
      members: body.members,
      idempotencyKey: requiredIdempotencyKey(request),
    });
    return NextResponse.json(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
