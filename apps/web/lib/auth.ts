import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { clearSession, resolveAgentActorFromBearer, resolveSessionActor } from "@corgtex/domain";
import { isDatabaseUnavailableError, sessionCookieName } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";

const SESSION_UNAVAILABLE_REDIRECT = "/login?error=session-unavailable";

function sessionUnavailableError() {
  return new AppError(503, "SESSION_UNAVAILABLE", "Session is temporarily unavailable. Try again.");
}

function rethrowIfSessionUnavailable(error: unknown) {
  if (isDatabaseUnavailableError(error)) {
    throw sessionUnavailableError();
  }
}

export async function resolveRequestActor(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    let agentActor;
    try {
      agentActor = await resolveAgentActorFromBearer(bearer);
    } catch (error) {
      rethrowIfSessionUnavailable(error);
      throw error;
    }

    if (agentActor) {
      return agentActor;
    }
  }

  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token) {
    throw new AppError(401, "UNAUTHENTICATED", "Missing session.");
  }

  let actor;
  try {
    actor = await resolveSessionActor(token);
  } catch (error) {
    rethrowIfSessionUnavailable(error);
    throw error;
  }

  if (!actor) {
    throw new AppError(401, "UNAUTHENTICATED", "Session expired.");
  }

  return actor;
}

export async function requirePageActor() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await resolveSessionActor(token);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      redirect(SESSION_UNAVAILABLE_REDIRECT);
    }
    throw error;
  }

  if (!actor) {
    redirect("/login");
  }

  return actor;
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function logoutAction() {
  "use server";

  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (token) {
    await clearSession(token);
  }
  cookieStore.delete(sessionCookieName());
  redirect("/login");
}
