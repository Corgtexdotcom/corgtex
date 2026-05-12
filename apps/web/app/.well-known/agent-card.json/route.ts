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
      description: "Agent-ready organization trial setup and MCP operations for Corgtex.",
      version: "1.0.0",
      capabilities: [
        "instant_limited_trial",
        "risk_gated_trial_review",
        "mcp_workspace_operations",
        "operator_trial_shutdown",
      ],
      procurement: {
        openapiUrl: `${origin}/api/procurement/v1/openapi.json`,
        productUrl: `${origin}/api/procurement/v1/product`,
        trialCreateUrl: `${origin}/api/procurement/v1/trials`,
      },
      mcp: {
        connectorUrl: getMcpPublicUrl(origin),
        humanInstallUrl: `${origin}/install`,
        claudeInstallUrl: `${origin}/install/claude`,
        claudeCodeInstallUrl: `${origin}/install/claude-code`,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
