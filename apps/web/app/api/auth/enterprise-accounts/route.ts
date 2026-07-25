import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { findEnterpriseAccountsForEmail } from "@corgtex/domain";
import { filterWorkspacesForDeploymentScope } from "@/lib/deployment-workspace-scope";
import { handleRouteError, validateBody } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

const discoverySchema = z.object({
  email: z.string().trim().email(),
});

export async function POST(request: NextRequest) {
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const body = await validateBody(request, discoverySchema);
    const result = await findEnterpriseAccountsForEmail(body.email);
    return NextResponse.json({
      ...result,
      matches: filterWorkspacesForDeploymentScope(result.matches),
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleRouteError(error, { request, surface: "auth" });
  }
}
