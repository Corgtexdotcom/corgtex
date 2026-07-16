#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createValidationRun,
  parseValidationPrNumbers,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function tenantFromSlug(slug) {
  const normalized = required(slug, "tenant slug");
  return { id: null, slug: normalized, label: normalized };
}

export function createBlockedValidationRun({
  runId = `blocked-${Date.now().toString(36)}`,
  tenantSlug = "corgtex-validation",
  prNumbers = [],
  baseUrl = null,
  method,
  intent,
  blocker,
  metadata = {},
} = {}) {
  const run = createValidationRun({
    runId,
    tenant: tenantFromSlug(tenantSlug),
    prNumbers,
    baseUrl,
    environment: "production",
    metadata: {
      script: "production-validation-blocked",
      ...metadata,
    },
  });

  const resultPrNumbers = run.prNumbers.length > 0 ? run.prNumbers : [null];
  for (const prNumber of resultPrNumbers) {
    recordValidationResult(run, {
      ...(prNumber ? { prNumber } : {}),
      intent: required(intent, "intent"),
      method: required(method, "method"),
      result: "blocked",
      blocker: required(blocker, "blocker"),
      evidence: [{
        type: "workflow",
        summary: "Validation was blocked before the smoke could execute.",
      }],
    });
  }

  return run;
}

async function main() {
  const outDir = required(arg("out-dir", process.env.PRODUCTION_VALIDATION_OUT_DIR), "out-dir");
  const run = createBlockedValidationRun({
    runId: arg("run-id", process.env.PRODUCTION_VALIDATION_RUN_ID || `blocked-${Date.now().toString(36)}`),
    tenantSlug: arg("tenant-slug", process.env.PRODUCTION_VALIDATION_WORKSPACE_SLUG || "corgtex-validation"),
    prNumbers: parseValidationPrNumbers(arg("pr-numbers", process.env.PRODUCTION_VALIDATION_PR_NUMBERS || "")),
    baseUrl: arg("base-url", process.env.PRODUCTION_VALIDATION_BASE_URL || null),
    method: arg("method", process.env.PRODUCTION_VALIDATION_METHOD),
    intent: arg("intent", process.env.PRODUCTION_VALIDATION_INTENT),
    blocker: arg("blocker", process.env.PRODUCTION_VALIDATION_BLOCKER),
    metadata: {
      workflow: process.env.GITHUB_WORKFLOW || null,
      runId: process.env.GITHUB_RUN_ID || null,
      sha: process.env.GITHUB_SHA || null,
    },
  });

  const artifacts = await writeValidationArtifacts(run, path.resolve(outDir));
  console.log(`Blocked validation artifacts written: ${artifacts.jsonPath}`);
  console.log(`Blocked validation report written: ${artifacts.markdownPath}`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
