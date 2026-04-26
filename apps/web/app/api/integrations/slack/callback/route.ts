import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { exchangeSlackOAuthCode, readSlackOAuthState, saveSlackInstallation } from "@corgtex/domain";
import { env } from "@corgtex/shared";

function appOrigin(request: Request) {
  return env.APP_URL || new URL(request.url).origin;
}

export async function GET(request: Request) {
  try {
    const actor = await requirePageActor();
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error || !code || !state) {
      return NextResponse.redirect(new URL("/workspaces?error=slack-oauth-failed", request.url));
    }

    const cookieStore = await cookies();
    const saved = cookieStore.get("slack_oauth_state")?.value;
    cookieStore.delete("slack_oauth_state");
    const [savedState, savedNonce] = saved?.split(":") ?? [];
    const parsed = readSlackOAuthState(state);

    if (!savedState || !savedNonce || state !== savedState || !parsed || parsed.nonce !== savedNonce) {
      return NextResponse.redirect(new URL("/workspaces?error=slack-invalid-state", request.url));
    }

    const redirectUri = `${appOrigin(request)}/api/integrations/slack/callback`;
    const oauthResponse = await exchangeSlackOAuthCode(code, redirectUri);
    await saveSlackInstallation(actor, {
      workspaceId: parsed.workspaceId,
      oauthResponse,
    });

    return NextResponse.redirect(new URL(`/workspaces/${parsed.workspaceId}/settings?tab=general&slack=connected`, request.url));
  } catch (error) {
    return handleRouteError(error);
  }
}
