import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

// /ai-readiness was merged into /how-we-work. Permanently redirect the old
// route (and its locale-prefixed variants) so existing links and SEO survive.
const AI_READINESS_REDIRECT = /^\/(?:(en|es)\/)?ai-readiness\/?$/;

export default function middleware(request: NextRequest) {
  const match = request.nextUrl.pathname.match(AI_READINESS_REDIRECT);
  if (match) {
    const locale = match[1];
    const url = request.nextUrl.clone();
    url.pathname = locale ? `/${locale}/how-we-work` : "/how-we-work";
    return NextResponse.redirect(url, 308);
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ["/", "/(es|en)/:path*", "/((?!api|_next|_vercel|.*\\..*).*)"],
};
