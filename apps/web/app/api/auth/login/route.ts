import { NextRequest, NextResponse } from "next/server";
import { listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { isDatabaseUnavailableError, sessionCookieName } from "@corgtex/shared";
import { handleRouteError, serviceUnavailableResponse } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export async function POST(request: NextRequest) {
  // Rate limit auth attempts
  const rateLimited = rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    const result = await loginUserWithPassword({
      email: String(body.email ?? ""),
      password: String(body.password ?? ""),
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
    return response;
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      return serviceUnavailableResponse("LOGIN_UNAVAILABLE", "Login is temporarily unavailable. Try again.");
    }

    return handleRouteError(error);
  }
}
