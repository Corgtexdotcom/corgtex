import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { AppError } from "@corgtex/domain";
import { checkRateLimit, RATE_LIMITS } from "@corgtex/shared";
import { z } from "zod";

const employeeRoleSchema = z.enum(["CONTRIBUTOR", "FACILITATOR", "FINANCE_STEWARD"]);

export const employeeInviteSchema = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1).max(160).optional(),
  role: employeeRoleSchema.optional(),
});

export const createWorkspaceSchema = z.object({
  companyName: z.string().trim().min(1).max(180),
  slug: z.string().trim().min(1).max(80).optional(),
  adminEmail: z.string().email(),
  adminName: z.string().trim().min(1).max(160).optional(),
  employees: z.array(employeeInviteSchema).max(50).optional(),
  billingContactEmail: z.string().email(),
  acceptedTermsVersion: z.string().trim().min(1).max(80),
  sourceAgent: z.record(z.string(), z.unknown()).optional(),
  planLabel: z.string().trim().min(1).max(80).optional(),
});

export const bulkInviteSchema = z.object({
  members: z.array(employeeInviteSchema).min(1).max(50),
});

export function requiredIdempotencyKey(request: NextRequest) {
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required.");
  }
  return idempotencyKey;
}

export function requiredSetupSessionToken(request: NextRequest) {
  const authorization = request.headers.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice("bearer ".length).trim();
    if (token) {
      return token;
    }
  }

  const headerToken = request.headers.get("x-setup-session-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  throw new AppError(401, "UNAUTHENTICATED", "Setup session token is required.");
}

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
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

export async function rateLimitProcurementWorkspaceCreate(request: NextRequest, params: {
  adminEmail: string;
  companyName: string;
  slug?: string | null;
}) {
  const ip = clientIp(request);
  const companyKey = normalizeKeyPart(params.slug || params.companyName);
  const domainKey = emailDomain(params.adminEmail);

  return (
    await enforceRateLimit(`ip:${ip}:procurement-setup`, RATE_LIMITS.PROCUREMENT_SETUP_PER_IP, "Too many self-serve setup requests from this network.") ??
    await enforceRateLimit(`email:${normalizeKeyPart(params.adminEmail)}:procurement-setup`, RATE_LIMITS.PROCUREMENT_SETUP_PER_EMAIL, "Too many self-serve setup requests for this admin email.") ??
    await enforceRateLimit(`company:${companyKey}:procurement-setup`, RATE_LIMITS.PROCUREMENT_SETUP_PER_COMPANY, "Too many self-serve setup requests for this company.") ??
    await enforceRateLimit(`domain:${domainKey}:procurement-setup`, RATE_LIMITS.PROCUREMENT_SETUP_PER_COMPANY, "Too many self-serve setup requests for this email domain.")
  );
}

export async function rateLimitProcurementBulkInvite(sessionId: string) {
  return enforceRateLimit(
    `setup-session:${sessionId}:procurement-bulk-invite`,
    RATE_LIMITS.PROCUREMENT_SETUP_INVITES_PER_SESSION,
    "Too many bulk invite requests for this setup session.",
  );
}
