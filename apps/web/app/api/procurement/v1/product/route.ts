import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getMcpPublicUrl, PROCUREMENT_TRIAL_LIMITS, PROCUREMENT_TRIAL_TTL_DAYS, TRIAL_CONNECTOR_SCOPES } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(request: NextRequest) {
  try {
    const origin = getPublicOrigin(request);
    return NextResponse.json({
      name: "Corgtex",
      description: "Corgtex gives organizations an agent-accessible operating system for governance, decisions, actions, knowledge, and member-aware operations.",
      procurementApi: {
        version: "v1",
        openapiUrl: `${origin}/api/procurement/v1/openapi.json`,
        trialCreateUrl: `${origin}/api/procurement/v1/trials`,
      },
      mcpConnector: {
        url: getMcpPublicUrl(origin),
        trialScopes: TRIAL_CONNECTOR_SCOPES,
      },
      trial: {
        instantBusinessDomainAccess: true,
        reviewGatedRiskyDomains: true,
        trialDays: PROCUREMENT_TRIAL_TTL_DAYS,
        limits: PROCUREMENT_TRIAL_LIMITS,
      },
      hostedInstances: {
        publicProvisioning: false,
        note: "Dedicated hosted customer infrastructure is provisioned through the internal Corgtex control plane after review.",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
