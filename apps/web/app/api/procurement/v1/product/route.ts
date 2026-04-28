import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { DEFAULT_PLAN_LABEL, getMcpPublicUrl, MAX_EMPLOYEE_INVITES } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(request: NextRequest) {
  try {
    const origin = getPublicOrigin(request);
    return NextResponse.json({
      name: "Corgtex",
      description: "Corgtex gives companies an agent-accessible operating system for governance, decisions, actions, finance workflows, member onboarding, and organizational memory.",
      procurementApi: {
        version: "v1",
        openapiUrl: `${origin}/api/procurement/v1/openapi.json`,
        workspaceCreateUrl: `${origin}/api/procurement/v1/workspaces`,
      },
      mcpConnector: {
        url: getMcpPublicUrl(origin),
        description: "Use the MCP connector after workspace setup for ongoing workspace operations.",
      },
      setup: {
        manualBilling: true,
        defaultPlanLabel: DEFAULT_PLAN_LABEL,
        maxInitialEmployeeInvites: MAX_EMPLOYEE_INVITES,
        setupSessionTtlHours: 24,
        paymentCollection: "manual",
      },
      terms: {
        acceptedTermsVersionRequired: true,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
