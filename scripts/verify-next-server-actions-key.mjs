#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const KEY_ENV = "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY";
const REQUIRED_BYTES = 32;

export function parseArgs(argv = process.argv.slice(2)) {
  return {
    required: argv.includes("--required"),
  };
}

function normalizedBase64(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
}

export function validateServerActionsKey(value) {
  const normalized = normalizedBase64(value);
  if (!normalized) {
    return {
      ok: false,
      reason: `${KEY_ENV} is missing.`,
    };
  }

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    return {
      ok: false,
      reason: `${KEY_ENV} must be standard base64.`,
    };
  }

  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    return {
      ok: false,
      reason: `${KEY_ENV} must be valid base64.`,
    };
  }

  if (decoded.byteLength !== REQUIRED_BYTES) {
    return {
      ok: false,
      reason: `${KEY_ENV} must decode to ${REQUIRED_BYTES} bytes for AES-256-GCM.`,
    };
  }

  return { ok: true };
}

export function verifyNextServerActionsKey(env = process.env, options = {}) {
  const required = Boolean(options.required);
  const result = validateServerActionsKey(env[KEY_ENV]);

  if (result.ok) {
    return {
      ok: true,
      level: "ok",
      message: `${KEY_ENV} is configured for this build.`,
    };
  }

  if (!required && result.reason === `${KEY_ENV} is missing.`) {
    return {
      ok: true,
      level: "warn",
      message: `${KEY_ENV} is not set. Local builds will use a generated Server Action key; production web image builds must provide a stable key.`,
    };
  }

  return {
    ok: false,
    level: "error",
    message: `${result.reason} Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`,
  };
}

function main() {
  const args = parseArgs();
  const result = verifyNextServerActionsKey(process.env, args);
  if (result.level === "warn") {
    console.warn(result.message);
  } else if (result.level === "error") {
    console.error(result.message);
  } else {
    console.log(result.message);
  }

  if (!result.ok) {
    process.exit(1);
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;

if (import.meta.url === invokedUrl) {
  main();
}
