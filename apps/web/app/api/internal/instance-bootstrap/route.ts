import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { AppError } from "@corgtex/domain";
import { prisma } from "@corgtex/shared";

import { handleRouteError } from "@/lib/http";

import { runStableClientSeed } from "./bootstrap-runner";

export const dynamic = "force-dynamic";

const bootstrapRequestSchema = z.object({
  customerSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  bundleUri: z.string().url(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  schemaVersion: z.string().min(1).max(64),
  expiresAt: z.string().datetime(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/i),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
});

type BootstrapRequestBody = z.infer<typeof bootstrapRequestSchema>;

const seedBundleSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string()).optional(),
});

function configuredBootstrapTokenHash() {
  const configuredHash = process.env.CORGTEX_INSTANCE_BOOTSTRAP_TOKEN_HASH?.trim()
    || process.env.CORGTTEX_INSTANCE_BOOTSTRAP_TOKEN_HASH?.trim();
  if (configuredHash && /^[a-f0-9]{64}$/i.test(configuredHash)) {
    return configuredHash.toLowerCase();
  }

  const legacyRawToken = process.env.CORGTEX_INSTANCE_BOOTSTRAP_TOKEN?.trim()
    || process.env.CORGTTEX_INSTANCE_BOOTSTRAP_TOKEN?.trim();
  return legacyRawToken ? sha256Hex(legacyRawToken) : null;
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacSha256Hex(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqualHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function bootstrapSignaturePayload(body: BootstrapRequestBody) {
  return JSON.stringify({
    customerSlug: body.customerSlug,
    bundleUri: body.bundleUri,
    checksum: body.checksum.toLowerCase(),
    schemaVersion: body.schemaVersion,
    expiresAt: body.expiresAt,
    tokenHash: body.tokenHash.toLowerCase(),
  });
}

function authorizeBootstrapRequest(req: NextRequest, body: BootstrapRequestBody) {
  const expectedTokenHash = configuredBootstrapTokenHash();
  const token = bearerToken(req);
  const requestTokenHash = body.tokenHash.toLowerCase();
  if (!expectedTokenHash || !token || requestTokenHash !== expectedTokenHash || sha256Hex(token) !== expectedTokenHash) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid bootstrap token.");
  }

  const expectedSignature = hmacSha256Hex(token, bootstrapSignaturePayload(body));
  if (!safeEqualHex(body.signature.toLowerCase(), expectedSignature)) {
    throw new AppError(401, "UNAUTHENTICATED", "Invalid bootstrap signature.");
  }

  return expectedTokenHash;
}

export async function POST(req: NextRequest) {
  let failureRunId: string | null = null;
  try {
    const body = bootstrapRequestSchema.parse(await req.json());
    const tokenHash = authorizeBootstrapRequest(req, body);
    const expiresAt = new Date(body.expiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, "BOOTSTRAP_EXPIRED", "Bootstrap request has expired.");
    }

    const existingAppliedRun = await prisma.instanceBootstrapRun.findFirst({
      where: {
        customerSlug: body.customerSlug,
        status: "applied",
      },
    });
    if (existingAppliedRun) {
      throw new AppError(409, "BOOTSTRAP_ALREADY_APPLIED", "Instance bootstrap has already been applied.");
    }

    const existingRun = await prisma.instanceBootstrapRun.findUnique({
      where: {
        customerSlug_bundleChecksum: {
          customerSlug: body.customerSlug,
          bundleChecksum: body.checksum.toLowerCase(),
        },
      },
    });
    if (existingRun?.bootstrapTokenConsumedAt) {
      throw new AppError(409, "BOOTSTRAP_TOKEN_CONSUMED", "Bootstrap token has already been consumed.");
    }
    if (existingRun?.bootstrapTokenHash && existingRun.bootstrapTokenHash !== tokenHash) {
      throw new AppError(409, "BOOTSTRAP_TOKEN_MISMATCH", "Bootstrap run is bound to a different token.");
    }

    const run = existingRun
      ? await prisma.instanceBootstrapRun.update({
        where: { id: existingRun.id },
        data: {
          status: "pending",
          error: null,
          bundleUri: body.bundleUri,
          schemaVersion: body.schemaVersion,
          expiresAt,
          bootstrapTokenHash: tokenHash,
          bootstrapTokenExpiresAt: expiresAt,
        },
      })
      : await prisma.instanceBootstrapRun.create({
        data: {
          customerSlug: body.customerSlug,
          bundleUri: body.bundleUri,
          bundleChecksum: body.checksum.toLowerCase(),
          schemaVersion: body.schemaVersion,
          requestedBy: "control-plane",
          expiresAt,
          bootstrapTokenHash: tokenHash,
          bootstrapTokenExpiresAt: expiresAt,
        },
      });

    const consumed = await prisma.instanceBootstrapRun.updateMany({
      where: {
        id: run.id,
        bootstrapTokenHash: tokenHash,
        bootstrapTokenConsumedAt: null,
        bootstrapTokenExpiresAt: { gt: new Date() },
      },
      data: {
        status: "applying",
        error: null,
        bootstrapTokenConsumedAt: new Date(),
      },
    });
    if (consumed.count !== 1) {
      throw new AppError(409, "BOOTSTRAP_TOKEN_CONSUMED", "Bootstrap token has already been consumed or expired.");
    }
    failureRunId = run.id;

    const bundleResponse = await fetch(body.bundleUri, { method: "GET" });
    if (!bundleResponse.ok) {
      throw new AppError(502, "BOOTSTRAP_BUNDLE_UNAVAILABLE", `Bootstrap bundle returned ${bundleResponse.status}.`);
    }

    const bundleText = await bundleResponse.text();
    if (sha256Hex(bundleText) !== body.checksum.toLowerCase()) {
      throw new AppError(400, "BOOTSTRAP_CHECKSUM_MISMATCH", "Bootstrap bundle checksum does not match.");
    }

    const bundle = seedBundleSchema.parse(JSON.parse(bundleText));
    const workspace = bundle.config.workspace as { slug?: unknown } | undefined;
    if (workspace?.slug !== body.customerSlug) {
      throw new AppError(400, "BOOTSTRAP_CUSTOMER_MISMATCH", "Bootstrap bundle customer slug does not match request.");
    }

    await runStableClientSeed(bundle.config, bundle.env ?? {});

    await prisma.instanceBootstrapRun.update({
      where: { id: run.id },
      data: {
        status: "applied",
        appliedAt: new Date(),
        error: null,
      },
    });

    return NextResponse.json({
      status: "applied",
      customerSlug: body.customerSlug,
      schemaVersion: body.schemaVersion,
    });
  } catch (error) {
    if (failureRunId && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) {
      await prisma.instanceBootstrapRun.update({
        where: { id: failureRunId },
        data: {
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown bootstrap error.",
        },
      }).catch(() => undefined);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return handleRouteError(new AppError(400, "VALIDATION_ERROR", "Invalid bootstrap request or bundle."));
    }
    return handleRouteError(error);
  }
}
