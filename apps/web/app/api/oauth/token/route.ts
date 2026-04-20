import { NextRequest, NextResponse } from "next/server";
import { exchangeAuthorizationCode, refreshAccessToken } from "@corgtex/domain";
import { AppError } from "@corgtex/domain";

export async function POST(request: NextRequest) {
  try {
    // Handle both JSON and form URL encoded bodies (most OAuth clients use application/x-www-form-urlencoded)
    const contentType = request.headers.get("content-type") || "";
    let bodyData: Record<string, string> = {};

    if (contentType.includes("application/json")) {
      bodyData = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        bodyData[key] = value.toString();
      });
    }

    // Sometimes credentials come in via Basic auth header
    let clientId = bodyData.client_id;
    let clientSecret = bodyData.client_secret;

    const authHeader = request.headers.get("authorization");
    if (authHeader && authHeader.toLowerCase().startsWith("basic ")) {
      const b64 = authHeader.substring(6);
      const decoded = Buffer.from(b64, "base64").toString("ascii");
      const [user, pass] = decoded.split(":");
      clientId = clientId || user;
      clientSecret = clientSecret || pass;
    }

    const grantType = bodyData.grant_type;

    if (!clientId) {
      return NextResponse.json({ error: "invalid_client", error_description: "Missing client credentials" }, { status: 401 });
    }

    // Authorization Code Exchange
    if (grantType === "authorization_code") {
      const code = bodyData.code;
      const redirectUri = bodyData.redirect_uri;

      if (!code || !redirectUri) {
        return NextResponse.json({ error: "invalid_request", error_description: "Missing code or redirect_uri" }, { status: 400 });
      }

      if (!clientSecret) {
        return NextResponse.json({ error: "invalid_client", error_description: "Missing client secret" }, { status: 401 });
      }

      const tokens = await exchangeAuthorizationCode({
        code,
        clientId,
        clientSecret,
        redirectUri,
      });

      return NextResponse.json(tokens, {
        headers: {
          "Cache-Control": "no-store",
          "Pragma": "no-cache"
        }
      });
    }

    // Refresh Token Grant
    else if (grantType === "refresh_token") {
      const refreshToken = bodyData.refresh_token;

      if (!refreshToken) {
        return NextResponse.json({ error: "invalid_request", error_description: "Missing refresh_token" }, { status: 400 });
      }

      const tokens = await refreshAccessToken({
        refreshToken,
        clientId,
        clientSecret,
      });

      return NextResponse.json(tokens, {
        headers: {
          "Cache-Control": "no-store",
          "Pragma": "no-cache"
        }
      });
    }

    // Unsupported Grant Type
    else {
      return NextResponse.json({ error: "unsupported_grant_type", error_description: "Grant type not supported" }, { status: 400 });
    }

  } catch (error) {
    if (error instanceof AppError) {
      const oauthErrorResponse = {
        error: error.status === 401 ? "invalid_client" : "invalid_grant",
        error_description: error.message
      };
      // Important trick for OAuth token response: Even for failures, some clients expect specific HTTP codes.
      return NextResponse.json(oauthErrorResponse, { status: error.status });
    }

    console.error("[OAuth Token Error]", error);
    return NextResponse.json({ error: "server_error", error_description: "Internal server error" }, { status: 500 });
  }
}
