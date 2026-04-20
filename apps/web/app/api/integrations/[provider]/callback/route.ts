import { requirePageActor } from "@/lib/auth";
import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@corgtex/shared";
import { requireWorkspaceMembership } from "@corgtex/domain";

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
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  const [userId, workspaceId] = (state || "").split(":");
  const returnUrl = workspaceId ? `/workspaces/${workspaceId}/settings` : "/";

  if (error) {
    return NextResponse.redirect(new URL(`${returnUrl}?error=${error}`, appUrl));
  }

  if (!code || !state || actor.user.id !== userId) {
    return NextResponse.redirect(new URL(`${returnUrl}?error=invalid_request`, appUrl));
  }

  try {
    if (workspaceId) {
      await requireWorkspaceMembership({
        actor,
        workspaceId,
      });
    }

    if (provider === "google") {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const redirectUri = `${appUrl}/api/integrations/google/callback`;

      if (!clientId || !clientSecret) throw new Error("Google integration not configured");

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenData.error || "Failed to exchange token");

      // Get user profile
      const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profileData.error?.message || "Failed to fetch profile");

      const connection = await prisma.oAuthConnection.upsert({
        where: { userId_provider: { userId: actor.user.id, provider: "GOOGLE" } },
        update: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || undefined,
          expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          providerAccountId: profileData.id,
          scopes: tokenData.scope?.split(" ") || [],
        },
        create: {
          userId: actor.user.id,
          provider: "GOOGLE",
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          providerAccountId: profileData.id,
          scopes: tokenData.scope?.split(" ") || [],
        },
      });

      if (workspaceId) {
        await prisma.workflowJob.create({
          data: {
            workspaceId,
            type: "calendar.sync",
            payload: {
              connectionId: connection.id,
            },
          },
        });
      }

      return NextResponse.redirect(new URL(`${returnUrl}?success=google_connected`, appUrl));
    }

    if (provider === "microsoft") {
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
      const redirectUri = `${appUrl}/api/integrations/microsoft/callback`;

      if (!clientId || !clientSecret) throw new Error("Microsoft integration not configured");

      const tokenResponse = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          scope: ["offline_access", "User.Read", "Calendars.ReadWrite"].join(" ")
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenData.error_description || "Failed to exchange token");

      const profileResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const profileData = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profileData.error?.message || "Failed to fetch profile");

      const connection = await prisma.oAuthConnection.upsert({
        where: { userId_provider: { userId: actor.user.id, provider: "MICROSOFT" } },
        update: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || undefined,
          expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          providerAccountId: profileData.id,
          scopes: tokenData.scope?.split(" ") || [],
        },
        create: {
          userId: actor.user.id,
          provider: "MICROSOFT",
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
          providerAccountId: profileData.id,
          scopes: tokenData.scope?.split(" ") || [],
        },
      });

      if (workspaceId) {
        await prisma.workflowJob.create({
          data: {
            workspaceId,
            type: "calendar.sync",
            payload: {
              connectionId: connection.id,
            },
          },
        });
      }

      return NextResponse.redirect(new URL(`${returnUrl}?success=microsoft_connected`, appUrl));
    }

    return NextResponse.redirect(new URL(`${returnUrl}?error=unsupported_provider`, appUrl));
  } catch (error: any) {
    console.error(`OAuth callback error for ${provider}:`, error);
    return NextResponse.redirect(new URL(`${returnUrl}?error=connection_failed`, appUrl));
  }
}
