import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { createSlackOAuthState, slackOAuthScopes } from "@corgtex/domain";
import { env } from "@corgtex/shared";

function appOrigin(request: Request) {
  return env.APP_URL || new URL(request.url).origin;
}

export async function GET(request: Request) {
  try {
    await requirePageActor();
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return NextResponse.redirect(new URL("/workspaces?error=missing-workspace", request.url));
    }

    if (!env.SLACK_CLIENT_ID) {
      return NextResponse.redirect(new URL(`/workspaces/${workspaceId}/settings?slack=not-configured`, request.url));
    }

    const state = createSlackOAuthState(workspaceId);
    const cookieStore = await cookies();
    cookieStore.set("slack_oauth_state", `${state.value}:${state.nonce}`, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
      sameSite: "lax",
    });

    const redirectUri = `${appOrigin(request)}/api/integrations/slack/callback`;
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    authorize.searchParams.set("scope", slackOAuthScopes());
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state.value);

    return NextResponse.redirect(authorize);
  } catch (error) {
    return handleRouteError(error);
  }
}
