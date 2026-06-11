import { NextResponse } from "next/server";

export type IntegrationOAuthProvider = "google" | "microsoft";
export type IntegrationOAuthIntent = "calendar" | "documents";

const OAUTH_STATE_MAX_AGE_SECONDS = 15 * 60;
const MICROSOFT_INVALID_CLIENT_SECRET_MARKERS = [
  "aadsts7000215",
  "invalid client secret",
  "secret value, not the client secret id",
];

export function isIntegrationOAuthProvider(value: string): value is IntegrationOAuthProvider {
  return value === "google" || value === "microsoft";
}

export function oauthStateCookieName(provider: IntegrationOAuthProvider) {
  return `corgtex_${provider}_oauth_state`;
}

export function setOAuthStateCookie(response: NextResponse, provider: IntegrationOAuthProvider, state: string) {
  response.cookies.set(oauthStateCookieName(provider), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    path: `/api/integrations/${provider}/callback`,
  });
}

export function clearOAuthStateCookie(response: NextResponse, provider: IntegrationOAuthProvider) {
  response.cookies.set(oauthStateCookieName(provider), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: `/api/integrations/${provider}/callback`,
  });
}

export function integrationRedirectUrl(origin: string, workspaceId: string | null | undefined, provider: IntegrationOAuthProvider, params: {
  status: "success" | "error";
  code: string;
  intent?: IntegrationOAuthIntent;
}) {
  const path = workspaceId
    ? params.intent === "documents"
      ? `/workspaces/${workspaceId}`
      : `/workspaces/${workspaceId}/tools`
    : "/";
  const url = new URL(path, origin);
  if (workspaceId && params.intent === "documents") {
    url.searchParams.set("onboarding", "setup");
  } else if (workspaceId) {
    url.searchParams.set("type", "CONNECTOR");
    url.searchParams.set("q", provider);
  }
  url.searchParams.set("integration", provider);
  url.searchParams.set("integrationStatus", params.status);
  if (params.status === "error") {
    url.searchParams.set("integrationError", params.code);
  } else {
    url.searchParams.set("integrationSuccess", params.code);
  }
  return url;
}

export function providerOAuthErrorCode(provider: IntegrationOAuthProvider, error: string | null, description?: string | null) {
  const raw = `${error ?? ""} ${description ?? ""}`.toLowerCase();
  if (provider === "google") {
    if (raw.includes("verification") || raw.includes("access_denied")) {
      return "google_verification_or_tester_required";
    }
    return "google_oauth_failed";
  }

  if (MICROSOFT_INVALID_CLIENT_SECRET_MARKERS.some((marker) => raw.includes(marker))) {
    return "microsoft_invalid_client_secret";
  }
  if (raw.includes("aadsts50020") || raw.includes("tenant") || raw.includes("external user")) {
    return "microsoft_tenant_access_denied";
  }
  if (raw.includes("admin") && raw.includes("consent")) {
    return "microsoft_admin_consent_required";
  }
  if (raw.includes("access_denied")) {
    return "microsoft_access_denied";
  }
  return "microsoft_oauth_failed";
}

export function tokenExchangeErrorCode(provider: IntegrationOAuthProvider, description?: string | null) {
  const raw = (description ?? "").toLowerCase();
  if (provider === "microsoft" && MICROSOFT_INVALID_CLIENT_SECRET_MARKERS.some((marker) => raw.includes(marker))) {
    return "microsoft_invalid_client_secret";
  }
  if (provider === "microsoft" && (raw.includes("aadsts50020") || raw.includes("tenant") || raw.includes("external user"))) {
    return "microsoft_tenant_access_denied";
  }
  if (provider === "microsoft" && raw.includes("admin") && raw.includes("consent")) {
    return "microsoft_admin_consent_required";
  }
  return `${provider}_token_exchange_failed`;
}
