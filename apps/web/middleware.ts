import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { controlPlaneUiRedirect } from "./lib/control-plane-middleware";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const controlPlaneRedirect = controlPlaneUiRedirect(request);
  if (controlPlaneRedirect) {
    return controlPlaneRedirect;
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ["/", "/(es|en)/:path*", "/((?!api|mcp|public|_next|_vercel|.*\\..*).*)"],
};
