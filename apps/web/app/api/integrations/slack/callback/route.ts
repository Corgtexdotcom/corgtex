import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import {
  exchangeSlackOAuthCode,
  isSlackTenantBindingError,
  readSlackOAuthState,
  saveSlackInstallation,
} from "@corgtex/domain";
import { appRedirectUrl, rethrowNextRedirectError, slackCallbackRedirectUri } from "../oauth";

function slackTeamId(oauthResponse: Awaited<ReturnType<typeof exchangeSlackOAuthCode>>) {
  const teamId = oauthResponse.team?.id?.trim();
  return teamId || null;
}

function slackToolsRedirect(request: Request, workspaceId: string, status: string) {
  return NextResponse.redirect(appRedirectUrl(request, `/workspaces/${workspaceId}/tools?type=CONNECTOR&q=slack&slack=${status}`));
}

export async function GET(request: Request) {
  try {
    const actor = await requirePageActor();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error || !code || !state) {
      return NextResponse.redirect(appRedirectUrl(request, "/workspaces?error=slack-oauth-failed"));
    }

    const cookieStore = await cookies();
    const saved = cookieStore.get("slack_oauth_state")?.value;
    cookieStore.delete("slack_oauth_state");
    const [savedState, savedNonce] = saved?.split(":") ?? [];
    const parsed = readSlackOAuthState(state);

    if (!savedState || !savedNonce || state !== savedState || !parsed || parsed.nonce !== savedNonce) {
      return NextResponse.redirect(appRedirectUrl(request, "/workspaces?error=slack-invalid-state"));
    }

    const redirectUri = slackCallbackRedirectUri(request);
    const oauthResponse = await exchangeSlackOAuthCode(code, redirectUri);
    if (parsed.expectedTeamId && slackTeamId(oauthResponse) !== parsed.expectedTeamId) {
      return slackToolsRedirect(request, parsed.workspaceId, "wrong-team");
    }
    try {
      await saveSlackInstallation(actor, {
        workspaceId: parsed.workspaceId,
        oauthResponse,
        expectedTeamId: parsed.expectedTeamId,
      });
    } catch (error) {
      if (isSlackTenantBindingError(error)) {
        return slackToolsRedirect(request, parsed.workspaceId, "wrong-team");
      }
      throw error;
    }

    return slackToolsRedirect(request, parsed.workspaceId, "connected");
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
