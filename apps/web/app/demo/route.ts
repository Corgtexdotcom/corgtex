import { NextRequest, NextResponse } from "next/server";
import { demoWorkspacePath, issueDemoSession, setDemoSessionCookie } from "@/lib/demo-session";
import { handleRouteError } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

function getRequestHeaderValue(request: NextRequest, headerName: string) {
  const value = request.headers.get(headerName)?.split(",")[0]?.trim();
  return value || null;
}

export async function GET(request: NextRequest) {
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const session = await issueDemoSession();
    const requestUrl = new URL(request.url);
    const host =
      getRequestHeaderValue(request, "x-forwarded-host") ||
      getRequestHeaderValue(request, "host") ||
      requestUrl.host;
    const protocol =
      getRequestHeaderValue(request, "x-forwarded-proto") ||
      requestUrl.protocol.replace(/:$/, "");
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      `${protocol}://${host}`;
    const response = NextResponse.redirect(new URL(demoWorkspacePath(session.workspaceId), baseUrl));
    setDemoSessionCookie(response, session);
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
