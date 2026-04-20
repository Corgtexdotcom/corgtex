import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";
import { demoWorkspacePath, issueDemoSession, setDemoSessionCookie } from "@/lib/demo-session";

export async function POST(request: NextRequest) {
  // We rate limit this similarly to regular auth
  const rateLimited = rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const session = await issueDemoSession();

    const response = NextResponse.json({
      success: true,
      redirectPath: demoWorkspacePath(session.workspaceId),
      workspaceId: session.workspaceId,
    });
    setDemoSessionCookie(response, session);

    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
