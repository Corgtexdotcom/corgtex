#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createValidationRun,
  parseValidationPrNumbers,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import { releaseDriftSummary } from "./lib/release-health-validation.mjs";
import { expectedReleaseGitSha, telemetrySent } from "./telemetry-release-smoke.mjs";

const [, , baseUrlArg, outDirArg] = process.argv;

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

function smokeSecret() {
  return optionalEnv("SMOKE_EMAIL_CAPTURE_SECRET") ?? optionalEnv("CORGTEX_SMOKE_SECRET");
}

function smokeRunId() {
  return optionalEnv("TELEMETRY_RELEASE_SMOKE_RUN_ID")
    ?? optionalEnv("CORGTEX_SMOKE_RUN_ID")
    ?? optionalEnv("GITHUB_RUN_ID")
    ?? `telemetry-release-${Date.now().toString(36)}`;
}

function tenantFromEnv() {
  const slug = optionalEnv("TELEMETRY_RELEASE_SMOKE_TENANT_SLUG") ?? "fleet-release";
  return { id: null, slug, label: slug };
}

function resultPrNumbers(run) {
  return run.prNumbers.length > 0 ? run.prNumbers : [null];
}

async function recordForEachPr(run, result) {
  for (const prNumber of resultPrNumbers(run)) {
    recordValidationResult(run, {
      ...(prNumber ? { prNumber } : {}),
      ...result,
    });
  }
}

async function main() {
  const baseUrl = (baseUrlArg || optionalEnv("APP_URL") || "https://app.corgtex.com").replace(/\/$/, "");
  const outDir = path.resolve(outDirArg || optionalEnv("TELEMETRY_RELEASE_SMOKE_OUT_DIR") || ".artifacts/production-validation/telemetry-release");
  const expectedGitSha = expectedReleaseGitSha();
  const runId = smokeRunId();
  const responsePath = path.join(outDir, "telemetry-release-response.json");
  const run = createValidationRun({
    runId,
    tenant: tenantFromEnv(),
    prNumbers: parseValidationPrNumbers(optionalEnv("TELEMETRY_RELEASE_SMOKE_PR_NUMBERS") ?? ""),
    baseUrl,
    environment: "production",
    metadata: {
      script: "telemetry-release-production-smoke",
      expectedGitSha,
      workflowRunId: optionalEnv("GITHUB_RUN_ID"),
    },
  });

  await mkdir(outDir, { recursive: true });

  try {
    const secret = smokeSecret();
    if (!secret) {
      throw new Error("SMOKE_EMAIL_CAPTURE_SECRET or CORGTEX_SMOKE_SECRET is required.");
    }

    const response = await fetch(new URL("/api/internal/smoke/telemetry/release", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedGitSha, runId }),
    });
    const payload = await response.json().catch(() => null);
    await writeFile(responsePath, `${JSON.stringify(payload, null, 2)}\n`);

    if (!response.ok) {
      throw new Error(`/api/internal/smoke/telemetry/release failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }
    if (expectedGitSha && payload?.release?.gitSha !== expectedGitSha) {
      throw new Error(`release.gitSha ${payload?.release?.gitSha ?? "missing"} did not match expected ${expectedGitSha}`);
    }
    const releaseDrift = releaseDriftSummary(payload?.release);
    if (releaseDrift) {
      throw new Error(`release metadata drift blocked telemetry proof: ${releaseDrift}`);
    }
    if (!telemetrySent(payload?.telemetry)) {
      throw new Error(`telemetry was not sent by any sink: ${JSON.stringify(payload?.telemetry ?? null)}`);
    }

    await recordForEachPr(run, {
      intent: "Release metadata and synthetic telemetry event tagging",
      method: "telemetry-release-production-smoke",
      result: "pass",
      evidence: [
        { type: "api-output", path: responsePath, summary: "Telemetry smoke response" },
        { type: "release", summary: `Telemetry tagged with release ${payload.release?.gitSha ?? "unknown"}` },
      ],
    });
    await writeValidationArtifacts(run, outDir);
    console.log(`OK telemetry release proof emitted for ${payload.release?.gitSha ?? "unknown"}`);
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    await recordForEachPr(run, {
      intent: "Release metadata and synthetic telemetry event tagging",
      method: "telemetry-release-production-smoke",
      result: "partial",
      blocker,
      evidence: [
        { type: "api-output", path: responsePath, summary: "Telemetry smoke response when available" },
        { type: "log", summary: blocker },
      ],
    });
    await writeValidationArtifacts(run, outDir);
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
