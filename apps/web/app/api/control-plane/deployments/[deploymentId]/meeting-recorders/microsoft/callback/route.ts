import { NextResponse, type NextRequest } from "next/server";
import {
  AppError,
  readRecorderCalendarOAuthState,
  saveControlPlaneRecorderCalendarSource,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

function appOrigin(request: NextRequest) {
  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  return `${protocol}://${host}`;
}

function deploymentRedirect(origin: string, deploymentId: string, params: Record<string, string>) {
  const url = new URL(`/control-plane/deployments/${deploymentId}`, `${origin}/`);
  url.hash = "integrations";
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) return unavailableResponse;

  try {
    const actor = await requirePageActor();
    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Only users can connect recorder calendars." }, { status: 403 });
    }

    const { deploymentId } = await props.params;
    const origin = appOrigin(request);
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const oauthError = request.nextUrl.searchParams.get("error");
    if (oauthError) {
      return NextResponse.redirect(deploymentRedirect(origin, deploymentId, { error: oauthError }));
    }
    if (!code || !state) {
      return NextResponse.redirect(deploymentRedirect(origin, deploymentId, { error: "invalid_request" }));
    }

    const parsedState = readRecorderCalendarOAuthState(state);
    if (!parsedState || parsedState.deploymentId !== deploymentId || parsedState.actorUserId !== actor.user.id) {
      throw new AppError(400, "INVALID_OAUTH_STATE", "Recorder calendar OAuth state is invalid.");
    }

    const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new AppError(503, "MICROSOFT_NOT_CONFIGURED", "Microsoft integration is not configured.");
    }

    const redirectUri = `${origin}/api/control-plane/deployments/${deploymentId}/meeting-recorders/microsoft/callback`;
    const tokenResponse = await fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: ["offline_access", "User.Read", "Calendars.Read"].join(" "),
      }),
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok) {
      throw new AppError(502, "MICROSOFT_TOKEN_EXCHANGE_FAILED", String(tokenData.error_description ?? tokenData.error ?? "Failed to exchange Microsoft token."));
    }

    const profileResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${String(tokenData.access_token)}` },
    });
    const profileData = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok) {
      throw new AppError(502, "MICROSOFT_PROFILE_FAILED", String(profileData.error?.message ?? "Failed to fetch Microsoft profile."));
    }

    await saveControlPlaneRecorderCalendarSource(actor, {
      deploymentId,
      providerAccountId: String(profileData.id),
      providerAccountEmail: typeof profileData.mail === "string" ? profileData.mail : typeof profileData.userPrincipalName === "string" ? profileData.userPrincipalName : null,
      displayName: typeof profileData.displayName === "string" ? profileData.displayName : null,
      accessToken: String(tokenData.access_token),
      refreshToken: typeof tokenData.refresh_token === "string" ? tokenData.refresh_token : null,
      expiresIn: typeof tokenData.expires_in === "number" ? tokenData.expires_in : null,
      scopes: typeof tokenData.scope === "string" ? tokenData.scope.split(/\s+/).filter(Boolean) : [],
      reason: "Connected Microsoft recorder calendar through Control Plane.",
    });

    return NextResponse.redirect(deploymentRedirect(origin, deploymentId, { success: "recorder_calendar_connected" }));
  } catch (error) {
    return handleRouteError(error);
  }
}
