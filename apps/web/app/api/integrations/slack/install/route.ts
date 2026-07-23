import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { createSlackOAuthState, getSlackOAuthInstallTarget, slackOAuthScopes } from "@corgtex/domain";
import { env } from "@corgtex/shared";
import { appRedirectUrl, rethrowNextRedirectError, slackCallbackRedirectUri } from "../oauth";

export async function GET(request: Request) {
  try {
    const actor = await requirePageActor();
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get("workspaceId");
    if (!workspaceId) {
      return NextResponse.redirect(appRedirectUrl(request, "/workspaces?error=missing-workspace"));
    }

    if (!env.SLACK_CLIENT_ID) {
      return NextResponse.redirect(appRedirectUrl(request, `/workspaces/${workspaceId}/tools?type=CONNECTOR&q=slack&slack=not-configured`));
    }

    const target = await getSlackOAuthInstallTarget(actor, workspaceId);
    const state = createSlackOAuthState(workspaceId, {
      expectedTeamId: target.expectedTeamId,
      flow: {
        kind: "workspace",
        initiatedByUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });
    const cookieStore = await cookies();
    cookieStore.set("slack_oauth_state", `${state.value}:${state.nonce}`, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
      sameSite: "lax",
    });

    const redirectUri = slackCallbackRedirectUri(request);
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    authorize.searchParams.set("scope", slackOAuthScopes());
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state.value);
    if (target.expectedTeamId) {
      authorize.searchParams.set("team", target.expectedTeamId);
    }

    return NextResponse.redirect(authorize);
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
