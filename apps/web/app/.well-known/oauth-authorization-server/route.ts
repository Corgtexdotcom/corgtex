import { NextRequest, NextResponse } from "next/server";
import { ALL_SCOPES } from "@corgtex/domain";

export async function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: ALL_SCOPES,
  }, {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
