import * as Sentry from "@sentry/nextjs";
import { captureErrorTelemetry } from "@corgtex/shared/telemetry";

function telemetrySurface(routeType: string | undefined) {
  if (routeType === "render") return "render";
  if (routeType === "action") return "server_action";
  return "route";
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.0,
      debug: false,
    });
  }
}

export const onRequestError = (error: unknown, request: unknown, context: unknown) => {
  Sentry.captureRequestError(
    error as Parameters<typeof Sentry.captureRequestError>[0],
    request as Parameters<typeof Sentry.captureRequestError>[1],
    context as Parameters<typeof Sentry.captureRequestError>[2],
  );

  const requestLike = request as { path?: string; method?: string; url?: string } | undefined;
  const contextLike = context as { routePath?: string; routeType?: string; routerKind?: string } | undefined;
  void captureErrorTelemetry({
    attributes: {
      next_route_type: contextLike?.routeType,
      router_kind: contextLike?.routerKind,
    },
    digest: error && typeof error === "object" && "digest" in error && typeof (error as { digest?: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : null,
    error,
    method: requestLike?.method,
    route: contextLike?.routePath ?? requestLike?.path ?? requestLike?.url,
    status: 500,
    surface: telemetrySurface(contextLike?.routeType),
  });
};
