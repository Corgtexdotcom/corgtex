import { requirePageActor } from "@/lib/auth";
import { handleRouteError } from "@/lib/http";
import { getPublicOrigin } from "@/lib/public-origin";
import { AppError, createIntegrationOAuthState, getSupportConnectorPreparationForConsent, requireWorkspaceMembership, supportCapabilityVersion } from "@corgtex/domain";
import { type NextRequest, NextResponse } from "next/server";
import { integrationRedirectUrl, isIntegrationOAuthProvider, setOAuthStateCookie } from "../../oauth-flow";

function safeWorkspaceReturnTo(workspaceId: string, raw: string | null) {
  if (!raw || !workspaceId) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (!decoded.startsWith(`/workspaces/${workspaceId}`)) return null;
  if (decoded.startsWith("//") || decoded.includes("://")) return null;
  return decoded;
}

export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  try {
    const params = await props.params;
    const actor = await requirePageActor();

    if (actor.kind !== "user") {
      return NextResponse.json({ error: "Only users can perform OAuth flows" }, { status: 403 });
    }

    const appUrl = getPublicOrigin(request);
    const workspaceId = request.nextUrl.searchParams.get("workspaceId") || "";
    const rawIntent = request.nextUrl.searchParams.get("intent");
    let intent = rawIntent === "documents" ? "documents" as const : rawIntent === "external_mcp" ? "external_mcp" as const : "calendar" as const;
    const returnTo = safeWorkspaceReturnTo(workspaceId, request.nextUrl.searchParams.get("returnTo"));
    if (workspaceId) {
      await requireWorkspaceMembership({ actor, workspaceId });
    }
    const supportGrantVersion = workspaceId ? await supportCapabilityVersion(actor.user.id, workspaceId) : null;
    const { provider } = params;
    if (!isIntegrationOAuthProvider(provider)) {
      return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
    }
    const preparationId = request.nextUrl.searchParams.get("preparationId");
    let calendarImport: boolean | undefined;
    if (preparationId) {
      const preparation = await getSupportConnectorPreparationForConsent(actor, { workspaceId, grantId: preparationId,
        revision: Number(request.nextUrl.searchParams.get("preparationRevision")), provider });
      if (preparation.intent === "selected_channels") throw new AppError(400, "INVALID_INPUT", "Wrong connector preparation.");
      intent = preparation.intent;
      calendarImport = preparation.calendarImport;
    }

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "google_not_configured",
        }));
      }

      const redirectUri = `${appUrl}/api/integrations/google/callback`;
      const scopes = intent === "documents"
        ? ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"].join(" ")
        : ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.readonly"].join(" ");
      const state = createIntegrationOAuthState({ userId: actor.user.id, workspaceId, intent, returnTo,
        ...(supportGrantVersion == null ? {} : { supportGrantVersion }), ...(calendarImport === undefined ? {} : { calendarImport }) });

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("state", state);

      const response = NextResponse.redirect(authUrl.toString());
      setOAuthStateCookie(response, provider, state);
      return response;
    }

    if (provider === "microsoft") {
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      if (!clientId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "microsoft_not_configured",
        }));
      }

      const redirectUri = `${appUrl}/api/integrations/microsoft/callback`;
      const scopes = ["offline_access", "User.Read", "Calendars.Read"].join(" ");
      const state = createIntegrationOAuthState({ userId: actor.user.id, workspaceId, returnTo,
        ...(supportGrantVersion == null ? {} : { supportGrantVersion }), ...(calendarImport === undefined ? {} : { calendarImport }) });

      const authUrl = new URL("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_mode", "query");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("state", state);

      const response = NextResponse.redirect(authUrl.toString());
      setOAuthStateCookie(response, provider, state);
      return response;
    }

    if (provider === "box") {
      if (!workspaceId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "box_workspace_required",
          intent: "external_mcp",
        }));
      }
      const clientId = process.env.BOX_CLIENT_ID;
      if (!clientId) {
        return NextResponse.redirect(integrationRedirectUrl(appUrl, workspaceId, provider, {
          status: "error",
          code: "box_not_configured",
          intent: "external_mcp",
          returnTo,
        }));
      }

      const redirectUri = `${appUrl}/api/integrations/box/callback`;
      const scopes = (process.env.BOX_MCP_SCOPES || "root_readwrite ai.readwrite").trim();
      const state = createIntegrationOAuthState({ userId: actor.user.id, workspaceId, intent: "external_mcp", returnTo,
        ...(supportGrantVersion == null ? {} : { supportGrantVersion }) });

      const authUrl = new URL("https://account.box.com/api/oauth2/authorize");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes);
      authUrl.searchParams.set("state", state);

      const response = NextResponse.redirect(authUrl.toString());
      setOAuthStateCookie(response, provider, state);
      return response;
    }

    return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
  } catch (error) {
    return handleRouteError(error);
  }
}
