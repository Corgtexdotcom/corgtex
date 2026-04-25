import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listActorWorkspaces, loginUserWithPassword } from "@corgtex/domain";
import { isDatabaseUnavailableError, sessionCookieName } from "@corgtex/shared";
import { handleRouteError, serviceUnavailableResponse, validateBody } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(8),
});

export async function POST(request: NextRequest) {
  // Rate limit auth attempts
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const body = await validateBody(request, loginSchema);
    const result = await loginUserWithPassword({
      email: body.email,
      password: body.password,
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
