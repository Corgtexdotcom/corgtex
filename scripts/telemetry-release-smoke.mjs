#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || null;
}

export function expectedReleaseGitSha(env = process.env) {
  return env.CORGTEX_EXPECTED_RELEASE_GIT_SHA?.trim() || env.GITHUB_SHA?.trim() || null;
}

export function telemetrySent(telemetry) {
  return telemetry?.posthog === "sent" || telemetry?.azure === "sent";
}

function smokeSecret() {
  return optionalEnv("SMOKE_EMAIL_CAPTURE_SECRET") ?? optionalEnv("CORGTEX_SMOKE_SECRET");
}

function smokeRunId(env = process.env) {
  return env.CORGTEX_SMOKE_RUN_ID?.trim()
    || env.GITHUB_RUN_ID?.trim()
    || `telemetry-release-${Date.now()}`;
}

async function main() {
  const [rawBaseUrl] = process.argv.slice(2);
  const baseUrl = rawBaseUrl ?? optionalEnv("APP_URL");
  const secret = smokeSecret();
  const expectedGitSha = expectedReleaseGitSha();
  const runId = smokeRunId();

  if (!baseUrl || !secret) {
    fail("usage: node scripts/telemetry-release-smoke.mjs <base-url>; requires SMOKE_EMAIL_CAPTURE_SECRET");
  }

  const response = await fetch(new URL("/api/internal/smoke/telemetry/release", baseUrl), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expectedGitSha,
      runId,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    fail(`/api/internal/smoke/telemetry/release failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (expectedGitSha && payload?.release?.gitSha !== expectedGitSha) {
    fail(`release.gitSha ${payload?.release?.gitSha ?? "missing"} did not match expected ${expectedGitSha}`);
  }
  if (!telemetrySent(payload?.telemetry)) {
    fail(`telemetry was not sent by any sink: ${JSON.stringify(payload?.telemetry ?? null)}`);
  }

  pass(`/api/internal/smoke/telemetry/release emitted telemetry for ${payload.release.gitSha ?? "unknown"}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
