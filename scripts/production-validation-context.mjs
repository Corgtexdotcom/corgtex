#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { collectProductionValidationPrNumbers } from "./production-validation-pr-numbers.mjs";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_RECORDER_DEPLOYMENTS = "managed-recorder-validation";
const DEFAULT_CLIENT_READINESS_ROUTES = "leads";
const UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED = "__unknown_production_app_release_required__";

function boolOutput(value) {
  return value ? "true" : "false";
}

function normalizeOptionalText(value) {
  return String(value ?? "").trim();
}

function assertSingleLine(value, label) {
  const normalized = String(value ?? "");
  if (/[\r\n]/.test(normalized)) {
    throw new Error(`${label} must be a single-line value.`);
  }
  return normalized;
}

function validateGitSha(value, label) {
  const normalized = normalizeOptionalText(value).toLowerCase();
  if (normalized && !/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 40-character git SHA when provided.`);
  }
  return normalized;
}

function validateBaseUrl(value) {
  const raw = normalizeOptionalText(value) || DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("base_url must be a valid URL.");
  }
  if (parsed.origin !== DEFAULT_BASE_URL || !["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error(`base_url must be exactly ${DEFAULT_BASE_URL}.`);
  }
  return parsed.origin;
}

export function productionAppReleaseRelevantPath(filePath) {
  const path = normalizeOptionalText(filePath);
  if (!path) return false;
  return !(
    path === "AGENTS.md"
    || path === "README.md"
    || path === "knip.jsonc"
    || path === "tsconfig.unused.json"
    || path.startsWith("docs/")
    || path.startsWith(".github/")
    || path.startsWith(".agents/")
    || path.startsWith(".codex/")
    || path.startsWith("apps/site/")
  );
}

export function requiresProductionAppRelease(changedFiles) {
  return changedFiles.some(productionAppReleaseRelevantPath);
}

function readSingleCommitChangedFilesFromGit() {
  try {
    execFileSync("git", ["rev-parse", "HEAD^"], { stdio: "ignore" });
  } catch {
    return [];
  }
  const output = execFileSync("git", ["diff", "--name-only", "HEAD^", "HEAD"], { encoding: "utf8" });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function changedFilesForEvent({
  eventName,
  event,
  releaseContextPath,
}) {
  if (eventName !== "workflow_run") {
    return readSingleCommitChangedFilesFromGit();
  }

  const ciReleaseContextFiles = await changedFilesFromCiReleaseContext({
    releaseContextPath,
    event,
  });

  return ciReleaseContextFiles ?? [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
}

function workflowRunIsTrusted(event, githubRepository) {
  const run = event?.workflow_run;
  return Boolean(
    run
    && run.conclusion === "success"
    && run.event === "push"
    && run.head_branch === "main"
    && run.head_repository?.full_name === githubRepository,
  );
}

function dispatchSmokeEnabled(value, eventName) {
  if (eventName !== "workflow_dispatch") return true;
  return normalizeOptionalText(value).toLowerCase() !== "false";
}

function expectedGitShaForRun({ eventName, event, githubSha, expectedInput, changedFiles }) {
  const explicit = validateGitSha(expectedInput, "expected_git_sha");
  if (explicit) return explicit;

  if (eventName === "schedule") return "";

  if (eventName === "workflow_run") {
    if (!requiresProductionAppRelease(changedFiles)) return "";
    return validateGitSha(event?.workflow_run?.head_sha, "workflow_run.head_sha");
  }

  return validateGitSha(githubSha, "GITHUB_SHA");
}

async function changedFilesFromCiReleaseContext({ releaseContextPath, event }) {
  const path = normalizeOptionalText(releaseContextPath);
  if (!path) return null;

  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }

  const context = JSON.parse(text);
  const eventSha = validateGitSha(event?.workflow_run?.head_sha, "workflow_run.head_sha");
  const contextAfter = validateGitSha(context?.after, "ci_release_context.after");
  if (eventSha && contextAfter && eventSha !== contextAfter) {
    throw new Error(`CI release context SHA does not match workflow_run.head_sha; context_after=${contextAfter} workflow_run_head_sha=${eventSha}`);
  }

  if (Array.isArray(context?.changedFiles)) {
    const changedFiles = [...new Set(context.changedFiles.map(normalizeOptionalText).filter(Boolean))];
    if (changedFiles.length > 0) return changedFiles;
  }

  if (context?.requiresProductionAppRelease === false || context?.skipReleaseMatch === true) {
    return [];
  }

  return [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
}

export function resolveProductionValidationContext({
  eventName,
  event,
  githubRef,
  githubSha,
  githubRepository,
  baseUrlInput,
  expectedGitShaInput,
  prNumbersInput,
  baselinePrNumbers,
  recorderDeploymentsInput,
  clientReadinessRoutesInput,
  smokeInputs = {},
  changedFiles = [],
}) {
  const allowed = eventName === "workflow_run"
    ? workflowRunIsTrusted(event, githubRepository)
    : true;

  const enabled = allowed;
  const prNumbers = collectProductionValidationPrNumbers({
    baseline: baselinePrNumbers,
    explicit: prNumbersInput,
    event,
  }).join(",");

  const expectedGitSha = enabled
    ? expectedGitShaForRun({
      eventName,
      event,
      githubSha,
      expectedInput: expectedGitShaInput,
      changedFiles,
    })
    : "";

  return {
    enabled: boolOutput(enabled),
    trusted_ref: boolOutput(githubRef === "refs/heads/main" || (eventName === "workflow_run" && allowed)),
    base_url: validateBaseUrl(baseUrlInput),
    expected_git_sha: expectedGitSha,
    pr_numbers: prNumbers,
    crm_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.crm, eventName)),
    telemetry_release_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.telemetryRelease, eventName)),
    client_readiness_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.clientReadiness, eventName)),
    client_readiness_routes: normalizeOptionalText(clientReadinessRoutesInput) || DEFAULT_CLIENT_READINESS_ROUTES,
    source_intake_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.sourceIntake, eventName)),
    work_item_parity_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.workItemParity, eventName)),
    briefing_fixture_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.briefingFixture, eventName)),
    recorder_readiness_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.recorderReadiness, eventName)),
    recorder_readiness_deployments: normalizeOptionalText(recorderDeploymentsInput) || DEFAULT_RECORDER_DEPLOYMENTS,
  };
}

export function formatGithubOutput(context) {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${assertSingleLine(value, key)}`)
    .join("\n");
}

async function readEvent(eventPath) {
  const path = normalizeOptionalText(eventPath);
  if (!path) return null;
  const text = (await readFile(path, "utf8")).trim();
  return text ? JSON.parse(text) : null;
}

function parseArgs(argv) {
  const args = {
    output: process.env.GITHUB_OUTPUT ?? "",
  };
  for (const arg of argv) {
    const [name, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (name === "--output") args.output = value;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const event = await readEvent(process.env.GITHUB_EVENT_PATH);
  const eventName = process.env.GITHUB_EVENT_NAME;
  const changedFiles = await changedFilesForEvent({
    eventName,
    event,
    releaseContextPath: process.env.PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH,
  });
  const context = resolveProductionValidationContext({
    eventName,
    event,
    githubRef: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
    githubRepository: process.env.GITHUB_REPOSITORY,
    baseUrlInput: process.env.PRODUCTION_VALIDATION_BASE_URL_INPUT,
    expectedGitShaInput: process.env.PRODUCTION_VALIDATION_EXPECTED_GIT_SHA_INPUT,
    prNumbersInput: process.env.PRODUCTION_VALIDATION_PR_NUMBERS_INPUT,
    baselinePrNumbers: process.env.PRODUCTION_VALIDATION_BASELINE_PR_NUMBERS,
    recorderDeploymentsInput: process.env.PRODUCTION_VALIDATION_RECORDER_DEPLOYMENTS_INPUT,
    clientReadinessRoutesInput: process.env.PRODUCTION_VALIDATION_CLIENT_READINESS_ROUTES_INPUT,
    smokeInputs: {
      crm: process.env.PRODUCTION_VALIDATION_CRM_SMOKE_INPUT,
      telemetryRelease: process.env.PRODUCTION_VALIDATION_TELEMETRY_RELEASE_SMOKE_INPUT,
      clientReadiness: process.env.PRODUCTION_VALIDATION_CLIENT_READINESS_SMOKE_INPUT,
      sourceIntake: process.env.PRODUCTION_VALIDATION_SOURCE_INTAKE_SMOKE_INPUT,
      workItemParity: process.env.PRODUCTION_VALIDATION_WORK_ITEM_PARITY_SMOKE_INPUT,
      briefingFixture: process.env.PRODUCTION_VALIDATION_BRIEFING_FIXTURE_SMOKE_INPUT,
      recorderReadiness: process.env.PRODUCTION_VALIDATION_RECORDER_READINESS_SMOKE_INPUT,
    },
    changedFiles,
  });

  if (args.output) {
    await writeFile(args.output, `${formatGithubOutput(context)}\n`, { flag: "a" });
  }
  console.log(JSON.stringify(context, null, 2));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
