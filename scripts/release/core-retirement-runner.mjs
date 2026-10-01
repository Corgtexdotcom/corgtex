#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readPin, resolveBaseline, identityHash, sha256 } from "../accepted-core-baseline.mjs";
import { RECOVERY_STATE_QUERY } from "./core-recovery.mjs";
import { inspectAcceptedRecoveryImage, assertRecoveryControlPlane } from "./core-recovery-runner.mjs";
import { RailwaySourceFence, createRailwayFenceTransport } from "../migration/railway-source-fence.mjs";
import { CORE_RETIREMENT_TARGET as target, CORE_DEPLOYMENT_ID, CORE_SOURCE_SHA, ROLES, need,
  retirementStage, retirementCommand, assertQuietTriggers, retireCore, recoverCoreHealthcheck } from "./core-retirement.mjs";
import { RECONCILE_STEP, RECONCILIATION_CASE, validateReconciliationEvidence,
  validateReconciliationApproval, downloadReconciliationMembers } from "./core-retirement-reconciliation.mjs";

import { HEALTHCHECK_CASE, HEALTHCHECK_STEP, validateHealthcheckPredecessors, validateHealthcheckRecoveryApproval } from "./core-retirement-healthcheck-recovery.mjs";

import { privateConfigurationFingerprints, sealConfigurationDiagnostic } from "./core-retirement-config-diagnostic.mjs";
import { verifyRetirementHistoryContinuity } from "./core-retirement-history-continuity.mjs";
import { WEB_COMPLETION_CASE, WEB_COMPLETION_STEP, completeCoreWebRetirement, validateWebCompletionPredecessors,
  validateWebCompletionApproval, verifyWebCompletionContinuity } from "./core-retirement-web-completion.mjs";
import { FINALIZATION_CASE, validateFinalizationPredecessors, verifyReadOnlyFinalization } from "./core-retirement-finalization.mjs";

const DIAGNOSTIC_RECIPIENT_SHA256 = "7fa67952a19d19d64e73d7174eee2b7a38bdf94c59c1071c8e30a9f9d1d9f907";
const REPO = "Corgtexdotcom/corgtex";
const WORKFLOW = ".github/workflows/core-retirement.yml";
export const EXECUTE_STEP = "Retire reviewed Core application execution";
const ROOT = ".artifacts/core-retirement";
const same = (a, b) => identityHash(a) === identityHash(b);
export function trustedRetirementContext(env) {
  need(env.GITHUB_REPOSITORY === REPO && env.GITHUB_REF === "refs/heads/main"
    && env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_WORKFLOW_REF === `${REPO}/${WORKFLOW}@refs/heads/main`
    && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA), "PROTECTED_MAIN_REQUIRED");
}

export async function reserveRetirementIntent({ env, api, reconciliation = false, healthcheckRecovery = false, webCompletion = false }) {
  trustedRetirementContext(env);
  need(env.GITHUB_RUN_ATTEMPT === "1" && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID), "RECONCILIATION_REQUIRED");
  const listing = await api("actions/workflows/core-retirement.yml/runs?event=workflow_dispatch&branch=main&per_page=100");
  need(Number.isInteger(listing.total_count) && listing.total_count <= 100
    && listing.workflow_runs?.length === listing.total_count, "HISTORY_UNBOUNDED");
  let current = false;
  const expectedPredecessors = webCompletion ? [RECONCILIATION_CASE, HEALTHCHECK_CASE, WEB_COMPLETION_CASE]
    : healthcheckRecovery ? [RECONCILIATION_CASE, HEALTHCHECK_CASE] : reconciliation ? [RECONCILIATION_CASE] : [];
  const predecessors = new Set();
  for (const run of listing.workflow_runs) {
    need(run.repository?.full_name === REPO && run.head_repository?.full_name === REPO
      && run.path === WORKFLOW && run.head_branch === "main" && run.event === "workflow_dispatch"
      && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 && run.run_attempt <= 10, "UNTRUSTED_HISTORY");
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      const listing = await api(`actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`);
      need(Number.isInteger(listing.total_count) && listing.total_count <= 100
        && listing.jobs?.length === listing.total_count, "JOBS_UNBOUNDED");
      for (const job of listing.jobs) for (const step of job.steps || []) {
        if (![EXECUTE_STEP, RECONCILE_STEP, HEALTHCHECK_STEP, WEB_COMPLETION_STEP].includes(step.name) || step.conclusion === "skipped" || !step.started_at) continue;
        const incident = expectedPredecessors.find(incident => run.id === incident.runId);
        if (incident) {
          need(!predecessors.has(run.id) && attempt === 1 && run.run_attempt === 1 && run.head_sha === incident.workflowSha
            && run.status === "completed" && run.conclusion === "failure" && job.id === incident.jobId
            && job.name === "Retire existing Core" && job.run_id === run.id && job.run_attempt === 1
            && step.name === (incident.stepName || EXECUTE_STEP) && step.status === "completed" && step.conclusion === "failure"
            && Number.isFinite(Date.parse(step.started_at)), "RECONCILIATION_PREDECESSOR_INVALID");
          predecessors.add(run.id); continue;
        }
        need(!current && run.id === Number(env.GITHUB_RUN_ID) && attempt === 1
          && run.head_sha === env.GITHUB_SHA && job.name === "Retire existing Core"
          && job.run_id === run.id && job.run_attempt === 1 && step.status === "in_progress"
          && step.name === (webCompletion ? WEB_COMPLETION_STEP : healthcheckRecovery ? HEALTHCHECK_STEP : reconciliation ? RECONCILE_STEP : EXECUTE_STEP)
          && Number.isFinite(Date.parse(step.started_at)), "PRIOR_EXECUTION_RECONCILIATION_REQUIRED");
        current = true;
      }
    }
  }
  need(current, "DURABLE_INTENT_NOT_VISIBLE");
  need(predecessors.size === expectedPredecessors.length, "RECONCILIATION_PREDECESSOR_MISSING");
  return true;
}

export function assertNodeEntrypoint(config, entrypointSource = "") {
  if (config.Entrypoint === null || same(config.Entrypoint, [])) return;
  need(same(config.Entrypoint, ["docker-entrypoint.sh"]), "IMAGE_ENTRYPOINT_UNSUPPORTED");
  const code = entrypointSource.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("#")).join("\n");
  const allowed = ["set -e", 'if [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ] || { [ -f "${1}" ] && ! [ -x "${1}" ]; }; then',
    'set -- node "$@"', "fi", 'exec "$@"'].join("\n");
  need(code === allowed, "IMAGE_ENTRYPOINT_UNPROVEN");
}

export function opsRetirementSnapshot(body, configured) {
  assertRecoveryControlPlane(body, { controlPlaneDeploymentId: CORE_DEPLOYMENT_ID },
    { ...target, origin: "https://app.corgtex.com" }, configured);
  // Bind classifications/mappings without persisting keys or customer content.
  return identityHash(body.deployments.map(row => ({ id: row.id, url: row.url, cloudProvider: row.cloudProvider,
    deploymentKind: row.deploymentKind, environment: row.environment, remoteWorkspaceId: row.remoteWorkspaceId,
    releaseLeaseId: row.releaseLeaseId ?? null, deploymentStatus: row.deploymentStatus,
    providerProjectId: row.providerProjectId, providerEnvironmentId: row.providerEnvironmentId,
    providerWebServiceId: row.providerWebServiceId, providerWorkerServiceId: row.providerWorkerServiceId,
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

// Fence.read() does not expose a start command or full configuration hash:
// sourceLinkSha256 binds source.image/repo only. The sole command exception is
// separately checked against both instance and config before hashing the rest.
export function stableRetirementFence(snapshot, draining = null) {
  const quiet = structuredClone(snapshot);
  if (draining) for (const service of quiet.services) {
    if (service.serviceId !== target[`${draining.role}ServiceId`]) continue;
    for (const deployment of service.deployments) {
      if (draining.previousIds.includes(deployment.id) && deployment.status === "REMOVING") deployment.status = "REMOVED";
    }
  }
  // Only our exact predecessor's removal may be pending while draining. All
  // other deployments, staging, triggers and environment work remain closed.
  assertQuietTriggers(quiet);
  const deployment = ({ updatedAt: _updated, instances, ...row }) => ({ ...row,
    instances: instances.map(instance => ({ ...instance })).sort((a, b) => a.idRef.localeCompare(b.idRef)) });
  const { id: _emptyStagingId, ...staged } = snapshot.staged;
  return { ...snapshot, staged, services: snapshot.services.map(service => {
    const { resolvedAt: _resolvedAt, ...fileConfig } = service.fileConfig || {};
    return { ...service, fileConfig: service.fileConfig ? fileConfig : null,
      activeDeployments: service.activeDeployments.map(deployment).sort((a, b) => a.id.localeCompare(b.id)),
      deployments: service.deployments.map(deployment).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }).sort((a, b) => a.serviceId.localeCompare(b.serviceId)) };
}

export function configurationDriftDiagnostic(before, after, key = randomBytes(32)) {
  const fingerprint = value => createHmac("sha256", key).update(JSON.stringify(value) ?? "undefined").digest("hex");
  const fields = new Set(["web", "worker", "config", "variables", "source", "deploy", "build", "image", "repo", "checkSuites",
    "startCommand", "registryCredentials", "username", "password", "restartPolicyType", "restartPolicyMaxRetries", "drainingSeconds",
    "overlapSeconds", "healthcheckPath", "healthcheckTimeout", "cronSchedule", "builder", "buildCommand", "watchPatterns"]);
  const changes = []; let total = 0;
  const visit = (left, right, path) => {
    if (same(left ?? null, right ?? null) && (left === undefined) === (right === undefined)) return;
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const safe = fields.has(name) ? name : `field-${fingerprint(name).slice(0, 16)}`;
        visit(left[name], right[name], [...path, safe]);
      }
      return;
    }
    total++;
    if (changes.length < 64) changes.push({ path: path.join("."), beforePresent: left !== undefined, afterPresent: right !== undefined,
      beforeType: left === null ? "null" : typeof left, afterType: right === null ? "null" : typeof right,
      beforeFingerprint: fingerprint(left), afterFingerprint: fingerprint(right) });
  };
  visit(before, after, []);
  return { kind: "redacted-preserved-configuration-drift", totalChanges: total, truncated: total > changes.length, changes };
}

export function createRetirementStateReader({ query, fence, evidence, commands, expectedConfigIdentity, onConfigDrift = async () => {}, onInitialConfigMismatch = async () => {} }) {
  let configIdentity, firstConfig;
  const diagnosticKey = randomBytes(32);
  return async ({ draining = null } = {}) => {
    const stages = {};
    const privateConfig = {};
    for (const role of ROLES) {
      const data = await query(RECOVERY_STATE_QUERY, { projectId: target.projectId, environmentId: target.environmentId,
        serviceId: target[`${role}ServiceId`] });
      if (draining?.role === role && Array.isArray(data.pending?.edges)) {
        data.pending.edges = data.pending.edges.filter(({ node }) =>
          !(draining.previousIds.includes(node.id) && node.status === "REMOVING"));
      }
      stages[role] = retirementStage(data, evidence.target, role, commands[role]);
      stages[role].activeDeployments.sort((a, b) => a.id.localeCompare(b.id));
      stages[role].history.sort((a, b) => a.id.localeCompare(b.id));
      const config = structuredClone(data.environment.config.services[target[`${role}ServiceId`]]);
      need(config.deploy?.startCommand === stages[role].startCommand, "CONFIG_COMMAND_MISMATCH");
      need([null, undefined, "/api/health", ...(role === "worker" ? ["/healthz"] : [])].includes(config.deploy.healthcheckPath), "HEALTHCHECK_PATH_UNSUPPORTED");
      delete config.deploy.startCommand;
      privateConfig[role] = { config, variables: data.variables };
    }
    const hash = identityHash(privateConfig);
    if (configIdentity && hash !== configIdentity) {
      try { await onConfigDrift(configurationDriftDiagnostic(firstConfig, privateConfig, diagnosticKey)); }
      catch { /* Diagnostic failures must not mask or relax the drift gate. */ }
      need(false, "PRESERVED_CONFIG_CHANGED");
    } else if (!configIdentity) {
      if (expectedConfigIdentity && hash !== expectedConfigIdentity) {
        try { await onInitialConfigMismatch({ expectedConfigIdentity, observedConfigIdentity: hash, privateConfig }); }
        catch { /* Diagnostic failures cannot mask or relax the unchanged gate. */ }
        need(false, "RECONCILIATION_PRIVATE_CONFIG_CHANGED");
      }
      configIdentity = hash; firstConfig = structuredClone(privateConfig);
    }
    return { stages, fence: stableRetirementFence(await fence.read(), draining), configIdentity: hash };
  };
}

export async function waitForRetiredRuntime({ role, deploymentId, command, previous, digest }, {
  query, readState, now = Date.now, sleep = delay, timeoutMs = 300000, signal, onHistorySupplement = async () => {},
}) {
  const deadline = now() + timeoutMs;
  const previousIds = previous.stages[role].activeDeployments.map(row => row.id);
  need(previousIds.length === 1 && previousIds[0] !== deploymentId, "PREDECESSOR_BINDING");
  while (now() < deadline) {
    const result = await query("query RetirementDeployment($id:String!) { deployment(id:$id) { id status meta } }", { id: deploymentId });
    need(result.deployment?.id === deploymentId
      && !["CRASHED", "FAILED", "REMOVED", "SKIPPED"].includes(result.deployment.status), "UTILITY_DEPLOYMENT_FAILED");
    if (result.deployment.meta?.imageDigest) need(result.deployment.meta.imageDigest === digest, "UTILITY_IMAGE_CHANGED");
    if (result.deployment.status === "SUCCESS") {
      need(result.deployment.meta?.imageDigest === digest, "UTILITY_IMAGE_CHANGED");
      const state = await readState({ draining: { role, previousIds } });
      const other = role === "worker" ? "web" : "worker";
      need(same(state.stages[other], previous.stages[other]), "OTHER_SERVICE_CHANGED");
      const stage = state.stages[role];
      need(stage.history.some(row => row.id === deploymentId && row.digest === digest)
        && previousIds.every(id => stage.history.some(row => row.id === id && row.digest === digest)), "UTILITY_IMAGE_CHANGED");
      need(stage.startCommand === command && same(stage.releaseSettings, previous.stages[role].releaseSettings)
        && stage.image === previous.stages[role].image
        && same(stage.latestDeployment, { id: deploymentId, status: "SUCCESS" })
        && stage.activeDeployments.every(row => (row.id === deploymentId && row.status === "SUCCESS")
          || (previousIds.includes(row.id) && ["SUCCESS", "REMOVING", "REMOVED"].includes(row.status))), "UTILITY_PROVIDER_READBACK");
      const service = state.fence.services.find(row => row.serviceId === target[`${role}ServiceId`]);
      await verifyRetirementHistoryContinuity({ role, previous, current: state, previousIds, target, query,
        onSupplement: rows => onHistorySupplement({ role, rows }) });
      const predecessors = previousIds.map(id => service?.deployments.find(row => row.id === id));
      need(predecessors.every(Boolean), "PREDECESSOR_EVIDENCE_MISSING");
      const inactive = ["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"];
      const drained = predecessors.every(row => row.deploymentStopped === true && row.status !== "REMOVING"
        && row.instances.every(instance => inactive.includes(instance.status)));
      if (drained && same(stage.activeDeployments, [{ id: deploymentId, status: "SUCCESS" }])) return state;
    }
    await sleep(10000, undefined, { signal });
  }
  need(false, "UTILITY_TIMEOUT_RECONCILE");
}

export async function waitForRetirementPublic(proofSha256, {
  fetchImpl = fetch, now = Date.now, sleep = delay, timeoutMs = 180000, signal,
} = {}) {
  const deadline = now() + timeoutMs;
  const transient = [500, 502, 503, 504];
  const request = async (path, method = "GET") => {
    try {
      return await fetchImpl(`https://app.corgtex.com${path}`, { method, redirect: "manual",
        headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
    } catch { return null; }
  };
  while (now() < deadline) {
    const response = await request("/api/health");
    let ready = false;
    if (response) {
      need(response.ok || transient.includes(response.status), "PUBLIC_HEALTH_REJECTED");
      if (response.ok) {
        let body;
        try { body = await response.json(); } catch { /* Proxy/startup body; bounded read-only retry. */ }
        if (body?.mode === "source-freeze-utility") {
          need(body.proofSha256 === proofSha256 && body.role === "web" && body.applicationWrites === false
            && body.businessWorker === false, "PUBLIC_UTILITY_IDENTITY_CHANGED");
          ready = body.status === "ok";
        } else if (body?.release) {
          // The known old app may still be routed briefly. A different release
          // or reported configuration drift is contradictory, never readiness.
          need([body.release.gitSha, body.release.runtime?.gitSha, body.release.configured?.gitSha]
            .every(value => !value || value === CORE_SOURCE_SHA)
            && [body.release.imageTag, body.release.runtime?.imageTag, body.release.configured?.imageTag]
              .every(value => !value || value === `sha-${CORE_SOURCE_SHA}`)
            && !Object.values(body.release.drift || {}).includes(true), "PUBLIC_RELEASE_CHANGED");
        } else need(!body?.proofSha256 && !body?.mode, "PUBLIC_UTILITY_IDENTITY_CHANGED");
      }
    }
    if (ready) {
      const page = await request("/");
      let html = "";
      try { if (page?.ok) html = await page.text(); } catch { /* Bounded body-read retry. */ }
      ready = Boolean(page?.ok && html.includes('href="https://selfserve.corgtex.com"'));
      if (page && !page.ok) {
        let legacyRedirect = false;
        if ([301, 302, 303, 307, 308].includes(page.status) && page.headers.get("location")) {
          try { legacyRedirect = new URL(page.headers.get("location"), "https://app.corgtex.com").origin === "https://app.corgtex.com"; }
          catch { /* Invalid redirect is contradictory, not readiness. */ }
        }
        need(transient.includes(page.status) || legacyRedirect, "PUBLIC_HANDOFF_REJECTED");
      }
      // Use read-only probes while routing converges. After all reads identify
      // the utility, perform each existing empty-body write denial probe once.
      if (ready) for (const path of ["/api/mcp", "/api/webhooks/test", "/api/auth/callback/google"]) {
        const denied = await request(path);
        if (!denied || denied.status !== 503 || denied.headers.get("retry-after") !== "3600") { ready = false; break; }
        need(!denied.headers.get("location"), "WRITES_NOT_FENCED");
      }
      if (ready) {
        for (const path of ["/api/mcp", "/api/webhooks/test"]) {
          const denied = await request(path, "POST");
          need(denied?.status === 503 && denied.headers.get("retry-after") === "3600" && !denied.headers.get("location"), "WRITES_NOT_FENCED");
        }
        return;
      }
    }
    await sleep(10000, undefined, { signal });
  }
  need(false, "PUBLIC_TIMEOUT_RECONCILE");
}

export async function verifyRetirementPublicReadOnly(proofSha256, { fetchImpl = fetch, signal } = {}) {
  const request = path => fetchImpl(`https://app.corgtex.com${path}`, { method: "GET", redirect: "manual",
    headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
  const response = await request("/api/health");
  const body = await response.json();
  need(response.ok && body.status === "ok" && body.mode === "source-freeze-utility" && body.role === "web"
    && body.proofSha256 === proofSha256 && body.applicationWrites === false && body.businessWorker === false,
  "FINALIZATION_PUBLIC_IDENTITY_CHANGED");
  const page = await request("/");
  need(page.ok && (await page.text()).includes('href="https://selfserve.corgtex.com"'), "FINALIZATION_HANDOFF_CHANGED");
  for (const path of ["/api/mcp", "/api/webhooks/test", "/api/auth/callback/google"]) {
    const denied = await request(path);
    need(denied.status === 503 && denied.headers.get("retry-after") === "3600" && !denied.headers.get("location"),
      "FINALIZATION_FENCE_CHANGED");
  }
}

export function retirementApprovalProof(mode, approval, manifestHash) {
  if (["plan", "healthcheck-plan", "web-completion-plan", "finalize"].includes(mode)) return undefined;
  return ["reconcile", "healthcheck-recover", "web-complete"].includes(mode) ? identityHash(approval) : manifestHash;
}

// Exercise the exact generated command, including the configured worker health
// route, inside each original pinned image. No provider or database access.
export async function exerciseRetirementCommands(evidence, proofSha256, { outputRoot = ROOT, proofsByRole = null } = {}) {
  const proofs = [];
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024, stdio: "pipe" });
  for (const role of ROLES) {
    const roleProof = proofsByRole?.[role] ?? proofSha256;
    const image = `ghcr.io/corgtexdotcom/corgtex/${role}@${evidence.images[role].digest}`;
    const command = retirementCommand(role, roleProof);
    let container;
    try {
      container = docker(["run", "--detach", "--platform=linux/amd64", "--network=none", "--read-only", "--cpus=1", "--memory=128m",
        "--env", "PORT=3000", image, "/bin/sh", "-c", command]).trim();
      need(/^[a-f0-9]{64}$/.test(container), "COMMAND_CONTAINER_INVALID");
      const probe = `
        const assert = require("node:assert/strict");
        (async () => {
          const role = ${JSON.stringify(role)}, proof = ${JSON.stringify(roleProof)};
          const request = (path, method = "GET") => fetch("http://127.0.0.1:3000" + path, { method, redirect: "manual" });
          let ready;
          for (let n = 0; n < 100; n++) {
            try { ready = await request("/api/health"); if (ready.status === 200) break; } catch {}
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.equal(ready?.status, 200);
          for (const path of role === "worker" ? ["/api/health", "/healthz"] : ["/api/health"]) {
            const response = await request(path); assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.role, role); assert.equal(body.proofSha256, proof);
            assert.equal(body.applicationWrites, false); assert.equal(body.businessWorker, false);
            const head = await request(path, "HEAD"); assert.equal(head.status, 200); assert.equal(await head.text(), "");
          }
          for (const [path, method] of [["/healthz", "POST"], ["/api/mcp", "POST"], ["/api/mcp", "GET"], ["/api/auth/callback/google", "GET"]]) {
            const response = await request(path, method); assert.equal(response.status, 503);
            assert.equal(response.headers.get("retry-after"), "3600"); assert.equal(response.headers.get("location"), null);
          }
          const root = await request("/"); assert.equal(root.status, role === "web" ? 200 : 503);
          if (role === "web") assert.ok((await root.text()).includes('href="https://selfserve.corgtex.com"'));
          process.stdout.write("CORE_UTILITY_COMMAND_VERIFIED");
        })().catch(error => { console.error(error.message); process.exitCode = 1; });`;
      const marker = docker(["exec", container, "/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", "/usr/local/bin/node", "-e", probe]);
      need(marker === "CORE_UTILITY_COMMAND_VERIFIED", "UTILITY_COMMAND_UNPROVEN");
      proofs.push({ role, image, commandSha256: sha256(command), proofSha256: roleProof,
        healthPaths: role === "worker" ? ["/api/health", "/healthz"] : ["/api/health"], verified: true });
    } finally { if (container && /^[a-f0-9]{64}$/.test(container)) docker(["rm", "--force", container]); }
  }
  await mkdir(outputRoot, { recursive: true });
  await writeFile(`${outputRoot}/utility-command-exercise.json`, JSON.stringify(proofs, null, 2) + "\n");
  return { sha256: identityHash(proofs), roles: proofs.map(row => row.role), verified: true };
}

export async function runRetirement({ env = process.env, mode = process.argv[2], fetchImpl = fetch } = {}) {
  trustedRetirementContext(env);
  need(["plan", "execute", "reconcile", "healthcheck-plan", "healthcheck-recover", "web-completion-plan", "web-complete", "finalize"].includes(mode), "MODE_REQUIRED");
  const pin = await readPin(); need(pin, "ACCEPTED_PIN_REQUIRED");
  let receiptBytes;
  const receipt = await resolveBaseline(pin, { persist: bytes => { receiptBytes = bytes; } });
  const api = async path => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}/${path}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    need(response.ok, "GITHUB_READ_FAILED"); return response.json();
  };
  const transport = createRailwayFenceTransport({ token: env.RAILWAY_API_TOKEN, fetchImpl });
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  const query = (query, variables) => transport({ query, variables, signal });
  const fence = new RailwaySourceFence({ binding: { projectId: target.projectId, environmentId: target.environmentId,
    serviceIds: [target.webServiceId, target.workerServiceId] }, transport, signal,
    runRecordedOperation: () => { throw new Error("CORE_RETIREMENT_GENERAL_FENCE_FORBIDDEN"); } });
  const healthcheckRecovery = mode.startsWith("healthcheck-");
  const webCompletion = mode.startsWith("web-complet");
  const finalization = mode === "finalize";
  const dryRun = ["plan", "healthcheck-plan", "web-completion-plan", "finalize"].includes(mode);
  const commands = finalization ? Object.fromEntries(ROLES.map(role => [role, retirementCommand(role, FINALIZATION_CASE.roleProofs[role].proofSha256)])) : webCompletion ? { worker: WEB_COMPLETION_CASE.workerStartCommand }
    : healthcheckRecovery ? { worker: HEALTHCHECK_CASE.predecessorWorkerStartCommand } : {};
  let reconciliation, healthcheckApproval, webCompletionApproval, predecessorIntent, approval;
  const authenticate = async incident => {
    const [run, artifact, artifacts, jobs, members] = await Promise.all([
      api(`actions/runs/${incident.runId}`), api(`actions/artifacts/${incident.artifactId}`),
      api(`actions/runs/${incident.runId}/artifacts?per_page=100`),
      api(`actions/runs/${incident.runId}/attempts/1/jobs?per_page=100`), downloadReconciliationMembers(env, fetchImpl, incident),
    ]);
    return validateReconciliationEvidence({ run, artifact, artifacts, jobs, members }, incident);
  };
  if (healthcheckRecovery || webCompletion || finalization) {
    need(finalization ? env.CORE_RETIREMENT_FINALIZE_FAILED_RUN_ID === String(FINALIZATION_CASE.runId)
      : webCompletion ? env.CORE_RETIREMENT_WEB_COMPLETION_FAILED_RUN_ID === String(WEB_COMPLETION_CASE.runId)
      : env.CORE_RETIREMENT_HEALTHCHECK_FAILED_RUN_ID === String(HEALTHCHECK_CASE.runId), "HEALTHCHECK_CASE_REQUIRED");
    const first = await authenticate(RECONCILIATION_CASE);
    predecessorIntent = await authenticate(HEALTHCHECK_CASE);
    validateHealthcheckPredecessors(first, predecessorIntent);
    if (webCompletion || finalization) {
      const third = await authenticate(WEB_COMPLETION_CASE);
      validateWebCompletionPredecessors(first, predecessorIntent, third);
      if (finalization) {
        const fourth = await authenticate(FINALIZATION_CASE);
        validateFinalizationPredecessors(first, predecessorIntent, third, fourth);
        predecessorIntent = fourth;
      } else predecessorIntent = third;
    }
  }
  if (!dryRun) {
    need(typeof env.CORE_RETIREMENT_APPROVAL_JSON === "string"
      && Buffer.byteLength(env.CORE_RETIREMENT_APPROVAL_JSON) <= 32768, "APPROVAL_INPUT_REQUIRED");
    const input = JSON.parse(env.CORE_RETIREMENT_APPROVAL_JSON);
    if (mode === "reconcile") {
      need(env.CORE_RETIREMENT_RECONCILE_FAILED_RUN_ID === String(RECONCILIATION_CASE.runId), "RECONCILIATION_CASE_REQUIRED");
      predecessorIntent = await authenticate(RECONCILIATION_CASE);
      approval = validateReconciliationApproval(input, env.CORE_RETIREMENT_APPROVAL_SHA256, predecessorIntent);
      reconciliation = input;
    } else if (webCompletion) {
      approval = validateWebCompletionApproval(input, env.CORE_RETIREMENT_APPROVAL_SHA256, predecessorIntent);
      webCompletionApproval = input;
    } else if (healthcheckRecovery) {
      approval = validateHealthcheckRecoveryApproval(input, env.CORE_RETIREMENT_APPROVAL_SHA256, predecessorIntent);
      healthcheckApproval = input;
    } else approval = input;
  }
  const readState = createRetirementStateReader({ query, fence, evidence: receipt.evidence, commands,
    expectedConfigIdentity: finalization ? FINALIZATION_CASE.privateConfigSha256 : webCompletion ? WEB_COMPLETION_CASE.privateConfigSha256
      : healthcheckRecovery ? HEALTHCHECK_CASE.privateConfigSha256 : reconciliation?.expectedPrivateConfigSha256,
    onInitialConfigMismatch: async ({ expectedConfigIdentity, observedConfigIdentity, privateConfig }) => {
      if (!["healthcheck-plan", "web-completion-plan", "finalize"].includes(mode)) return;
      const publicKey = await readFile(new URL("../../.github/core-retirement-config-diagnostic-recipient.pem", import.meta.url), "utf8");
      need(sha256(publicKey) === DIAGNOSTIC_RECIPIENT_SHA256, "DIAGNOSTIC_RECIPIENT_CHANGED");
      const report = { binding: { caseSha256: identityHash(finalization ? FINALIZATION_CASE : webCompletion ? WEB_COMPLETION_CASE : HEALTHCHECK_CASE), workflowSha: env.GITHUB_SHA,
        runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, target,
        querySha256: sha256(RECOVERY_STATE_QUERY), expectedConfigSha256: expectedConfigIdentity,
        observedConfigSha256: observedConfigIdentity, capturedAt: new Date().toISOString() },
      fingerprints: privateConfigurationFingerprints(privateConfig) };
      const envelope = sealConfigurationDiagnostic(report, publicKey);
      await mkdir(ROOT, { recursive: true });
      await writeFile(`${ROOT}/initial-config-mismatch-encrypted.json`, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    },
    onConfigDrift: async diagnostic => { await mkdir(ROOT, { recursive: true });
      await writeFile(`${ROOT}/preserved-config-drift.json`, JSON.stringify(diagnostic, null, 2) + "\n"); },
  });
  const verifyImages = async evidence => {
    const proofs = [];
    for (const role of ROLES) {
      const proof = inspectAcceptedRecoveryImage(role, evidence.images[role].digest);
      const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024, stdio: "pipe" });
      docker(["pull", "--platform=linux/amd64", proof.image]);
      const [image] = JSON.parse(docker(["image", "inspect", proof.image]));
      const source = image.Config.Entrypoint?.length ? docker(["run", "--rm", "--network=none", "--read-only", "--entrypoint=node", proof.image,
        "-e", 'process.stdout.write(require("fs").readFileSync("/usr/local/bin/docker-entrypoint.sh","utf8"))']) : "";
      assertNodeEntrypoint(image.Config, source);
      const marker = docker(["run", "--rm", "--network=none", "--read-only", "--cpus=1", "--memory=128m", proof.image,
        "/usr/bin/env", "-u", "NODE_OPTIONS", "-u", "NODE_PATH", "/usr/local/bin/node", "-e", 'process.stdout.write("CORE_NODE_ONLY")']);
      need(marker === "CORE_NODE_ONLY", "IMAGE_COMMAND_OVERRIDE_UNPROVEN");
      const dockerfile = execFileSync("git", ["show", `${CORE_SOURCE_SHA}:deploy/Dockerfile.${role}`], { encoding: "utf8" });
      need(!/^ENTRYPOINT\b/m.test(dockerfile) && /^CMD\b/m.test(dockerfile), "SOURCE_ENTRYPOINT_CHANGED");
      proofs.push({ ...proof, configSha256: identityHash(image.Config), entrypointSha256: identityHash(source) });
    }
    await writeFile(`${ROOT}/image-startup.json`, JSON.stringify(proofs, null, 2) + "\n");
    return identityHash(proofs);
  };
  const assertContext = async () => {
    need(env.CONTROL_PLANE_AGENT_API_KEY, "CONTROL_PLANE_AUTH_REQUIRED");
    const response = await fetchImpl("https://ops.corgtex.com/api/control-plane/deployments", {
      headers: { Authorization: `Bearer cp-${env.CONTROL_PLANE_AGENT_API_KEY}` }, redirect: "error", signal: AbortSignal.timeout(30000),
    });
    need(response.ok, "OPS_READ_FAILED");
    return opsRetirementSnapshot(await response.json(), JSON.parse(env.FLEET_RELEASE_BACKUP_APP_TARGET_JSON || "null"));
  };
  const historySupplements = [];
  const retainSupplement = async row => {
    historySupplements.push({ ...row, observedAt: new Date().toISOString() });
    await writeFile(`${ROOT}/history-continuity.json`, JSON.stringify(historySupplements, null, 2) + "\n", { mode: 0o600 });
  };
  const verifyRuntime = (role, deploymentId, command, previous) => waitForRetiredRuntime({
    role, deploymentId, command, previous, digest: receipt.evidence.images[role].digest,
  }, { query, readState, signal, onHistorySupplement: retainSupplement });
  await mkdir(ROOT, { recursive: true });
  const result = await (finalization ? verifyReadOnlyFinalization : webCompletion ? completeCoreWebRetirement : healthcheckRecovery ? recoverCoreHealthcheck : retireCore)({ pin, receipt, receiptBytes, approval,
    approvalHash: retirementApprovalProof(mode, approval, env.CORE_RETIREMENT_APPROVAL_SHA256), dryRun }, {
    assertContext, verifyImages, readState, query,
    verifyCommands: (evidence, state, proof) => exerciseRetirementCommands(evidence, proof,
      webCompletion ? { proofsByRole: { worker: WEB_COMPLETION_CASE.workerProofSha256, web: proof } } : {}),
    verifyContinuity: async state => {
      const rows = await verifyWebCompletionContinuity(state, query);
      await retainSupplement({ role: "worker", rows }); return rows;
    },
    reserveIntent: async intent => {
      need(!finalization, "FINALIZATION_MUTATION_FORBIDDEN");
      need(!reconciliation || intent.providerBeforeSha256 === reconciliation.expectedProviderSha256, "RECONCILIATION_PROVIDER_CHANGED");
      await reserveRetirementIntent({ env, api, reconciliation: Boolean(reconciliation), healthcheckRecovery, webCompletion });
      await writeFile(`${ROOT}/intent.json`, JSON.stringify({ ...intent, approval, reconciliation, healthcheckApproval, webCompletionApproval,
        predecessor: webCompletion ? WEB_COMPLETION_CASE : healthcheckRecovery ? HEALTHCHECK_CASE : reconciliation ? RECONCILIATION_CASE : null,
        workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID }, null, 2) + "\n");
      return true;
    },
    setCommand: async (role, command) => {
      need(!finalization, "FINALIZATION_MUTATION_FORBIDDEN");
      need(!webCompletion || role === "web", "WORKER_MUTATION_FORBIDDEN");
      const result = await query("mutation RetirementCommand($environmentId:String!,$serviceId:String!,$input:ServiceInstanceUpdateInput!) { serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input) }", {
        environmentId: target.environmentId, serviceId: target[`${role}ServiceId`], input: { startCommand: command },
      });
      need(result.serviceInstanceUpdate === true, "COMMAND_OUTCOME_UNCERTAIN"); commands[role] = command;
    },
    deploy: async role => {
      need(!finalization, "FINALIZATION_MUTATION_FORBIDDEN");
      need(!webCompletion || role === "web", "WORKER_MUTATION_FORBIDDEN");
      return (await query("mutation RetirementDeploy($environmentId:String!,$serviceId:String!) { deploymentId:serviceInstanceDeployV2(environmentId:$environmentId,serviceId:$serviceId) }", {
        environmentId: target.environmentId, serviceId: target[`${role}ServiceId`],
      })).deploymentId;
    },
    verifyRuntime,
    verifyPublic: proofSha256 => (finalization ? verifyRetirementPublicReadOnly : waitForRetirementPublic)(proofSha256, { fetchImpl, signal }),
  });
  await writeFile(`${ROOT}/${mode}.json`, JSON.stringify({ ...result, workflowSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID }, null, 2) + "\n");
  console.log(`Core retirement ${mode} verified; physical services and database retained.`);
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runRetirement().catch(async error => {
    const code = /^CORE_(?:RETIREMENT|BASELINE|RECOVERY)_[A-Z_]+$/.test(error.message) ? error.message : "CORE_RETIREMENT_UNVERIFIED";
    await mkdir(ROOT, { recursive: true });
    await writeFile(`${ROOT}/failed.json`, JSON.stringify({ status: "unverified", code,
      providerWrites: ["plan", "healthcheck-plan", "web-completion-plan", "finalize"].includes(process.argv[2]) ? false : "unknown; reconcile before another execution" }) + "\n");
    console.error(code); process.exitCode = 1;
  });
}
