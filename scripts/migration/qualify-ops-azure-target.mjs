#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RESOURCE, HOST, ProbeError, connectionConfig, captureWhenReady, sanitize } from "./probe-ops-azure-target.mjs";
import { validateRehearsalPrincipal } from "./validate-postgres-restore-rehearsal.mjs";

export const SUBSCRIPTION = "227eb707-bc46-415e-a09b-7d2b69fb14b2";
export const TENANT = "f6f245dd-ad33-4fed-8624-c44efa093b21";
export const GROUP = "rg-corgtex-migration-rehearsal";
export const SERVER = "corgtex-mig-reh-restore-pg";
const HOUR = 3600000, RESERVE = 900000;
const assert = (v, code) => { if (!v) throw new ProbeError(code); };
const digest = (v) => createHash("sha256").update(v).digest("hex");
const tags = { authority: "non-authoritative-restore-target", purpose: "railway-to-azure-migration-foundation", managedBy: "github-oidc" };
const numeric = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/u.test(v);
const sameKeys = (v, names) => v && Object.keys(v).sort().join() === [...names].sort().join();
export const firewallName = (run, attempt) => `corgtex-target-qualification-${run}-${attempt}`;
export const validIp = (ip) => isIP(ip) === 4 && !/^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./u.test(ip)
  && Number(ip.split(".")[0]) < 224;

export function validateEnvironment(env, recovery = false) {
  assert(env.GITHUB_REF === "refs/heads/main" && env.DOMAIN === "ops", "PROTECTED_INPUT_MISMATCH");
  assert(env.AZURE_SUBSCRIPTION_ID === SUBSCRIPTION && env.AZURE_TENANT_ID === TENANT
    && digest(String(env.AZURE_CLIENT_ID).toLowerCase()) === "707be00bd89b2c0cf1ebdf8c0d389ff24b5f69d9f2ba35a113cddf8f073296bf", "AZURE_IDENTITY_MISMATCH");
  assert(numeric(env.GITHUB_RUN_ID) && numeric(env.GITHUB_RUN_ATTEMPT), "RUN_IDENTITY_MISMATCH");
  if (recovery) assert(numeric(env.RECOVERY_RUN_ID) && numeric(env.RECOVERY_RUN_ATTEMPT), "RECOVERY_IDENTITY_MISSING");
  else assert(!env.RECOVERY_RUN_ID && !env.RECOVERY_RUN_ATTEMPT, "UNEXPECTED_RECOVERY_INPUT");
}

export function validateIntent(i, run, attempt) {
  assert(sameKeys(i, ["schemaVersion", "kind", "resource", "host", "database", "runId", "runAttempt", "initialState", "firewallName", "ipv4", "createdAt", "deadline", "workDeadline", "transitionCapUsd"]), "INTENT_SHAPE");
  assert(i.schemaVersion === "1.0.0" && i.kind === "ops-target-qualification" && i.resource === RESOURCE
    && i.host === HOST && i.database === "postgres" && i.initialState === "Stopped" && i.transitionCapUsd === 5, "INTENT_TARGET_MISMATCH");
  assert(numeric(run) && numeric(attempt) && i.runId === run && i.runAttempt === attempt
    && i.firewallName === firewallName(run, attempt) && validIp(i.ipv4), "INTENT_OWNER_MISMATCH");
  assert(Number.isSafeInteger(i.createdAt) && i.createdAt > 0 && i.deadline === i.createdAt + HOUR
    && i.workDeadline === i.deadline - RESERVE, "INTENT_DEADLINE_MISMATCH");
  return i;
}

export function validateServer(s) {
  assert(s?.id?.toLowerCase() === RESOURCE.toLowerCase() && s.name === SERVER && s.fullyQualifiedDomainName === HOST
    && s.administratorLogin === "corgtexadmin" && s.version === "18" && s.location?.replaceAll(" ", "").toLowerCase() === "westus3"
    && s.sku?.name === "Standard_D2ds_v5" && s.sku?.tier === "GeneralPurpose" && s.storage?.storageSizeGb === 128
    && s.highAvailability?.mode === "Disabled" && s.backup?.backupRetentionDays === 7
    && s.network?.publicNetworkAccess === "Enabled" && !s.network.delegatedSubnetResourceId
    && !s.network.privateDnsZoneArmResourceId && sameKeys(s.tags, Object.keys(tags))
    && Object.entries(tags).every(([k, v]) => s.tags?.[k] === v), "TARGET_DRIFT");
  assert(["Stopped", "Ready", "Starting", "Stopping"].includes(s.state), "TARGET_STATE_UNEXPECTED");
  return s;
}

export function validateRules(rules, intent, requireAbsent = false) {
  assert(Array.isArray(rules) && rules.length <= 1, "FOREIGN_FIREWALL_RULES");
  if (requireAbsent) assert(rules.length === 0, "FIREWALL_NOT_ABSENT");
  for (const r of rules) assert(r.id?.toLowerCase() === `${RESOURCE}/firewallRules/${intent.firewallName}`.toLowerCase()
    && r.name === intent.firewallName && r.startIpAddress === intent.ipv4 && r.endIpAddress === intent.ipv4, "FIREWALL_OWNER_MISMATCH");
  return rules;
}

export class Azure {
  constructor(env) { this.env = env; }
  async call(args, timeout = 60000) {
    if (this.deadline !== undefined) {
      timeout = Math.min(timeout, this.deadline - Date.now());
      assert(timeout > 0, "AZURE_OPERATION_DEADLINE");
    }
    return new Promise((resolveCall, reject) => {
      const childEnv = { ...process.env, AZURE_CORE_COLLECT_TELEMETRY: "no" };
      for (const key of ["TARGET_POSTGRES_ADMIN_PASSWORD", "TARGET_ADMIN_PASSWORD", "AZURE_MIGRATION_POSTGRES_ADMIN_PASSWORD", "GH_TOKEN"]) delete childEnv[key];
      execFile("az", [...args, "--subscription", SUBSCRIPTION, "--output", "json", "--only-show-errors"],
        { timeout, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env: childEnv },
        (error, stdout) => {
          if (error) { reject(new ProbeError("AZURE_COMMAND_FAILED")); return; }
          try { resolveCall(stdout.trim() ? JSON.parse(stdout) : null); } catch { reject(new ProbeError("AZURE_OUTPUT_INVALID")); }
        });
    });
  }
  async identity() {
    const a = await this.call(["account", "show"]);
    assert(a.id === SUBSCRIPTION && a.tenantId === TENANT && a.state === "Enabled", "AZURE_ACCOUNT_MISMATCH");
    const token = await this.call(["account", "get-access-token", "--resource", "https://management.azure.com/"]);
    let claims;
    try { claims = JSON.parse(Buffer.from(token.accessToken.split(".")[1], "base64url").toString()); } catch { throw new ProbeError("AZURE_TOKEN_IDENTITY_INVALID"); }
    assert(claims.tid === TENANT && (claims.appid ?? claims.azp)?.toLowerCase() === this.env.AZURE_CLIENT_ID.toLowerCase(), "AZURE_PRINCIPAL_MISMATCH");
    const assignments = await this.call(["role", "assignment", "list", "--assignee-object-id", claims.oid,
      "--scope", `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}`, "--include-groups", "--include-inherited", "--fill-principal-name", "false"]);
    validateRehearsalPrincipal({ clientId: this.env.AZURE_CLIENT_ID, principalId: claims.oid, subscriptionId: SUBSCRIPTION, resourceGroup: GROUP, assignments });
  }
  server() { return this.call(["postgres", "flexible-server", "show", "--resource-group", GROUP, "--name", SERVER]); }
  rules() { return this.call(["postgres", "flexible-server", "firewall-rule", "list", "--resource-group", GROUP, "--server-name", SERVER]); }
  async boundary() {
    const g = await this.call(["group", "show", "--name", GROUP]);
    assert(g.id?.toLowerCase() === `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}`.toLowerCase()
      && g.location?.replaceAll(" ", "").toLowerCase() === "westus3" && sameKeys(g.tags, Object.keys(tags))
      && Object.entries(tags).every(([k, v]) => g.tags?.[k] === v), "GROUP_AUTHORITY_DRIFT");
    const p = await this.call(["network", "private-endpoint-connection", "list", "--id", RESOURCE]);
    assert(Array.isArray(p) && p.length === 0, "PRIVATE_ENDPOINT_DRIFT");
  }
  async start() { await this.identity(); return this.call(["postgres", "flexible-server", "start", "--resource-group", GROUP, "--name", SERVER, "--no-wait"]); }
  async stop() { await this.identity(); return this.call(["postgres", "flexible-server", "stop", "--resource-group", GROUP, "--name", SERVER]); }
  async createRule(i) {
    await this.identity();
    return this.call(["postgres", "flexible-server", "firewall-rule", "create", "--resource-group", GROUP, "--server-name", SERVER,
      "--name", i.firewallName, "--start-ip-address", i.ipv4, "--end-ip-address", i.ipv4]);
  }
  async deleteRule(i) {
    await this.identity();
    return this.call(["postgres", "flexible-server", "firewall-rule", "delete", "--resource-group", GROUP, "--server-name", SERVER, "--name", i.firewallName, "--yes"]);
  }
}

export const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const remaining = (deadline, c) => assert(c.now() < deadline, "ABSOLUTE_DEADLINE_EXCEEDED");
async function waitState(api, wanted, deadline, c) {
  while (true) {
    remaining(deadline, c);
    const s = validateServer(await api.server());
    if (s.state === wanted) return s;
    await c.sleep(5000);
  }
}

export async function prepare(api, { runId, runAttempt, ipv4 }, c = clock) {
  assert(numeric(runId) && numeric(runAttempt) && validIp(ipv4), "PREPARE_INPUT_INVALID");
  await api.identity(); await api.boundary();
  assert(validateServer(await api.server()).state === "Stopped", "TARGET_NOT_STOPPED");
  assert((await api.rules()).length === 0, "FIREWALL_NOT_ABSENT");
  const createdAt = c.now();
  return validateIntent({ schemaVersion: "1.0.0", kind: "ops-target-qualification", resource: RESOURCE, host: HOST, database: "postgres",
    runId, runAttempt, initialState: "Stopped", firewallName: firewallName(runId, runAttempt), ipv4,
    createdAt, deadline: createdAt + HOUR, workDeadline: createdAt + HOUR - RESERVE, transitionCapUsd: 5 }, runId, runAttempt);
}

export async function qualify(api, i, probe, markAttempt, c = clock) {
  validateIntent(i, i.runId, i.runAttempt); remaining(i.workDeadline, c);
  assert(c.now() >= i.createdAt, "INTENT_FROM_FUTURE");
  api.deadline = i.workDeadline;
  await api.identity(); await api.boundary();
  assert(validateServer(await api.server()).state === "Stopped", "TARGET_NOT_STOPPED");
  validateRules(await api.rules(), i, true);
  remaining(i.workDeadline, c);
  await markAttempt(); // Durable local marker precedes the first possibly ambiguous effect.
  await api.start();
  await waitState(api, "Ready", i.workDeadline, c);
  remaining(i.workDeadline, c);
  await api.createRule(i);
  assert(validateRules(await api.rules(), i).length === 1, "FIREWALL_CREATE_UNPROVEN");
  remaining(i.workDeadline, c);
  const result = await probe({ deadline: i.workDeadline });
  remaining(i.workDeadline, c);
  return result;
}

export async function cleanup(api, i, c = clock, recovery = false) {
  validateIntent(i, i.runId, i.runAttempt);
  if (recovery) {
    assert(typeof api.verifyRecovery === "function", "RECOVERY_OWNERSHIP_UNPROVEN");
    await api.verifyRecovery();
  }
  assert(c.now() >= i.createdAt, "INTENT_FROM_FUTURE");
  // Recovery never extends the original spend window; it reports an overrun even after cleanup.
  const cleanupDeadline = recovery || c.now() >= i.deadline ? c.now() + RESERVE : i.deadline;
  api.deadline = cleanupDeadline;
  await api.identity(); await api.boundary();
  validateServer(await api.server());
  const rules = validateRules(await api.rules(), i);
  // A failed CLI response may follow an accepted write. Reconcile readbacks,
  // and still stop owned compute if removal of the owned firewall rule fails.
  if (rules.length) {
    try { await api.deleteRule(i); } catch { /* Final absence readback is authoritative. */ }
  }
  let s = validateServer(await api.server());
  // Stopped can be the pre-transition readback of an accepted START. It is not
  // terminal evidence. Without observing Ready, leave this execution unresolved.
  if (s.state === "Starting" || s.state === "Stopped") s = await waitState(api, "Ready", cleanupDeadline, c);
  assert(s.state === "Ready" || s.state === "Stopping", "START_TERMINAL_UNPROVEN");
  if (s.state === "Ready") {
    try { await api.stop(); } catch { /* Bounded state polling resolves an ambiguous response. */ }
  }
  await waitState(api, "Stopped", cleanupDeadline, c);
  validateRules(await api.rules(), i, true);
  return { status: "TARGET_QUALIFICATION_CLEANED", resource: RESOURCE, firewallAbsent: true, serverStopped: true,
    runId: i.runId, runAttempt: i.runAttempt, deadline: i.deadline, withinWindow: c.now() <= i.deadline,
    transitionCapUsd: i.transitionCapUsd, actualSpend: "PARENT_ACCOUNTING_REQUIRED", productionAccepted: false };
}

export function readIntent(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); assert(stat.isFile() && stat.size > 0 && stat.size <= 16384, "INTENT_FILE_LIMIT");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

export function validateRecoveryEvidence(i, env, { source, current, runs, jobs, marker, receipt }) {
  const workflow = ".github/workflows/azure-migration-postgres-rehearsal.yml";
  const repository = "Corgtexdotcom/corgtex";
  const workflowPaths = new Set([workflow, `${repository}/${workflow}`]
    .flatMap(path => [path, `${path}@main`, `${path}@refs/heads/main`]));
  const matches = (run, id, attempt) => String(run?.id) === id && String(run.run_attempt) === attempt
    && workflowPaths.has(run.path) && run.head_branch === "main" && run.event === "workflow_dispatch"
    && [run.repository, run.head_repository].every(repo => repo === undefined || repo?.full_name === repository);
  assert(matches(source, i.runId, i.runAttempt) && source.status === "completed", "RECOVERY_SOURCE_UNPROVEN");
  assert(matches(current, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT) && current.status === "in_progress"
    && current.run_attempt === 1 && source.workflow_id === current.workflow_id, "RECOVERY_CURRENT_UNPROVEN");
  assert(Number.isFinite(Date.parse(source.created_at)) && Number.isFinite(Date.parse(current.created_at))
    && Date.parse(source.created_at) <= i.createdAt && Date.parse(current.created_at) >= i.createdAt, "RECOVERY_TIME_UNPROVEN");
  assert(Array.isArray(runs?.workflow_runs) && Number.isInteger(runs.total_count) && runs.total_count === runs.workflow_runs.length
    && runs.total_count <= 100 && runs.workflow_runs.some(r => r.id === source.id) && runs.workflow_runs.some(r => r.id === current.id)
    && runs.workflow_runs.every(r => (r.id === source.id && r.run_attempt === source.run_attempt)
      || (r.id === current.id && r.run_attempt === current.run_attempt)), "RECOVERY_SUPERSEDED");
  assert(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.total_count <= 100, "RECOVERY_JOBS_UNPROVEN");
  const candidates = jobs.jobs.filter(j => j.name === "Qualify existing Ops target metadata only");
  assert(candidates.length === 1 && candidates[0].status === "completed", "RECOVERY_JOB_UNPROVEN");
  const steps = candidates[0].steps;
  const start = steps?.filter(s => s.name === "Start target, open single-IP access and read metadata once");
  const clean = steps?.filter(s => s.name === "Remove qualification access and return target to Stopped");
  assert(start?.length === 1 && start[0].status === "completed" && ["success", "failure", "cancelled", "timed_out"].includes(start[0].conclusion)
    && clean?.length === 1 && clean[0].conclusion !== "success", "RECOVERY_NOT_UNRESOLVED");
  assert(sameKeys(marker, ["runId", "runAttempt"]) && marker.runId === i.runId && marker.runAttempt === i.runAttempt, "RECOVERY_START_UNPROVEN");
  assert(!receipt, "RECOVERY_ALREADY_CLEANED");
}

// Read existing run/activity evidence only. No artifact or intent alone grants
// authority to stop a later use; any intervening protected workflow run blocks.
export async function recoveryEvidence(i, env, directory, request = fetch) {
  assert(env.GITHUB_REPOSITORY === "Corgtexdotcom/corgtex" && env.GH_TOKEN, "RECOVERY_GITHUB_IDENTITY_MISSING");
  const get = async (path) => {
    const response = await request(`https://api.github.com/repos/Corgtexdotcom/corgtex/actions/${path}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    assert(response.ok, "RECOVERY_ACTIVITY_UNAVAILABLE");
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length; assert(size <= 1048576, "RECOVERY_ACTIVITY_LIMIT"); chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ProbeError("RECOVERY_ACTIVITY_INVALID"); }
  };
  const source = await get(`runs/${i.runId}`), current = await get(`runs/${env.GITHUB_RUN_ID}`);
  assert(Number.isSafeInteger(source.workflow_id) && Number.isFinite(Date.parse(source.created_at))
    && Number.isFinite(Date.parse(current.created_at)), "RECOVERY_SOURCE_UNPROVEN");
  const range = encodeURIComponent(`${source.created_at}..${current.created_at}`);
  const runs = await get(`workflows/${source.workflow_id}/runs?per_page=100&created=${range}`);
  const jobs = await get(`runs/${i.runId}/attempts/${i.runAttempt}/jobs?per_page=100`);
  validateRecoveryEvidence(i, env, { source, current, runs, jobs,
    marker: existsSync(`${directory}/start-attempt.json`) ? readIntent(`${directory}/start-attempt.json`) : null,
    receipt: existsSync(`${directory}/cleanup.json`) ? readIntent(`${directory}/cleanup.json`) : null });
}
function save(path, data) {
  const bytes = JSON.stringify(data, null, 2) + "\n";
  assert(Buffer.byteLength(bytes) <= 65536, "RECEIPT_LIMIT");
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}
export async function main(args = process.argv.slice(2), env = process.env) {
  assert(args.length === 2 && ["prepare", "run", "cleanup", "recover"].includes(args[0]), "INVALID_ARGS");
  const [mode, directory] = args, recovery = mode === "recover";
  validateEnvironment(env, recovery);
  const dir = resolve(directory); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const api = new Azure(env), path = `${dir}/qualification-intent.json`;
  if (mode === "prepare") {
    await connectionConfig(env); // Missing secret or TLS material must fail before provider effects.
    const i = await prepare(api, { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ipv4: env.QUALIFY_RUNNER_IPV4 });
    save(path, i); console.log(JSON.stringify({ status: "QUALIFICATION_PREPARED", deadline: i.deadline })); return;
  }
  if (mode === "cleanup" && !existsSync(`${dir}/start-attempt.json`)) {
    save(`${dir}/cleanup.json`, { status: "START_NOT_ATTEMPTED", providerEffects: 0 }); return;
  }
  const i = validateIntent(readIntent(path), recovery ? env.RECOVERY_RUN_ID : env.GITHUB_RUN_ID,
    recovery ? env.RECOVERY_RUN_ATTEMPT : env.GITHUB_RUN_ATTEMPT);
  assert(!existsSync(`${dir}/cleanup.json`), "EXECUTION_ALREADY_CLEANED");
  if (recovery) api.verifyRecovery = () => recoveryEvidence(i, env, dir);
  if (mode === "run") {
    const config = await connectionConfig(env);
    const { default: pg } = await import("pg");
    const result = await qualify(api, i, (options) => captureWhenReady(() => new pg.Client(config), options), () => save(`${dir}/start-attempt.json`, { runId: i.runId, runAttempt: i.runAttempt }));
    save(`${dir}/metadata.json`, result); console.log(JSON.stringify({ status: result.status, comparison: result.comparison }));
  } else {
    const result = await cleanup(api, i, clock, recovery); save(`${dir}/cleanup.json`, result);
    console.log(JSON.stringify(result)); assert(result.withinWindow, "ABSOLUTE_WINDOW_BREACHED");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => {
  console.log(JSON.stringify(sanitize(e))); process.exitCode = 1;
});
