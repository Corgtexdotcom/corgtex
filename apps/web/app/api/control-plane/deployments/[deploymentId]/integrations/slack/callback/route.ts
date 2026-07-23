import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  exchangeSlackOAuthCode,
  getControlPlaneSlackSetupTarget,
  isSlackTenantBindingError,
  readSlackOAuthState,
  saveControlPlaneSlackInstallation,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { appRedirectUrl, rethrowNextRedirectError, slackCallbackRedirectUri } from "@/lib/slack-oauth";

export const dynamic = "force-dynamic";

const CONTROL_PLANE_SLACK_STATE_COOKIE = "control_plane_slack_oauth_state";

function slackTeamId(oauthResponse: Awaited<ReturnType<typeof exchangeSlackOAuthCode>>) {
  const teamId = oauthResponse.team?.id?.trim();
  return teamId || null;
}

function controlPlaneSlackRedirect(request: Request, deploymentId: string, status: string) {
  return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=${status}`));
}

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
      return controlPlaneSlackRedirect(request, deploymentId, "oauth-failed");
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
      return controlPlaneSlackRedirect(request, deploymentId, "invalid-state");
    }

    const target = await getControlPlaneSlackSetupTarget(actor, deploymentId);
    const stateMatchesControlPlaneFlow = parsed.version === 0 || (
      parsed.flow.kind === "control_plane"
      && parsed.flow.deploymentId === deploymentId
      && parsed.flow.initiatedByUserId === actor.user.id
    );
    if (
      parsed.workspaceId !== target.managedWorkspaceId
      || !stateMatchesControlPlaneFlow
    ) {
      return controlPlaneSlackRedirect(request, deploymentId, "invalid-state");
    }

    const redirectUri = slackCallbackRedirectUri(request, `/api/control-plane/deployments/${deploymentId}/integrations/slack/callback`);
    const oauthResponse = await exchangeSlackOAuthCode(code, redirectUri);
    const expectedTeamId = parsed.expectedTeamId ?? target.expectedTeamId;
    if (expectedTeamId && slackTeamId(oauthResponse) !== expectedTeamId) {
      return controlPlaneSlackRedirect(request, deploymentId, "wrong-team");
    }
    try {
      await saveControlPlaneSlackInstallation(actor, {
        deploymentId,
        oauthResponse,
        expectedTeamId,
        reason: "Connected Slack through Control Plane.",
      });
    } catch (error) {
      if (isSlackTenantBindingError(error)) {
        return controlPlaneSlackRedirect(request, deploymentId, "wrong-team");
      }
      throw error;
    }

    return controlPlaneSlackRedirect(request, deploymentId, "connected");
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
