#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { collectProductionValidationPrNumbers } from "./production-validation-pr-numbers.mjs";
import { readPin, resolveBaseline } from "./accepted-core-baseline.mjs";
import { validationTarget, validationRunTarget, SELFSERVE_VALIDATION_TARGET, selfserveExpectedRelease, assertSelfserveOrigin } from "./lib/selfserve-validation-target.mjs";

const DEFAULT_BASE_URL = "https://app.corgtex.com";
const DEFAULT_RECORDER_DEPLOYMENTS = "";
const DEFAULT_CLIENT_READINESS_ROUTES = "leads";
const CLIENT_READINESS_ROUTE_NAMES = new Set([
  "home",
  "goals",
  "brain",
  "brain-sources",
  "brain-status",
  "members",
  "tensions",
  "actions",
  "meetings",
  "proposals",
  "circles",
  "finance",
  "finance-clients",
  "audit",
  "settings",
  "chat",
  "leads",
  "agents",
  "governance",
  "operator",
]);
const UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED = "__unknown_production_app_release_required__";
// Standalone site/monitor hosting inputs: hosting-images.yml, the hosting README
// and site release CLI are their callers. Web/worker code and startup do not use
// them, even where an image's blanket COPY happens to include the scripts.
const NON_APP_RELEASE_FILES = new Set([
  "deploy/Dockerfile.site",
  "infra/azure/hosting/README.md",
  "infra/azure/hosting/site.bicep",
  "infra/azure/hosting/site.parameters.example.json",
  "infra/azure/hosting/site-identity.bicep",
  "infra/azure/hosting/registry-pull.bicep",
  "infra/azure/hosting/monitor.bicep",
  "infra/azure/hosting/monitor.parameters.example.json",
  "scripts/azure-site-image-release.mjs",
  "scripts/azure-site-image-release.node-test.mjs",
  "scripts/migration/hosting-image-receipt.mjs",
  "scripts/migration/hosting-image-receipt.test.mjs",
  "scripts/migration/site-candidate-smoke.mjs",
  "scripts/migration/site-candidate-smoke.test.mjs",
  // CI/validation policy and its tests execute on the runner. Changes still need
  // policy QA and live smoke, but no unrelated backup-app image deployment.
  "scripts/production-validation-context.mjs",
  "scripts/production-validation-context.test.mjs",
  "scripts/release/workspace-mcp-config.mjs",
  "scripts/release/workspace-mcp-config-azure.mjs",
  "scripts/release/workspace-mcp-config.test.mjs",
  "scripts/accepted-core-baseline.mjs",
  "scripts/accepted-core-baseline.test.mjs",
  "scripts/ci-production-boundary.test.mjs",
  "scripts/client-readiness-smoke.mjs",
  "scripts/work-item-parity-production-smoke.mjs",
  "scripts/lib/selfserve-validation-target.mjs",
  "scripts/selfserve-validation-fixture.mjs",
  "scripts/selfserve-validation-browser.mjs",
  "scripts/selfserve-validation-relay.mjs",
  "scripts/selfserve-validation-isolated.mjs",
  "scripts/selfserve-validation-navigation.mjs",
  "scripts/selfserve-validation-outcome.mjs",
  "scripts/selfserve-validation-parity.mjs",
  "scripts/selfserve-validation-recovery.mjs",
  "scripts/selfserve-validation-recovery.test.mjs",
  "scripts/selfserve-validation-control-flow.test.mjs",
  "scripts/selfserve-validation-schema.mjs",
  "scripts/selfserve-validation-schema.test.mjs",
  "scripts/lib/selfserve-schema-catalog.mjs",
  "scripts/selfserve-validation-catalog-fixture.mjs",
  "scripts/selfserve-schema-catalog.test.mjs",
  "scripts/selfserve-schema-catalog.integration.test.mjs",
  "scripts/selfserve-validation-schema.integration.test.mjs",
  "scripts/selfserve-validation-smoke.mjs",
  "scripts/selfserve-validation.test.mjs",
]);

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

function normalizeClientReadinessRoutes(value) {
  const raw = normalizeOptionalText(value) || DEFAULT_CLIENT_READINESS_ROUTES;
  const routeNames = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  if (routeNames.length === 0) {
    throw new Error("client_readiness_routes must include at least one route name.");
  }
  const unknown = routeNames.filter((name) => !CLIENT_READINESS_ROUTE_NAMES.has(name));
  if (unknown.length > 0) {
    throw new Error(`client_readiness_routes contains unsupported route name(s): ${unknown.join(", ")}`);
  }
  return routeNames.join(",");
}

export function productionAppReleaseRelevantPath(filePath) {
  if (typeof filePath !== "string") return true;
  const path = filePath;
  if (!path) return false;
  if (/[\r\n\0\\]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) return true;
  return !(
    NON_APP_RELEASE_FILES.has(path)
    || path === "AGENTS.md"
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
  return !Array.isArray(changedFiles) || changedFiles.some(productionAppReleaseRelevantPath);
}

export function productionAppChangedFilesFromGit({ before, after, cwd = process.cwd() }) {
  if (![before, after].every((sha) => /^[a-f0-9]{40}$/i.test(sha ?? "") && !/^0+$/.test(sha)) || before === after) {
    return [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", before, after], { cwd, stdio: "ignore" });
    // Disabling rename detection retains both deleted runtime and added site
    // paths. NUL delimiters avoid Git quoting or newline-based path truncation.
    const output = execFileSync("git", ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", before, after, "--"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split("\0").filter(Boolean);
  } catch {
    return [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
  }
}

function readSingleCommitChangedFilesFromGit() {
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD^1"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const after = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return productionAppChangedFilesFromGit({ before, after });
  } catch {
    return [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
  }
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

function booleanWorkflowInput(value) {
  return normalizeOptionalText(value).toLowerCase() === "true";
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
  const contextBefore = validateGitSha(context?.before, "ci_release_context.before");
  if (eventSha && contextAfter && eventSha !== contextAfter) {
    throw new Error(`CI release context SHA does not match workflow_run.head_sha; context_after=${contextAfter} workflow_run_head_sha=${eventSha}`);
  }

  if (context?.source !== "ci-push-range" || !eventSha || !contextAfter || !contextBefore
    || /^0+$/.test(contextBefore) || contextBefore === contextAfter) {
    return [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
  }

  if (Array.isArray(context?.changedFiles) && context.changedFiles.every((path) => typeof path === "string" && path.length > 0)) {
    const changedFiles = [...new Set(context.changedFiles)];
    if (changedFiles.length > 0 || (context?.requiresProductionAppRelease === false && context?.skipReleaseMatch === true)) return changedFiles;
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
  recorderTempMeetingsInput,
  clientReadinessRoutesInput,
  smokeInputs = {},
  changedFiles = [],
  acceptedBaseline = null,
  targetInput,
  acceptedSelfserveSha,
  selfserveParityInput,
  selfserveCrmInput,
}) {
  const target = validationTarget(targetInput);
  const allowed = eventName === "workflow_run"
    ? workflowRunIsTrusted(event, githubRepository)
    : true;

  if (target === SELFSERVE_VALIDATION_TARGET.name) {
    const trusted = githubRepository === "Corgtexdotcom/corgtex"
      && (githubRef === "refs/heads/main" || (eventName === "workflow_run" && allowed));
    if (!trusted || !allowed) throw new Error("SELFSERVE_VALIDATION_TRUSTED_MAIN_REQUIRED");
    const origin = assertSelfserveOrigin(baseUrlInput || SELFSERVE_VALIDATION_TARGET.origin);
    if (booleanWorkflowInput(selfserveCrmInput)) {
      throw new Error("SELFSERVE_CRM_BLOCKED: real-model CRM requires a fixed synthetic account and a separately approved model lane; the no-egress fixture cannot provide this proof.");
    }
    return {
      enabled: boolOutput(eventName !== "workflow_run"), target,
      validation_mode: eventName === "workflow_dispatch" ? "explicit-release" : "accepted-serving",
      trusted_ref: "true", base_url: origin,
      expected_git_sha: selfserveExpectedRelease({ eventName, expectedSha: expectedGitShaInput, acceptedSha: acceptedSelfserveSha }),
      pr_numbers: collectProductionValidationPrNumbers({ baseline: baselinePrNumbers, explicit: prNumbersInput, event }).join(","),
      // None of the legacy production-writer helpers may inherit this target.
      crm_smoke: "false", telemetry_release_smoke: "false", client_readiness_smoke: "false",
      client_readiness_routes: normalizeClientReadinessRoutes(clientReadinessRoutesInput),
      source_intake_smoke: "false", work_item_parity_smoke: "false", briefing_fixture_smoke: "false",
      recorder_readiness_smoke: "false", recorder_readiness_deployments: "", recorder_readiness_temp_meetings: "false",
      selfserve_parity_smoke: boolOutput(eventName === "workflow_dispatch" && booleanWorkflowInput(selfserveParityInput)),
    };
  }

  // Source CI already validates the accepted Core baseline. Its completion (or
  // a schedule) is not authority to import new-main fixtures into that runtime.
  // Explicit dispatch remains an exact incoming release validation.
  const baselineOnly = Boolean(acceptedBaseline) && eventName !== "workflow_dispatch";
  const enabled = allowed && !baselineOnly;
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
    validation_mode: baselineOnly ? "accepted-baseline-ci-only" : "legacy-or-explicit-release",
    trusted_ref: boolOutput(githubRef === "refs/heads/main" || (eventName === "workflow_run" && allowed)),
    base_url: validateBaseUrl(baseUrlInput),
    expected_git_sha: expectedGitSha,
    pr_numbers: prNumbers,
    crm_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.crm, eventName)),
    telemetry_release_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.telemetryRelease, eventName)),
    client_readiness_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.clientReadiness, eventName)),
    client_readiness_routes: normalizeClientReadinessRoutes(clientReadinessRoutesInput),
    source_intake_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.sourceIntake, eventName)),
    work_item_parity_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.workItemParity, eventName)),
    briefing_fixture_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.briefingFixture, eventName)),
    recorder_readiness_smoke: boolOutput(enabled && dispatchSmokeEnabled(smokeInputs.recorderReadiness, eventName)),
    recorder_readiness_deployments: normalizeOptionalText(recorderDeploymentsInput) || DEFAULT_RECORDER_DEPLOYMENTS,
    recorder_readiness_temp_meetings: boolOutput(enabled && eventName === "workflow_dispatch" && booleanWorkflowInput(recorderTempMeetingsInput)),
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
    if (name === "--classify-app-release") args.classifyAppRelease = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.classifyAppRelease) {
    const before = process.env.RELEASE_CONTEXT_BEFORE ?? "";
    const after = process.env.RELEASE_CONTEXT_AFTER ?? "";
    const releaseContextPath = process.env.PRODUCTION_VALIDATION_CI_RELEASE_CONTEXT_PATH;
    let changedFiles;
    try {
      changedFiles = releaseContextPath
        ? await changedFilesForEvent({ eventName: "workflow_run", event: { workflow_run: { head_sha: after } }, releaseContextPath })
        : productionAppChangedFilesFromGit({ before, after });
    } catch {
      // Recovery still runs its health/auth/schema checks when range evidence is
      // unreadable or stale, but must also match the failed app release exactly.
      changedFiles = [UNKNOWN_PRODUCTION_APP_RELEASE_REQUIRED];
    }
    const requiresAppRelease = requiresProductionAppRelease(changedFiles);
    const context = { source: "ci-push-range", before, after, changedFiles,
      skipReleaseMatch: !requiresAppRelease, requiresProductionAppRelease: requiresAppRelease };
    if (process.env.ACCEPTED_CORE_BASELINE === "true") {
      context.validationMode = "accepted-core-baseline";
      context.acceptedSourceSha = validateGitSha(process.env.ACCEPTED_CORE_SOURCE_SHA, "accepted baseline source");
      if (!context.acceptedSourceSha) throw new Error("Accepted baseline source is missing.");
    }
    if (process.env.RELEASE_CONTEXT_PATH) await writeFile(process.env.RELEASE_CONTEXT_PATH, `${JSON.stringify(context, null, 2)}\n`);
    if (args.output) await writeFile(args.output, `${formatGithubOutput({
      skip_release_match: boolOutput(!requiresAppRelease), requires_app_release: boolOutput(requiresAppRelease),
    })}\n`, { flag: "a" });
    console.log(JSON.stringify(context, null, 2));
    return;
  }
  const event = await readEvent(process.env.GITHUB_EVENT_PATH);
  const eventName = process.env.GITHUB_EVENT_NAME;
  const automaticTrusted = process.env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex" && process.env.GITHUB_REF === "refs/heads/main"
    && (eventName === "schedule" || (eventName === "workflow_run" && workflowRunIsTrusted(event, process.env.GITHUB_REPOSITORY)));
  const target = validationRunTarget({ eventName, pinnedTarget: process.env.PRODUCTION_VALIDATION_PINNED_TARGET,
    configuredTarget: process.env.PRODUCTION_VALIDATION_TARGET });
  const acceptedBaseline = automaticTrusted && target === "core" ? await resolveBaseline(await readPin()) : null;
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
    recorderTempMeetingsInput: process.env.PRODUCTION_VALIDATION_RECORDER_TEMP_MEETINGS_INPUT,
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
    acceptedBaseline,
    targetInput: target,
    acceptedSelfserveSha: process.env.SELFSERVE_VALIDATION_ACCEPTED_SHA,
    selfserveParityInput: process.env.SELFSERVE_PARITY_INPUT,
    selfserveCrmInput: process.env.SELFSERVE_CRM_INPUT,
  });
  if (target === SELFSERVE_VALIDATION_TARGET.name) {
    context.verifier_sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }

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
