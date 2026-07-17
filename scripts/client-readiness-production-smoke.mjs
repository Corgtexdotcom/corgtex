#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  createValidationRun,
  parseValidationPrNumbers,
  recordValidationResult,
  writeValidationArtifacts,
} from "./lib/production-validation.mjs";
import { healthReleaseValidationMismatch } from "./lib/release-health-validation.mjs";

const [, , baseUrlArg, outDirArg] = process.argv;

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || null;
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

function smokeRunId() {
  return optionalEnv("CLIENT_READINESS_SMOKE_RUN_ID")
    ?? optionalEnv("GITHUB_RUN_ID")
    ?? `client-readiness-${Date.now().toString(36)}`;
}

function tenantFromEnv() {
  const slug = optionalEnv("CLIENT_READINESS_WORKSPACE_SLUG") ?? "corgtex-validation";
  return { id: null, slug, label: slug };
}

async function fetchHealth(baseUrl, healthPath) {
  const response = await fetch(new URL("/api/health", baseUrl), {
    headers: { "user-agent": "corgtex-client-readiness-production-smoke/1.0" },
  });
  const payload = await response.json().catch(() => null);
  await writeFile(healthPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (!response.ok) {
    throw new Error(`/api/health failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function runClientReadiness({ baseUrl, outDir, logPath }) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/client-readiness-smoke.mjs", baseUrl, outDir], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(logPath, { flags: "a" });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on("error", (error) => {
      log.end();
      reject(error);
    });
    child.on("close", (code, signal) => {
      log.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`client-readiness-smoke exited with code ${code ?? "null"} signal ${signal ?? "none"}`));
      }
    });
  });
}

async function readQaResults(qaPath) {
  try {
    return JSON.parse(await readFile(qaPath, "utf8"));
  } catch {
    return null;
  }
}

export function summarizeQaResults(qaResults) {
  if (!qaResults) return "Client readiness QA results were not written.";
  const routes = Array.isArray(qaResults.routeResults) ? qaResults.routeResults.length : 0;
  const findings = Array.isArray(qaResults.findings) ? qaResults.findings.length : 0;
  const consoleErrors = Array.isArray(qaResults.consoleErrors) ? qaResults.consoleErrors.length : 0;
  return `${routes} routes checked, ${findings} findings, ${consoleErrors} console errors`;
}

async function main() {
  const baseUrl = (baseUrlArg || optionalEnv("CLIENT_READINESS_BASE_URL") || "https://app.corgtex.com").replace(/\/$/, "");
  const outDir = path.resolve(outDirArg || optionalEnv("CLIENT_READINESS_OUT_DIR") || ".artifacts/production-validation/client-readiness");
  const expectedGitSha = optionalEnv("CLIENT_READINESS_SMOKE_EXPECTED_GIT_SHA");
  const runId = smokeRunId();
  const healthPath = path.join(outDir, "health.json");
  const qaPath = path.join(outDir, "qa-results.json");
  const logPath = path.join(outDir, "client-readiness-smoke.log");
  const run = createValidationRun({
    runId,
    tenant: tenantFromEnv(),
    prNumbers: parseValidationPrNumbers(optionalEnv("CLIENT_READINESS_SMOKE_PR_NUMBERS") ?? ""),
    baseUrl,
    environment: "production",
    metadata: {
      script: "client-readiness-production-smoke",
      expectedGitSha,
      routeNames: optionalEnv("CLIENT_READINESS_ROUTE_NAMES"),
      workflowRunId: optionalEnv("GITHUB_RUN_ID"),
    },
  });

  await mkdir(outDir, { recursive: true });

  try {
    const health = await fetchHealth(baseUrl, healthPath);
    const releaseMismatch = healthReleaseValidationMismatch(health, expectedGitSha, {
      requireConfiguredMatch: true,
    });
    if (releaseMismatch) throw new Error(releaseMismatch);

    await runClientReadiness({ baseUrl, outDir, logPath });
    const qaResults = await readQaResults(qaPath);

    await recordForEachPr(run, {
      intent: "Client-readiness route, selected workspace, desktop and mobile proof",
      method: "client-readiness-production-smoke",
      result: "pass",
      evidence: [
        { type: "health", path: healthPath, summary: "Production health and release metadata" },
        { type: "qa-results", path: qaPath, summary: summarizeQaResults(qaResults) },
        { type: "log", path: logPath, summary: "Client readiness smoke log" },
      ],
    });
    await writeValidationArtifacts(run, outDir);
    console.log(`OK client readiness proof complete: ${summarizeQaResults(qaResults)}`);
  } catch (error) {
    const qaResults = await readQaResults(qaPath);
    const blocker = error instanceof Error ? error.message : String(error);
    await recordForEachPr(run, {
      intent: "Client-readiness route, selected workspace, desktop and mobile proof",
      method: "client-readiness-production-smoke",
      result: "partial",
      blocker,
      evidence: [
        { type: "health", path: healthPath, summary: "Production health and release metadata when available" },
        { type: "qa-results", path: qaPath, summary: summarizeQaResults(qaResults) },
        { type: "log", path: logPath, summary: blocker },
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
