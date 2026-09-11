import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AppError,
  createSlackOAuthState,
  getControlPlaneSlackSetupTarget,
  getSlackWorkspaceBinding,
  slackOAuthScopes,
} from "@corgtex/domain";
import { env } from "@corgtex/shared";
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
    const target = await getControlPlaneSlackSetupTarget(actor, deploymentId);

    const binding = getSlackWorkspaceBinding(target.managedWorkspaceId);
    if (!binding?.clientId || !binding.clientSecret) {
      return NextResponse.redirect(appRedirectUrl(request, `/control-plane/deployments/${deploymentId}?tab=tools&slack=not-configured`));
    }

    if (binding.source === "workspace" && target.expectedTeamId && target.expectedTeamId !== binding.teamId) {
      throw new AppError(409, "SLACK_TEAM_MISMATCH", "Slack workspace binding does not match this workspace.");
    }
    const expectedTeamId = binding.teamId ?? target.expectedTeamId;
    const state = createSlackOAuthState(target.managedWorkspaceId, {
      expectedTeamId,
      flow: {
        kind: "control_plane",
        deploymentId,
        initiatedByUserId: actor.kind === "user" ? actor.user.id : null,
      },
    });
    const cookieStore = await cookies();
    cookieStore.set(CONTROL_PLANE_SLACK_STATE_COOKIE, `${state.value}:${state.nonce}:${deploymentId}:${actor.kind === "user" ? actor.user.id : ""}`, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      path: `/api/control-plane/deployments/${deploymentId}/integrations/slack/callback`,
      maxAge: 60 * 10,
      sameSite: "lax",
    });

    const redirectUri = slackCallbackRedirectUri(request, `/api/control-plane/deployments/${deploymentId}/integrations/slack/callback`);
    const authorize = new URL("https://slack.com/oauth/v2/authorize");
    authorize.searchParams.set("client_id", binding.clientId);
    authorize.searchParams.set("scope", binding.scopes?.join(",") ?? slackOAuthScopes());
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("state", state.value);
    if (expectedTeamId) {
      authorize.searchParams.set("team", expectedTeamId);
    }

    return NextResponse.redirect(authorize);
  } catch (error) {
    rethrowNextRedirectError(error);
    return handleRouteError(error);
  }
}
