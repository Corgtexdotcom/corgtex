import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { archiveEvidenceHash as hash } from "../migration/ops-core-archive.mjs";
import { managedAzureConsumptionEphemeralStorage } from "./managed-azure-container-app-transport.mjs";
import { WORKER_DEMAND_QUERY } from "./worker-demand.mjs";

const API = "2025-07-01";
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join() === keys.split(",").sort().join();
const same = (a, b) => hash(a) === hash(b);
const sameId = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
class DemandError extends Error {}
const need = (v, code) => { if (!v) throw new DemandError(code); };
export const managedAzureWorkerDemandDiagnostic = e => e instanceof DemandError ? e.message : null;
const schedulerCadence = demand => Object.hasOwn(demand, "schedulerCadenceMinutes") ? demand.schedulerCadenceMinutes : 1;
const schedulerCron = cadence => cadence === 5 ? "*/5 * * * *" : "* * * * *";

export function validateManagedAzureWorkerDemand(value, target, context = {}) {
  const p = structuredClone(value);
  const identityPrefix = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/`;
  need(exact(p, `schedulerJobName,scalerConnectionSecret,schedulerResources${Object.hasOwn(p ?? {}, "schedulerCadenceMinutes") ? ",schedulerCadenceMinutes" : ""}`)
    && [1, 5].includes(schedulerCadence(p)) && /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(p.schedulerJobName)
    && !p.schedulerJobName.includes("--") && !Object.values(target.apps).includes(p.schedulerJobName), "WORKER_DEMAND_PLAN_INVALID");
  need(exact(p.schedulerResources, "cpu,memory") && Number.isFinite(p.schedulerResources.cpu)
    && p.schedulerResources.cpu >= 0.25 && p.schedulerResources.cpu <= 4 && Number.isInteger(p.schedulerResources.cpu * 4)
    && p.schedulerResources.memory === `${p.schedulerResources.cpu * 2}Gi`, "WORKER_DEMAND_SCHEDULER_RESOURCES_INVALID");
  const s = p.scalerConnectionSecret;
  need(exact(s, "name,keyVaultUrl,identity") && s.name === "worker-scaler-connection"
    && typeof s.identity === "string" && s.identity.startsWith(identityPrefix) && /^[A-Za-z0-9_-]{1,128}$/.test(s.identity.slice(identityPrefix.length))
    && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[A-Za-z0-9-]{1,127}\/[a-f0-9]{32}$/.test(s.keyVaultUrl)
    && (!context.managedIdentityId || sameId(s.identity, context.managedIdentityId))
    && (!context.runtimeVaultUri || s.keyVaultUrl.startsWith(`${context.runtimeVaultUri}secrets/`)), "WORKER_DEMAND_SCALER_SECRET_INVALID");
  return p;
}

export function managedAzureWorkerDemandScale(value) {
  return { minReplicas: 0, maxReplicas: 1, cooldownPeriod: 30, pollingInterval: 10, rules: [
    { name: "postgres-demand", custom: { type: "postgresql", metadata: {
      query: WORKER_DEMAND_QUERY, targetQueryValue: "1", activationTargetQueryValue: "0" },
    auth: [{ secretRef: value.scalerConnectionSecret.name, triggerParameter: "connection" }] } },
    { name: "internal-health-wake", http: { metadata: { concurrentRequests: "1" } } },
  ] };
}

export function assertManagedAzureWorkerDemandApp(app, demand, target) {
  validateManagedAzureWorkerDemand(demand, target);
  const p = app?.properties, c = p?.configuration, container = p?.template?.containers?.[0];
  need(sameId(app?.id, `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.App/containerApps/${target.apps.worker}`)
    && sameId(p?.environmentId ?? p?.managedEnvironmentId, target.environmentId)
    && p?.template?.containers?.length === 1 && same(p.template.scale, managedAzureWorkerDemandScale(demand))
    && c?.activeRevisionsMode === "Single" && c?.ingress?.external === false && c.ingress.targetPort === 9090 && c.ingress.allowInsecure === false
    && app.identity?.type === "UserAssigned" && Object.keys(app.identity.userAssignedIdentities ?? {}).length === 1
    && sameId(Object.keys(app.identity.userAssignedIdentities)[0], demand.scalerConnectionSecret.identity)
    && (!container.command || container.command.length === 0) && (!container.args || container.args.length === 0)
    && container.env?.filter(e => e.name === "WORKER_EXECUTION_MODE").length === 1
    && container.env.find(e => e.name === "WORKER_EXECUTION_MODE").value === "queue-only"
    && !container.env.some(e => e.name === "WORKER_SCHEDULER_PROOF_NONCE"
      || e.name === "WORKER_SCHEDULER_CADENCE_MINUTES" || e.secretRef === demand.scalerConnectionSecret.name), "WORKER_DEMAND_APP_DRIFT");
  const scaler = c.secrets?.filter(s => s.name === demand.scalerConnectionSecret.name);
  need(scaler?.length === 1 && same({ name: scaler[0].name, keyVaultUrl: scaler[0].keyVaultUrl, identity: scaler[0].identity }, demand.scalerConnectionSecret)
    && scaler[0].value == null, "WORKER_DEMAND_SCALER_SECRET_DRIFT");
  const db = container.env.find(e => e.name === "DATABASE_URL");
  need(db?.secretRef && db.secretRef !== demand.scalerConnectionSecret.name
    && c.secrets.some(s => s.name === db.secretRef && s.keyVaultUrl !== demand.scalerConnectionSecret.keyVaultUrl), "WORKER_DEMAND_RUNTIME_CREDENTIAL_INVALID");
  return true;
}

export function buildManagedAzureSchedulerJob({ workerApp, demand, target, trigger = "Manual" }) {
  assertManagedAzureWorkerDemandApp(workerApp, demand, target);
  need(["Manual", "Schedule"].includes(trigger), "WORKER_DEMAND_TRIGGER_INVALID");
  const p = workerApp.properties, runtime = structuredClone(p.template.containers[0]);
  runtime.name = "scheduler";
  runtime.resources = structuredClone(demand.schedulerResources);
  delete runtime.probes;
  runtime.env = runtime.env.map(e => e.name === "WORKER_EXECUTION_MODE" ? { name: e.name, value: "scheduler-once" } : e);
  if (schedulerCadence(demand) === 5) runtime.env.push({ name: "WORKER_SCHEDULER_CADENCE_MINUTES", value: "5" });
  return { location: workerApp.location,
    identity: { type: "UserAssigned", userAssignedIdentities: { [demand.scalerConnectionSecret.identity]: {} } },
    properties: { environmentId: target.environmentId, workloadProfileName: "Consumption",
      configuration: { triggerType: trigger, replicaTimeout: 120, replicaRetryLimit: 0,
        [trigger === "Manual" ? "manualTriggerConfig" : "scheduleTriggerConfig"]: {
          parallelism: 1, replicaCompletionCount: 1, ...(trigger === "Schedule" ? { cronExpression: schedulerCron(schedulerCadence(demand)) } : {}) },
        secrets: p.configuration.secrets.filter(s => s.name !== demand.scalerConnectionSecret.name).map(s => ({ name: s.name, keyVaultUrl: s.keyVaultUrl, identity: s.identity })),
        registries: structuredClone(p.configuration.registries) },
      template: { containers: [runtime], initContainers: [] } } };
}

export function schedulerJobWithRelease(body, image, release, trigger = "Manual") {
  const next = structuredClone(body), c = next.properties.template.containers[0];
  need(/\/corgtex\/worker@sha256:[a-f0-9]{64}$/.test(image), "WORKER_DEMAND_IMAGE_INVALID");
  need(["Manual", "Schedule"].includes(trigger), "WORKER_DEMAND_TRIGGER_INVALID");
  const cadenceValues = c.env.filter(e => e.name === "WORKER_SCHEDULER_CADENCE_MINUTES");
  need(cadenceValues.length <= 1 && (cadenceValues.length === 0 || cadenceValues[0].value === "5"), "WORKER_DEMAND_SCHEDULER_POLICY_INVALID");
  const cron = schedulerCron(cadenceValues.length ? 5 : 1);
  if (next.properties.configuration.triggerType === "Schedule") {
    need(next.properties.configuration.scheduleTriggerConfig?.cronExpression === cron, "WORKER_DEMAND_SCHEDULER_CADENCE_DRIFT");
  }
  c.image = image;
  const generated = { CORGTEX_RELEASE_GIT_SHA: release.gitSha, CORGTEX_RELEASE_IMAGE_TAG: release.imageTag, CORGTEX_RELEASE_VERSION: release.version };
  c.env = c.env.map(e => generated[e.name] === undefined ? e : { name: e.name, value: generated[e.name] });
  next.properties.configuration.triggerType = trigger;
  delete next.properties.configuration.manualTriggerConfig; delete next.properties.configuration.scheduleTriggerConfig;
  next.properties.configuration[trigger === "Manual" ? "manualTriggerConfig" : "scheduleTriggerConfig"] = {
    parallelism: 1, replicaCompletionCount: 1, ...(trigger === "Schedule" ? { cronExpression: cron } : {}) };
  return next;
}

function omitNull(value, keys) {
  for (const key of keys) if (value[key] == null) delete value[key];
  return value;
}
function configurationIdentity(value) {
  const result = structuredClone(value);
  omitNull(result, ["dapr", "eventTriggerConfig", "manualTriggerConfig", "scheduleTriggerConfig"]);
  if (result.identitySettings?.length === 0) delete result.identitySettings;
  for (const secret of result.secrets ?? []) omitNull(secret, ["value"]);
  for (const registry of result.registries ?? []) {
    omitNull(registry, ["username", "passwordSecretRef", "identity"]);
    // ARM materializes an inactive identity for password-authenticated registries.
    if (registry.identity === "" && typeof registry.username === "string" && registry.username.length > 0
      && typeof registry.passwordSecretRef === "string" && registry.passwordSecretRef.length > 0) delete registry.identity;
  }
  return result;
}
function region(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9 ]{1,63}$/.test(value) ? value.replaceAll(" ", "").toLowerCase() : null;
}
function templateIdentity(template) {
  const result = structuredClone(template);
  if (!result.initContainers) result.initContainers = [];
  if (result.volumes == null || result.volumes.length === 0) delete result.volumes;
  for (const c of result.containers ?? []) {
    if (c.imageType == null || c.imageType === "ContainerImage") delete c.imageType;
    if (c.command == null || c.command.length === 0) delete c.command;
    if (c.args == null || c.args.length === 0) delete c.args;
    for (const env of c.env ?? []) omitNull(env, ["value", "secretRef"]);
    const resources = c.resources;
    if (resources && (resources.ephemeralStorage == null || resources.ephemeralStorage === ""
      || resources.ephemeralStorage === managedAzureConsumptionEphemeralStorage(resources.cpu))) delete resources.ephemeralStorage;
    c.env?.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}
export function assertManagedAzureSchedulerJob(actual, expected, jobId) {
  const p = actual?.properties, e = expected.properties;
  const identities = Object.keys(actual?.identity?.userAssignedIdentities ?? {});
  need(sameId(actual?.id, jobId) && sameId(actual?.type, "Microsoft.App/jobs")
    && actual.name === jobId.split("/").at(-1) && region(actual.location) !== null && region(actual.location) === region(expected.location)
    && actual.identity?.type === "UserAssigned" && identities.length === 1
    && sameId(identities[0], Object.keys(expected.identity.userAssignedIdentities)[0])
    && p?.provisioningState === "Succeeded" && sameId(p.environmentId, e.environmentId)
    && p.workloadProfileName === "Consumption" && same(configurationIdentity(p.configuration), configurationIdentity(e.configuration))
    && same(templateIdentity(p.template), templateIdentity(e.template)), "WORKER_DEMAND_SCHEDULER_DRIFT");
  return true;
}

/** Bounded direct execution logs. Raw provider output never enters evidence or diagnostics. */
export function createManagedAzureSchedulerProofReader({ exec = promisify(execFile) } = {}) {
  return async ({ jobId, execution, signal }) => {
    const parts = jobId.split("/"), common = ["--subscription", parts[2], "--resource-group", parts[4], "--name", parts.at(-1), "--execution", execution.name];
    try {
      const options = { encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024, shell: false, signal,
        env: { ...process.env, AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" } };
      const replicas = JSON.parse((await exec("az", ["containerapp", "job", "replica", "list", ...common, "--output", "json", "--only-show-errors"], options)).stdout);
      need(Array.isArray(replicas) && replicas.length === 1 && /^[a-z0-9-]{1,100}$/.test(replicas[0].name)
        && replicas[0].name.startsWith(`${execution.name}-`), "WORKER_DEMAND_PROOF_REPLICA_INVALID");
      const replicaName = replicas[0].name;
      const { stdout } = await exec("az", ["containerapp", "job", "logs", "show", ...common, "--replica", replicaName,
        "--container", "scheduler", "--tail", "100", "--format", "text", "--only-show-errors"], options);
      const records = [];
      for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
        // Native text output preserves JSON escaping, unlike the installed
        // CLI's JSON mode. Accept only a complete stdout CRI record; connection
        // notices, stderr, partial fragments and arbitrary JSON substrings are not proof.
        const framed = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})) stdout F (\{.*\})$/.exec(line);
        if (!framed || !Number.isFinite(Date.parse(framed[1]))) continue;
        let wrapper, receipt;
        try {
          wrapper = JSON.parse(framed[2]);
          if (wrapper?.level !== "info" || typeof wrapper.msg !== "string") continue;
          receipt = JSON.parse(wrapper.msg);
        } catch { continue; }
        if (receipt?.event === "scheduler_complete") records.push(receipt);
      }
      need(records.length === 1, "WORKER_DEMAND_PROOF_LOG_UNPROVEN");
      return { jobId, executionId: execution.id, replicaName, containerName: "scheduler", receipt: records[0] };
    } catch (error) { throw error instanceof DemandError ? error : new DemandError("WORKER_DEMAND_PROOF_LOG_UNAVAILABLE"); }
  };
}

/** All mutation dispatches are journalled by the caller's existing phase recorder.
 * An inherited intent is observation-only; no provider retry or ambiguous replay. */
export function createManagedAzureWorkerDemandLifecycle({ jobId, target, operations, proofStore, proofPrefix, request, check, signal,
  schedulerProof = createManagedAzureSchedulerProofReader(), now = Date.now,
  wait = ms => delay(ms, undefined, { signal }), timeoutMs = 180_000 }) {
  need(jobId.startsWith(`/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.App/jobs/`)
    && signal instanceof AbortSignal && [request, check, schedulerProof].every(v => typeof v === "function"), "WORKER_DEMAND_DEPENDENCY_INVALID");
  async function readJob() { await check(); const r = await request(jobId, { apiVersion: API }); await check(); return r; }
  async function executions() {
    await check(); const r = await request(`${jobId}/executions`, { apiVersion: API }); await check();
    need(r.status === 200 && Array.isArray(r.body?.value) && r.body.value.length <= 100 && !r.body.nextLink, "WORKER_DEMAND_EXECUTION_INVENTORY_INVALID");
    return r.body.value.map(e => {
      need(/^[a-z0-9][a-z0-9-]{0,79}$/.test(e.name) && (!e.id || sameId(e.id, `${jobId}/executions/${e.name}`))
        && ["Running", "Processing", "Succeeded", "Failed", "Stopped", "Degraded", "Unknown"].includes(e.properties?.status), "WORKER_DEMAND_EXECUTION_INVALID");
      return { ...e, id: `${jobId}/executions/${e.name}` };
    });
  }
  async function assertJob(body) { const r = await readJob(); need(r.status === 200, "WORKER_DEMAND_SCHEDULER_MISSING"); assertManagedAzureSchedulerJob(r.body, body, jobId); return r.body; }
  async function drained(body) {
    await assertJob(body);
    const rows = await executions();
    need(rows.every(e => ["Succeeded", "Failed", "Stopped"].includes(e.properties.status)), "WORKER_DEMAND_SCHEDULER_NOT_DRAINED");
    return { complete: true, evidence: { jobId, bodySha256: hash(body), executionInventorySha256: hash(rows), drained: true } };
  }
  async function settle(body, requireDrained) {
    const deadline = now() + timeoutMs;
    while (true) {
      await check(); need(now() < deadline, "WORKER_DEMAND_DEADLINE");
      const r = await readJob();
      if (r.status === 200 && r.body.properties?.provisioningState === "Succeeded") {
        assertManagedAzureSchedulerJob(r.body, body, jobId);
        const rows = await executions();
        if (!requireDrained || rows.every(e => ["Succeeded", "Failed", "Stopped"].includes(e.properties.status))) {
          return { complete: true, evidence: { jobId, bodySha256: hash(body), executionInventorySha256: hash(rows), drained: requireDrained } };
        }
      } else need(r.status === 200 && !["Failed", "Canceled"].includes(r.body.properties?.provisioningState), "WORKER_DEMAND_PROVISIONING_FAILED");
      await wait(1000);
    }
  }
  async function write(kind, before, body, allowDispatch, requireDrained = true) {
    need(operations && typeof operations.runRecordedOperation === "function", "WORKER_DEMAND_RECORDER_REQUIRED");
    const input = { jobId, bodySha256: hash(body), beforeSha256: before ? hash(before) : null };
    const prior = await operations.readStatus(kind, input);
    if (prior.receipt) return prior.receipt;
    need(prior.intent || allowDispatch, "WORKER_DEMAND_CONTINUATION_REQUIRED");
    return operations.runRecordedOperation({ kind, input,
      apply: async () => {
        await check();
        if (Array.isArray(before)) {
          const observed = await readJob();
          need(observed.status === 200 && before.some(candidate => {
            try { assertManagedAzureSchedulerJob(observed.body, candidate, jobId); return true; } catch { return false; }
          }), "WORKER_DEMAND_SCHEDULER_DRIFT");
        } else if (before) await assertJob(before);
        else { const r = await readJob(); need(r.status === 404, "WORKER_DEMAND_SCHEDULER_NOT_ABSENT"); }
        const r = await request(jobId, { method: "PUT", body, apiVersion: API }); await check();
        need([200, 201, 202].includes(r.status), "WORKER_DEMAND_WRITE_UNCERTAIN");
      }, verify: () => settle(body, requireDrained) });
  }
  async function prove(body, release, context, allowDispatch) {
    const nonce = hash({ jobId, bodySha256: hash(body), context });
    const template = structuredClone(body.properties.template);
    template.containers[0].env.push({ name: "WORKER_SCHEDULER_PROOF_NONCE", value: nonce });
    const input = { jobId, context, nonce, templateSha256: hash(template), release };
    const kind = "WORKER_SCHEDULER_PROOF";
    const prior = await operations.readStatus(kind, input);
    need(prior.intent || allowDispatch, "WORKER_DEMAND_CONTINUATION_REQUIRED");
    need(proofStore && [proofStore.assertPrivate, proofStore.readOptional, proofStore.createOnly].every(v => typeof v === "function")
      && /^operations\/(ops|core)\/[a-f0-9]{64}\/[a-f0-9-]{36}\/$/.test(proofPrefix), "WORKER_DEMAND_PROOF_STORE_REQUIRED");
    const proofKey = `${proofPrefix}${hash({ kind, inputSha256: hash(input) })}/descriptor.json`;
    const retainedType = "WORKER_SCHEDULER_VERIFIED_PROOF";
    async function readProof() {
      await check(); await proofStore.assertPrivate();
      const text = await proofStore.readOptional(proofKey, signal); await check();
      if (text === null) return null;
      need(typeof text === "string" && Buffer.byteLength(text) <= 65536, "WORKER_DEMAND_RETAINED_PROOF_INVALID");
      let retained; try { retained = JSON.parse(text); } catch { throw new DemandError("WORKER_DEMAND_RETAINED_PROOF_INVALID"); }
      need(exact(retained, "schemaVersion,type,input,proof") && retained.schemaVersion === 1 && retained.type === retainedType
        && same(retained.input, input), "WORKER_DEMAND_RETAINED_PROOF_INVALID");
      return retained;
    }
    function assertRetainedProof(retained, status) {
      const binding = status.intent?.binding;
      need(proofPrefix === `operations/${binding?.domain}/${binding?.intentSha256}/${binding?.phaseOperationId}/`
        && status.receipt && retained?.proof?.complete === true && hash(retained.proof) === status.receipt.evidenceSha256
        && retained.proof.jobId === jobId && retained.proof.nonce === nonce && retained.proof.context === context
        && retained.proof.templateSha256 === input.templateSha256 && same(retained.proof.release, release)
        && retained.proof.image === template.containers[0].image, "WORKER_DEMAND_RETAINED_PROOF_INVALID");
      return structuredClone(retained.proof);
    }
    // Provider receipts retain the verified evidence digest. The corresponding
    // immutable safe projection is retained before that receipt is committed.
    // Later reconciliation must not depend on ephemeral execution/pod logs.
    if (prior.receipt) return assertRetainedProof(await readProof(), prior);
    let proof;
    const verify = async () => {
      const deadline = now() + timeoutMs;
      while (true) {
        await check(); need(now() < deadline, "WORKER_DEMAND_PROOF_DEADLINE");
        const matching = (await executions()).filter(e => e.properties.template?.containers?.[0]?.env?.some(v => v.name === "WORKER_SCHEDULER_PROOF_NONCE" && v.value === nonce));
        need(matching.length <= 1, "WORKER_DEMAND_PROOF_AMBIGUOUS");
        const e = matching[0];
        if (!e || ["Running", "Processing"].includes(e.properties.status)) { await wait(1000); continue; }
        need(e.properties.status === "Succeeded" && same(templateIdentity(e.properties.template), templateIdentity(template)), "WORKER_DEMAND_PROOF_EXECUTION_INVALID");
        const observed = await schedulerProof({ jobId, execution: e, template: structuredClone(template), nonce, release, signal }); await check();
        const r = observed?.receipt, start = Date.parse(e.properties.startTime), end = Date.parse(e.properties.endTime);
        need(observed?.jobId === jobId && observed.executionId === e.id && observed.containerName === "scheduler"
          && typeof observed.replicaName === "string" && observed.replicaName.startsWith(`${e.name}-`)
          && r?.event === "scheduler_complete" && r.skipped === false && r.proofNonce === nonce
          && r.executionMode === "scheduler-once" && r.release?.gitSha === release.gitSha
          && r.release?.evidence === "baked" && r.release.version === release.version && r.release.imageTag === release.imageTag
          && r.release.drift?.gitSha === false && r.release.drift.version === false && r.release.drift.imageTag === false
          && Array.isArray(r.release.drift.details) && r.release.drift.details.length === 0
          && Date.parse(r.ts) >= start && Date.parse(r.ts) <= end + (/T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(e.properties.endTime) ? 999 : 0)
          && Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 180_000
          && ["finalized", "dispatched", "processed", "scheduled", "scheduledPeriodic", "scheduledDrip"].every(k => Number.isSafeInteger(r.counts?.[k]) && r.counts[k] >= 0)
          && r.counts.dispatched === 0 && r.counts.processed === 0, "WORKER_DEMAND_PROOF_RECEIPT_INVALID");
        proof = { complete: true, jobId, executionId: e.id, nonce, context, templateSha256: hash(template),
          image: template.containers[0].image, release, receiptSha256: hash(r), startedAt: start, completedAt: end };
        const retained = { schemaVersion: 1, type: retainedType, input, proof };
        const existing = await readProof();
        if (existing === null) { await check(); await proofStore.createOnly(proofKey, JSON.stringify(retained), signal); await check(); }
        need(same(await readProof(), retained), "WORKER_DEMAND_RETAINED_PROOF_INVALID");
        return { complete: true, evidence: proof };
      }
    };
    await operations.runRecordedOperation({ kind, input, apply: async () => {
      await drained(body);
      const r = await request(`${jobId}/start`, { apiVersion: API, method: "POST", body: template }); await check();
      need([200, 202].includes(r.status), "WORKER_DEMAND_PROOF_START_UNCERTAIN");
    }, verify });
    return assertRetainedProof(await readProof(), await operations.readStatus(kind, input));
  }
  async function assertProofStartSettled(body, release, context) {
    const nonce = hash({ jobId, bodySha256: hash(body), context });
    const template = structuredClone(body.properties.template);
    template.containers[0].env.push({ name: "WORKER_SCHEDULER_PROOF_NONCE", value: nonce });
    const prior = await operations.readStatus("WORKER_SCHEDULER_PROOF", { jobId, context, nonce, templateSha256: hash(template), release });
    if (!prior.intent || prior.receipt) return;
    const matching = (await executions()).filter(e => e.properties.template?.containers?.[0]?.env?.some(v => v.name === "WORKER_SCHEDULER_PROOF_NONCE" && v.value === nonce));
    need(matching.length === 1 && ["Succeeded", "Failed", "Stopped"].includes(matching[0].properties.status)
      && same(templateIdentity(matching[0].properties.template), templateIdentity(template)), "WORKER_DEMAND_PROOF_START_UNSETTLED");
  }
  async function observe(body) {
    await assertJob(body); const rows = await executions();
    for (const e of rows.filter(e => !["Succeeded", "Failed", "Stopped"].includes(e.properties.status))) {
      need(same(templateIdentity(e.properties.template), templateIdentity(body.properties.template)), "WORKER_DEMAND_FOREIGN_SCHEDULER_EXECUTION");
    }
    return { complete: true, jobId, bodySha256: hash(body), executionInventorySha256: hash(rows) };
  }
  return Object.freeze({ write, prove, observe, drained, assertJob, assertProofStartSettled });
}
