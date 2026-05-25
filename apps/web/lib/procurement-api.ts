import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError } from "@corgtex/domain";
import { checkRateLimit, RATE_LIMITS } from "@corgtex/shared";
import { z } from "zod";

export const createTrialSchema = z.object({
  companyName: z.string().trim().min(1).max(180),
  adminEmail: z.string().email(),
  adminName: z.string().trim().min(1).max(160).optional(),
  billingContactEmail: z.string().email().optional(),
  acceptedTermsVersion: z.string().trim().min(1).max(80),
  sourceAgent: z.record(z.string(), z.unknown()).optional(),
});

export function requiredIdempotencyKey(request: NextRequest) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.");
  }
  return idempotencyKey;
}

type HeaderReader = Pick<Headers, "get">;

function clientIp(headers: HeaderReader): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown"
  );
}

function normalizeKeyPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function emailDomain(email: string) {
  return normalizeKeyPart(email.split("@")[1] ?? "unknown");
}

function rateLimitResponse(message: string, resetAtMs: number) {
  return NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED",
        message,
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000))),
      },
    },
  );
}

async function enforceRateLimit(key: string, limit: typeof RATE_LIMITS[keyof typeof RATE_LIMITS], message: string) {
  const result = await checkRateLimit(key, limit);
  if (!result.allowed) {
    return rateLimitResponse(message, result.resetAtMs);
  }
  return null;
}

export async function rateLimitProcurementTrialCreateForHeaders(headers: HeaderReader, params: {
  adminEmail: string;
  companyName: string;
}) {
  const ip = clientIp(headers);
  const companyKey = normalizeKeyPart(params.companyName);
  const domainKey = emailDomain(params.adminEmail);

  return (
    await enforceRateLimit(`ip:${ip}:procurement-trial`, RATE_LIMITS.PROCUREMENT_TRIAL_PER_IP, "Too many trial requests from this network.") ??
    await enforceRateLimit(`email:${normalizeKeyPart(params.adminEmail)}:procurement-trial`, RATE_LIMITS.PROCUREMENT_TRIAL_PER_EMAIL, "Too many trial requests for this admin email.") ??
    await enforceRateLimit(`company:${companyKey}:procurement-trial`, RATE_LIMITS.PROCUREMENT_TRIAL_PER_COMPANY, "Too many trial requests for this company.") ??
    await enforceRateLimit(`domain:${domainKey}:procurement-trial`, RATE_LIMITS.PROCUREMENT_TRIAL_PER_DOMAIN, "Too many trial requests for this email domain.")
  );
}

export async function rateLimitProcurementTrialCreate(request: NextRequest, params: {
  adminEmail: string;
  companyName: string;
}) {
  return rateLimitProcurementTrialCreateForHeaders(request.headers, params);
}
