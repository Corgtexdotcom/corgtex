import * as Sentry from "@sentry/nextjs";
import { captureErrorTelemetry } from "@corgtex/shared/telemetry";

const AUTHORIZATION_CONTEXT_REQUIRED = "AUTHORIZATION_CONTEXT_REQUIRED";
const PLATFORM_IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,199}$/i;
type HeaderPresence = boolean | "unknown";

function telemetrySurface(routeType: string | undefined) {
  if (routeType === "render") return "render";
  if (routeType === "action") return "server_action";
  return "route";
}

function pathnameCategory(path: unknown) {
  if (typeof path !== "string") return "other";
  const pathname = path.split("?", 1)[0];
  if (pathname === "/") return "root";
  if (/^\/(?:en|es)\/?$/.test(pathname)) return "known_locale";
  return "other";
}

function headerPresence(headers: unknown, name: string): HeaderPresence {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "unknown";

  if ("has" in headers && typeof headers.has === "function") {
    return headers.has(name);
  }

  return Object.keys(headers).some((key) => key.toLowerCase() === name);
}

function platformIdentifier(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && PLATFORM_IDENTIFIER.test(normalized) ? normalized : undefined;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

export function authorizationContextTelemetryAttributes(
  request: { path?: string; headers?: unknown } | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const headers = request?.headers;
  return {
    request_path_category: pathnameCategory(request?.path),
    request_rsc_header_present: headerPresence(headers, "rsc"),
    request_next_action_header_present: headerPresence(headers, "next-action"),
    request_middleware_subrequest_header_present: headerPresence(headers, "x-middleware-subrequest"),
    container_app_revision: platformIdentifier(env.CONTAINER_APP_REVISION),
    container_app_replica_name: platformIdentifier(env.CONTAINER_APP_REPLICA_NAME),
  };
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

export const onRequestError = async (error: unknown, request: unknown, context: unknown) => {
  Sentry.captureRequestError(
    error as Parameters<typeof Sentry.captureRequestError>[0],
    request as Parameters<typeof Sentry.captureRequestError>[1],
    context as Parameters<typeof Sentry.captureRequestError>[2],
  );

  const requestLike = request as { path?: string; method?: string; headers?: unknown; url?: string } | undefined;
  const contextLike = context as { routePath?: string; routeType?: string; routerKind?: string } | undefined;
  const authorizationContextRequired = errorCode(error) === AUTHORIZATION_CONTEXT_REQUIRED;
  const capture = process.env.NEXT_RUNTIME === "nodejs"
    ? (await import("@corgtex/shared/telemetry-node")).captureErrorTelemetry
    : captureErrorTelemetry;
  void capture({
    attributes: {
      next_route_type: contextLike?.routeType,
      router_kind: contextLike?.routerKind,
      ...(authorizationContextRequired
        ? authorizationContextTelemetryAttributes(requestLike)
        : {}),
    },
    digest: error && typeof error === "object" && "digest" in error && typeof (error as { digest?: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : null,
    error,
    method: requestLike?.method,
    route: authorizationContextRequired
      ? contextLike?.routePath
      : contextLike?.routePath ?? requestLike?.path ?? requestLike?.url,
    status: 500,
    surface: telemetrySurface(contextLike?.routeType),
  });
};
