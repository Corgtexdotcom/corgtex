import { loginUserWithPassword, listActorWorkspaces } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { NextResponse } from "next/server";

const DEMO_EMAIL = "demo@jnj-demo.corgtex.app";
const DEMO_PASSWORD = "demo1234";
const DEMO_WORKSPACE_SLUG = "jnj-demo";

type DemoSession = {
  expiresAt: Date;
  token: string;
  workspaceId: string;
};

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

export function demoWorkspacePath(workspaceId: string) {
  return `/workspaces/${workspaceId}`;
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
