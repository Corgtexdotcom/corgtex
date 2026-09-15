import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { controlPlaneUiRedirect } from "./lib/control-plane-middleware";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  // Overwrite caller-supplied values before forwarding them to server components.
  request.headers.set("x-corgtex-pathname", request.nextUrl.pathname);
  if (request.nextUrl.pathname.startsWith("/api/") || request.nextUrl.pathname.startsWith("/support/sessions/")) {
    return NextResponse.next({ request: { headers: request.headers } });
  }
  const controlPlaneRedirect = controlPlaneUiRedirect(request);
  if (controlPlaneRedirect) {
    return controlPlaneRedirect;
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ["/", "/api/:path*", "/(es|en)/:path*", "/((?!api|mcp|public|_next|_vercel|.*\\..*).*)"],
};
