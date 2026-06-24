#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 30;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const EXPECTED_PAYLOAD = {
  status: "ok",
  service: "web",
  database: "up",
  schema: "ready",
  app: "corgtex",
  auth: "password-session",
};

function positiveIntegerEnv(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function healthPayloadMismatch(payload) {
  for (const [key, expected] of Object.entries(EXPECTED_PAYLOAD)) {
    if (payload?.[key] !== expected) {
      return `unexpected health payload ${JSON.stringify(payload)}`;
    }
  }
  return null;
}

export function healthWaitConfig(env = process.env) {
  return {
    attempts: positiveIntegerEnv(env, "CORGTEX_HEALTH_WAIT_ATTEMPTS", DEFAULT_ATTEMPTS),
    intervalMs: positiveIntegerEnv(env, "CORGTEX_HEALTH_WAIT_INTERVAL_MS", DEFAULT_INTERVAL_MS),
    timeoutMs: positiveIntegerEnv(env, "CORGTEX_HEALTH_WAIT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForHealth(url, options = {}) {
  const config = options.config ?? healthWaitConfig(options.env ?? process.env);
  const label = options.label ?? url;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleep ?? sleep;
  let last = "no response";

  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: { "cache-control": "no-cache" },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        last = `HTTP ${response.status}; non-JSON body ${text.slice(0, 500)}; parse=${errorMessage(error)}`;
      }

      if (payload) {
        const mismatch = healthPayloadMismatch(payload);
        if (response.ok && !mismatch) {
          console.log(`OK ${label} health passed on attempt ${attempt}.`);
          return payload;
        }
        last = `HTTP ${response.status}; ${mismatch ?? JSON.stringify(payload)}`;
      }
    } catch (error) {
      last = errorMessage(error);
    } finally {
      clearTimeout(timeout);
    }

    console.log(`Waiting for ${label} health attempt ${attempt}/${config.attempts}: ${last}`);
    if (attempt < config.attempts) await sleepImpl(config.intervalMs);
  }

  throw new Error(`${label} health did not pass after ${config.attempts} attempt(s): ${last}`);
}

function readArg(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const url = argv.find((arg) => !arg.startsWith("--"));
  if (!url) throw new Error("Usage: node scripts/wait-health.mjs <health-url> [--label <label>]");
  await waitForHealth(url, { label: readArg("--label", argv) ?? url });
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (import.meta.url === invokedScriptUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
