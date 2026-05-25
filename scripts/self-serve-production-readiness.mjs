#!/usr/bin/env node
import process from "node:process";

const REQUIRED_ENV = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "DATABASE_URL",
  "SESSION_COOKIE_SECRET",
  "ENCRYPTION_KEY",
  "MODEL_PROVIDER",
  "MODEL_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_AI_USAGE_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_MAX_POLL_INTERVAL_MS",
  "WORKER_EVENT_BATCH_SIZE",
  "WORKER_JOB_BATCH_SIZE",
  "WORKER_HEALTH_PORT",
  "WORKER_SHUTDOWN_TIMEOUT_MS",
];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function pass(message) {
  console.log(`OK   ${message}`);
}

function warn(message) {
  console.log(`WARN ${message}`);
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function configured(name) {
  return Boolean(process.env[name]?.trim());
}

function envValue(name) {
  return process.env[name]?.trim() ?? "";
}

function looksLikeUuid(value) {
  return UUID_PATTERN.test(value);
}

async function checkEndpoint(baseUrl, path, predicate, label) {
  try {
    const response = await fetch(new URL(path, baseUrl));
    const text = await response.text();
    if (!response.ok || !predicate(text, response)) {
      fail(`${label} returned unexpected response (${response.status})`);
      return;
    }
    pass(label);
  } catch (error) {
    fail(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const strict = process.argv.includes("--strict");
  const baseUrl = arg("base-url") || process.env.SELF_SERVE_READINESS_BASE_URL || process.env.APP_URL;

  for (const name of REQUIRED_ENV) {
    if (configured(name)) {
      pass(`${name} configured`);
    } else if (strict) {
      fail(`${name} missing`);
    } else {
      warn(`${name} missing`);
    }
  }

  const microsoftClientSecret = envValue("MICROSOFT_CLIENT_SECRET");
  if (microsoftClientSecret && looksLikeUuid(microsoftClientSecret)) {
    fail("MICROSOFT_CLIENT_SECRET looks like an Entra Secret ID. Use the client secret Value instead.");
  }

  if (!baseUrl) {
    warn("No base URL supplied; skipping HTTP readiness checks");
    return;
  }

  await checkEndpoint(baseUrl, "/api/health", (text) => {
    const body = JSON.parse(text);
    return body.status === "ok" && body.service === "web" && body.database === "up";
  }, "/api/health reports ready web/database state");

  await checkEndpoint(baseUrl, "/api/procurement/v1/product", (text) => {
    const body = JSON.parse(text);
    return Boolean(body.procurementApi?.trialCreateUrl && body.trial?.trialDays === 30);
  }, "procurement product metadata advertises 30-day trial");

  await checkEndpoint(baseUrl, "/api/procurement/v1/openapi.json", (text) => {
    const body = JSON.parse(text);
    return Boolean(body.paths?.["/trials"]?.post && body.paths?.["/trials/{trialId}"]?.get);
  }, "procurement OpenAPI exposes trial create/status");

  await checkEndpoint(baseUrl, "/.well-known/agent-card.json", (text) => {
    const body = JSON.parse(text);
    return Array.isArray(body.capabilities) && body.capabilities.includes("instant_limited_trial");
  }, "agent card exposes instant limited trial capability");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
