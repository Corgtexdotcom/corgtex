import { NextRequest, NextResponse } from "next/server";
import { ALL_SCOPES, getMcpPublicUrl } from "@corgtex/domain";
import { getPublicOrigin } from "@/lib/public-origin";

export async function GET(request: NextRequest) {
  const origin = getPublicOrigin(request);
  return NextResponse.json({
    resource: getMcpPublicUrl(origin),
    resource_name: "Corgtex",
    resource_documentation: `${origin}/install`,
    resource_policy_uri: `${origin}/install`,
    authorization_servers: [origin],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
  }, {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
