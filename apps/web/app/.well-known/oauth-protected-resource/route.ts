import { NextRequest, NextResponse } from "next/server";
import { ALL_SCOPES, getMcpPublicUrl } from "@corgtex/domain";

function originFromRequest(request: NextRequest) {
  return new URL(request.url).origin;
}

export async function GET(request: NextRequest) {
  const origin = originFromRequest(request);
  return NextResponse.json({
    resource: getMcpPublicUrl(origin),
    authorization_servers: [origin],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Corgtex connector",
  }, {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
