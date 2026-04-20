import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRateLimit, RATE_LIMITS } from "@corgtex/shared";

export function rateLimitWebhookIngest(request: NextRequest, workspaceId: string): NextResponse | null {
  const key = `ws:${workspaceId}:webhook-ingest`;
  const result = checkRateLimit(key, RATE_LIMITS.WEBHOOK_INGEST_PER_WORKSPACE);

  if (!result.allowed) {
    return NextResponse.json(
      { error: "Webhook ingestion rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((result.resetAtMs - Date.now()) / 1000)),
        },
      },
    );
  }

  return null;
}

export function rateLimitAuth(request: NextRequest): NextResponse | null {
  const key = `ip:${clientIp(request)}:auth`;
  const result = checkRateLimit(key, RATE_LIMITS.AUTH_PER_IP);

  if (!result.allowed) {
    return NextResponse.json(
      { error: "Too many authentication attempts" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((result.resetAtMs - Date.now()) / 1000)),
        },
      },
    );
  }

  return null;
}

export function rateLimitPasswordReset(request: NextRequest, email: string): NextResponse | null {
  const ip = clientIp(request);

  const ipResult = checkRateLimit(`ip:${ip}:password-reset`, RATE_LIMITS.PASSWORD_RESET_PER_IP);
  if (!ipResult.allowed) {
    return NextResponse.json(
      { error: "Too many password reset requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((ipResult.resetAtMs - Date.now()) / 1000)),
        },
      },
    );
  }

  const emailResult = checkRateLimit(`email:${email}:password-reset`, RATE_LIMITS.PASSWORD_RESET_PER_EMAIL);
  if (!emailResult.allowed) {
    return NextResponse.json(
      { error: "Too many password reset requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((emailResult.resetAtMs - Date.now()) / 1000)),
        },
      },
    );
  }

  return null;
}

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}
