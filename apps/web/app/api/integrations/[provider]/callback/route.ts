import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import { type NextRequest, NextResponse } from "next/server";
import { saveOAuthConnectionAndEnqueueCalendarSync, verifyIntegrationOAuthState } from "@corgtex/domain";
import {
  clearOAuthStateCookie,
  type IntegrationOAuthIntent,
  integrationRedirectUrl,
  isIntegrationOAuthProvider,
  oauthStateCookieName,
  providerOAuthErrorCode,
  tokenExchangeErrorCode,
  type IntegrationOAuthProvider,
} from "../../oauth-flow";

function redirectWithStateCleared(origin: string, workspaceId: string | null | undefined, provider: IntegrationOAuthProvider, params: {
  status: "success" | "error";
  code: string;
  intent?: IntegrationOAuthIntent;
}) {
  const response = NextResponse.redirect(integrationRedirectUrl(origin, workspaceId, provider, params));
  clearOAuthStateCookie(response, provider);
  return response;
}

function readErrorMessage(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.error_description === "string") return record.error_description;
    if (typeof record.error === "string") return record.error;
    const nestedError = record.error;
    if (nestedError && typeof nestedError === "object") {
      const nested = nestedError as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
      if (typeof nested.code === "string") return nested.code;
    }
  }
  return null;
}

export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  let appUrl = "";
  let providerForError: IntegrationOAuthProvider | null = null;
  let workspaceIdForError: string | null = null;
  try {
    const params = await props.params;
    const actor = await requirePageActor();

    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Only users can perform OAuth flows" }, { status: 403 });
    }

    appUrl = getPublicOrigin(request);
    const { provider } = params;
    if (!isIntegrationOAuthProvider(provider)) {
      return NextResponse.redirect(new URL("/?integrationStatus=error&integrationError=unsupported_provider", appUrl));
    }
    providerForError = provider;
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const error = request.nextUrl.searchParams.get("error");
    const errorDescription = request.nextUrl.searchParams.get("error_description");
    const cookieState = request.cookies.get(oauthStateCookieName(provider))?.value;

    let statePayload: { workspaceId: string | null; intent?: IntegrationOAuthIntent };
    try {
      if (!state || !cookieState || state !== cookieState) {
        throw new Error("OAuth state cookie mismatch");
      }
      statePayload = verifyIntegrationOAuthState(state, actor.user.id);
    } catch {
      return redirectWithStateCleared(appUrl, null, provider, {
        status: "error",
        code: "oauth_state_invalid",
      });
    }
    const workspaceId = statePayload.workspaceId ?? "";
    const intent = statePayload.intent ?? "calendar";
    workspaceIdForError = workspaceId || null;

    if (error) {
      return redirectWithStateCleared(appUrl, workspaceId, provider, {
        status: "error",
        code: providerOAuthErrorCode(provider, error, errorDescription),
        intent,
      });
    }

    if (!code) {
      return redirectWithStateCleared(appUrl, workspaceId, provider, {
        status: "error",
        code: "oauth_code_missing",
        intent,
      });
    }

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = `${appUrl}/api/integrations/google/callback`;

      if (!clientId || !clientSecret) {
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: "google_not_configured",
          intent,
        });
      }

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        const message = readErrorMessage(tokenData);
        console.error("[OAuthCallback] Google token exchange failed", { error: message });
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: tokenExchangeErrorCode(provider, message),
          intent,
        });
      }

      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) {
        const message = readErrorMessage(profileData);
        console.error("[OAuthCallback] Google profile fetch failed", { error: message });
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: "google_profile_failed",
          intent,
        });
      }

      await saveOAuthConnectionAndEnqueueCalendarSync(actor, {
        workspaceId,
        provider: "GOOGLE",
        accessToken: String(tokenData.access_token),
        refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : null,
        expiresIn: typeof tokenData.expires_in === "number" ? tokenData.expires_in : null,
        providerAccountId: String(profileData.id),
        providerEmail: typeof profileData.email === "string" ? profileData.email : null,
        scopes: typeof tokenData.scope === "string" ? tokenData.scope.split(" ") : [],
      });

      return redirectWithStateCleared(appUrl, workspaceId, provider, {
        status: "success",
        code: "google_connected",
        intent,
      });
    }

    if (provider === "microsoft") {
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
      const redirectUri = `${appUrl}/api/integrations/microsoft/callback`;

      if (!clientId || !clientSecret) {
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: "microsoft_not_configured",
          intent,
        });
      }

      const tokenResponse = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope: ["offline_access", "User.Read", "Calendars.Read"].join(" ")
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        const message = readErrorMessage(tokenData);
        console.error("[OAuthCallback] Microsoft token exchange failed", { error: message });
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: tokenExchangeErrorCode(provider, message),
          intent,
        });
      }

      const profileResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) {
        const message = readErrorMessage(profileData);
        console.error("[OAuthCallback] Microsoft profile fetch failed", { error: message });
        return redirectWithStateCleared(appUrl, workspaceId, provider, {
          status: "error",
          code: "microsoft_profile_failed",
          intent,
        });
      }

      await saveOAuthConnectionAndEnqueueCalendarSync(actor, {
        workspaceId,
        provider: "MICROSOFT",
        accessToken: String(tokenData.access_token),
        refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : null,
        expiresIn: typeof tokenData.expires_in === "number" ? tokenData.expires_in : null,
        providerAccountId: String(profileData.id),
        providerEmail: typeof profileData.mail === "string"
          ? profileData.mail
          : typeof profileData.userPrincipalName === "string" ? profileData.userPrincipalName : null,
        scopes: typeof tokenData.scope === "string" ? tokenData.scope.split(" ") : [],
      });

      return redirectWithStateCleared(appUrl, workspaceId, provider, {
        status: "success",
        code: "microsoft_connected",
        intent,
      });
    }

    return NextResponse.redirect(new URL("/?integrationStatus=error&integrationError=unsupported_provider", appUrl));
  } catch (error) {
    if (providerForError && appUrl) {
      console.error("[OAuthCallback] Unexpected OAuth callback failure", { provider: providerForError, error });
      return redirectWithStateCleared(appUrl, workspaceIdForError, providerForError, {
        status: "error",
        code: `${providerForError}_unexpected_error`,
      });
    }
    return handleRouteError(error);
  }
}
