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
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_AI_USAGE_ID",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_REPLY_TO",
  "WORKER_POLL_INTERVAL_MS",
  "WORKER_MAX_POLL_INTERVAL_MS",
  "WORKER_EVENT_BATCH_SIZE",
  "WORKER_JOB_BATCH_SIZE",
  "WORKER_HEALTH_PORT",
  "WORKER_SHUTDOWN_TIMEOUT_MS",
];

const REQUIRED_EMAIL_FROM_ADDRESS = "notifications@auth.corgtex.com";
const REQUIRED_EMAIL_REPLY_TO_ADDRESS = "support@corgtex.com";
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

function parseEmailAddress(value) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/<([^<>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function checkConfigured(name, strict, message) {
  if (configured(name)) {
    pass(`${name} configured`);
  } else if (strict) {
    fail(message ?? `${name} missing`);
  } else {
    warn(message ?? `${name} missing`);
  }
}

function checkEmailSenderConfiguration() {
  if (configured("EMAIL_FROM")) {
    const fromAddress = parseEmailAddress(envValue("EMAIL_FROM"));
    if (fromAddress === REQUIRED_EMAIL_FROM_ADDRESS) {
      pass(`EMAIL_FROM uses ${REQUIRED_EMAIL_FROM_ADDRESS}`);
    } else {
      fail(`EMAIL_FROM must use ${REQUIRED_EMAIL_FROM_ADDRESS}; got ${fromAddress || "empty"}`);
    }
  }

  if (configured("EMAIL_REPLY_TO")) {
    const replyToAddress = parseEmailAddress(envValue("EMAIL_REPLY_TO"));
    if (replyToAddress === REQUIRED_EMAIL_REPLY_TO_ADDRESS) {
      pass(`EMAIL_REPLY_TO uses ${REQUIRED_EMAIL_REPLY_TO_ADDRESS}`);
    } else {
      fail(`EMAIL_REPLY_TO must use ${REQUIRED_EMAIL_REPLY_TO_ADDRESS}; got ${replyToAddress || "empty"}`);
    }
  }
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

function checkModelConfiguration(strict) {
  const provider = envValue("MODEL_PROVIDER") || "openrouter";
  if (provider === "azure-openai") {
    checkConfigured("MODEL_BASE_URL", strict, "MODEL_BASE_URL missing for Azure OpenAI.");
    const authMode = envValue("AZURE_OPENAI_AUTH_MODE") || "api_key";
    if (authMode === "managed_identity") {
      pass("AZURE_OPENAI_AUTH_MODE configured for managed identity");
      if (configured("AZURE_CLIENT_ID")) {
        pass("AZURE_CLIENT_ID configured");
      } else {
        warn("AZURE_CLIENT_ID missing; Azure OpenAI will rely on system-assigned managed identity.");
      }
      return;
    }
    if (authMode !== "api_key") {
      fail("AZURE_OPENAI_AUTH_MODE must be api_key or managed_identity.");
      return;
    }
    if (configured("AZURE_OPENAI_API_KEY") || configured("MODEL_API_KEY")) {
      pass("Azure OpenAI API key configured");
    } else {
      checkConfigured("AZURE_OPENAI_API_KEY", strict, "AZURE_OPENAI_API_KEY or MODEL_API_KEY missing for Azure OpenAI API key auth.");
    }
    return;
  }

  if (provider === "fake") {
    warn("MODEL_PROVIDER is fake; do not use this for production launch.");
    return;
  }

  checkConfigured("MODEL_API_KEY", strict, "MODEL_API_KEY missing for OpenAI-compatible model provider.");
}

async function main() {
  const strict = process.argv.includes("--strict");
  const skipHttp = process.argv.includes("--skip-http");
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

  checkEmailSenderConfiguration();
  checkModelConfiguration(strict);

  if (skipHttp) {
    pass("HTTP readiness checks skipped by request");
    return;
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
