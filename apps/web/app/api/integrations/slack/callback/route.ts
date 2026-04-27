import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { exchangeSlackOAuthCode, readSlackOAuthState, saveSlackInstallation } from "@corgtex/domain";
import { appRedirectUrl, rethrowNextRedirectError, slackCallbackRedirectUri } from "../oauth";

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
    await saveSlackInstallation(actor, {
      workspaceId: parsed.workspaceId,
      oauthResponse,
    });

    return NextResponse.redirect(appRedirectUrl(request, `/workspaces/${parsed.workspaceId}/settings?tab=general&slack=connected`));
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
