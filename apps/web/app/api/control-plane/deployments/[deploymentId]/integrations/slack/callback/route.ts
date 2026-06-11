import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeSlackOAuthCode,
  getControlPlaneSlackSetupTarget,
  readSlackOAuthState,
  saveControlPlaneSlackInstallation,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { appRedirectUrl, rethrowNextRedirectError, slackCallbackRedirectUri } from "@/lib/slack-oauth";

export const dynamic = "force-dynamic";

const CONTROL_PLANE_SLACK_STATE_COOKIE = "control_plane_slack_oauth_state";

export async function GET(
  request: Request,
  props: { params: Promise<{ deploymentId: string }> },
) {
  const unavailableResponse = requireControlPlaneDeploymentMode();
  if (unavailableResponse) {
    return unavailableResponse;
  }

  try {
    const actor = await requirePageActor();
    const { deploymentId } = await props.params;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error || !code || !state || actor.kind !== "user") {
      return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=oauth-failed`));
    }

    const cookieStore = await cookies();
    const saved = cookieStore.get(CONTROL_PLANE_SLACK_STATE_COOKIE)?.value;
    cookieStore.delete(CONTROL_PLANE_SLACK_STATE_COOKIE);
    const [savedState, savedNonce, savedDeploymentId, savedUserId] = saved?.split(":") ?? [];
    const parsed = readSlackOAuthState(state);

    if (
      !savedState
      || !savedNonce
      || !savedDeploymentId
      || state !== savedState
      || deploymentId !== savedDeploymentId
      || savedUserId !== actor.user.id
      || !parsed
      || parsed.nonce !== savedNonce
    ) {
      return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=invalid-state`));
    }

    const target = await getControlPlaneSlackSetupTarget(actor, deploymentId);
    if (parsed.workspaceId !== target.managedWorkspaceId) {
      return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=invalid-workspace`));
    }

    const redirectUri = slackCallbackRedirectUri(request, `/api/control-plane/deployments/${deploymentId}/integrations/slack/callback`);
    const oauthResponse = await exchangeSlackOAuthCode(code, redirectUri);
    await saveControlPlaneSlackInstallation(actor, {
      deploymentId,
      oauthResponse,
      reason: "Connected Slack through Control Plane.",
    });

    return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=connected`));
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
