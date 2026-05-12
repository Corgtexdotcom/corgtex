import { NextResponse, type NextRequest } from "next/server";
import { createRecorderCalendarOAuthState, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { requireControlPlaneDeploymentMode } from "@/lib/control-plane-guard";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

function appOrigin(request: NextRequest) {
  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  return `${protocol}://${host}`;
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
    await requireControlPlaneAccess(actor, { deploymentId });

    const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
    if (!clientId) {
      return NextResponse.json({ error: "Microsoft integration not configured" }, { status: 500 });
    }

    const origin = appOrigin(request);
    const redirectUri = `${origin}/api/control-plane/deployments/${deploymentId}/meeting-recorders/microsoft/callback`;
    const state = createRecorderCalendarOAuthState({ deploymentId, actorUserId: actor.user.id });
    const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", ["offline_access", "User.Read", "Calendars.Read"].join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("prompt", "consent");

    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    return handleRouteError(error);
  }
}
