import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { reserveRetirementIntent, trustedRetirementContext, assertNodeEntrypoint, opsRetirementSnapshot, createRetirementStateReader, configurationDriftDiagnostic, waitForRetiredRuntime, waitForRetirementPublic, EXECUTE_STEP } from "./core-retirement-runner.mjs";
import { HEALTHCHECK_CASE, HEALTHCHECK_STEP } from "./core-retirement-healthcheck-recovery.mjs";
import { RECONCILE_STEP, RECONCILIATION_CASE } from "./core-retirement-reconciliation.mjs";
import { CORE_RETIREMENT_TARGET as target, CORE_DEPLOYMENT_ID, CORE_BEFORE, CORE_SOURCE_SHA, retirementCommand } from "./core-retirement.mjs";
import { RailwaySourceFence } from "../migration/railway-source-fence.mjs";
const REPO = "Corgtexdotcom/corgtex", path = ".github/workflows/core-retirement.yml", sha = "a".repeat(40);
const env = { GITHUB_REPOSITORY: REPO, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `${REPO}/${path}@refs/heads/main`, GITHUB_SHA: sha, GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1" };
const run = () => ({ id: 10, repository: { full_name: REPO }, head_repository: { full_name: REPO }, path,
  head_branch: "main", event: "workflow_dispatch", run_attempt: 1, head_sha: sha });
const job = () => ({ name: "Retire existing Core", run_id: 10, run_attempt: 1,
  steps: [{ name: EXECUTE_STEP, status: "in_progress", started_at: "2026-09-30T20:00:00Z" }] });

describe("protected retirement intent", () => {
  it.each(["GITHUB_REPOSITORY", "GITHUB_REF", "GITHUB_EVENT_NAME", "GITHUB_WORKFLOW_REF", "GITHUB_SHA"])("rejects invalid %s", key => {
    expect(() => trustedRetirementContext({ ...env, [key]: "other" })).toThrow("PROTECTED_MAIN_REQUIRED");
  });
  const api = (runs = [run()], jobs = [job()]) => async path => path.includes("/jobs?")
    ? { total_count: jobs.length, jobs } : { total_count: runs.length, workflow_runs: runs };
  it("reserves only a visible first-attempt execution step", async () => {
    expect(await reserveRetirementIntent({ env, api: api() })).toBe(true);
    await expect(reserveRetirementIntent({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, api: api() })).rejects.toThrow("RECONCILIATION");
    await expect(reserveRetirementIntent({ env, api: api([], []) })).rejects.toThrow("NOT_VISIBLE");
  });
  it.each(["prior", "duplicate", "wrong-commit", "wrong-job", "unbounded"])("refuses ambiguous %s history", async kind => {
    let runs = [run()], jobs = [job()];
    if (kind === "prior") runs.unshift({ ...run(), id: 9 });
    if (kind === "duplicate") jobs.push(job());
    if (kind === "wrong-commit") runs[0].head_sha = "b".repeat(40);
    if (kind === "wrong-job") jobs[0].name = "not protected";
    const reader = kind === "unbounded" ? async () => ({ total_count: 101, workflow_runs: runs }) : api(runs, jobs);
    await expect(reserveRetirementIntent({ env, api: reader })).rejects.toThrow();
  });
  it("does not mistake skipped dry-run execution for a prior provider write", async () => {
    const runs = [{ ...run(), id: 9 }, run()];
    const reader = async path => path.includes("/jobs?") ? { total_count: 1,
      jobs: [path.includes("runs/9/") ? { ...job(), run_id: 9, steps: [{ name: EXECUTE_STEP, conclusion: "skipped" }] } : job()] }
      : { total_count: 2, workflow_runs: runs };
    expect(await reserveRetirementIntent({ env, api: reader })).toBe(true);
  });
});

describe("actual startup and Ops boundaries", () => {
  it("accepts only no entrypoint or the exact stock Node command forwarding script", () => {
    const wrapper = '#!/bin/sh\nset -e\n# stock wrapper\nif [ "${1#-}" != "${1}" ] || [ -z "$(command -v "${1}")" ] || { [ -f "${1}" ] && ! [ -x "${1}" ]; }; then\n set -- node "$@"\nfi\nexec "$@"\n';
    expect(() => assertNodeEntrypoint({ Entrypoint: null })).not.toThrow();
    expect(() => assertNodeEntrypoint({ Entrypoint: ["docker-entrypoint.sh"] }, wrapper)).not.toThrow();
    expect(() => assertNodeEntrypoint({ Entrypoint: ["/app/deploy/entrypoint.sh"] }, wrapper)).toThrow();
    expect(() => assertNodeEntrypoint({ Entrypoint: ["docker-entrypoint.sh"] }, wrapper + 'npm run prisma:migrate\n')).toThrow();
  });
  it("binds the real Core Ops identity and blocks any active lease or remapping", () => {
    const configured = { provider: "railway", url: "https://app.corgtex.com", railway: target };
    const row = { id: CORE_DEPLOYMENT_ID, url: configured.url, cloudProvider: "RAILWAY", deploymentKind: "INTERNAL", environment: "internal" };
    const body = { deployments: [row] };
    expect(opsRetirementSnapshot(body, configured)).toMatch(/^[a-f0-9]{64}$/);
    for (const change of [{ remoteWorkspaceId: "customer" }, { cloudProvider: "AZURE" }, { releaseLeaseId: "owned" }]) {
      expect(() => opsRetirementSnapshot({ deployments: [{ ...row, ...change }] }, configured)).toThrow();
    }
    expect(() => opsRetirementSnapshot({ deployments: [row, { id: "other", releaseLeaseId: "owned" }] }, configured)).toThrow();
  });
  it("uses shared non-cancelling protection, read-only permissions and no DB credentials", () => {
    const source = readFileSync(new URL("../../.github/workflows/core-retirement.yml", import.meta.url), "utf8");
    const workflow = parse(source);
    expect(workflow.concurrency).toEqual({ group: "fleet-release", "cancel-in-progress": false });
    expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
    expect(workflow.jobs.retire.environment).toBe("fleet-release-production");
    expect(Object.values(workflow.permissions)).toEqual(["read", "read", "read"]);
    expect(source).not.toMatch(/DATABASE_URL|ADMIN_PASSWORD|AZURE_CLIENT|prisma|migrate/);
    const runner = readFileSync(new URL("./core-retirement-runner.mjs", import.meta.url), "utf8");
    expect(runner).not.toMatch(/variableCollectionUpsert|deploymentStop\s*\(|serviceDelete|environmentDelete|disableTriggers\(/);
    expect(runner).toContain('input: { startCommand: command }');
  });
});

function adapterFixture() {
  const roles = ["web", "worker"], hash = "a".repeat(64), at = "2026-09-30T20:00:00Z";
  const commands = {}, rows = {};
  const config = { services: {} };
  for (const role of roles) {
    const serviceId = target[`${role}ServiceId`], deploymentId = CORE_BEFORE[role];
    const source = { image: `ghcr.io/corgtexdotcom/corgtex/${role}@sha256:${hash}`, repo: null };
    const deployment = { id: deploymentId, projectId: target.projectId, environmentId: target.environmentId, serviceId,
      status: "SUCCESS", createdAt: at, updatedAt: at, deploymentStopped: false, instances: [{ id: `${role}-process`, status: "RUNNING" }] };
    const startCommand = `npm run start --workspace=@corgtex/${role}`;
    config.services[serviceId] = { source: { image: source.image }, deploy: { startCommand,
      registryCredentials: { username: "***", password: "***" }, restartPolicyType: "ON_FAILURE" } };
    rows[role] = { serviceId, deployment, instance: { id: serviceId, serviceId, environmentId: target.environmentId,
      service: { id: serviceId, projectId: target.projectId }, source, startCommand, preDeployCommand: null,
      latestDeployment: { id: deploymentId, status: "SUCCESS" }, activeDeployments: [deployment],
      cronSchedule: null, nextCronRunAt: null, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3,
      drainingSeconds: 30, overlapSeconds: 0,
      resolvedFileConfig: { deploymentId, resolvedAt: at, fileManifest: { deploy: { startCommand } } } },
    variables: { CORGTEX_RELEASE_VERSION: `main-${CORE_SOURCE_SHA.slice(0, 12)}`, CORGTEX_RELEASE_IMAGE_TAG: `sha-${CORE_SOURCE_SHA}`,
      CORGTEX_RELEASE_GIT_SHA: CORE_SOURCE_SHA, CORGTEX_STARTUP_MODE: "web", DATABASE_URL: "retained-private-value" } };
  }
  let stagingId = "<empty>";
  const transport = async ({ query, variables }) => {
    const environment = { id: target.environmentId, projectId: target.projectId, config };
    const row = Object.values(rows).find(row => row.serviceId === variables.serviceId);
    if (query.includes("query FenceEnvironment")) return structuredClone({ environment,
      environmentStagedChanges: { id: stagingId, environmentId: target.environmentId, status: "STAGED", patch: {} }, environmentPendingWork: [] });
    if (query.includes("query FenceService")) return structuredClone({ environment, serviceInstance: row.instance, serviceInstanceAutoDeployStatus: { enabled: false } });
    if (query.includes("query FenceDeployments")) return structuredClone({ environment, deployments: {
      edges: (row.deployments || [row.deployment]).map(node => ({ cursor: node.id, node })), pageInfo: { hasNextPage: false, endCursor: null } } });
    if (query.includes("query CoreRecoveryState")) return structuredClone({ environment,
      instance: { ...row.instance, activeDeployments: row.instance.activeDeployments.map(({ id, status }) => ({ id, status })) },
      variables: row.variables, deployments: { edges: (row.deployments || [row.deployment]).map(deployment => ({ node: { id: deployment.id, status: deployment.status, meta: { imageDigest: deployment.digest || `sha256:${hash}` } } })),
        pageInfo: { hasNextPage: false } }, pending: { edges: (row.deployments || [row.deployment]).filter(node => node.status === "REMOVING").map(node => ({ node: { id: node.id, status: node.status } })), pageInfo: { hasNextPage: false } } });
    throw new Error("Unexpected fixture query");
  };
  const fence = new RailwaySourceFence({ binding: { projectId: target.projectId, environmentId: target.environmentId,
    serviceIds: roles.map(role => target[`${role}ServiceId`]) }, transport, signal: new AbortController().signal,
    runRecordedOperation: () => { throw new Error("Read-only fixture"); } });
  const read = createRetirementStateReader({ query: (query, variables) => transport({ query, variables }), fence,
    evidence: { target }, commands });
  return { read, fence, rows, config, commands, query: (query, variables) => transport({ query, variables }), advanceMetadata() {
    stagingId = "00000000-0000-0000-0000-000000000001";
    for (const row of Object.values(rows)) {
      row.deployment.updatedAt = "2026-09-30T20:01:00Z";
      row.instance.resolvedFileConfig.resolvedAt = "2026-09-30T20:01:00Z";
    }
  } };
}

describe("real Railway fence and retirement reader integration", () => {
  it("rejects a reconciliation whose first private configuration differs", async () => {
    const f = adapterFixture();
    const read = createRetirementStateReader({ query: f.query, fence: f.fence, evidence: { target }, commands: {},
      expectedConfigIdentity: "0".repeat(64) });
    await expect(read()).rejects.toThrow("RECONCILIATION_PRIVATE_CONFIG_CHANGED");
  });
  it("retains the configuration mismatch if redacted diagnostic storage fails", async () => {
    const f = adapterFixture(), onConfigDrift = vi.fn(async () => { throw new Error("unavailable artifact store"); });
    const read = createRetirementStateReader({ query: f.query, fence: f.fence, evidence: { target }, commands: {}, onConfigDrift });
    await read(); f.rows.worker.variables.DATABASE_URL = "a-real-secret-change";
    await expect(read()).rejects.toThrow("PRESERVED_CONFIG_CHANGED");
    expect(onConfigDrift).toHaveBeenCalledOnce();
    expect(JSON.stringify(onConfigDrift.mock.calls)).not.toContain("a-real-secret-change");
  });
  it("admits exactly the reviewed command diff and discards only volatile read metadata", async () => {
    const f = adapterFixture(), before = await f.read(), rawBefore = await f.fence.read();
    const command = retirementCommand("worker", "a".repeat(64));
    f.rows.worker.instance.startCommand = command;
    f.config.services[target.workerServiceId].deploy.startCommand = command;
    f.commands.worker = command;
    f.advanceMetadata();
    const after = await f.read(), rawAfter = await f.fence.read();
    const expected = structuredClone(before); expected.stages.worker.startCommand = command;
    expect(after).toEqual(expected);
    expect(rawAfter).not.toEqual(rawBefore);
    expect(after.fence.services.map(service => service.sourceLinkSha256)).toEqual(before.fence.services.map(service => service.sourceLinkSha256));
    expect(JSON.stringify(after)).not.toContain("retained-private-value");
  });
  it.each(["unreviewed-command", "config-command", "variable", "other-config", "trigger", "instance", "source-link", "file-manifest"])("retains detection of %s drift with actual adapter shapes", async kind => {
    const f = adapterFixture(), before = await f.read();
    if (kind === "unreviewed-command") f.rows.worker.instance.startCommand = "node unreviewed.js";
    if (kind === "config-command") f.config.services[target.workerServiceId].deploy.startCommand = "node unreviewed.js";
    if (kind === "variable") f.rows.worker.variables.DATABASE_URL = "changed-private-value";
    if (kind === "other-config") f.config.services[target.workerServiceId].deploy.restartPolicyType = "ALWAYS";
    if (kind === "trigger") f.rows.worker.instance.cronSchedule = "* * * * *";
    if (kind === "instance") f.rows.worker.deployment.instances[0].status = "STOPPED";
    if (kind === "source-link") {
      f.rows.worker.instance.source.image = f.rows.worker.instance.source.image.replace("a".repeat(64), "b".repeat(64));
      f.config.services[target.workerServiceId].source.image = f.rows.worker.instance.source.image;
    }
    if (kind === "file-manifest") f.rows.worker.instance.resolvedFileConfig.fileManifest.deploy.startCommand = "changed";
    if (["instance", "file-manifest"].includes(kind)) expect(await f.read()).not.toEqual(before);
    else await expect(f.read()).rejects.toThrow();
  });
  it("passes the exact dispatch manifest through the protected execution step", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/core-retirement.yml", import.meta.url), "utf8"));
    const step = workflow.jobs.retire.steps.find(step => step.name === EXECUTE_STEP);
    expect(workflow.on.workflow_dispatch.inputs.approval_json.type).toBe("string");
    expect(step.env.CORE_RETIREMENT_APPROVAL_JSON).toBe("${{ inputs.approval_json }}");
    expect(step.env.CORE_RETIREMENT_APPROVAL_SHA256).toBe("${{ inputs.approval_sha256 }}");
    expect(workflow.jobs.retire.environment).toBe("fleet-release-production");
  });
});

describe("incident-bound no-replay reservation", () => {
  const oldRun = () => ({ ...run(), id: RECONCILIATION_CASE.runId, head_sha: RECONCILIATION_CASE.workflowSha,
    status: "completed", conclusion: "failure" });
  const oldJob = () => ({ ...job(), id: RECONCILIATION_CASE.jobId, run_id: RECONCILIATION_CASE.runId,
    status: "completed", conclusion: "failure", steps: [{ name: EXECUTE_STEP, status: "completed", conclusion: "failure", started_at: "2026-10-01T15:23:12Z" }] });
  const currentJob = () => ({ ...job(), steps: [{ ...job().steps[0], name: RECONCILE_STEP }] });
  const reader = (runs = [oldRun(), run()], original = oldJob(), current = currentJob()) => async path => path.includes("/jobs?")
    ? { total_count: 1, jobs: [path.includes(`runs/${RECONCILIATION_CASE.runId}/`) ? original : current] }
    : { total_count: runs.length, workflow_runs: runs };
  it("admits exactly the authenticated failed predecessor plus this visible first reconciliation", async () => {
    expect(await reserveRetirementIntent({ env, api: reader(), reconciliation: true })).toBe(true);
    await expect(reserveRetirementIntent({ env, api: reader() })).rejects.toThrow("RECONCILIATION");
  });
  it.each(["missing-predecessor", "changed-predecessor", "prior-reconciliation", "rerun", "duplicate"])("blocks %s", async kind => {
    let runs = [oldRun(), run()], original = oldJob(), current = currentJob();
    if (kind === "missing-predecessor") runs = [run()];
    if (kind === "changed-predecessor") original.steps[0].conclusion = "success";
    if (kind === "prior-reconciliation") runs.push({ ...run(), id: 11 });
    if (kind === "rerun") runs[0].run_attempt = 2;
    if (kind === "duplicate") current.steps.push({ ...current.steps[0] });
    await expect(reserveRetirementIntent({ env, api: reader(runs, original, current), reconciliation: true })).rejects.toThrow();
  });
  it("ordinary execution also refuses a started reconciliation regardless of its outcome", async () => {
    const current = currentJob(); current.steps[0].status = "completed"; current.steps[0].conclusion = "failure";
    await expect(reserveRetirementIntent({ env, api: reader([run()], oldJob(), current) })).rejects.toThrow();
  });
});

describe("redacted configuration drift", () => {
  it("reports structural changes without values or dynamic secret keys", () => {
    const before = { worker: { variables: { DATABASE_URL: "postgres://private:old@host/db", "secret-dynamic-key": "token-old" }, config: { source: { checkSuites: false } } } };
    const after = { worker: { variables: { DATABASE_URL: "postgres://private:new@host/db", "secret-dynamic-key": "token-new" }, config: { source: {} } } };
    const one = configurationDriftDiagnostic(before, after), two = configurationDriftDiagnostic(before, after);
    expect(one.totalChanges).toBe(3);
    expect(one.changes).toContainEqual(expect.objectContaining({ path: "worker.config.source.checkSuites", beforePresent: true, afterPresent: false }));
    expect(JSON.stringify(one)).not.toMatch(/postgres|private:|token-old|token-new|secret-dynamic-key|DATABASE_URL/);
    expect(one.changes[0].beforeFingerprint).not.toBe(two.changes[0].beforeFingerprint);
    expect(configurationDriftDiagnostic(before, before).changes).toEqual([]);
  });
});

async function rollingAdapterFixture() {
  const f = adapterFixture(), previous = await f.read();
  const role = "worker", deploymentId = "00000000-0000-0000-0000-000000000099", digest = `sha256:${"a".repeat(64)}`;
  const command = retirementCommand(role, "a".repeat(64));
  f.rows.worker.instance.startCommand = command;
  f.config.services[target.workerServiceId].deploy.startCommand = command;
  f.commands.worker = command;
  const incoming = { ...structuredClone(f.rows.worker.deployment), id: deploymentId, instances: [{ id: "new-worker", status: "RUNNING" }] };
  f.rows.worker.deployments = [f.rows.worker.deployment, incoming];
  f.rows.worker.instance.latestDeployment = { id: deploymentId, status: "SUCCESS" };
  // This is precisely the old bug: the latest/active listing shows only the
  // successful utility, while the predecessor history still has RUNNING instances.
  f.rows.worker.instance.activeDeployments = [incoming];
  const query = vi.fn(async () => ({ deployment: { id: deploymentId, status: "SUCCESS", meta: { imageDigest: digest } } }));
  return { ...f, input: { role, deploymentId, digest, command, previous }, query,
    stopOld() { f.rows.worker.deployment.deploymentStopped = true;
      f.rows.worker.deployment.status = "REMOVED"; f.rows.worker.deployment.instances[0].status = "STOPPED"; } };
}

describe("bounded actual-adapter retirement drain", () => {
  it("waits after new SUCCESS until the exact old RUNNING process is stopped", async () => {
    const f = await rollingAdapterFixture(); let time = 0;
    const sleep = vi.fn(async () => { time += 10000; f.stopOld(); });
    const state = await waitForRetiredRuntime(f.input, { query: f.query, readState: f.read, now: () => time, sleep, timeoutMs: 20000 });
    expect(sleep).toHaveBeenCalledOnce(); expect(f.query).toHaveBeenCalledTimes(2);
    expect(state.fence.services.find(row => row.serviceId === target.workerServiceId).deployments
      .find(row => row.id === CORE_BEFORE.worker)).toMatchObject({ deploymentStopped: true, instances: [{ status: "STOPPED" }] });
  });
  it("waits through only the exact predecessor's REMOVING state", async () => {
    const f = await rollingAdapterFixture(); f.rows.worker.deployment.status = "REMOVING";
    let time = 0; const sleep = vi.fn(async () => { time += 10000; f.stopOld(); });
    await expect(waitForRetiredRuntime(f.input, { query: f.query, readState: f.read, now: () => time, sleep, timeoutMs: 20000 })).resolves.toBeTruthy();
    expect(sleep).toHaveBeenCalledOnce();
  });
  it.each(["flag", "instances"])("times out without proceeding when old %s never proves stopped", async kind => {
    const f = await rollingAdapterFixture();
    if (kind === "flag") f.rows.worker.deployment.instances[0].status = "STOPPED";
    else f.rows.worker.deployment.deploymentStopped = true;
    let time = 0; const sleep = vi.fn(async () => { time += 10000; });
    await expect(waitForRetiredRuntime(f.input, { query: f.query, readState: f.read, now: () => time, sleep, timeoutMs: 20000 }))
      .rejects.toThrow("UTILITY_TIMEOUT_RECONCILE");
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(["digest", "config", "identity"])("rejects positive %s drift immediately without readiness retry", async kind => {
    const f = await rollingAdapterFixture(), sleep = vi.fn();
    if (kind === "digest") f.query.mockResolvedValue({ deployment: { id: f.input.deploymentId, status: "SUCCESS", meta: { imageDigest: `sha256:${"b".repeat(64)}` } } });
    if (kind === "config") f.config.services[target.workerServiceId].deploy.restartPolicyType = "ALWAYS";
    if (kind === "identity") f.rows.worker.instance.latestDeployment.id = "00000000-0000-0000-0000-000000000088";
    await expect(waitForRetiredRuntime(f.input, { query: f.query, readState: f.read, sleep })).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("bounded public routing convergence", () => {
  const proof = "a".repeat(64);
  const utility = overrides => new Response(JSON.stringify({ status: "ok", mode: "source-freeze-utility", role: "web",
    applicationWrites: false, businessWorker: false, proofSha256: proof, ...overrides }));
  const response = path => path === "/" ? new Response('<a href="https://selfserve.corgtex.com">Open</a>')
    : new Response("{}", { status: 503, headers: { "Retry-After": "3600" } });
  it.each(["502", "non-JSON", "network", "old-release"])("retries %s then verifies utility health and denial exactly once", async transient => {
    let time = 0, probes = 0;
    const fetchImpl = vi.fn(async (url, options) => {
      const path = new URL(url).pathname;
      if (path !== "/api/health") return response(path);
      if (probes++ > 0) return utility();
      if (transient === "network") throw new Error("temporary transport failure");
      if (transient === "non-JSON") return new Response("starting");
      if (transient === "old-release") return new Response(JSON.stringify({ release: { gitSha: CORE_SOURCE_SHA } }));
      return new Response("bad gateway", { status: 502 });
    });
    const sleep = vi.fn(async () => { time += 10000; });
    await waitForRetirementPublic(proof, { fetchImpl, now: () => time, sleep, timeoutMs: 20000 });
    expect(sleep).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(2);
  });
  it("waits for a stale same-origin legacy page redirect after health converges", async () => {
    let time = 0, pages = 0;
    const fetchImpl = vi.fn(async url => {
      const path = new URL(url).pathname;
      if (path === "/api/health") return utility();
      if (path === "/" && pages++ === 0) return new Response(null, { status: 303, headers: { location: "/en/login" } });
      return response(path);
    });
    const sleep = vi.fn(async () => { time += 10000; });
    await waitForRetirementPublic(proof, { fetchImpl, now: () => time, sleep, timeoutMs: 20000 });
    expect(sleep).toHaveBeenCalledOnce();
  });
  it("times out on continued gateway failure with no write probes", async () => {
    let time = 0; const fetchImpl = vi.fn(async () => new Response("not ready", { status: 502 }));
    await expect(waitForRetirementPublic(proof, { fetchImpl, now: () => time, sleep: async () => { time += 10000; }, timeoutMs: 20000 }))
      .rejects.toThrow("PUBLIC_TIMEOUT_RECONCILE");
    expect(fetchImpl.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it.each(["proof", "writes", "role", "release", "configured", "image"])("rejects contradictory %s immediately", async kind => {
    const sleep = vi.fn();
    const fetchImpl = async () => {
      if (kind === "proof") return utility({ proofSha256: "b".repeat(64) });
      if (kind === "writes") return utility({ applicationWrites: true });
      if (kind === "role") return utility({ role: "worker" });
      return new Response(JSON.stringify({ release: { gitSha: kind === "release" ? "b".repeat(40) : CORE_SOURCE_SHA,
        ...(kind === "configured" ? { drift: { gitSha: true } } : {}), ...(kind === "image" ? { imageTag: "sha-wrong" } : {}) } }));
    };
    await expect(waitForRetirementPublic(proof, { fetchImpl, sleep })).rejects.toThrow();
    expect(sleep).not.toHaveBeenCalled();
  });
});


describe("two-predecessor healthcheck recovery barrier", () => {
  const original = incident => ({ ...run(), id: incident.runId, head_sha: incident.workflowSha, status: "completed", conclusion: "failure" });
  const failedJob = incident => ({ ...job(), id: incident.jobId, run_id: incident.runId, status: "completed", conclusion: "failure",
    steps: [{ name: incident.stepName || EXECUTE_STEP, status: "completed", conclusion: "failure", started_at: "2026-10-01T16:30:00Z" }] });
  const setup = () => {
    const runs = [original(RECONCILIATION_CASE), original(HEALTHCHECK_CASE), run()];
    const jobs = new Map([[RECONCILIATION_CASE.runId, failedJob(RECONCILIATION_CASE)], [HEALTHCHECK_CASE.runId, failedJob(HEALTHCHECK_CASE)],
      [10, { ...job(), steps: [{ ...job().steps[0], name: HEALTHCHECK_STEP }] }]]);
    const api = async path => path.includes("/jobs?") ? { total_count: 1, jobs: [jobs.get(Number(path.split("/")[2]))] }
      : { total_count: runs.length, workflow_runs: runs };
    return { runs, jobs, api };
  };
  it("admits only the two fixed failed predecessors and the current first recovery", async () => {
    const f = setup(); expect(await reserveRetirementIntent({ env, api: f.api, healthcheckRecovery: true })).toBe(true);
    await expect(reserveRetirementIntent({ env, api: f.api, reconciliation: true })).rejects.toThrow();
    await expect(reserveRetirementIntent({ env, api: f.api })).rejects.toThrow();
  });
  it.each(["missing", "rerun", "success", "wrong-step", "third-attempt", "duplicate"])("blocks %s history", async kind => {
    const f = setup();
    if (kind === "missing") f.runs.shift();
    if (kind === "rerun") f.runs[1].run_attempt = 2;
    if (kind === "success") f.jobs.get(HEALTHCHECK_CASE.runId).steps[0].conclusion = "success";
    if (kind === "wrong-step") f.jobs.get(HEALTHCHECK_CASE.runId).steps[0].name = EXECUTE_STEP;
    if (kind === "duplicate") f.jobs.get(10).steps.push({ ...f.jobs.get(10).steps[0] });
    if (kind === "third-attempt") { f.runs.push({ ...run(), id: 11 }); f.jobs.set(11, { ...f.jobs.get(10), run_id: 11 }); }
    await expect(reserveRetirementIntent({ env, api: f.api, healthcheckRecovery: true })).rejects.toThrow();
  });
  it("routes recovery plans and execution through the existing protection", () => {
    const workflow = parse(readFileSync(new URL("../../.github/workflows/core-retirement.yml", import.meta.url), "utf8"));
    const recover = workflow.jobs.retire.steps.find(step => step.name === HEALTHCHECK_STEP);
    expect(recover.run).toBe("node scripts/release/core-retirement-runner.mjs healthcheck-recover");
    expect(recover.env.CORE_RETIREMENT_HEALTHCHECK_FAILED_RUN_ID).toBe("${{ inputs.healthcheck_failed_run_id }}");
    expect(recover.if).toContain("!inputs.dry_run");
    expect(recover.if).toContain("inputs.reconcile_failed_run_id == ''");
  });
});
