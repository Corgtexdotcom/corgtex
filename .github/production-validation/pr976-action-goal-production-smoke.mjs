#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";

export const OPERATION_KEY = "pr976-action-goal-production-validation";
export const TARGET_SHA = "086cec6d25f3457ce7b6858aa8c8f31ceb0cc771";
export const TARGET_PR = 976;
export const ACTION_PROVEN_BODY = "corgtex:production-validation:pr976:action-goal:action:proven";
export const GOAL_PROGRESS = 37;
export const PR976_FILES = Object.freeze([
  "apps/web/app/[locale]/workspaces/[workspaceId]/actions/actions.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/actions/actions.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/actions/page.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/actions/page.tsx",
  "apps/web/app/[locale]/workspaces/[workspaceId]/goals/actions.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/goals/actions.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx",
  "apps/web/app/[locale]/workspaces/[workspaceId]/proposals/actions.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/proposals/actions.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/tensions/actions.test.ts",
  "apps/web/app/[locale]/workspaces/[workspaceId]/tensions/actions.ts",
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 512_000;
const CLEANUP_RESERVE_MS = 90_000;

export function sanitize(value) {
  return JSON.parse(JSON.stringify(value, (key, inner) => {
    if (/authorization|cookie|password|secret|token|credentialToken|set-cookie/i.test(key)) return "[redacted]";
    if (typeof inner === "string" && /(agentc-|Bearer\s+|password|secret|token)/i.test(inner)) return "[redacted]";
    return inner;
  }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing required environment variable: ${names.join(" or ")}`);
}

function assertTrustedRef() {
  const ref = process.env.GITHUB_REF || "";
  const event = process.env.GITHUB_EVENT_NAME || "";
  if (event !== "workflow_dispatch" || ref !== "refs/heads/main") {
    throw new Error("UNTRUSTED_REF: production smoke must be manually dispatched from refs/heads/main.");
  }
}

function currentGitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function verifyGitLineage(servingSha, trustedMainSha = currentGitHead()) {
  execFileSync("git", ["merge-base", "--is-ancestor", TARGET_SHA, servingSha], { stdio: "pipe" });
  execFileSync("git", ["merge-base", "--is-ancestor", servingSha, trustedMainSha], { stdio: "pipe" });
  for (const file of PR976_FILES) {
    const expected = execFileSync("git", ["show", `${TARGET_SHA}:${file}`]);
    const observed = execFileSync("git", ["show", `${servingSha}:${file}`]);
    if (sha256(expected) !== sha256(observed)) {
      throw new Error(`PR976_FILE_DRIFT:${file}`);
    }
  }
}

export async function fetchJson(url, init = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("REQUEST_DEADLINE_EXCEEDED")), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const reader = response.body?.getReader();
    let received = 0;
    const chunks = [];
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("INVALID_JSON_RESPONSE");
      }
    }
    if (!response.ok) {
      const error = new Error(`HTTP_${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("LOGIN_COOKIE_MISSING");
  return setCookie.split(";")[0];
}

async function login(baseUrl, email, password) {
  const response = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return cookieFrom(response);
}

async function internal(baseUrl, cookie, body, timeoutMs) {
  return (await fetchJson(`${baseUrl}/api/internal/smoke/pr976-action-goal`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  }, { timeoutMs })).body;
}

export function expectVersionConflictStatus(result) {
  if (result?.status !== "VERSION_CONFLICT") {
    throw Object.assign(new Error("VERSION_CONFLICT_NOT_RETURNED"), { body: result });
  }
}

export function assertActionProofResponse(action, actionId, baselineVersion) {
  if (
    action?.action?.id !== actionId
    || action.action.bodyMd !== ACTION_PROVEN_BODY
    || action.action.version !== baselineVersion + 1
  ) {
    throw Object.assign(new Error("ACTION_PROOF_WRITE_UNPROVEN"), { body: action });
  }
}

export function assertActionNoEffect(status, actionId, provenVersion) {
  if (
    status?.action?.id !== actionId
    || status.action.bodyMd !== ACTION_PROVEN_BODY
    || status.action.version !== provenVersion
  ) {
    throw Object.assign(new Error("ACTION_STALE_NO_EFFECT_UNPROVEN"), { body: status });
  }
}

export function assertGoalProofResponse(result, goalId, baselineVersion) {
  if (
    result?.id !== goalId
    || result.status !== "DRAFT"
    || result.version !== baselineVersion + 1
  ) {
    throw Object.assign(new Error("GOAL_PROOF_WRITE_UNPROVEN"), { body: result });
  }
}

export function assertGoalStatusProof(status, goalId, progressPercent, provenVersion) {
  if (
    status?.goal?.id !== goalId
    || status.goal.progressPercent !== progressPercent
    || status.goal.version !== provenVersion
  ) {
    throw Object.assign(new Error("GOAL_STATUS_PROOF_UNPROVEN"), { body: status });
  }
}

function releaseDriftBlocker(release) {
  const drift = release?.drift;
  if (!drift) return null;
  if (drift.gitSha || drift.imageTag || drift.version) {
    return drift.details?.length ? drift.details.join("; ") : JSON.stringify(drift);
  }
  return null;
}

export function assertReleaseRuntime(release, expectedGitSha) {
  if (release?.gitSha !== expectedGitSha) {
    throw Object.assign(new Error("SERVING_SHA_MISMATCH"), { body: { release } });
  }
  if (release?.runtime?.gitSha !== expectedGitSha || !/^[0-9a-f]{40}$/i.test(release.runtime.gitSha)) {
    throw Object.assign(new Error("SERVING_RUNTIME_SHA_MISMATCH"), { body: { release } });
  }
  if (!release.runtime.source) {
    throw Object.assign(new Error("SERVING_RUNTIME_SOURCE_MISSING"), { body: { release } });
  }
  if (
    release?.image?.gitSha !== expectedGitSha
    || release.image.source !== "image_stamp"
    || release.image.valid !== true
  ) {
    throw Object.assign(new Error("SERVING_IMAGE_SHA_MISMATCH"), { body: { release } });
  }
  const drift = releaseDriftBlocker(release);
  if (drift) {
    throw Object.assign(new Error("SERVING_RELEASE_DRIFT"), { body: { drift, release } });
  }
}

async function verifyHealth(baseUrl, expectedGitSha) {
  const health = await fetchJson(`${baseUrl}/api/health`, {}, { timeoutMs: 20_000 });
  const body = health.body;
  if (body?.status !== "ok" || body?.database !== "up" || body?.schema !== "ready") {
    throw Object.assign(new Error("HEALTH_NOT_READY"), { body });
  }
  assertReleaseRuntime(body.release, expectedGitSha);
  return body.release;
}

async function writeEvidence(outDir, evidence) {
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/summary.json`, `${JSON.stringify(sanitize(evidence), null, 2)}\n`);
}

export async function run() {
  assertTrustedRef();
  const baseUrl = (process.env.PRODUCTION_BASE_URL || "https://app.corgtex.com").replace(/\/$/, "");
  const email = requireEnv(["PRODUCTION_VALIDATION_ADMIN_EMAIL", "ADMIN_EMAIL"]);
  const password = requireEnv(["PRODUCTION_VALIDATION_ADMIN_PASSWORD", "ADMIN_PASSWORD"]);
  const deployedSha = requireEnv(["EXPECTED_DEPLOYED_SHA", "GITHUB_SHA"]);
  const outDir = process.env.OUT_DIR || ".artifacts/production-validation/pr976-action-goal";
  const evidence = { operationKey: OPERATION_KEY, targetPullRequest: TARGET_PR, deployedSha, steps: [] };
  const execution = {
    operationKey: OPERATION_KEY,
    workflowRunId: process.env.GITHUB_RUN_ID || "",
    workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
  };
  let cookie;
  let token;
  try {
    verifyGitLineage(deployedSha);
    evidence.steps.push({ name: "lineage", status: "passed" });
    const initialRelease = await verifyHealth(baseUrl, deployedSha);
    evidence.steps.push({ name: "pre-provision-health", status: "passed", release: initialRelease });
    cookie = await login(baseUrl, email, password);
    const provision = await internal(baseUrl, cookie, {
      operation: "provision",
      ...execution,
      deployedSha,
      ancestorSha: TARGET_SHA,
    }, 45_000);
    token = provision.credentialToken;
    if (!token) throw new Error("CREDENTIAL_TOKEN_NOT_RETURNED_FOR_NEW_CLAIM");
    const { workspaceId, actionId, goalId, actionBaselineVersion, goalBaselineVersion } = provision.receipt;
    const action = await internal(baseUrl, cookie, { operation: "prove_action", ...execution }, 20_000);
    assertActionProofResponse(action, actionId, actionBaselineVersion);
    const staleAction = await internal(baseUrl, cookie, { operation: "prove_action_stale", ...execution }, 20_000);
    expectVersionConflictStatus(staleAction);
    const afterAction = await internal(baseUrl, cookie, { operation: "status", ...execution }, 20_000);
    assertActionNoEffect(afterAction, actionId, action.action.version);
    const goalUpdate = await internal(baseUrl, cookie, { operation: "prove_goal", ...execution }, 20_000);
    assertGoalProofResponse(goalUpdate, goalId, goalBaselineVersion);
    const afterGoalWrite = await internal(baseUrl, cookie, { operation: "status", ...execution }, 20_000);
    assertGoalStatusProof(afterGoalWrite, goalId, GOAL_PROGRESS, goalUpdate.version);
    const staleGoal = await internal(baseUrl, cookie, { operation: "prove_goal_stale", ...execution }, 20_000);
    expectVersionConflictStatus(staleGoal);
    const afterGoal = await internal(baseUrl, cookie, { operation: "status", ...execution }, 20_000);
    assertGoalStatusProof(afterGoal, goalId, GOAL_PROGRESS, goalUpdate.version);
    await internal(baseUrl, cookie, {
      operation: "feature_proof",
      ...execution,
      actionObservedBodyMd: ACTION_PROVEN_BODY,
      actionObservedVersion: afterAction.action.version,
      goalObservedProgress: GOAL_PROGRESS,
      goalObservedVersion: afterGoal.goal.version,
    }, 20_000);
    const terminal = await internal(baseUrl, cookie, { operation: "terminalize", ...execution, mode: "all" }, CLEANUP_RESERVE_MS);
    if (terminal.receipt.outcome !== "COMPLETED") throw new Error("TERMINAL_RECEIPT_INCOMPLETE");
    const terminalRelease = await verifyHealth(baseUrl, deployedSha);
    evidence.steps.push({ name: "feature-and-cleanup", status: "passed", receipt: terminal.receipt });
    evidence.steps.push({ name: "post-cleanup-health", status: "passed", release: terminalRelease });
    await writeEvidence(outDir, evidence);
  } catch (error) {
    evidence.error = { message: error.message, status: error.status, body: sanitize(error.body ?? null) };
    if (cookie) {
      try {
        evidence.terminalizeAfterFailure = await internal(baseUrl, cookie, {
          operation: "terminalize",
          ...execution,
          mode: "all",
          failureCode: "DRIVER_FAILURE",
          failureMessage: error.message,
        }, CLEANUP_RESERVE_MS);
      } catch (cleanupError) {
        evidence.cleanupError = { message: cleanupError.message, status: cleanupError.status, body: sanitize(cleanupError.body ?? null) };
      }
    }
    await writeEvidence(outDir, evidence);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(JSON.stringify(sanitize({ error: error.message, body: error.body ?? null })));
    process.exitCode = 1;
  });
}
