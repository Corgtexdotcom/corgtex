import { NextRequest, NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import {
  getMcpOAuthClientByClientId,
  getMcpPublicUrl,
  getOAuthAppByClientId,
  isAllowedMcpRedirectUri,
  isAllowedOAuthRedirectUri,
  issueAuthorizationCode,
  issueMcpAuthorizationCode,
} from "@corgtex/domain";
import { z } from "zod";

// This is the endpoint ChatGPT calls to start the OAuth flow.
// Typically it's a GET, but we'll accept POST too for the user consent submission.

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const responseType = url.searchParams.get("response_type"); // expected: "code"
    const scopeString = url.searchParams.get("scope") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
    const resource = url.searchParams.get("resource") || "";

    if (!clientId || !redirectUri || responseType !== "code") {
      return NextResponse.json({ error: "invalid_request", message: "Missing required parameters (client_id, redirect_uri) or invalid response_type" }, { status: 400 });
    }

    const mcpClient = await getMcpOAuthClientByClientId(clientId).catch(() => null);
    if (mcpClient) {
      if (!isAllowedMcpRedirectUri(mcpClient.redirectUris, redirectUri)) {
        return NextResponse.json({ error: "invalid_request", message: "Redirect URI is not registered" }, { status: 400 });
      }
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        return NextResponse.json({ error: "invalid_request", message: "MCP connector OAuth requires S256 PKCE" }, { status: 400 });
      }

      await requirePageActor();

      const consentUrl = new URL("/oauth/authorize", getPublicOrigin(request));
      consentUrl.searchParams.set("client_id", clientId);
      consentUrl.searchParams.set("redirect_uri", redirectUri);
      consentUrl.searchParams.set("state", state || "");
      consentUrl.searchParams.set("scope", scopeString);
      consentUrl.searchParams.set("code_challenge", codeChallenge);
      consentUrl.searchParams.set("code_challenge_method", codeChallengeMethod);
      if (resource) {
        consentUrl.searchParams.set("resource", resource);
      }

      return NextResponse.redirect(consentUrl);
    }

    const app = await getOAuthAppByClientId(clientId).catch(() => null);
    if (!app) {
      return NextResponse.json({ error: "invalid_client", message: "Unknown client_id" }, { status: 400 });
    }
    if (!isAllowedOAuthRedirectUri(app.redirectUris, redirectUri)) {
      return NextResponse.json({ error: "invalid_request", message: "Redirect URI is not registered" }, { status: 400 });
    }

    // Ensure user is logged in
    await requirePageActor();

    // Create a URL pointing to our UI consent page
    const consentUrl = new URL("/oauth/authorize", getPublicOrigin(request));
    consentUrl.searchParams.set("client_id", clientId);
    consentUrl.searchParams.set("redirect_uri", redirectUri);
    consentUrl.searchParams.set("state", state || "");
    consentUrl.searchParams.set("scope", scopeString);

    return NextResponse.redirect(consentUrl);
  } catch (error) {
    unstable_rethrow(error);
    return handleRouteError(error);
  }
}

// Handling the consent form submission from our UI
export async function POST(request: NextRequest) {
  try {
    const actor = await requirePageActor();

    const contentType = request.headers.get("content-type") || "";
    let bodyData: any = {};

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      bodyData = Object.fromEntries(formData.entries());
    } else {
      // Attempt JSON fallback
      try {
        bodyData = await request.json();
      } catch {
        // Ignore JSON parse errors for fallback
      }
    }

    const jsBody = bodyData;
    const schema = z.object({
      clientId: z.string(),
      redirectUri: z.string(),
      state: z.string().optional(),
      scopes: z.string().optional(),
      workspaceId: z.string().optional(),
      codeChallenge: z.string().optional(),
      codeChallengeMethod: z.string().optional(),
      resource: z.string().optional(),
    });

    const parsed = schema.safeParse(jsBody);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const body = parsed.data;

    const scopeArray = (body.scopes || "").split(" ").filter(Boolean);
    const mcpClient = await getMcpOAuthClientByClientId(body.clientId).catch(() => null);
    let code: string;

    if (mcpClient) {
      if (!body.workspaceId) {
        return NextResponse.json({ error: "invalid_request", message: "Workspace is required" }, { status: 400 });
      }
      code = await issueMcpAuthorizationCode(actor, {
        clientId: body.clientId,
        workspaceId: body.workspaceId,
        redirectUri: body.redirectUri,
        scopes: scopeArray.length > 0 ? scopeArray : undefined,
        codeChallenge: body.codeChallenge ?? "",
        codeChallengeMethod: body.codeChallengeMethod ?? "",
        resource: body.resource || getMcpPublicUrl(getPublicOrigin(request)),
      });
    } else {
      const app = await getOAuthAppByClientId(body.clientId);
      const effectiveScopes = scopeArray.length > 0 ? scopeArray : app.scopes;
      code = await issueAuthorizationCode(actor, {
        clientId: body.clientId,
        workspaceId: app.workspaceId,
        redirectUri: body.redirectUri,
        scopes: effectiveScopes,
      });
    }

    // Build redirect back to ChatGPT
    const redirectUrl = new URL(body.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (body.state) {
      redirectUrl.searchParams.set("state", body.state);
    }

    if (contentType.includes("application/json") || request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json({ redirectUrl: redirectUrl.toString() });
    }

    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (error) {
    unstable_rethrow(error);
    return handleRouteError(error);
  }
}
