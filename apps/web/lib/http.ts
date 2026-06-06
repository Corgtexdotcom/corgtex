import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AppError } from "@corgtex/domain";
import { isDatabaseUnavailableError } from "@corgtex/shared";
import { z } from "zod";
import { capturePostHogEvent } from "@/lib/posthog-server";

type RouteErrorTelemetryContext = {
  actorKind?: string;
  request?: Request | NextRequest;
  surface?: string;
  workspaceId?: string;
};

type RouteErrorInfo = {
  code: string;
  message: string;
  status: number;
};

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );
}

export function serviceUnavailableResponse(
  code = "SERVICE_UNAVAILABLE",
  message = "Service is temporarily unavailable. Try again.",
) {
  return errorResponse(503, code, message);
}

function routeErrorInfo(error: unknown): RouteErrorInfo {
  if (error instanceof AppError) {
    return { status: error.status, code: error.code, message: error.message };
  }

  if (error instanceof Error) {
    const routeError = error as Error & { status?: unknown; code?: unknown };
    const status = routeError.status;
    const code = routeError.code;
    if (typeof status === "number" && typeof code === "string" && status >= 400 && status < 600) {
      return { status, code, message: error.message };
    }
  }

  if (isDatabaseUnavailableError(error)) {
    return { status: 503, code: "SERVICE_UNAVAILABLE", message: "Service is temporarily unavailable. Try again." };
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error." };
}

function shouldCaptureRouteError(info: RouteErrorInfo) {
  return info.status >= 500 || info.status === 400 || info.status === 401 || info.status === 403 || info.status === 429;
}

function sanitizedRequestPath(request: Request | NextRequest | undefined) {
  if (!request) return undefined;

  try {
    const pathname = new URL(request.url).pathname;
    const parts = pathname.split("/");
    return parts
      .map((part, index) => {
        if (!part) return part;
        if (parts[index - 1] === "workspaces") return ":workspaceId";
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(part)) return ":id";
        if (/^[A-Za-z0-9_-]{24,}$/.test(part)) return ":id";
        return part.slice(0, 80);
      })
      .join("/");
  } catch {
    return undefined;
  }
}

function requestMethod(request: Request | NextRequest | undefined) {
  return request?.method?.toUpperCase();
}

function captureRouteError(error: unknown, info: RouteErrorInfo, context: RouteErrorTelemetryContext = {}) {
  if (!shouldCaptureRouteError(info)) return;

  const route = sanitizedRequestPath(context.request);
  const method = requestMethod(context.request);

  void capturePostHogEvent({
    event: "corgtex_app_route_error",
    distinctId: context.workspaceId ? `workspace:${context.workspaceId}` : `route:${method ?? "UNKNOWN"}:${route ?? "unknown"}`,
    properties: {
      actor_kind: context.actorKind,
      code: info.code,
      error_class: error instanceof Error ? error.name : typeof error,
      method,
      route,
      status: info.status,
      surface: context.surface ?? "api",
      transient: info.status >= 500,
      workspace_id: context.workspaceId,
    },
    processPersonProfile: false,
  });
}

export function handleRouteError(error: unknown, context: RouteErrorTelemetryContext = {}) {
  const info = routeErrorInfo(error);
  captureRouteError(error, info, context);

  if (isDatabaseUnavailableError(error)) {
    console.error("Route failed because the database is unavailable.", error);
    return serviceUnavailableResponse();
  }

  if (info.status === 500 && info.code === "INTERNAL_ERROR") {
    console.error(error);
  }

  return errorResponse(info.status, info.code, info.message);
}

export async function validateBody<T>(req: NextRequest, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new AppError(400, "VALIDATION_ERROR", details || "Request body failed validation.");
  }

  return parsed.data;
}
