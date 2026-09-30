#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readPin, resolveBaseline, identityHash, verifiedSmokeChecks } from "../accepted-core-baseline.mjs";
import { verifyRecoveryDatabase } from "../core-readonly-database.mjs";
export { recoveryTls, verifyRecoveryDatabase } from "../core-readonly-database.mjs";
import { recoverCore, recoveryStage, RECOVERY_STATE_QUERY } from "./core-recovery.mjs";

const REPO = "Corgtexdotcom/corgtex";
const WORKFLOW = ".github/workflows/core-recovery.yml";
export const DEPLOY_STEP = "Restore and verify incident-bound Core runtime";
const ROOT = ".artifacts/core-recovery";
const check = (ok, code) => { if (!ok) throw new Error(`CORE_RECOVERY_${code}`); };
const same = (a, b) => identityHash(a) === identityHash(b);

export function inspectAcceptedRecoveryImage(role, digest, execute = (args) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, maxBuffer: 1024 * 1024,
})) {
  check(["web", "worker"].includes(role) && /^sha256:[a-f0-9]{64}$/.test(digest), "REGISTRY_BINDING");
  const image = `ghcr.io/corgtexdotcom/corgtex/${role}@${digest}`;
  let manifest; let entries;
  try {
    const root = execute(["buildx", "imagetools", "inspect", "--format", "{{json .Manifest}}", image]);
    const platforms = execute(["manifest", "inspect", "--verbose", image]);
    check(typeof root === "string" && typeof platforms === "string"
      && Buffer.byteLength(root) <= 1024 * 1024 && Buffer.byteLength(platforms) <= 1024 * 1024, "REGISTRY_OUTPUT");
    manifest = JSON.parse(root);
    const parsed = JSON.parse(platforms);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch { throw new Error("CORE_RECOVERY_REGISTRY_READ_UNVERIFIED"); }
  // Provider metadata can identify an image index. Its platform descriptor is
  // a different digest; preserve the accepted root and prove its amd64 child.
  check(manifest?.digest === digest
    && Number.isSafeInteger(manifest.size) && manifest.size > 0, "BASELINE_REGISTRY_DIGEST");
  const index = ["application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json"].includes(manifest.mediaType);
  check(index || ["application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json"].includes(manifest.mediaType), "REGISTRY_MEDIA_TYPE");
  const amd64 = entries.filter(entry => entry?.Descriptor?.platform?.os === "linux"
    && entry.Descriptor.platform.architecture === "amd64");
  check(amd64.length === 1 && /^sha256:[a-f0-9]{64}$/.test(amd64[0].Descriptor.digest), "REGISTRY_PLATFORM");
  const platformDigest = amd64[0].Descriptor.digest;
  if (index) {
    check(manifest.schemaVersion === 2 && Array.isArray(manifest.manifests), "REGISTRY_INDEX");
    const children = manifest.manifests.filter(child => child?.platform?.os === "linux" && child.platform.architecture === "amd64");
    check(children.length === 1 && children[0].digest === platformDigest, "REGISTRY_INDEX_PLATFORM");
  } else check(platformDigest === digest, "REGISTRY_MANIFEST_PLATFORM");
  return { role, image, acceptedDigest: digest, mediaType: manifest.mediaType,
    platform: "linux/amd64", platformManifestDigest: platformDigest };
}

export function trustedRecoveryContext(env) {
  check(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_EVENT_NAME === "workflow_dispatch"
    && env.GITHUB_WORKFLOW_REF === `${REPO}/${WORKFLOW}@refs/heads/main`
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA), "PROTECTED_MAIN_REQUIRED");
}

export function assertRecoveryControlPlane(body, request, target, configured) {
  check(Array.isArray(body?.deployments) && body.deployments.length > 0
    && body.deployments.every(row => !row.releaseLeaseId), "RELEASE_LEASE_PRESENT");
  const matches = body.deployments.filter(row => row.id === request.controlPlaneDeploymentId);
  check(matches.length === 1 && matches[0].url?.replace(/\/$/, "") === target.origin
    && matches[0].cloudProvider === "RAILWAY" && matches[0].deploymentKind === "INTERNAL"
    && matches[0].environment === "internal" && !matches[0].remoteWorkspaceId, "CORE_CLASSIFICATION");
  // Legacy Core has no provider IDs in its Ops record. Bind physical identity
  // independently to the reviewed workflow target and accepted receipt.
  check(configured?.provider === "railway" && configured.url?.replace(/\/$/, "") === target.origin
    && ["projectId", "environmentId", "webServiceId", "workerServiceId"].every(key => configured.railway?.[key] === target[key]), "CONFIGURED_TARGET");
}

export async function reserveGithubDeployment(intent, { env, api }) {
  trustedRecoveryContext(env);
  // GitHub's persisted attempt/job/step journal is the durable incident barrier.
  // A workflow rerun is forbidden, including one after an uncertain response.
  check(env.GITHUB_RUN_ATTEMPT === "1" && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID), "RECONCILIATION_REQUIRED");
  const listing = await api(`actions/workflows/core-recovery.yml/runs?event=workflow_dispatch&branch=main&per_page=100`);
  check(Number.isInteger(listing.total_count) && listing.total_count <= 100
    && Array.isArray(listing.workflow_runs) && listing.workflow_runs.length === listing.total_count, "RECOVERY_HISTORY_UNBOUNDED");
  let currentFound = false;
  for (const run of listing.workflow_runs) {
    check(run.repository?.full_name === REPO && run.head_repository?.full_name === REPO
      && run.path === WORKFLOW && run.head_branch === "main" && run.event === "workflow_dispatch"
      && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 && run.run_attempt <= 10, "RECOVERY_HISTORY_UNTRUSTED");
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const jobs = await api(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
      check(Number.isInteger(jobs.total_count) && jobs.total_count <= 100
        && Array.isArray(jobs.jobs) && jobs.jobs.length === jobs.total_count, "RECOVERY_JOBS_UNBOUNDED");
      for (const job of jobs.jobs) {
        const steps = job.steps?.filter(step => step.name === DEPLOY_STEP) ?? [];
        check(steps.length <= 1, "DEPLOYMENT_STEP_AMBIGUOUS");
        const step = steps[0];
        const submitted = step && step.conclusion !== "skipped" && step.started_at;
        if (!submitted) continue;
        if (run.id === Number(env.GITHUB_RUN_ID) && attempt === 1) {
          check(!currentFound && run.head_sha === env.GITHUB_SHA && job.name === "Recover existing Core"
            && job.run_id === run.id && job.run_attempt === 1 && step.status === "in_progress"
            && Number.isFinite(Date.parse(step.started_at)), "CURRENT_INTENT_UNVERIFIED");
          currentFound = true;
        } else {
          // Conservative once-per-incident submission. Even an earlier failed
          // step may have submitted a request whose provider observation lags.
          check(false, "PRIOR_DEPLOYMENT_RECONCILIATION_REQUIRED");
        }
      }
    }
  }
  check(currentFound, "DURABLE_INTENT_NOT_VISIBLE");
  return { reserved: true, intent, githubRunId: Number(env.GITHUB_RUN_ID), githubRunAttempt: 1 };
}

async function githubApi(path, env) {
  check(env.GITHUB_TOKEN, "GITHUB_READ_AUTH_REQUIRED");
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    redirect: "error", signal: AbortSignal.timeout(30000),
  });
  check(response.ok, "GITHUB_READ_FAILED");
  return response.json();
}

async function graphql(query, variables, env) {
  check(env.RAILWAY_API_TOKEN, "RAILWAY_AUTH_REQUIRED");
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { Authorization: `Bearer ${env.RAILWAY_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(30000),
  });
  check(response.ok, "PROVIDER_REQUEST_FAILED");
  const body = await response.json();
  check(!body.errors && body.data, "PROVIDER_REQUEST_REJECTED");
  return body.data;
}

export async function waitForRecoveredWeb(runtime, restoredSettings, {
  query, fetchImpl = fetch, now = Date.now, sleep = delay, timeoutMs = 600000,
}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const data = await query(`query CoreRecoveryDeployment($id: String!) { deployment(id: $id) { id status meta } }`, { id: runtime.images.web.deploymentId });
    check(data.deployment?.id === runtime.images.web.deploymentId, "RECOVERED_DEPLOYMENT_ID");
    const status = data.deployment.status;
    check(!["FAILED", "CRASHED", "REMOVED", "SKIPPED"].includes(status), "RECOVERED_DEPLOYMENT_FAILED");
    if (status === "SUCCESS") {
      check(data.deployment.meta?.imageDigest === runtime.images.web.digest, "RECOVERED_DIGEST");
      let response;
      try { response = await fetchImpl(`${runtime.target.origin}/api/health`, { redirect: "error", signal: AbortSignal.timeout(30000) }); }
      catch { /* Startup/network readiness remains bounded by the same deadline. */ }
      if (response?.ok) {
        const health = await response.json();
        const release = health.release;
        check(!release?.gitSha || release.gitSha === runtime.sourceSha, "RECOVERED_HEALTH_IDENTITY");
        check(!release?.imageTag || release.imageTag === restoredSettings.CORGTEX_RELEASE_IMAGE_TAG, "RECOVERED_HEALTH_IDENTITY");
        check(!release?.version || release.version === restoredSettings.CORGTEX_RELEASE_VERSION, "RECOVERED_HEALTH_IDENTITY");
        check(!release?.drift || ![release.drift.gitSha, release.drift.imageTag, release.drift.version].includes(true), "RECOVERED_HEALTH_IDENTITY");
        if (health.database === "up" && health.schema === "ready" && release?.gitSha === runtime.sourceSha
          && release.imageTag === restoredSettings.CORGTEX_RELEASE_IMAGE_TAG && release.version === restoredSettings.CORGTEX_RELEASE_VERSION
          && release.drift?.gitSha === false && release.drift.imageTag === false && release.drift.version === false) return;
      } else if (response) {
        check([500, 502, 503, 504].includes(response.status), "RECOVERED_HEALTH_REJECTED");
      }
    }
    await sleep(10000);
  }
  check(false, "RECOVERY_DEPLOYMENT_TIMEOUT");
}

export async function runRecovery({ env = process.env, mode = process.argv[2] } = {}) {
  trustedRecoveryContext(env);
  const request = JSON.parse(await readFile(".github/core-recovery-incident.json", "utf8"));
  const pin = await readPin();
  check(pin, "ACCEPTED_PIN_REQUIRED");
  let receiptBytes;
  const receipt = await resolveBaseline(pin, { persist: bytes => { receiptBytes = bytes; } });
  await mkdir(ROOT, { recursive: true });
  if (mode === "prepare") {
    if (env.GITHUB_OUTPUT) await writeFile(env.GITHUB_OUTPUT, `source_sha=${pin.sourceSha}\n`, { flag: "a" });
    console.log("Accepted Core receipt provenance verified; no promotion performed.");
    return;
  }
  check(mode === "plan" || mode === "recover", "MODE_REQUIRED");
  const { default: pg } = await import("pg");
  const sourceDir = resolve(".baseline/source");
  const api = path => githubApi(path, env);
  const query = (text, variables) => graphql(text, variables, env);
  const verifyRuntime = async (runtime, restoredSettings) => {
    await waitForRecoveredWeb(runtime, restoredSettings, { query });
    for (const role of ["web", "worker"]) {
      const target = runtime.target;
      const state = recoveryStage(await query(RECOVERY_STATE_QUERY, { projectId: target.projectId,
        environmentId: target.environmentId, serviceId: target[`${role}ServiceId`] }), target, role);
      check(same(state.latestDeployment, { id: runtime.images[role].deploymentId, status: "SUCCESS" })
        && same(state.activeDeployments, [{ id: runtime.images[role].deploymentId, status: "SUCCESS" }])
        && state.history.some(row => row.id === runtime.images[role].deploymentId && row.status === "SUCCESS"
          && row.digest === runtime.images[role].digest)
        && state.image === `ghcr.io/corgtexdotcom/corgtex/${role}@${runtime.images[role].digest}`
        && same(state.releaseSettings, restoredSettings), "RECOVERED_PROVIDER_READBACK");
    }
    check(env.ADMIN_EMAIL && env.ADMIN_PASSWORD, "AUTH_SMOKE_CREDENTIALS");
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from "node:url";
      process.argv=[process.execPath,"scripts/railway-smoke.mjs",process.env.APP_URL,process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD];
      await import(pathToFileURL(process.cwd()+"/scripts/railway-smoke.mjs"));
    `], { cwd: sourceDir, stdio: "pipe", timeout: 180000, maxBuffer: 128000, env: {
      PATH: env.PATH, ADMIN_EMAIL: env.ADMIN_EMAIL, ADMIN_PASSWORD: env.ADMIN_PASSWORD,
      APP_URL: runtime.target.origin, GITHUB_SHA: runtime.sourceSha, CORGTEX_EXPECTED_RELEASE_GIT_SHA: runtime.sourceSha,
      CORGTEX_SKIP_RELEASE_MATCH: "false", CORGTEX_RELEASE_MATCH_TIMEOUT_MS: "60000",
    } });
    verifiedSmokeChecks(stdout.toString());
  };
  let registryProofs;
  const result = await recoverCore({ request, receipt, receiptBytes, pin, dryRun: mode === "plan" }, {
    graphql: query,
    assertContext: async (_request, target) => {
      const run = await api(`actions/runs/${request.failedRunId}`);
      check(run.run_attempt === request.failedRunAttempt && run.status === "completed" && run.conclusion === "failure"
        && run.path === ".github/workflows/fleet-release.yml" && run.head_sha === request.failedCandidateSha
        && run.head_branch === "main" && run.event === "workflow_dispatch"
        && run.repository?.full_name === REPO && run.head_repository?.full_name === REPO, "FAILED_FLEET_BINDING");
      const active = await api("actions/workflows/fleet-release.yml/runs?status=in_progress&per_page=100");
      check(active.total_count === 0 && active.workflow_runs?.length === 0, "ACTIVE_FLEET_RELEASE");
      check(env.CONTROL_PLANE_AGENT_API_KEY, "CONTROL_PLANE_READ_AUTH");
      const response = await fetch("https://ops.corgtex.com/api/control-plane/deployments", {
        headers: { Authorization: `Bearer cp-${env.CONTROL_PLANE_AGENT_API_KEY}` }, redirect: "error", signal: AbortSignal.timeout(30000),
      });
      check(response.ok, "CONTROL_PLANE_READ_FAILED");
      assertRecoveryControlPlane(await response.json(), request, target, JSON.parse(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON || "null"));
    },
    verifyDatabase: (evidence, schema) => verifyRecoveryDatabase(evidence, schema, request, { env, sourceDir, Client: pg.Client }),
    verifyRegistry: async evidence => {
      registryProofs = ["web", "worker"].map(role => inspectAcceptedRecoveryImage(role, evidence.images[role].digest));
    },
    reserveDeployment: intent => reserveGithubDeployment(intent, { env, api }),
    verifyRuntime,
  });
  await writeFile(`${ROOT}/${mode}.json`, JSON.stringify({ ...result, registryProofs, workflowSha: env.GITHUB_SHA,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), verifiedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log(mode === "plan" ? "Read-only incident recovery plan verified." : "Recovered Core runtime verified; baseline adoption is still required.");
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runRecovery().catch(async error => {
    const code = /^CORE_(RECOVERY|BASELINE)_[A-Z_]+$/.test(error.message) ? error.message : "CORE_RECOVERY_UNVERIFIED";
    const mode = ["prepare", "plan", "recover"].includes(process.argv[2]) ? process.argv[2] : "unknown";
    await mkdir(ROOT, { recursive: true });
    await writeFile(`${ROOT}/${mode}-failed.json`, JSON.stringify({ status: "unverified", mode, code,
      providerWrites: mode === "plan" || mode === "prepare" ? false : "unknown; reconcile before resubmission" }) + "\n", { mode: 0o600 });
    console.error(code);
    process.exitCode = 1;
  });
}
