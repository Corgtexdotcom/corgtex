import { NextRequest, NextResponse } from "next/server";
import { requirePageActor } from "@/lib/auth";
import { getOAuthAppByClientId, isAllowedOAuthRedirectUri, issueAuthorizationCode } from "@corgtex/domain";
import { z } from "zod";

// This is the endpoint ChatGPT calls to start the OAuth flow.
// Typically it's a GET, but we'll accept POST too for the user consent submission.

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const responseType = url.searchParams.get("response_type"); // expected: "code"
  const scopeString = url.searchParams.get("scope") || "";

  if (!clientId || !redirectUri || responseType !== "code") {
    return NextResponse.json({ error: "invalid_request", message: "Missing required parameters (client_id, redirect_uri) or invalid response_type" }, { status: 400 });
  }

  // The Custom GPT should specify the workspace in the request, or we can use the app's workspaceId
  let app;
  try {
    app = await getOAuthAppByClientId(clientId);
  } catch (e) {
    return NextResponse.json({ error: "invalid_client", message: "Unknown client_id" }, { status: 400 });
  }

  if (!isAllowedOAuthRedirectUri(app.redirectUris, redirectUri)) {
    return NextResponse.json({ error: "invalid_request", message: "Redirect URI is not registered" }, { status: 400 });
  }

  // Ensure user is logged in
  try {
    await requirePageActor();
  } catch (e) {
    // requirePageActor will redirect to /login
    // Once they login, they would ideally be redirected back here.
    // However, our standard login redirects to /. To fix this, you'd modify login to support return_to or use Next.js middleware.
    // For now we'll rely on the existing redirect behavior and ChatGPT's ability to retry.
    throw e;
  }

  // Create a URL pointing to our UI consent page
  const consentUrl = new URL("/oauth/authorize", request.url);
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("state", state || "");
  consentUrl.searchParams.set("scope", scopeString);

  return NextResponse.redirect(consentUrl);
}

// Handling the consent form submission from our UI
export async function POST(request: NextRequest) {
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
    } catch (e) {
      // Ignore JSON parse errors for fallback
    }
  }

  const jsBody = bodyData;
  const schema = z.object({
    clientId: z.string(),
    redirectUri: z.string(),
    state: z.string().optional(),
    scopes: z.string().optional(),
  });

  const parsed = schema.safeParse(jsBody);
  if (!parsed.success) {
     return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const body = parsed.data;

  try {
    const app = await getOAuthAppByClientId(body.clientId);
    const scopeArray = (body.scopes || "").split(" ").filter(Boolean);
    const effectiveScopes = scopeArray.length > 0 ? scopeArray : app.scopes;

    // Issue code
    const code = await issueAuthorizationCode(actor, {
      clientId: body.clientId,
      workspaceId: app.workspaceId,
      redirectUri: body.redirectUri,
      scopes: effectiveScopes,
    });

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
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
