import { loginUserWithPassword, listActorWorkspaces } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { NextRequest, NextResponse } from "next/server";

const DEMO_EMAIL = "demo@jnj-demo.corgtex.app";
const DEMO_PASSWORD = "demo1234";
const DEMO_WORKSPACE_SLUG = "jnj-demo";

type DemoSession = {
  expiresAt: Date;
  token: string;
  workspaceId: string;
};

export type DemoLocale = "en" | "es";

export async function issueDemoSession(): Promise<DemoSession> {
  const result = await loginUserWithPassword({
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
  });

  const actor = {
    kind: "user" as const,
    user: result.user,
  };

  const workspaces = await listActorWorkspaces(actor);
  const targetWorkspace =
    workspaces.find((workspace) => workspace.slug === DEMO_WORKSPACE_SLUG) ?? workspaces[0];

  if (!targetWorkspace) {
    throw new Error("Demo workspace not found");
  }

  return {
    token: result.token,
    expiresAt: result.expiresAt,
    workspaceId: targetWorkspace.id,
  };
}

export function normalizeDemoLocale(locale?: string | null): DemoLocale {
  return locale === "es" ? "es" : "en";
}

export function demoWorkspacePath(workspaceId: string, locale?: string | null) {
  return normalizeDemoLocale(locale) === "es"
    ? `/es/workspaces/${workspaceId}`
    : `/workspaces/${workspaceId}`;
}

function getRequestHeaderValue(request: NextRequest, headerName: string) {
  const value = request.headers.get(headerName)?.split(",")[0]?.trim();
  return value || null;
}

export function demoRedirectBaseUrl(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const host =
    getRequestHeaderValue(request, "x-forwarded-host") ||
    getRequestHeaderValue(request, "host") ||
    requestUrl.host;
  const protocol =
    getRequestHeaderValue(request, "x-forwarded-proto") ||
    requestUrl.protocol.replace(/:$/, "");

  return process.env.NEXT_PUBLIC_APP_URL || `${protocol}://${host}`;
}

export async function createDemoRedirectResponse(request: NextRequest, locale?: string | null) {
  const session = await issueDemoSession();
  const response = NextResponse.redirect(
    new URL(demoWorkspacePath(session.workspaceId, locale), demoRedirectBaseUrl(request)),
  );
  setDemoSessionCookie(response, session);
  return response;
}

export function setDemoSessionCookie(response: NextResponse, session: DemoSession) {
  response.cookies.set(sessionCookieName(), session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: session.expiresAt,
  });
}
