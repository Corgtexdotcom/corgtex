import { createHash } from "node:crypto";

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
});

const seedBundleSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string()).optional(),
});

function configuredBootstrapToken() {
  return process.env.CORGTEX_INSTANCE_BOOTSTRAP_TOKEN?.trim()
    || process.env.CORGTTEX_INSTANCE_BOOTSTRAP_TOKEN?.trim()
    || null;
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function POST(req: NextRequest) {
  let runId: string | null = null;
  try {
    const configuredToken = configuredBootstrapToken();
    if (!configuredToken || bearerToken(req) !== configuredToken) {
      throw new AppError(401, "UNAUTHENTICATED", "Invalid bootstrap token.");
    }

    const body = bootstrapRequestSchema.parse(await req.json());
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

    const run = await prisma.instanceBootstrapRun.upsert({
      where: {
        customerSlug_bundleChecksum: {
          customerSlug: body.customerSlug,
          bundleChecksum: body.checksum.toLowerCase(),
        },
      },
      update: {
        status: "pending",
        error: null,
        bundleUri: body.bundleUri,
        schemaVersion: body.schemaVersion,
        expiresAt,
      },
      create: {
        customerSlug: body.customerSlug,
        bundleUri: body.bundleUri,
        bundleChecksum: body.checksum.toLowerCase(),
        schemaVersion: body.schemaVersion,
        requestedBy: "control-plane",
        expiresAt,
      },
    });
    runId = run.id;

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

    await prisma.instanceBootstrapRun.update({
      where: { id: run.id },
      data: { status: "applying", error: null },
    });

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
    if (runId && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) {
      await prisma.instanceBootstrapRun.update({
        where: { id: runId },
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
