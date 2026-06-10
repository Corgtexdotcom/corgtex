import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  AppError,
  buildSelfServeRegistrySyncPayload,
  recordSelfServeRegistrySync,
  verifySelfServeRegistrySyncSignature,
} from "@corgtex/domain";
import type { AppActor } from "@corgtex/shared";
import { env } from "@corgtex/shared";
import { handleRouteError } from "@/lib/http";

export const dynamic = "force-dynamic";

const registrySyncPayloadSchema = z.object({
  schemaVersion: z.literal("self-serve-registry-sync-v1"),
  sourceId: z.string().trim().min(1).max(128),
  sourceUrl: z.string().trim().url(),
  sourceDeploymentId: z.string().trim().min(1).nullable().optional(),
  generatedAt: z.string().datetime(),
  summary: z.record(z.string(), z.unknown()),
  items: z.array(z.record(z.string(), z.unknown())).max(250),
}).strict();

const internalActor: AppActor = {
  kind: "agent",
  authProvider: "control-plane",
  label: "self-serve-registry-sync",
  scopes: ["control-plane:read"],
};

function syncSecret() {
  const secret = env.SELF_SERVE_REGISTRY_SYNC_SECRET;
  if (!secret) {
    throw new AppError(503, "REGISTRY_SYNC_NOT_CONFIGURED", "Self-serve registry sync is not configured.");
  }
  return secret;
}

function bearerSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : null;
}

function assertBearer(request: NextRequest) {
  if (bearerSecret(request) !== syncSecret()) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid registry sync bearer token.");
  }
}

function numberParam(value: string | null) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function GET(request: NextRequest) {
  try {
    assertBearer(request);
    const url = new URL(request.url);
    const payload = await buildSelfServeRegistrySyncPayload(internalActor, {
      take: numberParam(url.searchParams.get("take")),
      status: url.searchParams.get("status"),
      sourceId: url.searchParams.get("sourceId"),
      sourceUrl: url.searchParams.get("sourceUrl") ?? env.APP_URL,
      sourceDeploymentId: url.searchParams.get("sourceDeploymentId"),
    });
    return NextResponse.json(payload);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const bodyText = await request.text();
    verifySelfServeRegistrySyncSignature({
      secret: syncSecret(),
      timestamp: request.headers.get("x-corgtex-registry-sync-timestamp"),
      signature: request.headers.get("x-corgtex-registry-sync-signature"),
      body: bodyText,
    });
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      throw new AppError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }
    const parsed = registrySyncPayloadSchema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Registry sync payload is invalid.");
    }
    const payload = parsed.data;
    const result = await recordSelfServeRegistrySync(payload);
    return NextResponse.json({ result }, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
