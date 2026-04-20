import { requirePageActor } from "@/lib/auth";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest, props: { params: Promise<{ provider: string }> }) {
  const params = await props.params;
  const actor = await requirePageActor();

  if (actor.kind !== "user") {
    return NextResponse.json({ error: "Only users can perform OAuth flows" }, { status: 403 });
  }

  const protocol = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  const appUrl = `${protocol}://${host}`;

  const { provider } = params;

  if (provider === "google") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ error: "Google integration not configured" }, { status: 500 });
    }

    const redirectUri = `${appUrl}/api/integrations/google/callback`;
    const scopes = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"].join(" ");

    const workspaceId = request.nextUrl.searchParams.get("workspaceId") || "";
    const state = `${actor.user.id}:${workspaceId}`;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    return NextResponse.redirect(authUrl.toString());
  }

  if (provider === "microsoft") {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json({ error: "Microsoft integration not configured" }, { status: 500 });
    }

    const redirectUri = `${appUrl}/api/integrations/microsoft/callback`;
    const scopes = ["offline_access", "User.Read", "Calendars.ReadWrite"].join(" ");

    const workspaceId = request.nextUrl.searchParams.get("workspaceId") || "";
    const state = `${actor.user.id}:${workspaceId}`;

    const authUrl = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_mode", "query");
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);

    return NextResponse.redirect(authUrl.toString());
  }

  return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
}
