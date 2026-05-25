import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import { createIntegrationOAuthState, requireWorkspaceMembership } from "@corgtex/domain";
import { type NextRequest, NextResponse } from "next/server";
import { integrationRedirectUrl, isIntegrationOAuthProvider, setOAuthStateCookie } from "../../oauth-flow";

export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  try {
    const params = await props.params;
    const actor = await requirePageActor();

    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Only users can perform OAuth flows" }, { status: 403 });
    }

    const appUrl = getPublicOrigin(request);
    const workspaceId = request.nextUrl.searchParams.get("workspaceId") || "";
    if (workspaceId) {
      await requireWorkspaceMembership({ actor, workspaceId });
    }
    const { provider } = params;
    if (!isIntegrationOAuthProvider(provider)) {
      return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
    }

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "google_not_configured",
        }));
      }

      const redirectUri = `${appUrl}/api/integrations/google/callback`;
      const scopes = [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
      ].join(" ");
      const state = createIntegrationOAuthState({ userId: actor.user.id, workspaceId });

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("state", state);

      const response = NextResponse.redirect(authUrl.toString());
      setOAuthStateCookie(response, provider, state);
      return response;
    }

    if (provider === "microsoft") {
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      if (!clientId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "microsoft_not_configured",
        }));
      }

      const redirectUri = `${appUrl}/api/integrations/microsoft/callback`;
      const scopes = ["offline_access", "User.Read", "Calendars.Read"].join(" ");
      const state = createIntegrationOAuthState({ userId: actor.user.id, workspaceId });

      const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_mode", "query");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("state", state);

      const response = NextResponse.redirect(authUrl.toString());
      setOAuthStateCookie(response, provider, state);
      return response;
    }

    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  } catch (error) {
    return handleRouteError(error);
  }
}
