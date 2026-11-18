import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { createAzureTargetArmTransport, opsCoreAzureTargetBindingSha256, OPS_CORE_APP_SNAPSHOT_API } from "./ops-core-azure-target.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { createManagedAzureContainerAppTransport, buildManagedAzureReleaseTemplate,
  managedAzureTemplateDigest, managedAzureConfigurationDigest, canonicalizeManagedAzureContainerAppState } from "../release/managed-azure-container-app-transport.mjs";
import { snapshotManagedAzureExclusiveActivation } from "../release/managed-azure-exclusive-activation.mjs";
import { managedAzureHealthReady } from "../release/managed-azure-release-transaction.mjs";
import { projectWorkerHealth, validateHealthChallenge } from "./ops-core-health-probe.mjs";
import { buildHealthProbeJobDefinition, assertHealthJobStartDescriptor } from "./ops-core-health-job.mjs";
import { opsCoreImageRepository } from "./ops-core-image-repository.mjs";

import { opsCoreRevisionSuffix } from "./ops-core-activation-revision.mjs";
import { createOpsCoreActivationArmTransport } from "./ops-core-activation.mjs";
import { validateManagedAzureWorkerDemand, assertManagedAzureWorkerDemandApp, buildManagedAzureSchedulerJob,
  schedulerJobWithRelease, createManagedAzureWorkerDemandLifecycle } from "../release/managed-azure-worker-demand.mjs";

const ROLES = ["web", "worker"];
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const exact = (v, names) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join() === names.split(",").sort().join();
class UpdateError extends Error {}
const need = (value, code) => { if (!value) throw new UpdateError(code); };
export const opsCoreUpdateDiagnostic = error => error instanceof UpdateError ? error.message : null;
const same = (a, b) => hash(a) === hash(b);

export function validateOpsCoreUpdatePlan(input) {
  const p = structuredClone(input);
  need([1, 2].includes(p.schemaVersion) && exact(p, `schemaVersion,domain,releaseId,target,acrName,authority,baseline,incoming,recovery,origins${p.schemaVersion === 2 ? ",workerDemand" : ""}`) && UUID.test(p.releaseId) && p.domain === p.target?.domain
    && /^[a-z0-9]{5,50}$/.test(p.acrName), "UPDATE_PLAN_INVALID");
  opsCoreAzureTargetBindingSha256(p.target);
  if (p.schemaVersion === 2) validateManagedAzureWorkerDemand(p.workerDemand, p.target);
  need(ROLES.every(role => /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(p.target.apps[role])
    && !p.target.apps[role].includes("--")), "UPDATE_TARGET_INVALID");
  need(exact(p.authority, "acceptedMigrationSha256,migrationIntentSha256,migrationSourceFenceSha256,compatibilitySha256")
    && Object.values(p.authority).every(value => HASH.test(value)), "UPDATE_AUTHORITY_INVALID");
  for (const key of ["baseline", "incoming", "recovery"]) {
    const v = p[key];
    need(exact(v, "release,images") && exact(v.release, "gitSha,imageTag,version")
      && /^[a-f0-9]{40}$/.test(v.release.gitSha) && v.release.imageTag === `sha-${v.release.gitSha}`
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(v.release.version) && exact(v.images, "web,worker")
      && ROLES.every(role => v.images[role].startsWith(`${opsCoreImageRepository(`${p.acrName}.azurecr.io`, role)}@sha256:`)
        && HASH.test(v.images[role].split("@sha256:")[1])), "UPDATE_RELEASE_INVALID");
  }
  need(exact(p.origins, "web,worker") && ROLES.every(role => typeof p.origins[role] === "string"
    && new RegExp(`^https://${p.target.apps[role]}\\.${role === "worker" ? "internal\\." : ""}[a-z0-9.-]+\\.azurecontainerapps\\.io$`).test(p.origins[role])),
  "UPDATE_ORIGIN_INVALID");
  return p;
}

export function opsCoreUpdateTransportTarget(plan) {
  return { subscriptionId: plan.target.subscriptionId, resourceGroup: plan.target.resourceGroupName,
    acrName: plan.acrName, acrServer: `${plan.acrName}.azurecr.io`,
    webAppName: plan.target.apps.web, workerAppName: plan.target.apps.worker };
}

/** Read-only ACR preflight. Immutable forward AND compatible recovery images
 * must already exist before the old writer is drained. No import/build here. */
export async function assertOpsCoreUpdateImages(plan, signal, exec = promisify(execFile)) {
  for (const image of new Set([plan.incoming, plan.recovery].flatMap(v => Object.values(v.images)))) {
    signal.throwIfAborted();
    const reference = image.slice(`${plan.acrName}.azurecr.io/`.length);
    try {
      const { stdout } = await exec("az", ["acr", "manifest", "show-metadata", "--registry", plan.acrName,
        "--subscription", plan.target.subscriptionId, "--name", reference, "--output", "json", "--only-show-errors"],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 65536, shell: false, signal });
      need(JSON.parse(stdout).digest === image.split("@")[1], "UPDATE_IMAGE_UNPROVEN");
    } catch { throw new UpdateError("UPDATE_IMAGE_UNPROVEN"); }
  }
  return { complete: true, imagesSha256: hash({ incoming: plan.incoming.images, recovery: plan.recovery.images }) };
}

export async function fetchOpsCoreUpdateWebHealth({ origin, signal }, fetchImpl = fetch) {
  const url = `${origin}/api/health`, bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const r = await fetchImpl(url, { method: "GET", redirect: "error", signal: bounded, headers: { Accept: "application/json" } });
  need(r.status === 200 && !r.redirected && r.url === url
    && /^application\/json(?:\s*;|$)/i.test(r.headers.get("content-type") ?? "") && r.body, "UPDATE_WEB_HEALTH_UNPROVEN");
  const parts = []; let bytes = 0;
  for await (const part of r.body) { bytes += part.length; need(bytes <= 32768, "UPDATE_WEB_HEALTH_TOO_LARGE"); parts.push(Buffer.from(part)); }
  bounded.throwIfAborted();
  return { health: { status: 200, body: JSON.parse(Buffer.concat(parts).toString("utf8")) } };
}

/** Direct Azure release; no Ops inventory, database, API or Railway dependency.
 * apply is only for the original lease owner. reconcile makes no runtime writes
 * and may finish an already completed pair. recover is an explicit, separately
 * recorded transition to preapproved schema-compatible Azure images. It never
 * replays a forward effect or clears the migrated-database write boundary.
 * Callers bind authority to retained ACCEPTED migration and compatibility proof.
 */
export async function runOpsCoreUpdate({ plan: input, custody, operationStore: store, action = "apply",
  assertDeploymentAuthority, prepareHealth, workerHealth, settleHealth,
  webHealth = fetchOpsCoreUpdateWebHealth, assertImages = assertOpsCoreUpdateImages,
  transport = createManagedAzureContainerAppTransport(), armTransport, demandArmTransport, schedulerProof,
  now = Date.now, wait = (ms, signal) => delay(ms, undefined, { signal }) }) {
  const p = validateOpsCoreUpdatePlan(input), target = opsCoreUpdateTransportTarget(p);
  const arm = armTransport ?? createAzureTargetArmTransport({ subscriptionId: p.target.subscriptionId });
  need(["apply", "reconcile", "recover", "resume"].includes(action) && custody?.signal instanceof AbortSignal
    && [assertDeploymentAuthority, prepareHealth, workerHealth].every(fn => typeof fn === "function"), "UPDATE_CALLBACK_REQUIRED");
  const demandArm = p.workerDemand ? demandArmTransport ?? createOpsCoreActivationArmTransport({ subscriptionId: p.target.subscriptionId }) : null;
  const schedulerId = p.workerDemand ? `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/jobs/${p.workerDemand.schedulerJobName}` : null;
  const workerAppId = `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/containerApps/${p.target.apps.worker}`;
  const binding = { domain: p.domain, intentSha256: hash(p), releaseId: p.releaseId,
    targetBindingSha256: opsCoreAzureTargetBindingSha256(p.target), ...p.authority };
  async function owned() {
    custody.signal.throwIfAborted(); await custody.assertOwned(); custody.signal.throwIfAborted();
    const c = custody.snapshot();
    need(c.domain === p.domain && c.intentSha256 === binding.intentSha256
      && c.pending?.to === "RELEASING" && c.pending.operationId === p.releaseId, "UPDATE_CUSTODY_CHANGED");
  }
  async function authority() {
    await owned(); const observed = await assertDeploymentAuthority(structuredClone(binding)); await owned();
    need(observed?.complete === true && same(observed.binding, binding), "UPDATE_AUTHORITY_UNPROVEN");
  }
  await authority();
  need(custody.mode !== "finished" && (action !== "apply" || custody.mode === "apply"), "UPDATE_RECONCILE_REQUIRED");
  if (action === "resume") need(custody.mode === "reconcile" && p.workerDemand, "UPDATE_RESUME_STAGE_UNSUPPORTED");
  need(!custody.result || action === "reconcile", "UPDATE_RESULT_RECONCILE_REQUIRED");
  const prefix = `operations/${p.domain}/${binding.intentSha256}/${p.releaseId}`;
  const snapshotKey = `${prefix}/phase-plan.json`;
  const decisionKey = `${prefix}/${hash({ kind: "UPDATE_RECOVERY_DECISION" })}/descriptor.json`;
  const unchangedKey = `${prefix}/${hash({ kind: "UPDATE_UNCHANGED_DECISION" })}/descriptor.json`;
  const resumeKey = `${prefix}/${hash({ kind: "UPDATE_FORWARD_RESUME_DECISION" })}/descriptor.json`;
  async function read(key) {
    await owned(); await store.assertPrivate(); const text = await store.readOptional(key, custody.signal); await owned();
    if (text === null) return null;
    need(typeof text === "string" && Buffer.byteLength(text) <= 65536, "UPDATE_RECORD_INVALID");
    return JSON.parse(text);
  }
  async function retain(key, value) {
    const before = await read(key);
    if (before !== null) { need(same(before, value), "UPDATE_RECORD_CHANGED"); return; }
    await owned(); await store.createOnly(key, JSON.stringify(value), custody.signal); await owned();
    need(same(await read(key), value), "UPDATE_RECORD_UNPROVEN");
  }
  async function onlyBaselineObservations() {
    need(typeof store.listRecords === "function", "UPDATE_RECORD_INVENTORY_REQUIRED");
    await owned();
    const keys = await store.listRecords(`${prefix}/`, custody.signal);
    await owned();
    const allowed = new Set([snapshotKey]);
    const observer = await openProviderOperationRecorder({ custody, store, phase: "RELEASING", signal: custody.signal });
    const baselineTarget = { appId: `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/containerApps/${p.target.apps.worker}`,
      origin: p.origins.worker, image: p.baseline.images.worker, release: p.baseline.release };
    const indices = new Set();
    for (const key of keys.filter(key => key.endsWith("/descriptor.json"))) {
      const d = await read(key);
      // A recovery decision or a non-observer descriptor cannot establish an
      // unused attempt. Full runtime intents/receipts also remain outside the
      // allow-set built from independently validated baseline probe inputs.
      if (d?.kind !== "AZURE_HEALTH_PROBE_START" || !d.input?.plan || !d.input.challenge) return false;
      const h = d.input.plan, challenge = d.input.challenge, index = d.input.index;
      if (!Number.isInteger(index) || index < 0 || index >= 10) return false;
      const context = { domain: p.domain, intentSha256: binding.intentSha256, sourceFenceSha256: p.authority.migrationSourceFenceSha256,
        phaseOperationId: p.releaseId, ...(p.workerDemand ? { workerDemandSha256: hash({ plan: p.workerDemand, target: p.target }) } : {}),
        mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256 };
      const authority = { mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256, releaseId: p.releaseId,
        targetSha256: hash(baselineTarget), sourceFenceProvenance: "historical-migration" };
      assertHealthJobStartDescriptor(d, { plan: h, context, index, authority });
      buildHealthProbeJobDefinition(h);
      if (!same(h.worker, baselineTarget) || h.environmentResourceId !== p.target.environmentId
        || challenge.domain !== p.domain || challenge.intentSha256 !== binding.intentSha256
        || challenge.request?.invocationContext !== "baseline-worker" || challenge.authority?.releaseId !== p.releaseId
        || challenge.authority?.acceptedMigrationSha256 !== p.authority.acceptedMigrationSha256
        || challenge.sourceFenceSha256 !== p.authority.migrationSourceFenceSha256) return false;
      validateHealthChallenge(challenge, h.worker, { jobResourceId: h.jobResourceId,
        imageDigest: h.image.split("@")[1], probeSha256: h.probeSha256 }, { fresh: false });
      // readStatus validates the actual immutable intent/receipt binding and
      // digest. This is read-only and never starts another observation job.
      if (!(await observer.readStatus(d.kind, d.input)).intent) return false;
      const operationKey = hash({ kind: d.kind, inputSha256: hash(d.input) });
      const descriptorKey = `${prefix}/${operationKey}/descriptor.json`;
      const slotKey = `${prefix}/${hash({ kind: "AZURE_HEALTH_PROBE_SLOT", inputSha256: hash({ plan: h, context, index }) })}/descriptor.json`;
      if (![descriptorKey, slotKey].includes(key) || !same(await read(descriptorKey), d) || !same(await read(slotKey), d)) return false;
      indices.add(index);
      allowed.add(descriptorKey); allowed.add(slotKey);
      allowed.add(`${prefix}/${operationKey}/intent.json`); allowed.add(`${prefix}/${operationKey}/receipt.json`);
    }
    return [...indices].sort((a, b) => a - b).every((index, position) => index === position)
      && keys.every(key => allowed.has(key));
  }
  async function workerObservation(phase, context, revisionName) {
    await authority();
    const worker = await workerHealth({ phase, invocationContext: context, revisionName: revisionName,
      release: p[phase].release, origin: p.origins.worker, signal: custody.signal });
    need(worker?.health?.status === 200 && worker.ready?.status === 200 && worker.evidence?.mode === "release"
      && worker.evidence.invocationContext === context && worker.evidence.sourceFenceProvenance === "historical-migration", "UPDATE_WORKER_HEALTH_UNPROVEN");
    const workerTarget = { appId: `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/containerApps/${p.target.apps.worker}`,
      origin: p.origins.worker, image: p[phase].images.worker, release: p[phase].release };
    need(same(projectWorkerHealth(worker.health.body, worker.ready.body, workerTarget), { health: worker.health, ready: worker.ready })
      && worker.evidence.requestSha256 === hash({ role: "worker", origin: p.origins.worker, release: p[phase].release,
        appId: workerTarget.appId, revisionName: revisionName, invocationContext: context })
      && worker.evidence.authoritySha256 === hash({ mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256,
        releaseId: p.releaseId, targetSha256: hash(workerTarget), sourceFenceProvenance: "historical-migration" }), "UPDATE_WORKER_HEALTH_UNPROVEN");
    await authority(); return worker.evidence;
  }
  let unchanged = await read(unchangedKey);
  if (unchanged) need(action === "reconcile" && same(unchanged, { type: "UPDATE_UNCHANGED_DECISION", binding }), "UPDATE_UNCHANGED_DECISION_CHANGED");
  let snapshot = await read(snapshotKey);
  if (snapshot && action === "reconcile" && !unchanged && !custody.result && await onlyBaselineObservations()) {
    unchanged = { type: "UPDATE_UNCHANGED_DECISION", binding };
    await retain(unchangedKey, unchanged);
  }
  if (!snapshot) {
    need(action === "apply" && custody.mode === "apply" || action === "reconcile", "UPDATE_BASELINE_MISSING");
    if (action === "reconcile" && !unchanged) {
      // Demand-mode baseline health runs before snapshot retention. Admit only
      // its native bound observer records (or an empty history), never a runtime
      // effect. Persist UNCHANGED before fresh health so reopening cannot apply.
      need(await onlyBaselineObservations(), "UPDATE_UNRECORDED_BASELINE_EFFECTS");
      unchanged = { type: "UPDATE_UNCHANGED_DECISION", binding };
      await retain(unchangedKey, unchanged);
    }
    const baselines = {};
    for (const role of ROLES) {
      await authority();
      baselines[role] = await transport.readApp({ target, role, release: p.baseline.release,
        imageDigest: p.baseline.images[role].split("@")[1], ...(p.workerDemand && role === "worker" ? { workerDemandEnabled: true } : {}) });
    }
    let demand;
    if (p.workerDemand) {
      await prepareHealth({ phase: "baseline", plan: p, signal: custody.signal });
      await workerObservation("baseline", "baseline-worker", baselines.worker.revisionName);
      await authority();
      const workerAppId = `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/containerApps/${p.target.apps.worker}`;
      const raw = await demandArm({ resourceId: workerAppId, signal: custody.signal }); await authority();
      need(raw.status === 200, "UPDATE_DEMAND_APP_UNPROVEN");
      assertManagedAzureWorkerDemandApp(raw.body, p.workerDemand, p.target);
      need(managedAzureTemplateDigest(raw.body.properties.template) === baselines.worker.templateDigest, "UPDATE_DEMAND_TEMPLATE_DRIFT");
      demand = { baselineJob: buildManagedAzureSchedulerJob({ workerApp: raw.body, demand: p.workerDemand, target: p.target, trigger: "Schedule" }) };
    }
    const ownership = await snapshotManagedAzureExclusiveActivation(transport, target, baselines, { onProgress: authority, signal: custody.signal });
    snapshot = { schemaVersion: 1, binding, baselines, ownership, ...(demand ? { demand } : {}) };
    await retain(snapshotKey, snapshot);
  }
  need(snapshot.schemaVersion === 1 && same(snapshot.binding, binding), "UPDATE_BASELINE_CHANGED");
  const ownership = snapshot.ownership;
  need(ownership?.originalMode === "Single" && ownership.temporaryMode === "Multiple"
    && ROLES.every(role => /^sha256:[a-f0-9]{64}$/.test(ownership.configurationDigests?.[role])
      && snapshot.baselines?.[role]?.image === p.baseline.images[role]
      && snapshot.baselines[role].templateDigest === managedAzureTemplateDigest(snapshot.baselines[role].template)), "UPDATE_BASELINE_INVALID");
  const operations = await openProviderOperationRecorder({ custody, store, phase: "RELEASING", signal: custody.signal });
  const scheduler = p.workerDemand ? createManagedAzureWorkerDemandLifecycle({ jobId: schedulerId, target: p.target, operations, proofStore: store, proofPrefix: `${prefix}/`,
    request: (resourceId, extra = {}) => demandArm({ resourceId, signal: custody.signal, ...extra }),
    check: authority, signal: custody.signal, schedulerProof }) : null;
  if (p.workerDemand) need(snapshot.demand?.baselineJob?.properties?.configuration?.triggerType === "Schedule", "UPDATE_SCHEDULER_BASELINE_INVALID");
  const schedulerBody = (phase, trigger = "Manual") => schedulerJobWithRelease(snapshot.demand.baselineJob,
    p[phase].images.worker, p[phase].release, trigger);
  const candidates = {};
  for (const phase of ["incoming", "recovery"]) {
    candidates[phase] = {};
    for (const role of ROLES) {
      const prefix = phase === "incoming" ? "upd" : "rec", app = p.target.apps[role];
      const build = (suffix) => {
        const template = buildManagedAzureReleaseTemplate({ baseline: snapshot.baselines[role], role, image: p[phase].images[role],
          release: p[phase].release, revisionSuffix: suffix, migrateWeb: role === "web" });
        return { template, revisionName: `${app}--${suffix}` };
      };
      const suffix = opsCoreRevisionSuffix(prefix, app, p.releaseId, role);
      const original = opsCoreRevisionSuffix(prefix, app, p.releaseId, role, true);
      let candidate = build(suffix);
      // Never convert a previously submitted template into another provider write.
      if (suffix !== original) {
        const legacy = build(original);
        if ((await operations.readStatus("UPDATE_TEMPLATE", descriptor(phase, role, legacy))).intent) {
          need(!(await operations.readStatus("UPDATE_TEMPLATE", descriptor(phase, role, candidate))).intent, "UPDATE_REVISION_INTENT_CONFLICT");
          candidate = legacy;
        }
      }
      candidates[phase][role] = candidate;
    }
  }
  const inputFor = (role) => ({ target, role, exclusiveActivation: ownership, onProgress: authority, signal: custody.signal, ...(p.workerDemand && role === "worker" ? { workerDemandEnabled: true } : {}) });
  function descriptor(phase, role, candidate) {
    return { phase, role, revisionName: candidate.revisionName, templateSha256: managedAzureTemplateDigest(candidate.template) };
  }
  const patchInput = (phase, role) => descriptor(phase, role, candidates[phase][role]);
  const known = Object.fromEntries(ROLES.map(role => [role, new Set([snapshot.baselines[role].revisionName])]));
  for (const phase of ["incoming", "recovery"]) for (const role of ROLES) {
    if ((await operations.readStatus("UPDATE_TEMPLATE", patchInput(phase, role))).intent) known[role].add(candidates[phase][role].revisionName);
  }
  async function inspect() {
    await authority(); const result = {};
    for (const role of ROLES) {
      const s = await transport.readExclusiveState(inputFor(role));
      need(s.configurationDigest === ownership.configurationDigests[role]
        && (scheduler && role === "worker" ? s.mode === "Single" : ["Single", "Multiple"].includes(s.mode)) && s.provisioningState === "Succeeded", "UPDATE_PROVIDER_NOT_SETTLED");
      need(s.revisions.every(r => (!r.active && r.replicaCount === 0) || known[role].has(r.revisionName)), "UPDATE_FOREIGN_WRITER");
      result[role] = s;
    }
    await authority(); return result;
  }
  const workerDrained = s => scheduler ? s.mode === "Single" && s.runningStatus === "Stopped"
    && s.revisions.every(r => r.replicaCount === 0) : s.revisions.every(r => !r.active && r.replicaCount === 0);
  async function stoppedTemplate(phase) {
    // A PATCH acknowledgement can precede application provisioning completion.
    // Observe only the exact stopped app and its retained predecessor/candidate;
    // never dispatch another PATCH or weaken the final full census/readback.
    const candidate = candidates[phase].worker;
    const predecessors = [snapshot.baselines.worker, ...(phase === "recovery" && known.worker.has(candidates.incoming.worker.revisionName) ? [candidates.incoming.worker] : [])];
    const allowed = new Map([...predecessors.map(v => [v.revisionName, managedAzureTemplateDigest(v.template)]),
      [candidate.revisionName, managedAzureTemplateDigest(candidate.template)]]);
    const deadline = now() + 180_000;
    const signal = AbortSignal.any([custody.signal, AbortSignal.timeout(180_000)]);
    for (;;) {
      await authority(); need(now() < deadline, "UPDATE_STOPPED_TEMPLATE_TIMEOUT");
      signal.throwIfAborted();
      const r = await demandArm({ resourceId: workerAppId, apiVersion: OPS_CORE_APP_SNAPSHOT_API, signal });
      await authority(); need(now() < deadline, "UPDATE_STOPPED_TEMPLATE_TIMEOUT");
      const raw = r.body, properties = raw?.properties;
      const templateDigest = managedAzureTemplateDigest(properties?.template);
      need(r.status === 200 && raw?.id?.toLowerCase() === workerAppId.toLowerCase()
        && (properties.environmentId ?? properties.managedEnvironmentId)?.toLowerCase() === p.target.environmentId.toLowerCase()
        && properties.runningStatus === "Stopped" && properties.configuration?.activeRevisionsMode === "Single"
        && managedAzureConfigurationDigest(properties.configuration) === ownership.configurationDigests.worker
        && allowed.has(properties.latestRevisionName)
        && (allowed.get(properties.latestRevisionName) === templateDigest
          || templateDigest === managedAzureTemplateDigest(candidate.template)), "UPDATE_STOPPED_TEMPLATE_DRIFT");
      if (properties.provisioningState === "Succeeded") {
        need(properties.latestRevisionName === candidate.revisionName && templateDigest === managedAzureTemplateDigest(candidate.template), "UPDATE_TEMPLATE_DRIFT"); break;
      }
      need(["InProgress", "Accepted", "Updating", "Provisioning"].includes(properties.provisioningState), "UPDATE_STOPPED_TEMPLATE_FAILED");
      await wait(Math.min(1000, deadline - now()), signal);
    }
    const state = (await inspect()).worker;
    need(workerDrained(state), "UPDATE_WORKER_STOP_UNPROVEN");
    const observed = await transport.readAppTemplate({ ...inputFor("worker"), release: p[phase].release,
      imageDigest: p[phase].images.worker.split("@")[1] });
    need(observed.provisioningState === "Succeeded" && observed.state.revisionName === candidate.revisionName
      && observed.state.templateDigest === managedAzureTemplateDigest(candidate.template), "UPDATE_TEMPLATE_DRIFT");
    // The revision projection must also match, but a stopped image is not ready.
    await transport.readRevisionState({ ...inputFor("worker"), revisionName: candidate.revisionName, expectedTemplate: candidate.template });
    need(workerDrained((await inspect()).worker), "UPDATE_WORKER_STOP_UNPROVEN");
    return { revisionName: candidate.revisionName, templateSha256: observed.state.templateDigest, runningStatus: "Stopped" };
  }
  async function selected(phase, role) {
    await authority();
    const candidate = candidates[phase][role];
    need(known[role].has(candidate.revisionName), "UPDATE_REVISION_INTENT_MISSING");
    if (scheduler && role === "worker") {
      need((await inspect()).worker.runningStatus === "Running", "UPDATE_WORKER_START_UNPROVEN");
      await workerObservation(phase, phase === "incoming" ? "release-final" : "recovery-final", candidate.revisionName);
    }
    const state = await transport.readApp({ ...inputFor(role), release: p[phase].release,
      imageDigest: p[phase].images[role].split("@")[1] });
    need(state.revisionName === candidate.revisionName && state.templateDigest === managedAzureTemplateDigest(candidate.template), "UPDATE_TEMPLATE_DRIFT");
    if (scheduler && role === "worker" && (await transport.readRevisionState({ ...inputFor(role), revisionName: candidate.revisionName,
      expectedTemplate: candidate.template })).kind !== "READY") {
      await workerObservation(phase, phase === "incoming" ? "release-final" : "recovery-final", candidate.revisionName);
    }
    need((await transport.readRevisionState({ ...inputFor(role), revisionName: candidate.revisionName,
      expectedTemplate: candidate.template })).kind === "READY", "UPDATE_REVISION_NOT_READY");
    const inventory = (await inspect())[role];
    need(inventory.latestRevisionName === candidate.revisionName && inventory.latestReadyRevisionName === candidate.revisionName
      && inventory.revisions.some(r => r.revisionName === candidate.revisionName && r.active && r.replicaCount > 0)
      && inventory.revisions.every(r => r.revisionName === candidate.revisionName || !r.active && r.replicaCount === 0), "UPDATE_PAIR_NOT_EXCLUSIVE");
    return { revisionName: candidate.revisionName, templateSha256: state.templateDigest };
  }
  function validateWeb(web, phase) {
    const body = web?.health?.body, release = body?.release;
    need(web?.health?.status === 200 && managedAzureHealthReady(body, p[phase].release)
      && release?.runtime?.source === "baked" && release.runtime.evidence === "baked"
      && release.runtime.gitSha === p[phase].release.gitSha
      && release.drift?.gitSha === false && release.drift.version === false && release.drift.imageTag === false
      && Array.isArray(release.drift.details) && release.drift.details.length === 0, "UPDATE_WEB_HEALTH_UNPROVEN");
    return body;
  }
  async function assertWebOrigin(phase) {
    await authority();
    const appId = `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/Microsoft.App/containerApps/${p.target.apps.web}`;
    const response = await arm({ resourceId: appId, apiVersion: OPS_CORE_APP_SNAPSHOT_API, signal: custody.signal });
    await authority();
    const app = response?.body, properties = app?.properties, configuration = properties?.configuration;
    const sameId = (a, b) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
    need(response?.status === 200 && sameId(app?.id, appId)
      && sameId(app?.type, "Microsoft.App/containerApps") && sameId(app?.name, p.target.apps.web)
      && sameId(properties?.environmentId ?? properties?.managedEnvironmentId, p.target.environmentId)
      && properties?.provisioningState === "Succeeded" && configuration?.ingress?.external === true
      && `https://${configuration.ingress.fqdn}` === p.origins.web,
    "UPDATE_WEB_ORIGIN_UNPROVEN");
    need(managedAzureConfigurationDigest(configuration) === ownership.configurationDigests.web,
      "UPDATE_WEB_ORIGIN_UNPROVEN");
    if (phase) {
      const expected = phase === "baseline" ? snapshot.baselines.web : candidates[phase].web;
      const state = canonicalizeManagedAzureContainerAppState(app, { ...inputFor("web"),
        release: p[phase].release, imageDigest: p[phase].images.web.split("@")[1] });
      need(configuration.activeRevisionsMode === "Single" && state.revisionName === expected.revisionName
        && state.templateDigest === managedAzureTemplateDigest(expected.template), "UPDATE_WEB_ORIGIN_UNPROVEN");
    }
  }
  async function boundWebHealth(phase) {
    // The plan's hostname syntax is not target evidence. Bind the exact live
    // app and environment on both sides of each HTTP observation.
    await assertWebOrigin(phase);
    const response = await webHealth({ origin: p.origins.web, release: p[phase].release, signal: custody.signal });
    await assertWebOrigin(phase);
    return validateWeb(response, phase);
  }
  async function health(phase, context, revisions) {
    await authority();
    const body = await boundWebHealth(phase);
    const workerEvidence = await workerObservation(phase, context, revisions.worker);
    await authority(); return { webSha256: hash(body), worker: workerEvidence };
  }
  async function finish(result) {
    const retained = custody.result;
    if (retained) {
      need(same({ ...retained, evidence: result.evidence }, result), "UPDATE_RETAINED_RESULT_CHANGED");
      const fresh = { type: "UPDATE_RECONCILIATION", binding, retainedResultSha256: hash(retained), evidence: result.evidence, revisions: result.revisions };
      await retain(`${prefix}/phase-evidence-${hash(fresh)}.json`, fresh);
    }
    await custody.finish(retained ?? result);
    return retained ?? result;
  }
  if (unchanged) {
    async function unchangedPair() {
      await authority();
      const baselines = {};
      for (const role of ROLES) {
        baselines[role] = await transport.readApp({ target, role, release: p.baseline.release,
          imageDigest: p.baseline.images[role].split("@")[1], ...(p.workerDemand && role === "worker" ? { workerDemandEnabled: true } : {}) });
        need(same(baselines[role], snapshot.baselines[role]), "UPDATE_UNCHANGED_BASELINE_DRIFT");
        need((await transport.readRevisionState({ target, role, ...(p.workerDemand && role === "worker" ? { workerDemandEnabled: true } : {}), revisionName: baselines[role].revisionName,
          expectedTemplate: baselines[role].template })).kind === "READY", "UPDATE_REVISION_NOT_READY");
      }
      need(same(await snapshotManagedAzureExclusiveActivation(transport, target, baselines, { onProgress: authority, signal: custody.signal }), ownership), "UPDATE_UNCHANGED_BASELINE_DRIFT");
      await authority();
    }
    await unchangedPair();
    await prepareHealth({ phase: "baseline", plan: p, signal: custody.signal });
    const revisions = Object.fromEntries(ROLES.map(role => [role, snapshot.baselines[role].revisionName]));
    const evidence = await health("baseline", "baseline-worker", revisions);
    await unchangedPair();
    if (scheduler) evidence.scheduler = await scheduler.observe(schedulerBody("baseline", "Schedule"));
    return finish({ complete: true, schemaVersion: 1, binding, outcome: "UNCHANGED", release: p.baseline.release,
      images: p.baseline.images, revisions, evidence, sourceFenceProvenance: "historical-migration" });
  }
  let decision = await read(decisionKey);
  if (decision) need(same(decision, { type: "UPDATE_RECOVERY_DECISION", binding }), "UPDATE_RECOVERY_DECISION_CHANGED");
  need(!decision || !["apply", "resume"].includes(action), "UPDATE_RECOVERY_ALREADY_STARTED");
  const phase = action === "recover" || decision ? "recovery" : "incoming";
  async function admitForwardResume() {
    // Deliberately limited to the already-submitted stopped worker template and
    // subsequent start/scheduler/finalization steps. Earlier failures retain the
    // existing reconcile/recover policy; resume never invents a baseline.
    need(scheduler && typeof store.listRecords === "function", "UPDATE_RESUME_STAGE_UNSUPPORTED");
    const resume = { type: "UPDATE_FORWARD_RESUME_DECISION", binding, snapshotSha256: hash(snapshot) };
    const retained = await read(resumeKey);
    need(retained === null || same(retained, resume), "UPDATE_RESUME_DECISION_CHANGED");
    const allowed = new Set([snapshotKey, resumeKey]);
    async function entry(kind, input, required = false) {
      const status = await operations.readStatus(kind, input);
      need(!required || status.intent && status.receipt, "UPDATE_RESUME_STAGE_UNSUPPORTED");
      const key = `${prefix}/${hash({ kind, inputSha256: hash(input) })}`;
      allowed.add(`${key}/intent.json`); allowed.add(`${key}/receipt.json`);
      return { kind, input, ...status, key };
    }
    await entry("UPDATE_SCHEDULER_DISABLE", { jobId: schedulerId, bodySha256: hash(schedulerBody("baseline")), beforeSha256: hash(schedulerBody("baseline", "Schedule")) }, true);
    await entry("UPDATE_WORKER_RUNNING", { phase: "incoming", runningStatus: "Stopped" }, true);
    await entry("UPDATE_MODE", { phase: "incoming", role: "web", mode: "Multiple" }, true);
    await entry("UPDATE_DRAIN", { phase: "incoming", role: "web", revisionName: snapshot.baselines.web.revisionName }, true);
    await entry("UPDATE_TEMPLATE", patchInput("incoming", "web"), true);
    await entry("UPDATE_MODE", { phase: "incoming", role: "web", mode: "Single" }, true);
    const patch = await entry("UPDATE_TEMPLATE", patchInput("incoming", "worker"));
    need(patch.intent, "UPDATE_RESUME_STAGE_UNSUPPORTED");
    const start = await entry("UPDATE_WORKER_RUNNING", { phase: "incoming", runningStatus: "Running" });
    const single = await entry("UPDATE_MODE", { phase: "incoming", role: "worker", mode: "Single" });
    const install = await entry("UPDATE_SCHEDULER_INSTALL", { jobId: schedulerId, bodySha256: hash(schedulerBody("incoming")), beforeSha256: hash(schedulerBody("baseline")) });
    const context = `${p.releaseId}-incoming`, nonce = hash({ jobId: schedulerId, bodySha256: hash(schedulerBody("incoming")), context });
    const template = structuredClone(schedulerBody("incoming").properties.template);
    template.containers[0].env.push({ name: "WORKER_SCHEDULER_PROOF_NONCE", value: nonce });
    const proof = await entry("WORKER_SCHEDULER_PROOF", { jobId: schedulerId, context, nonce, templateSha256: hash(template), release: p.incoming.release });
    if (proof.intent) allowed.add(`${proof.key}/descriptor.json`);
    const enable = await entry("UPDATE_SCHEDULER_ENABLE", { jobId: schedulerId, bodySha256: hash(schedulerBody("incoming", "Schedule")), beforeSha256: hash(schedulerBody("incoming")) });
    need((!start.intent || patch.receipt) && (!single.intent || start.receipt) && (!install.intent || single.receipt)
      && (!proof.intent || install.receipt) && (!enable.intent || proof.receipt), "UPDATE_RESUME_EFFECT_ORDER_INVALID");
    await authority();
    const keys = await store.listRecords(`${prefix}/`, custody.signal), observers = new Map();
    await authority();
    for (const key of keys.filter(key => key.endsWith("/descriptor.json") && !allowed.has(key))) {
      const d = await read(key), h = d?.input?.plan, index = d?.input?.index;
      need(d?.kind === "AZURE_HEALTH_PROBE_START" && h && Number.isInteger(index) && index >= 0 && index < 10, "UPDATE_RESUME_RECORD_UNBOUND");
      const name = ["baseline", "incoming"].find(name => same(h.worker, { appId: workerAppId, origin: p.origins.worker, image: p[name].images.worker, release: p[name].release }));
      need(name && h.environmentResourceId === p.target.environmentId, "UPDATE_RESUME_RECORD_UNBOUND");
      const observerContext = { domain: p.domain, intentSha256: binding.intentSha256, sourceFenceSha256: p.authority.migrationSourceFenceSha256,
        phaseOperationId: p.releaseId, workerDemandSha256: hash({ plan: p.workerDemand, target: p.target }), mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256 };
      const observerAuthority = { mode: "release", acceptedMigrationSha256: p.authority.acceptedMigrationSha256, releaseId: p.releaseId,
        targetSha256: hash(h.worker), sourceFenceProvenance: "historical-migration" };
      assertHealthJobStartDescriptor(d, { plan: h, context: observerContext, index, authority: observerAuthority });
      buildHealthProbeJobDefinition(h);
      need(d.input.challenge.request.invocationContext === (name === "baseline" ? "baseline-worker" : "release-final")
        && d.input.challenge.request.revisionName === (name === "baseline" ? snapshot.baselines.worker.revisionName : candidates.incoming.worker.revisionName), "UPDATE_RESUME_RECORD_UNBOUND");
      const status = await operations.readStatus(d.kind, d.input);
      need(status.intent, "UPDATE_RESUME_RECORD_UNBOUND");
      const op = `${prefix}/${hash({ kind: d.kind, inputSha256: hash(d.input) })}`, slot = `${prefix}/${hash({ kind: "AZURE_HEALTH_PROBE_SLOT", inputSha256: hash({ plan: h, context: observerContext, index }) })}/descriptor.json`;
      need([`${op}/descriptor.json`, slot].includes(key) && same(await read(`${op}/descriptor.json`), d) && same(await read(slot), d), "UPDATE_RESUME_RECORD_UNBOUND");
      for (const k of [`${op}/descriptor.json`, slot, `${op}/intent.json`, `${op}/receipt.json`]) allowed.add(k);
      const prior = observers.get(name);
      need(!prior || same(prior.plan, h), "UPDATE_RESUME_RECORD_UNBOUND");
      const observer = prior ?? { plan: h, slots: new Map() }; observer.slots.set(index, status); observers.set(name, observer);
    }
    need(keys.every(key => allowed.has(key)), "UPDATE_RESUME_RECORD_UNBOUND");
    // All original inputs are validated before settlement. The recorder can
    // append an honest readback receipt, but its inherited apply callback is a trap.
    async function settled(e, verify) {
      if (!e.intent || e.receipt) return;
      await operations.runRecordedOperation({ kind: e.kind, input: e.input,
        apply: async () => { throw Error("UPDATE_RESUME_REPLAY_DENIED"); }, verify: async () => ({ complete: true, evidence: await verify() }) });
    }
    if (!patch.receipt) await settled(patch, () => stoppedTemplate("incoming"));
    const pair = await inspect();
    need(pair.web.mode === "Single" && pair.worker.mode === "Single" && pair.worker.latestRevisionName === candidates.incoming.worker.revisionName
      && pair.worker.runningStatus === (start.intent ? "Running" : "Stopped"), "UPDATE_RESUME_STATE_UNPROVEN");
    if (!start.intent) need(workerDrained(pair.worker), "UPDATE_WORKER_STOP_UNPROVEN");
    else need(pair.worker.latestReadyRevisionName === candidates.incoming.worker.revisionName
      && pair.worker.revisions.some(r => r.revisionName === candidates.incoming.worker.revisionName && r.active)
      && pair.worker.revisions.every(r => r.revisionName === candidates.incoming.worker.revisionName || !r.active && r.replicaCount === 0), "UPDATE_PAIR_NOT_EXCLUSIVE");
    const current = await transport.readAppTemplate({ ...inputFor("worker"), release: p.incoming.release, imageDigest: p.incoming.images.worker.split("@")[1] });
    need(current.provisioningState === "Succeeded" && current.state.revisionName === candidates.incoming.worker.revisionName
      && current.state.templateDigest === managedAzureTemplateDigest(candidates.incoming.worker.template), "UPDATE_TEMPLATE_DRIFT");
    await transport.readRevisionState({ ...inputFor("worker"), revisionName: candidates.incoming.worker.revisionName, expectedTemplate: candidates.incoming.worker.template });
    await selected("incoming", "web"); await boundWebHealth("incoming");
    await settled(start, async () => pair.worker); await settled(single, async () => pair.worker);
    const expectedJob = enable.intent ? schedulerBody("incoming", "Schedule") : install.intent ? schedulerBody("incoming") : schedulerBody("baseline");
    await scheduler.assertJob(expectedJob);
    await settled(install, () => scheduler.assertJob(schedulerBody("incoming")));
    if (proof.intent) {
      await scheduler.assertProofStartSettled(schedulerBody("incoming"), p.incoming.release, context);
      await scheduler.prove(schedulerBody("incoming"), p.incoming.release, context, false);
    }
    await settled(enable, () => scheduler.assertJob(schedulerBody("incoming", "Schedule")));
    for (const [name, observer] of observers) {
      const indices = [...observer.slots.keys()].sort((a, b) => a - b), last = indices.at(-1);
      need(indices.every((v, i) => v === i && (v === last || observer.slots.get(v).receipt)), "UPDATE_RESUME_RECORD_UNBOUND");
      need(typeof settleHealth === "function", "UPDATE_RESUME_HEALTH_SETTLEMENT_REQUIRED");
      const result = await settleHealth({ phase: name, plan: observer.plan, index: last, signal: custody.signal });
      need(result?.complete === true && result.phase === name && result.planSha256 === hash(observer.plan) && result.index === last, "UPDATE_RESUME_HEALTH_UNSETTLED");
    }
    await authority();
    need((await store.listRecords(`${prefix}/`, custody.signal)).every(key => allowed.has(key)), "UPDATE_RESUME_RECORD_UNBOUND");
    await inspect(); await authority(); await retain(resumeKey, resume);
  }
  if (action !== "reconcile") {
    await assertWebOrigin();
    await authority();
    const images = await assertImages(p, custody.signal);
    need(images?.complete === true && images.imagesSha256 === hash({ incoming: p.incoming.images, recovery: p.recovery.images }), "UPDATE_IMAGE_UNPROVEN");
    await prepareHealth({ phase, plan: p, signal: custody.signal }); await authority();
    if (action === "apply") {
      // Private baseline proof happens while the known old pair still serves.
      await health("baseline", "baseline-worker", Object.fromEntries(ROLES.map(role => [role, snapshot.baselines[role].revisionName])));
    }
    if (action === "resume") await admitForwardResume();
    await inspect();
    if (action === "recover" && !decision) {
      // Read-only settlement of every unreceipted forward effect precedes the
      // recovery decision. An absent/unknown PATCH is not permission to race it.
      const observed = await inspect();
      for (const role of ROLES) {
        for (const mode of ["Multiple", "Single"]) {
          const prior = await operations.readStatus("UPDATE_MODE", { phase: "incoming", role, mode });
          need(!prior.intent || prior.receipt || observed[role].mode === mode, "UPDATE_FORWARD_EFFECT_UNSETTLED");
        }
        const priorDrain = await operations.readStatus("UPDATE_DRAIN", { phase: "incoming", role, revisionName: snapshot.baselines[role].revisionName });
        const base = observed[role].revisions.find(r => r.revisionName === snapshot.baselines[role].revisionName);
        need(!priorDrain.intent || priorDrain.receipt || base && !base.active && base.replicaCount === 0, "UPDATE_FORWARD_EFFECT_UNSETTLED");
        const priorPatch = await operations.readStatus("UPDATE_TEMPLATE", patchInput("incoming", role));
        if (priorPatch.intent && !priorPatch.receipt) {
          const candidate = candidates.incoming[role];
          need(observed[role].latestRevisionName === candidate.revisionName, "UPDATE_FORWARD_EFFECT_UNSETTLED");
          const revision = await transport.readRevisionState({ ...inputFor(role), revisionName: candidate.revisionName, expectedTemplate: candidate.template });
          if (scheduler && role === "worker" && workerDrained(observed.worker)) await stoppedTemplate("incoming");
          else need(["READY", "FAILED"].includes(revision.kind), "UPDATE_FORWARD_EFFECT_UNSETTLED");
        }
      }
      if (scheduler) for (const runningStatus of ["Stopped", "Running"]) {
        const prior = await operations.readStatus("UPDATE_WORKER_RUNNING", { phase: "incoming", runningStatus });
        need(!prior.intent || prior.receipt || observed.worker.runningStatus === runningStatus
          && (runningStatus !== "Stopped" || workerDrained(observed.worker)), "UPDATE_FORWARD_EFFECT_UNSETTLED");
      }
      if (scheduler) {
        for (const [kind, before, after] of [
          ["UPDATE_SCHEDULER_DISABLE", schedulerBody("baseline", "Schedule"), schedulerBody("baseline")],
          ["UPDATE_SCHEDULER_INSTALL", schedulerBody("baseline"), schedulerBody("incoming")],
          ["UPDATE_SCHEDULER_ENABLE", schedulerBody("incoming"), schedulerBody("incoming", "Schedule")],
        ]) {
          const prior = await operations.readStatus(kind, { jobId: schedulerId, bodySha256: hash(after), beforeSha256: hash(before) });
          if (prior.intent && !prior.receipt) await scheduler.assertJob(after);
        }
        await scheduler.assertProofStartSettled(schedulerBody("incoming"), p.incoming.release, `${p.releaseId}-incoming`);
      }
      decision = { type: "UPDATE_RECOVERY_DECISION", binding };
      await retain(decisionKey, decision);
    }
    // A completed receipt is reusable after a later owned step supersedes its
    // postcondition. Unreceipted intent always goes through fresh readback and
    // can never dispatch a second provider effect.
    async function effect(kind, input, apply, verify) {
      await inspect();
      const prior = await operations.readStatus(kind, input);
      if (prior.receipt) return;
      await operations.runRecordedOperation({ kind, input, apply: async () => { await authority(); await apply(); }, verify });
      await inspect();
    }
    if (scheduler) {
      // Every scheduler execution is a database writer. Disable new cron starts
      // and wait for all existing executions before either app is drained.
      if (phase === "incoming") await scheduler.write("UPDATE_SCHEDULER_DISABLE",
        schedulerBody("baseline", "Schedule"), schedulerBody("baseline"), true);
      else {
        const allowed = [schedulerBody("baseline", "Schedule"), schedulerBody("baseline")];
        for (const previous of ["incoming"]) {
          const prior = await operations.readStatus("UPDATE_SCHEDULER_INSTALL", { jobId: schedulerId,
            bodySha256: hash(schedulerBody(previous)), beforeSha256: hash(schedulerBody("baseline")) });
          if (prior.intent) allowed.push(schedulerBody(previous), schedulerBody(previous, "Schedule"));
        }
        // The complete, deterministic predecessor set is retained in the input;
        // inherited intent can only read back, never dispatch a second PUT.
        await scheduler.write("RECOVERY_SCHEDULER_DISABLE", allowed, schedulerBody("baseline"), true);
      }
      const install = await operations.readStatus("UPDATE_SCHEDULER_INSTALL", { jobId: schedulerId,
        bodySha256: hash(schedulerBody(phase)), beforeSha256: hash(schedulerBody("baseline")) });
      if (!install.intent) await scheduler.drained(schedulerBody("baseline"));
      await effect("UPDATE_WORKER_RUNNING", { phase, runningStatus: "Stopped" },
        async () => { await scheduler.drained(schedulerBody("baseline"));
          await transport.setAppRunningState({ ...inputFor("worker"), runningStatus: "Stopped", onProgress: authority }); },
        async () => { const state = (await inspect()).worker; return { complete: workerDrained(state), evidence: state }; });
    }
    for (const role of scheduler ? ["web"] : ROLES) {
      await effect("UPDATE_MODE", { phase, role, mode: "Multiple" },
        () => transport.setRevisionMode({ ...inputFor(role), mode: "Multiple", onProgress: authority }),
        async () => { const s = (await inspect())[role]; return { complete: s.mode === "Multiple", evidence: s }; });
    }
    for (const role of scheduler ? ["web"] : ["worker", "web"]) {
      const state = (await inspect())[role];
      for (const revision of state.revisions) {
        if (!revision.active && revision.replicaCount === 0) continue;
        // On explicit recovery continuation keep only its proven candidate.
        if (revision.revisionName === candidates[phase][role].revisionName) continue;
        await effect("UPDATE_DRAIN", { phase, role, revisionName: revision.revisionName },
          () => transport.setRevisionActive({ target, role, revisionName: revision.revisionName, active: false, onProgress: authority }),
          async () => { const s = (await inspect())[role]; const r = s.revisions.find(v => v.revisionName === revision.revisionName);
            return { complete: !!r && !r.active && r.replicaCount === 0, evidence: s }; });
      }
    }
    for (const role of ROLES) {
      const candidate = candidates[phase][role];
      await effect("UPDATE_TEMPLATE", patchInput(phase, role), async () => {
        // runRecordedOperation invokes apply only after intent write/readback.
        known[role].add(candidate.revisionName);
        const pair = await inspect(), before = pair[role];
        need(before.mode === (scheduler && role === "worker" ? "Single" : "Multiple") && (scheduler && role === "worker" ? workerDrained(before) : before.revisions.every(r => !r.active && r.replicaCount === 0)), "UPDATE_ROLE_NOT_DRAINED");
        need(!before.revisions.some(r => r.revisionName === candidate.revisionName), "UPDATE_REVISION_ALREADY_EXISTS");
        if (role === "web") {
          need(workerDrained(pair.worker), "UPDATE_ROLE_NOT_DRAINED");
          if (scheduler) await scheduler.drained(schedulerBody("baseline"));
        } else {
          await selected(phase, "web");
          need(pair.web.mode === "Single", "UPDATE_WEB_HEALTH_UNPROVEN");
          await boundWebHealth(phase);
          await authority();
          await selected(phase, "web");
          const afterHealth = await inspect();
          need(afterHealth.web.mode === "Single" && afterHealth.worker.mode === (scheduler ? "Single" : "Multiple")
            && workerDrained(afterHealth.worker), "UPDATE_ROLE_NOT_DRAINED");
          if (scheduler) await scheduler.drained(schedulerBody("baseline"));
        }
        await transport.patchTemplate({ ...inputFor(role), location: snapshot.baselines[role].location,
          template: candidate.template, onProgress: authority });
        if (scheduler && role === "worker") return;
        await transport.waitForState({ ...inputFor(role), release: p[phase].release, imageDigest: p[phase].images[role].split("@")[1],
          expectedTemplate: candidate.template, onProgress: authority });
      }, async () => ({ complete: true, evidence: scheduler && role === "worker" ? await stoppedTemplate(phase) : await selected(phase, role) }));
      if (scheduler && role === "worker") {
        await effect("UPDATE_WORKER_RUNNING", { phase, runningStatus: "Running" },
          async () => { await stoppedTemplate(phase); await scheduler.drained(schedulerBody("baseline"));
            await transport.setAppRunningState({ ...inputFor(role), runningStatus: "Running", onProgress: authority }); },
          async () => ({ complete: (await inspect()).worker.runningStatus === "Running", evidence: await selected(phase, role) }));
      }
      await selected(phase, role);
      await effect("UPDATE_MODE", { phase, role, mode: "Single" },
        () => transport.setRevisionMode({ ...inputFor(role), mode: "Single", onProgress: authority }),
        async () => { const s = (await inspect())[role]; return { complete: s.mode === "Single", evidence: s }; });
      if (role === "web") {
        await boundWebHealth(phase);
        await authority();
      }
    }
  }
  let schedulerEvidence;
  if (scheduler) {
    if (action !== "reconcile") {
      await scheduler.write("UPDATE_SCHEDULER_INSTALL", schedulerBody("baseline"), schedulerBody(phase), true);
      const proof = await scheduler.prove(schedulerBody(phase), p[phase].release, `${p.releaseId}-${phase}`, true);
      await scheduler.write("UPDATE_SCHEDULER_ENABLE", schedulerBody(phase), schedulerBody(phase, "Schedule"), true, false);
      schedulerEvidence = { ...await scheduler.observe(schedulerBody(phase, "Schedule")), proof };
    } else {
      const proof = await scheduler.prove(schedulerBody(phase), p[phase].release, `${p.releaseId}-${phase}`, false);
      schedulerEvidence = { ...await scheduler.observe(schedulerBody(phase, "Schedule")), proof };
    }
  }
  const revisions = {};
  for (const role of ROLES) revisions[role] = (await selected(phase, role)).revisionName;
  need(Object.values(await inspect()).every(s => s.mode === "Single"), "UPDATE_FINAL_MODE_UNPROVEN");
  const context = phase === "incoming" ? "release-final" : "recovery-final";
  const evidence = await health(phase, context, revisions);
  if (schedulerEvidence) evidence.scheduler = schedulerEvidence;
  for (const role of ROLES) await selected(phase, role);
  await authority();
  const result = { complete: true, schemaVersion: 1, binding, outcome: phase === "incoming" ? "UPDATED" : "RECOVERED",
    release: p[phase].release, images: p[phase].images, revisions, evidence, sourceFenceProvenance: "historical-migration" };
  return finish(result);
}
