import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { consumeSelfServeSupportSession } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await props.params;
    const consumed = await consumeSelfServeSupportSession({
      token,
      ipAddress: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    });
    const response = NextResponse.redirect(new URL(`/workspaces/${consumed.workspaceId}`, request.url));
    response.cookies.set(sessionCookieName(), consumed.session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      expires: consumed.session.expiresAt,
    });
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
