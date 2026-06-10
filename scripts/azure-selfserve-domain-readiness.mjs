#!/usr/bin/env node
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_APP_URL = "https://selfserve.corgtex.com";
export const DEFAULT_SITE_URL = "https://www.corgtex.com";

const DEFAULT_ALLOWED_APP_HOSTS = [
  "selfserve.corgtex.com",
  "selfserve-staging.corgtex.com",
];

const REQUIRED_RUNTIME_ENV = [
  "APP_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "MCP_PUBLIC_URL",
  "MEETING_RECORDER_PUBLIC_BASE_URL",
  "SESSION_COOKIE_SECRET",
  "ENCRYPTION_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "SELF_SERVE_REGISTRY_SYNC_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
];

const STRICT_PROVIDER_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_AI_USAGE_ID",
  "RESEND_WEBHOOK_SECRET",
];

const OPTIONAL_PROVIDER_ENV = [
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
  "NEXT_PUBLIC_INTERCOM_APP_ID",
  "INTERCOM_MESSENGER_SECRET",
];

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function csv(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeOrigin(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  const parsed = new URL(raw);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function normalizeUrl(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw new Error(`${label} is required.`);
  }
  const parsed = new URL(raw);
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function urlFor(origin, path) {
  return new URL(path, `${origin}/`).toString();
}

function status(level, name, detail) {
  return { level, name, detail };
}

function envConfigured(env, name) {
  return Boolean(env[name]?.trim());
}

function expectedMcpUrl(appOrigin) {
  return urlFor(appOrigin, "/mcp").replace(/\/$/, "");
}

export function buildAzureSelfServeDomainReadiness(input = {}) {
  const appOrigin = normalizeOrigin(input.appUrl ?? DEFAULT_APP_URL, "appUrl");
  const siteOrigin = normalizeOrigin(input.siteUrl ?? DEFAULT_SITE_URL, "siteUrl");
  const mcpPublicUrl = normalizeUrl(input.mcpPublicUrl ?? expectedMcpUrl(appOrigin), "mcpPublicUrl");
  const meetingRecorderPublicBaseUrl = normalizeOrigin(
    input.meetingRecorderPublicBaseUrl ?? appOrigin,
    "meetingRecorderPublicBaseUrl",
  );

  return {
    appOrigin,
    siteOrigin,
    mcpPublicUrl,
    meetingRecorderPublicBaseUrl,
    callbacks: {
      googleOAuthRedirect: urlFor(appOrigin, "/api/integrations/google/callback"),
      microsoftOAuthRedirect: urlFor(appOrigin, "/api/integrations/microsoft/callback"),
      workspaceSsoRedirect: urlFor(appOrigin, "/api/auth/sso/callback"),
      slackOAuthRedirect: urlFor(appOrigin, "/api/integrations/slack/callback"),
      stripeWebhook: urlFor(appOrigin, "/api/webhooks/stripe"),
      resendInboundWebhook: urlFor(appOrigin, "/api/webhooks/resend-inbound"),
      mcpServer: expectedMcpUrl(appOrigin),
      mcpAuthorizationServerMetadata: urlFor(appOrigin, "/.well-known/oauth-authorization-server"),
      mcpProtectedResourceMetadata: urlFor(appOrigin, "/.well-known/oauth-protected-resource"),
      mcpAuthorize: urlFor(appOrigin, "/api/oauth/authorize"),
      mcpToken: urlFor(appOrigin, "/api/oauth/token"),
      mcpDynamicClientRegistration: urlFor(appOrigin, "/api/oauth/register"),
    },
  };
}

export function validateAzureSelfServeDomainReadiness(env = process.env, options = {}) {
  const appUrl = options.appUrl ?? env.APP_URL ?? DEFAULT_APP_URL;
  const siteUrl = options.siteUrl ?? env.NEXT_PUBLIC_SITE_URL ?? DEFAULT_SITE_URL;
  const readiness = buildAzureSelfServeDomainReadiness({
    appUrl,
    siteUrl,
    mcpPublicUrl: options.mcpPublicUrl ?? env.MCP_PUBLIC_URL ?? expectedMcpUrl(normalizeOrigin(appUrl, "APP_URL")),
    meetingRecorderPublicBaseUrl: options.meetingRecorderPublicBaseUrl ?? env.MEETING_RECORDER_PUBLIC_BASE_URL ?? appUrl,
  });
  const strict = Boolean(options.strict);
  const allowedHosts = new Set(options.allowedHosts?.length ? options.allowedHosts : DEFAULT_ALLOWED_APP_HOSTS);
  const checks = [];
  const appHost = new URL(readiness.appOrigin).hostname;

  checks.push(
    new URL(readiness.appOrigin).protocol === "https:"
      ? status("ok", "app-url-https", "APP_URL uses HTTPS.")
      : status("error", "app-url-https", "APP_URL must use HTTPS for Azure self-serve."),
  );
  checks.push(
    allowedHosts.has(appHost)
      ? status("ok", "app-domain", `${appHost} is an approved Azure self-serve host.`)
      : status("error", "app-domain", `${appHost} is not in the approved Azure self-serve host allowlist.`),
  );
  checks.push(
    readiness.siteOrigin !== readiness.appOrigin
      ? status("ok", "site-app-split", "NEXT_PUBLIC_SITE_URL remains separate from the Azure app origin.")
      : status("error", "site-app-split", "NEXT_PUBLIC_SITE_URL must not equal APP_URL for the split site/app deployment."),
  );

  const nextPublicAppUrl = env.NEXT_PUBLIC_APP_URL?.trim();
  if (nextPublicAppUrl) {
    const nextPublicAppOrigin = normalizeOrigin(nextPublicAppUrl, "NEXT_PUBLIC_APP_URL");
    checks.push(
      nextPublicAppOrigin === readiness.appOrigin
        ? status("ok", "next-public-app-url", "NEXT_PUBLIC_APP_URL matches APP_URL.")
        : status("error", "next-public-app-url", "NEXT_PUBLIC_APP_URL must match APP_URL for callback generation."),
    );
  }

  checks.push(
    readiness.mcpPublicUrl === expectedMcpUrl(readiness.appOrigin)
      ? status("ok", "mcp-public-url", "MCP_PUBLIC_URL points at the /mcp endpoint.")
      : status("error", "mcp-public-url", `MCP_PUBLIC_URL must be ${expectedMcpUrl(readiness.appOrigin)}.`),
  );
  checks.push(
    readiness.meetingRecorderPublicBaseUrl === readiness.appOrigin
      ? status("ok", "meeting-recorder-origin", "MEETING_RECORDER_PUBLIC_BASE_URL matches APP_URL.")
      : status("error", "meeting-recorder-origin", "MEETING_RECORDER_PUBLIC_BASE_URL must match APP_URL."),
  );

  for (const name of REQUIRED_RUNTIME_ENV) {
    if (envConfigured(env, name)) {
      checks.push(status("ok", `env:${name}`, `${name} is configured.`));
    } else {
      checks.push(status(strict ? "error" : "warn", `env:${name}`, `${name} is missing.`));
    }
  }

  for (const name of STRICT_PROVIDER_ENV) {
    if (envConfigured(env, name)) {
      checks.push(status("ok", `provider:${name}`, `${name} is configured.`));
    } else {
      checks.push(status(strict ? "error" : "warn", `provider:${name}`, `${name} must be configured before provider smoke.`));
    }
  }

  for (const name of OPTIONAL_PROVIDER_ENV) {
    checks.push(
      envConfigured(env, name)
        ? status("ok", `optional:${name}`, `${name} is configured.`)
        : status("warn", `optional:${name}`, `${name} is missing; keep the related integration disabled until configured.`),
    );
  }

  return { ...readiness, checks };
}

function printText(result) {
  console.log("Azure self-serve domain readiness");
  console.log(`App origin: ${result.appOrigin}`);
  console.log(`Site origin: ${result.siteOrigin}`);
  console.log("");
  console.log("Provider callback and webhook URLs");
  for (const [name, value] of Object.entries(result.callbacks)) {
    console.log(`- ${name}: ${value}`);
  }
  console.log("");
  console.log("Checks");
  for (const check of result.checks) {
    const prefix = check.level === "ok" ? "OK  " : check.level === "warn" ? "WARN" : "FAIL";
    console.log(`${prefix} ${check.name}: ${check.detail}`);
  }
}

function main() {
  const json = process.argv.includes("--json");
  const strict = process.argv.includes("--strict");
  const result = validateAzureSelfServeDomainReadiness(process.env, {
    strict,
    appUrl: arg("app-url"),
    siteUrl: arg("site-url"),
    mcpPublicUrl: arg("mcp-public-url"),
    meetingRecorderPublicBaseUrl: arg("meeting-recorder-public-base-url"),
    allowedHosts: csv(arg("allowed-hosts") || process.env.AZURE_SELFSERVE_ALLOWED_HOSTS),
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }

  if (result.checks.some((check) => check.level === "error")) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
