import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getMcpPublicUrl } from "@corgtex/domain";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(request: NextRequest) {
  try {
    const origin = getPublicOrigin(request);
    return NextResponse.json({
      name: "Corgtex",
      description: "Agent-ready company workspace setup and operations for Corgtex.",
      version: "1.0.0",
      capabilities: [
        "self_serve_workspace_setup",
        "employee_onboarding",
        "manual_billing_handoff",
        "mcp_workspace_operations",
      ],
      procurement: {
        openapiUrl: `${origin}/api/procurement/v1/openapi.json`,
        productUrl: `${origin}/api/procurement/v1/product`,
      },
      mcp: {
        connectorUrl: getMcpPublicUrl(origin),
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
