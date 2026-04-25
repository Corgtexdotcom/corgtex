import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { handleRouteError } from "@/lib/http";
import { createSession, linkOrProvisionSsoUser } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";
import { setSessionCookie } from "@/lib/auth";
import * as oidc from "openid-client";

function providerIssuer(provider: string) {
  if (provider === "GOOGLE") {
    return new URL("https://accounts.google.com");
  }

  if (provider === "MICROSOFT") {
    return new URL("https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration");
  }

  throw new Error("Unsupported SSO provider.");
}

function appOrigin(request: Request) {
  return process.env.APP_URL?.trim() || new URL(request.url).origin;
}

function claimString(claims: Record<string, unknown>, key: string) {
  const value = claims[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");

    if (error || !code) {
      return NextResponse.redirect(new URL("/login?error=sso-failed", request.url));
    }

    const cookieStore = await cookies();
    const savedState = cookieStore.get("sso_state")?.value;
    const expectedNonce = cookieStore.get("sso_nonce")?.value;
    const pkceCodeVerifier = cookieStore.get("sso_pkce_verifier")?.value;
    const workspaceId = cookieStore.get("sso_workspace_id")?.value;
    const provider = cookieStore.get("sso_provider")?.value;

    cookieStore.delete("sso_state");
    cookieStore.delete("sso_nonce");
    cookieStore.delete("sso_pkce_verifier");
    cookieStore.delete("sso_workspace_id");
    cookieStore.delete("sso_provider");

    if (
      !state ||
      state !== savedState ||
      !expectedNonce ||
      !pkceCodeVerifier ||
      !workspaceId ||
      (provider !== "GOOGLE" && provider !== "MICROSOFT")
    ) {
      return NextResponse.redirect(new URL("/login?error=invalid-state", request.url));
    }

    const config = await prisma.workspaceSsoConfig.findUnique({
      where: {
        workspaceId_provider: {
          workspaceId,
          provider,
        }
      },
      include: {
        workspace: true
      }
    });

    if (!config || !config.isEnabled) {
      return NextResponse.redirect(new URL("/login?error=sso-not-configured", request.url));
    }

    const oidcConfig = await oidc.discovery(
      providerIssuer(provider),
      config.clientId,
      config.clientSecretEnc,
      oidc.ClientSecretPost(config.clientSecretEnc),
      { timeout: 10 },
    );
    const currentUrl = new URL(`${appOrigin(request)}/api/auth/sso/callback`);
    for (const [key, value] of searchParams.entries()) {
      currentUrl.searchParams.append(key, value);
    }

    const tokens = await oidc.authorizationCodeGrant(oidcConfig, currentUrl, {
      expectedState: savedState,
      expectedNonce,
      pkceCodeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    const subject = claims ? claimString(claims, "sub") : null;
    const email = claims
      ? claimString(claims, "email") ?? claimString(claims, "preferred_username") ?? claimString(claims, "upn")
      : null;

    if (!claims || !subject || !email) {
      return NextResponse.redirect(new URL("/login?error=invalid-id-token", request.url));
    }

    if (provider === "GOOGLE" && claims.email_verified === false) {
      return NextResponse.redirect(new URL("/login?error=email-not-verified", request.url));
    }

    const emailDomain = email.split("@")[1]?.toLowerCase();
    const allowedDomains = config.allowedDomains.map((domain) => domain.toLowerCase());
    if (!emailDomain || !allowedDomains.includes(emailDomain)) {
      return NextResponse.redirect(new URL("/login?error=domain-not-allowed", request.url));
    }

    const user = await linkOrProvisionSsoUser({
      workspaceId,
      provider,
      providerSubjectId: subject,
      email,
      displayName: claims ? claimString(claims, "name") : undefined,
    });

    const session = await createSession(user.id);
    await setSessionCookie(session.token, session.expiresAt);

    return NextResponse.redirect(new URL(`/workspaces/${config.workspace.slug}`, request.url));
  } catch (error) {
    return handleRouteError(error);
  }
}
