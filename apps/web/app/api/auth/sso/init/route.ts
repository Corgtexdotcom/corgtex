import { NextResponse } from "next/server";
import { lookupSsoConfigForDomain } from "@corgtex/domain";
import { cookies } from "next/headers";
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.redirect(new URL("/login?error=email-required", request.url));
  }

  const ssoConfig = await lookupSsoConfigForDomain(email);

  if (!ssoConfig || !ssoConfig.isEnabled) {
    return NextResponse.redirect(new URL("/login?error=sso-not-configured", request.url));
  }

  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

  const cookieStore = await cookies();
  cookieStore.set("sso_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5, // 5 minutes
    sameSite: "lax",
  });

  cookieStore.set("sso_nonce", nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5,
    sameSite: "lax",
  });

  cookieStore.set("sso_pkce_verifier", codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5,
    sameSite: "lax",
  });

  cookieStore.set("sso_workspace_id", ssoConfig.workspaceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5,
    sameSite: "lax",
  });

  cookieStore.set("sso_provider", ssoConfig.provider, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 5,
    sameSite: "lax",
  });

  const redirectUri = `${appOrigin(request)}/api/auth/sso/callback`;
  const config = await oidc.discovery(
    providerIssuer(ssoConfig.provider),
    ssoConfig.clientId,
    ssoConfig.clientSecretEnc,
    oidc.ClientSecretPost(ssoConfig.clientSecretEnc),
    { timeout: 10 },
  );

  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (ssoConfig.provider === "GOOGLE") {
    authUrl.searchParams.set("prompt", "select_account");
  }

  return NextResponse.redirect(authUrl.toString());
}
