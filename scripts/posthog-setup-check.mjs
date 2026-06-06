#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_API_HOST = "https://us.i.posthog.com";

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const raw = match[2].replace(/\s+#.*$/, "").trim();
    process.env[match[1]] = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

function optional(name) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function booleanFromEnv(name, fallback = false) {
  const value = optional(name);
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function numberFromEnv(name, fallback) {
  const value = optional(name);
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function line(label, ok, detail) {
  const status = ok ? "ok" : "check";
  console.log(`${status.padEnd(6)} ${label}${detail ? ` - ${detail}` : ""}`);
}

async function sendTestEvent() {
  const token = optional("POSTHOG_PROJECT_TOKEN");
  const apiHost = (optional("POSTHOG_API_HOST") ?? DEFAULT_API_HOST).replace(/\/+$/, "");
  if (!token) {
    console.error("Cannot send test event: POSTHOG_PROJECT_TOKEN is not set.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${apiHost}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: token,
      distinct_id: `posthog-check:${randomUUID()}`,
      event: "corgtex_posthog_setup_check",
      properties: {
        "$lib": "corgtex-server",
        "$process_person_profile": false,
        corgtex_environment: optional("POSTHOG_ENVIRONMENT") ?? optional("NODE_ENV") ?? "development",
        corgtex_instance_id: optional("POSTHOG_INSTANCE_ID") ?? "local",
      },
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    console.error(`PostHog test event failed with HTTP ${response.status}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`ok     test event accepted by PostHog (${response.status})`);
}

loadDotEnv();

const enabled = booleanFromEnv("POSTHOG_ENABLED");
const killed = booleanFromEnv("POSTHOG_CAPTURE_KILL_SWITCH");
const tokenSet = Boolean(optional("POSTHOG_PROJECT_TOKEN"));
const apiHost = optional("POSTHOG_API_HOST") ?? DEFAULT_API_HOST;
const sampleRate = numberFromEnv("POSTHOG_EVENT_SAMPLE_RATE", 1);
const timeoutMs = numberFromEnv("POSTHOG_CAPTURE_TIMEOUT_MS", 1500);

line("POSTHOG_ENABLED", enabled, enabled ? "capture can run when token is present" : "capture is fail-closed");
line("POSTHOG_CAPTURE_KILL_SWITCH", !killed, killed ? "capture is force-disabled" : "not active");
line("POSTHOG_PROJECT_TOKEN", tokenSet, tokenSet ? "set" : "missing");
line("POSTHOG_API_HOST", /^https:\/\/(us|eu)\.i\.posthog\.com$/.test(apiHost) || apiHost.startsWith("https://"), apiHost);
line("POSTHOG_EVENT_SAMPLE_RATE", sampleRate >= 0 && sampleRate <= 1, String(sampleRate));
line("POSTHOG_CAPTURE_TIMEOUT_MS", timeoutMs >= 250 && timeoutMs <= 10_000, `${timeoutMs}ms`);

console.log("");
console.log("Required account-side controls:");
console.log("- Use one legitimate PostHog organization for Corgtex and client instances; do not multiply free limits across throwaway accounts.");
console.log("- Set PostHog billing limits per product before enabling capture. PostHog drops data over the limit instead of billing above the limit.");
console.log("- Keep Session Replay, Logs, Surveys, Feature Flags, Workflows, and Data Pipelines disabled until there is an approved product need and a matching billing limit.");
console.log("- Set POSTHOG_INSTANCE_ID uniquely per Corgtex/client deployment so one project can separate usage without multiplying projects.");
console.log("- Add the official PostHog MCP with: codex mcp add posthog --url https://mcp.posthog.com/mcp");

if (process.argv.includes("--send-test")) {
  await sendTestEvent();
}
