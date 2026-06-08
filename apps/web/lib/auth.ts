import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { clearSession, isGlobalOperator, resolveAgentActorFromBearer, resolveControlPlaneAgentFromBearer, resolveSessionActor } from "@corgtex/domain";
import { env, isDatabaseUnavailableError, sessionCookieName } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError } from "@corgtex/domain";

const SESSION_UNAVAILABLE_REDIRECT = "/login?error=session-unavailable";
const SESSION_RESOLUTION_TIMEOUT_MS = 15_000;

function sessionUnavailableError() {
  return new AppError(503, "SESSION_UNAVAILABLE", "Session is temporarily unavailable. Try again.");
}

function isSessionUnavailableError(error: unknown) {
  return isDatabaseUnavailableError(error) || (error instanceof AppError && error.code === "SESSION_UNAVAILABLE");
}

function rethrowIfSessionUnavailable(error: unknown) {
  if (isSessionUnavailableError(error)) {
    throw sessionUnavailableError();
  }
}

function withSessionResolutionTimeout<T>(operation: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(sessionUnavailableError());
    }, SESSION_RESOLUTION_TIMEOUT_MS);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function assertAllowedInControlPlaneMode(actor: AppActor) {
  if (env.CONTROL_PLANE_MODE && !isGlobalOperator(actor)) {
    throw new AppError(403, "CONTROL_PLANE_ONLY", "This deployment is restricted to platform operators.");
  }
}

export async function resolveRequestActor(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    let agentActor;
    try {
      agentActor = await withSessionResolutionTimeout(resolveAgentActorFromBearer(bearer));
    } catch (error) {
      rethrowIfSessionUnavailable(error);
      throw error;
    }

    if (agentActor) {
      assertAllowedInControlPlaneMode(agentActor);
      return agentActor;
    }
  }

  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token) {
    throw new AppError(401, "UNAUTHENTICATED", "Missing session.");
  }

  let actor;
  try {
    actor = await withSessionResolutionTimeout(resolveSessionActor(token));
  } catch (error) {
    rethrowIfSessionUnavailable(error);
    throw error;
  }

  if (!actor) {
    throw new AppError(401, "UNAUTHENTICATED", "Session expired.");
  }

  assertAllowedInControlPlaneMode(actor);
  return actor;
}

export async function resolveControlPlaneRequestActor(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    let agentActor;
    try {
      agentActor = await withSessionResolutionTimeout(resolveControlPlaneAgentFromBearer(bearer));
    } catch (error) {
      rethrowIfSessionUnavailable(error);
      throw error;
    }
    if (agentActor) {
      return agentActor;
    }
  }

  return resolveRequestActor(request);
}

export async function requirePageActor() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName())?.value;
  if (!token) {
    redirect("/login");
  }

  let actor;
  try {
    actor = await withSessionResolutionTimeout(resolveSessionActor(token));
  } catch (error) {
    if (isSessionUnavailableError(error)) {
      redirect(SESSION_UNAVAILABLE_REDIRECT);
    }
    throw error;
  }

  if (!actor) {
    redirect("/login");
  }

  if (env.CONTROL_PLANE_MODE && !isGlobalOperator(actor)) {
    redirect("/login?error=control-plane-only");
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
