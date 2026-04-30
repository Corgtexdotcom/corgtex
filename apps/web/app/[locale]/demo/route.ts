import { NextRequest } from "next/server";
import { createDemoRedirectResponse, normalizeDemoLocale } from "@/lib/demo-session";
import { handleRouteError } from "@/lib/http";
import { rateLimitAuth } from "@/lib/rate-limit-middleware";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ locale: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const rateLimited = await rateLimitAuth(request);
  if (rateLimited) return rateLimited;

  try {
    const { locale } = await context.params;
    return await createDemoRedirectResponse(request, normalizeDemoLocale(locale));
  } catch (error) {
    return handleRouteError(error);
  }
}
