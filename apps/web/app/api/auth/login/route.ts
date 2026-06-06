import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { isDatabaseUnavailableError, sessionCookieName } from "@corgtex/shared";
import { handleRouteError, serviceUnavailableResponse, validateBody } from "@/lib/http";
import { capturePostHogEvent } from "@/lib/posthog-server";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(8),
});

function loginAttemptId(email: string) {
  return `login:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 20)}`;
}

function errorStatus(error: unknown) {
  if (error instanceof Error) {
    const candidate = error as Error & { status?: unknown };
    return typeof candidate.status === "number" ? candidate.status : 500;
  }
  return 500;
}

function errorCode(error: unknown) {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    return typeof candidate.code === "string" ? candidate.code : error.name;
  }
  return typeof error;
}

export async function POST(request: NextRequest) {
  // Rate limit auth attempts
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) {
    await capturePostHogEvent({
      event: "corgtex_auth_login_rate_limited",
      distinctId: "login:rate-limited",
      properties: {
        method: "password",
        status: 429,
        surface: "auth",
      },
      processPersonProfile: false,
    });
    return rateLimited;
  }

  let attemptDistinctId = "login:unknown";
  try {
    const body = await validateBody(request, loginSchema);
    attemptDistinctId = loginAttemptId(body.email);
    const result = await loginUserWithPassword({
      email: body.email,
      password: body.password,
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null,
      userAgent: request.headers.get("user-agent") || null,
    });

    const actor = {
      kind: "user" as const,
      user: result.user,
    };
    const workspaces = await listActorWorkspaces(actor);

    const response = NextResponse.json({
      user: result.user,
      workspaces,
    });
    response.cookies.set(sessionCookieName(), result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: result.expiresAt,
    });
    await capturePostHogEvent({
      event: "corgtex_auth_login_succeeded",
      distinctId: `user:${result.user.id}`,
      properties: {
        method: "password",
        status: 200,
        surface: "auth",
        workspace_count: workspaces.length,
      },
      processPersonProfile: false,
    });
    return response;
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      await capturePostHogEvent({
        event: "corgtex_auth_login_failed",
        distinctId: attemptDistinctId,
        properties: {
          code: "LOGIN_UNAVAILABLE",
          method: "password",
          status: 503,
          surface: "auth",
          transient: true,
        },
        processPersonProfile: false,
      });
      return serviceUnavailableResponse("LOGIN_UNAVAILABLE", "Login is temporarily unavailable. Try again.");
    }

    await capturePostHogEvent({
      event: "corgtex_auth_login_failed",
      distinctId: attemptDistinctId,
      properties: {
        code: errorCode(error),
        method: "password",
        status: errorStatus(error),
        surface: "auth",
        transient: errorStatus(error) >= 500,
      },
      processPersonProfile: false,
    });
    return handleRouteError(error, { request, surface: "auth" });
  }
}
