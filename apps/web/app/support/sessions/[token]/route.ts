import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { consumeSelfServeSupportSession } from "@corgtex/domain";
import { sessionCookieName } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

function clientIp(request: NextRequest) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function confirmationHtml(action: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>Corgtex Support Session</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #080b12; color: #f8fafc; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(420px, calc(100vw - 32px)); border: 1px solid #263244; border-radius: 10px; background: #111827; padding: 24px; box-shadow: 0 24px 80px rgba(0, 0, 0, 0.4); }
      h1 { margin: 0 0 8px; font-size: 20px; line-height: 1.2; }
      p { margin: 0 0 18px; color: #cbd5e1; font-size: 14px; line-height: 1.5; }
      button { width: 100%; height: 42px; border: 0; border-radius: 8px; background: #38bdf8; color: #03131f; font-weight: 700; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>Open support session</h1>
      <p>This one-time link creates an audited Corgtex support login for the selected workspace.</p>
      <form method="post" action="${escapeHtml(action)}">
        <button type="submit">Open support session</button>
      </form>
    </main>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  return new NextResponse(confirmationHtml(request.nextUrl.pathname), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await props.params;
    const consumed = await consumeSelfServeSupportSession({
      token,
      ipAddress: clientIp(request),
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
