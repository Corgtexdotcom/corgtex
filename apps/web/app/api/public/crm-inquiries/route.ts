import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AppError, captureCrmInquiry, CRM_INQUIRY_PERSONAS } from "@corgtex/domain";
import { checkRateLimit } from "@corgtex/shared";
import { z } from "zod";
import { handleRouteError, validateBody } from "@/lib/http";

export const dynamic = "force-dynamic";

const CORPORATE_REBELS_BROWSER_ORIGINS = new Set([
  "https://us.corporate-rebels.com",
  "https://www.us.corporate-rebels.com",
]);
const LOCAL_BROWSER_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const CRM_INQUIRY_RATE_LIMIT = { windowMs: 60_000, limit: 10, failClosed: true } as const;
const DEFAULT_CRM_WORKSPACE_SLUG = ["cr", "ina"].join("");
const DEFAULT_CRM_HOST = `${DEFAULT_CRM_WORKSPACE_SLUG}.corgtex.com`;
const CORGTEX_PUBLIC_HOST_PATTERN = /(^|\.)corgtex\.com$/;

const optionalText = (max = 500) => z.string().trim().min(1).max(max).optional();
const crmInquirySchema = z.object({
  source: z.string().trim().min(1).max(64),
  sourceExternalId: z.string().trim().min(1).max(200),
  persona: z.enum(CRM_INQUIRY_PERSONAS),
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(320),
  phone: optionalText(80),
  company: optionalText(180),
  website: optionalText(500),
  title: optionalText(160),
  location: optionalText(160),
  message: optionalText(5000),
  answers: z.record(z.string(), z.unknown()).optional(),
  sourceUrl: optionalText(1000),
  referrerUrl: optionalText(1000),
  utmSource: optionalText(160),
  utmMedium: optionalText(160),
  utmCampaign: optionalText(240),
  utmTerm: optionalText(240),
  utmContent: optionalText(240),
  utmId: optionalText(160),
  consentToContact: z.boolean(),
  honeypot: z.string().optional(),
});

function normalizeOrigin(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeHostname(value: string | null) {
  if (!value) return null;
  const firstValue = value.split(",")[0]?.trim();
  if (!firstValue) return null;
  try {
    return new URL(firstValue.includes("://") ? firstValue : `https://${firstValue}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function presentHostname(value: string | null): value is string {
  return Boolean(value);
}

function isDefaultCrmDeploymentRequest(request: NextRequest) {
  const directHostnames = [
    normalizeHostname(request.headers.get("host")),
    normalizeHostname(request.url),
  ].filter(presentHostname);
  const publicDirectHostnames = directHostnames.filter((hostname) => CORGTEX_PUBLIC_HOST_PATTERN.test(hostname));
  if (publicDirectHostnames.length > 0) {
    return publicDirectHostnames.some((hostname) => hostname === DEFAULT_CRM_HOST);
  }

  const proxyHostnames = [
    normalizeHostname(request.headers.get("x-forwarded-host")),
    normalizeHostname(request.headers.get("x-original-host")),
  ].filter(presentHostname);
  return [...directHostnames, ...proxyHostnames].some((hostname) => hostname === DEFAULT_CRM_HOST);
}

function isAllowedBrowserOrigin(origin: string, request: NextRequest) {
  if (LOCAL_BROWSER_ORIGIN_PATTERN.test(origin)) return true;
  if (CORPORATE_REBELS_BROWSER_ORIGINS.has(origin)) return isDefaultCrmDeploymentRequest(request);
  return false;
}

function allowedOriginForRequest(request: NextRequest) {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return null;
  if (!isAllowedBrowserOrigin(origin, request)) {
    throw new AppError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed.");
  }
  return origin;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function withCors(response: NextResponse, origin: string | null) {
  if (!origin) return response;
  const headers = corsHeaders(origin);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

function clientIp(request: NextRequest) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "unknown"
  );
}

async function rateLimitCrmInquiry(request: NextRequest) {
  const result = await checkRateLimit(`ip:${clientIp(request)}:crm-inquiry`, CRM_INQUIRY_RATE_LIMIT);
  if (result.allowed) return null;
  return NextResponse.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many CRM inquiry requests from this network.",
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000))),
      },
    },
  );
}

export async function OPTIONS(request: NextRequest) {
  try {
    const origin = allowedOriginForRequest(request);
    return withCors(new NextResponse(null, { status: 204 }), origin);
  } catch (error) {
    return handleRouteError(error, { request, surface: "crm-inquiries" });
  }
}

export async function POST(request: NextRequest) {
  let origin: string | null = null;
  try {
    origin = allowedOriginForRequest(request);
    const body = await validateBody(request, crmInquirySchema);
    if (body.honeypot?.trim()) {
      throw new AppError(400, "HONEYPOT_REJECTED", "Inquiry was rejected.");
    }

    const rateLimited = await rateLimitCrmInquiry(request);
    if (rateLimited) return withCors(rateLimited, origin);

    const result = await captureCrmInquiry({
      workspaceSlug: process.env.WORKSPACE_SLUG || DEFAULT_CRM_WORKSPACE_SLUG,
      source: body.source,
      sourceExternalId: body.sourceExternalId,
      persona: body.persona,
      name: body.name,
      email: body.email,
      phone: body.phone,
      company: body.company,
      website: body.website,
      title: body.title,
      location: body.location,
      message: body.message,
      answers: body.answers,
      sourceUrl: body.sourceUrl,
      referrerUrl: body.referrerUrl,
      utmSource: body.utmSource,
      utmMedium: body.utmMedium,
      utmCampaign: body.utmCampaign,
      utmTerm: body.utmTerm,
      utmContent: body.utmContent,
      utmId: body.utmId,
      consentToContact: body.consentToContact,
    });

    return withCors(NextResponse.json({
      ok: true,
      duplicate: result.duplicate,
      submissionId: result.submissionId,
    }), origin);
  } catch (error) {
    return withCors(handleRouteError(error, { request, surface: "crm-inquiries" }), origin);
  }
}
