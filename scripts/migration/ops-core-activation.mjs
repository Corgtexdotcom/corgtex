import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createOpsCoreAzureTarget, opsCoreAzureTargetBindingSha256, opsCoreSharedStateBackend } from "./ops-core-azure-target.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { assertManagedAzureRevisionProjection, managedAzureConsumptionEphemeralStorage } from "../release/managed-azure-container-app-transport.mjs";
import { managedAzureHealthReady } from "../release/managed-azure-release-transaction.mjs";

import { validateManagedAzureWorkerDemand, managedAzureWorkerDemandScale, buildManagedAzureSchedulerJob,
  schedulerJobWithRelease, createManagedAzureWorkerDemandLifecycle } from "../release/managed-azure-worker-demand.mjs";

const ARM = "https://management.azure.com";
const API = "2025-01-01";
const HASH = /^[a-f0-9]{64}$/;
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ROLES = ["web", "worker"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const region = value => typeof value === "string" ? value.replace(/\s/g, "").toLowerCase() : null;
class ActivationError extends Error {}
const requireValue = (condition, code) => { if (!condition) throw new ActivationError(code); };
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === keys.split(",").sort().join();
export const opsCoreActivationDiagnostic = error => error instanceof ActivationError ? error.message : null;

export function validateOpsCoreActivationPlan(input) {
  const p = structuredClone(input);
  requireValue([1, 2].includes(p.schemaVersion) && exact(p,
    `schemaVersion,target,location,managedIdentityId,managedIdentityClientId,runtimeVaultUri,acrServer,release,roles${p.schemaVersion === 2 ? ",workerDemand" : ""}`), "ACTIVATION_PLAN_INVALID");
  opsCoreAzureTargetBindingSha256(p.target);
  const prefix = `/subscriptions/${p.target.subscriptionId}/resourceGroups/${p.target.resourceGroupName}/providers/`;
  const identityPrefix = `${prefix}Microsoft.ManagedIdentity/userAssignedIdentities/`;
  requireValue(/^[a-z0-9]{2,40}$/.test(p.location) && GUID.test(p.managedIdentityClientId)
    && typeof p.managedIdentityId === "string" && p.managedIdentityId.toLowerCase().startsWith(identityPrefix.toLowerCase())
    && /^[a-zA-Z0-9_-]{1,128}$/.test(p.managedIdentityId.slice(identityPrefix.length))
    && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/$/.test(p.runtimeVaultUri)
    && /^[a-z0-9]{5,50}\.azurecr\.io$/.test(p.acrServer)
    && exact(p.release, "gitSha,imageTag,version") && /^[a-f0-9]{40}$/.test(p.release.gitSha)
    && p.release.imageTag === `sha-${p.release.gitSha}` && /^[A-Za-z0-9._+-]{1,128}$/.test(p.release.version)
    && exact(p.roles, "web,worker"), "ACTIVATION_PLAN_INVALID");

  if (p.schemaVersion === 2) validateManagedAzureWorkerDemand(p.workerDemand, p.target, p);
  for (const role of ROLES) {
    const r = p.roles[role];
    const generated = generatedEnv(p, role);
    requireValue(exact(r, "image,env,secrets,resources") && r.image.startsWith(`${p.acrServer}/corgtex/${role}@sha256:`)
      && HASH.test(r.image.split("@sha256:")[1]) && Array.isArray(r.env) && r.env.length <= 200
      && Array.isArray(r.secrets) && r.secrets.length <= 200, "ACTIVATION_RUNTIME_INVALID");
    requireValue(exact(r.resources, "cpu,memory") && Number.isFinite(r.resources.cpu)
      && r.resources.cpu >= 0.25 && r.resources.cpu <= 4 && Number.isInteger(r.resources.cpu * 4)
      && r.resources.memory === `${r.resources.cpu * 2}Gi`, "ACTIVATION_RESOURCES_INVALID");
    const names = new Set();
    for (const s of r.secrets) {
      requireValue(exact(s, "name,keyVaultUrl,identity") && s.identity === p.managedIdentityId && /^[a-z][a-z0-9-]{0,62}$/.test(s.name) && !names.has(s.name)
        && s.keyVaultUrl.startsWith(`${p.runtimeVaultUri}secrets/`)
        && /^[a-zA-Z0-9-]{1,127}\/[a-f0-9]{32}$/.test(s.keyVaultUrl.slice(`${p.runtimeVaultUri}secrets/`.length)),
      "ACTIVATION_SECRET_REFERENCE_INVALID");
      names.add(s.name);
    }
    const envNames = new Set();
    for (const e of r.env) {
      requireValue((exact(e, "name,value") || exact(e, "name,secretRef")) && /^[A-Z][A-Z0-9_]{0,127}$/.test(e.name)
        && !envNames.has(e.name) && (generated[e.name] === undefined || e.value === generated[e.name])
        && e.name !== "GITHUB_SHA" && (role === "web" || e.name !== "CORGTEX_STARTUP_MODE"), "ACTIVATION_ENV_INVALID");
      envNames.add(e.name);
      requireValue(e.secretRef ? names.has(e.secretRef) : typeof e.value === "string" && e.value.length <= 8192
        && !/(?:SECRET|PASSWORD|TOKEN|API_KEY|ENCRYPTION_KEY|DATABASE_URL|REDIS_URL)/.test(e.name), "ACTIVATION_ENV_INVALID");
    }
    if (p.workerDemand) requireValue(!r.env.some(e => e.name === "WORKER_SCHEDULER_PROOF_NONCE"
      || e.secretRef === p.workerDemand.scalerConnectionSecret.name)
      && !r.secrets.some(e => e.name === p.workerDemand.scalerConnectionSecret.name
        || e.keyVaultUrl === p.workerDemand.scalerConnectionSecret.keyVaultUrl), "ACTIVATION_DEMAND_SECRET_INVALID");
    const backend = opsCoreSharedStateBackend(p.target);
    for (const name of backend === "redis" ? ["DATABASE_URL", "REDIS_URL"] : ["DATABASE_URL"]) {
      requireValue(r.env.some(e => e.name === name && e.secretRef), "ACTIVATION_ENV_INVALID");
    }
    if (backend === "postgres") requireValue(!envNames.has("REDIS_URL")
      && r.env.some(e => e.name === "SHARED_STATE_BACKEND" && e.value === "postgres"), "ACTIVATION_SHARED_STATE_INVALID");
    else requireValue(!envNames.has("SHARED_STATE_BACKEND")
      || r.env.some(e => e.name === "SHARED_STATE_BACKEND" && e.value === "redis"), "ACTIVATION_SHARED_STATE_INVALID");
  }
  return p;
}

/** Only GET and one-shot PUT, exact subscription/resource paths, bounded bodies.
 * Tokens and ARM errors are never included in a thrown diagnostic. */
export function createOpsCoreActivationArmTransport({ subscriptionId, fetchImpl = fetch,
  execFileImpl = promisify(execFile) } = {}) {
  requireValue(GUID.test(subscriptionId), "ACTIVATION_TRANSPORT_INVALID");
  return async ({ resourceId, apiVersion = API, method = "GET", body, nextLink, signal }) => {
    requireValue(signal instanceof AbortSignal && ["GET", "PUT", "POST"].includes(method)
      && (method !== "POST" || /\/providers\/Microsoft\.App\/jobs\/[a-z0-9-]+\/start$/.test(resourceId))
      && resourceId.startsWith(`/subscriptions/${subscriptionId}/resourceGroups/`)
      && /^\/[A-Za-z0-9_.()\/-]+$/.test(resourceId) && /^20\d{2}-\d{2}-\d{2}$/.test(apiVersion), "ACTIVATION_REQUEST_INVALID");
    const base = new URL(`${ARM}${resourceId}?api-version=${apiVersion}`);
    const url = nextLink ? new URL(nextLink) : base;
    requireValue(url.origin === ARM && url.pathname === base.pathname && !url.username && !url.password && !url.hash
      && url.searchParams.get("api-version") === apiVersion && (method === "GET" || !nextLink), "ACTIVATION_REQUEST_INVALID");
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    try {
      const { stdout } = await execFileImpl("az", ["account", "get-access-token", "--subscription", subscriptionId,
        "--resource", `${ARM}/`, "--query", "accessToken", "--output", "tsv", "--only-show-errors"],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 65536, signal: bounded, shell: false });
      const token = stdout.trim();
      requireValue(token.length > 0 && token.length < 32768, "ACTIVATION_AUTH_FAILED");
      const response = await fetchImpl(url, { method, redirect: "error", signal: bounded,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const chunks = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length;
        requireValue(size <= 2 * 1024 * 1024, "ACTIVATION_RESPONSE_TOO_LARGE"); chunks.push(Buffer.from(chunk));
      }
      bounded.throwIfAborted();
      const text = Buffer.concat(chunks).toString("utf8");
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch (error) {
      throw error instanceof ActivationError ? error : new ActivationError("ACTIVATION_ARM_UNCERTAIN");
    }
  };
}

function generatedEnv(plan, role) {
  return { PORT: role === "web" ? "3000" : "9090", AZURE_CLIENT_ID: plan.managedIdentityClientId,
    ...(opsCoreSharedStateBackend(plan.target) === "postgres" ? { SHARED_STATE_BACKEND: "postgres" } : {}),
    CORGTEX_RELEASE_GIT_SHA: plan.release.gitSha, CORGTEX_RELEASE_IMAGE_TAG: plan.release.imageTag,
    CORGTEX_RELEASE_VERSION: plan.release.version,
    ...(role === "web" ? { CORGTEX_STARTUP_MODE: "migrate-and-web" } : { WORKER_HEALTH_PORT: "9090", ...(plan.workerDemand ? { WORKER_EXECUTION_MODE: "queue-only" } : {}) }) };
}

function appBody(plan, role, suffix) {
  const runtime = plan.roles[role]; const port = role === "web" ? 3000 : 9090;
  const generated = generatedEnv(plan, role);
  const env = [...runtime.env.filter(e => generated[e.name] === undefined),
    ...Object.entries(generated).map(([name, value]) => ({ name, value }))];
  const path = role === "web" ? "/api/health" : "/health";
  return { location: plan.location, identity: { type: "UserAssigned", userAssignedIdentities: { [plan.managedIdentityId]: {} } },
    properties: { environmentId: plan.target.environmentId, workloadProfileName: "Consumption",
      configuration: { activeRevisionsMode: "Single",
        ingress: { external: role === "web", targetPort: port, transport: "auto", allowInsecure: false,
          traffic: [{ latestRevision: true, weight: 100 }] },
        registries: [{ server: plan.acrServer, identity: plan.managedIdentityId }],
        secrets: [...runtime.secrets.map(s => ({ ...s, identity: plan.managedIdentityId })),
          ...(role === "worker" && plan.workerDemand ? [plan.workerDemand.scalerConnectionSecret] : [])] },
      template: { revisionSuffix: suffix, terminationGracePeriodSeconds: 30,
        containers: [{ name: role, image: runtime.image, env, resources: { ...runtime.resources,
          ephemeralStorage: managedAzureConsumptionEphemeralStorage(runtime.resources.cpu) },
          probes: [
            { type: "Startup", httpGet: { path, port, scheme: "HTTP" }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 60, successThreshold: 1 },
            { type: "Readiness", httpGet: { path, port, scheme: "HTTP" }, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3, successThreshold: 1 },
            { type: "Liveness", httpGet: { path, port, scheme: "HTTP" }, periodSeconds: 30, timeoutSeconds: 5, failureThreshold: 3, successThreshold: 1 },
          ] }], scale: role === "worker" && plan.workerDemand ? managedAzureWorkerDemandScale(plan.workerDemand)
            : { minReplicas: 1, maxReplicas: 1, cooldownPeriod: 300, pollingInterval: 30, rules: [] } } } };
}

function assertBootstrapProjection(expected, actual, appName, revisionName) {
  // ARM may materialize or omit the documented probe successThreshold=1.
  // Normalize this default alone; every other field remains subject to the
  // shared exact projection check (including commands, image, env and scale).
  const projection = structuredClone(actual);
  for (const container of projection?.containers ?? []) for (const probe of container.probes ?? []) {
    if (probe.successThreshold == null) probe.successThreshold = 1;
  }
  return assertManagedAzureRevisionProjection(expected, projection, appName, revisionName);
}

/** Bootstrap only: existing apps (including stopped apps) are not overwritten.
 * assertSourceFenced is a source-only observer valid after destination writes;
 * it returns {complete:true,domain,intentSha256}. It must not use the transfer
 * guard that requires destinationMayHaveWritten=false.
 * healthProbe({role,appId,revisionName,origin,release,invocationContext,signal}) must perform a
 * fresh bounded request (the worker URL is private) and return {health:{status,body},evidence}.
 * Caller owns source-to-vault secret parity, registry RBAC, private probe access,
 * schema compatibility and absence of other target DB clients. No routing here.
 * Any inherited pending phase is refused; recovery requires explicit readback.
 */
export function createOpsCoreActivation({ plan: input, custody, operationStore, assertSourceFenced, healthProbe,
  armTransport, schedulerProof, now = Date.now, wait = (ms, signal) => sleep(ms, undefined, { signal }), timeoutMs = 15 * 60_000 } = {}) {
  const plan = validateOpsCoreActivationPlan(input), planSha256 = hash(plan), target = plan.target;
  requireValue(custody?.signal instanceof AbortSignal && typeof custody.assertOwned === "function"
    && typeof custody.begin === "function" && typeof custody.complete === "function"
    && typeof assertSourceFenced === "function" && typeof healthProbe === "function" && operationStore
    && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30 * 60_000, "ACTIVATION_DEPENDENCY_INVALID");
  const transport = armTransport ?? createOpsCoreActivationArmTransport({ subscriptionId: target.subscriptionId });
  const appId = role => `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.App/containerApps/${target.apps[role]}`;
  const schedulerId = plan.workerDemand
    ? `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroupName}/providers/Microsoft.App/jobs/${plan.workerDemand.schedulerJobName}` : null;
  function schedulerBody(workerBody) {
    return buildManagedAzureSchedulerJob({ workerApp: { ...workerBody, id: appId("worker") }, demand: plan.workerDemand, target });
  }
  let used = false;
  async function run(action, { customDomains = [] } = {}) {
      requireValue(!used, "ACTIVATION_ALREADY_ATTEMPTED"); used = true;
      requireValue(["activate", "reconcile", "resume", "observe"].includes(action)
        && Array.isArray(customDomains) && customDomains.every(name => typeof name === "string" && /^[a-z0-9.-]+$/.test(name))
        && new Set(customDomains).size === customDomains.length, "ACTIVATION_ACTION_INVALID");
      const signal = AbortSignal.any([custody.signal, AbortSignal.timeout(timeoutMs)]), deadline = now() + timeoutMs;
      const intentSha256 = custody.snapshot().intentSha256;
      requireValue(HASH.test(intentSha256), "ACTIVATION_CUSTODY_MISMATCH");
      async function check() {
        signal.throwIfAborted(); await custody.assertOwned(); signal.throwIfAborted();
        const s = custody.snapshot();
        requireValue(s.domain === target.domain && s.intentSha256 === intentSha256, "ACTIVATION_CUSTODY_MISMATCH");
        requireValue(now() < deadline, "ACTIVATION_DEADLINE");
      }
      async function request(resourceId, extra = {}) {
        await check(); const result = await transport({ resourceId, apiVersion: API, signal, ...extra }); await check(); return result;
      }
      async function fenced() {
        await check(); const r = await assertSourceFenced({ domain: target.domain, intentSha256: intentSha256, signal }); await check();
        requireValue(r?.complete === true && r.domain === target.domain && r.intentSha256 === intentSha256, "ACTIVATION_SOURCE_UNPROVEN");
      }
      async function absent(role) {
        const r = await request(appId(role));
        requireValue(r.status === 404 && r.body?.error?.code === "ResourceNotFound", "ACTIVATION_APP_NOT_ABSENT");
      }
      async function list(id) {
        const rows = [], seen = new Set(); let nextLink;
        do {
          const r = await request(id, { nextLink });
          requireValue(r.status === 200 && Array.isArray(r.body?.value) && rows.length + r.body.value.length <= 512,
            "ACTIVATION_INVENTORY_INVALID"); rows.push(...r.body.value);
          nextLink = r.body.nextLink;
          requireValue(!nextLink || typeof nextLink === "string" && !seen.has(nextLink) && seen.size < 100, "ACTIVATION_INVENTORY_INVALID");
          if (nextLink) {
            const url = new URL(nextLink);
            requireValue(url.origin === ARM && url.pathname === id && url.searchParams.get("api-version") === API
              && !url.username && !url.password && !url.hash, "ACTIVATION_INVENTORY_INVALID"); seen.add(nextLink);
          }
        } while (nextLink);
        return rows;
      }
      function assertApp(app, role, expected, fqdn) {
        const p = app?.properties, c = p?.configuration, ingress = c?.ingress;
        const identities = Object.entries(app?.identity?.userAssignedIdentities ?? {});
        const registry = c?.registries?.[0];
        const expectedSecrets = expected.properties.configuration.secrets;
        requireValue(same(app?.id, appId(role)) && app.name === target.apps[role] && same(app.type, "Microsoft.App/containerApps")
          && region(app.location) === region(plan.location) && app.identity?.type === "UserAssigned"
          && identities.length === 1 && same(identities[0][0], plan.managedIdentityId)
          && same(identities[0][1].clientId, plan.managedIdentityClientId)
          && same(p?.environmentId ?? p?.managedEnvironmentId, target.environmentId)
          && (!p.environmentId || same(p.environmentId, target.environmentId))
          && (!p.managedEnvironmentId || same(p.managedEnvironmentId, target.environmentId))
          && p.workloadProfileName === "Consumption" && c.activeRevisionsMode === "Single"
          && c.registries?.length === 1 && registry.server === plan.acrServer && same(registry.identity, plan.managedIdentityId)
          && registry.username == null && registry.passwordSecretRef == null
          && Array.isArray(c.secrets) && c.secrets.length === expectedSecrets.length
          && new Set(c.secrets.map(s => s.name)).size === c.secrets.length
          && c.secrets.every(s => expectedSecrets.some(e => e.name === s.name && e.keyVaultUrl === s.keyVaultUrl
            && same(e.identity, s.identity)) && s.value == null)
          && ingress?.fqdn === fqdn && ingress.external === (role === "web")
          && ingress.targetPort === (role === "web" ? 3000 : 9090) && ingress.allowInsecure === false
          && ingress.transport === "auto" && canonical(ingress.traffic) === canonical([{ latestRevision: true, weight: 100 }])
          && (action === "observe"
            ? canonical((ingress.customDomains ?? []).map(d => d.name).sort()) === canonical(role === "web" ? [...customDomains].sort() : [])
              && (ingress.customDomains ?? []).every(d => d.bindingType === "SniEnabled" && typeof d.certificateId === "string")
            : !(ingress.customDomains?.length)) && !(ingress.ipSecurityRestrictions?.length)
          && p.template?.revisionSuffix === expected.properties.template.revisionSuffix, "ACTIVATION_APP_DRIFT");
        assertBootstrapProjection(expected.properties.template, p.template, target.apps[role], `${target.apps[role]}--${p.template.revisionSuffix}`);
        return p;
      }
      async function ready(role, expected, fqdn, invocationContext) {
        const revisionName = `${target.apps[role]}--${expected.properties.template.revisionSuffix}`;
        while (true) {
          const r = await request(appId(role));
          if (r.status === 404 && r.body?.error?.code === "ResourceNotFound") { await wait(2000, signal); continue; }
          requireValue(r.status === 200, "ACTIVATION_READBACK_UNCERTAIN");
          requireValue(same(r.body?.id, appId(role)) && r.body.name === target.apps[role]
            && same(r.body.type, "Microsoft.App/containerApps"), "ACTIVATION_APP_DRIFT");
          requireValue(!["Failed", "Canceled"].includes(r.body.properties?.provisioningState), "ACTIVATION_PROVISIONING_FAILED");
          if (r.body.properties?.provisioningState !== "Succeeded") { await wait(2000, signal); continue; }
          const p = assertApp(r.body, role, expected, fqdn);
          if (p.latestRevisionName !== revisionName || p.latestReadyRevisionName !== revisionName && !(plan.workerDemand && role === "worker")) {
            await wait(2000, signal); continue;
          }
          const revisions = await list(`${appId(role)}/revisions`);
          requireValue(revisions.length === 1 && revisions[0]?.name === revisionName
            && same(revisions[0].id, `${appId(role)}/revisions/${revisionName}`), "ACTIVATION_REVISION_DRIFT");
          const rev = revisions[0].properties;
          assertBootstrapProjection(expected.properties.template, rev.template, target.apps[role], revisionName);
          const replicas = await list(`${appId(role)}/revisions/${revisionName}/replicas`);
          requireValue(replicas.length <= 1, "ACTIVATION_REPLICA_DRIFT");
          if (plan.workerDemand && role === "worker" && replicas.length === 0) {
            // Internal HTTP scaler wakes the exact target; idle is never accepted as serving.
            await check();
            await healthProbe({ role, appId: appId(role), revisionName, origin: `https://${fqdn}`,
              release: structuredClone(plan.release), invocationContext, signal });
            await check(); await wait(1000, signal); continue;
          }
          if (rev.active !== true || rev.provisioningState !== "Provisioned" || rev.healthState !== "Healthy"
            || !["Running", "RunningAtMaxScale"].includes(rev.runningState) || replicas.length !== 1
            || replicas[0].properties?.runningState !== "Running" || replicas[0].properties?.containers?.length !== 1
            || replicas[0].properties.containers[0].name !== role || replicas[0].properties.containers[0].ready !== true) {
            await wait(2000, signal); continue;
          }
          await check();
          const probe = await healthProbe({ role, appId: appId(role), revisionName,
            origin: `https://${fqdn}`, release: structuredClone(plan.release), invocationContext, signal });
          const health = probe?.health;
          await check();
          const healthy = health?.status === 200 && (role === "web" ? managedAzureHealthReady(health.body, plan.release)
            : health.body?.status === "ok" && health.body.phase === "running" && health.body.release?.gitSha === plan.release.gitSha
              && health.body.release?.imageTag === plan.release.imageTag && health.body.release?.version === plan.release.version);
          const stateReady = opsCoreSharedStateBackend(plan.target) !== "postgres" || role !== "web"
            || health.body?.runtime?.sharedState?.backend === "postgres" && health.body.runtime.sharedState.status === "configured";
          if (!healthy || !stateReady) { await wait(2000, signal); continue; }
          const final = await request(appId(role));
          requireValue(final.status === 200, "ACTIVATION_READBACK_UNCERTAIN");
          const after = assertApp(final.body, role, expected, fqdn);
          requireValue(after.provisioningState === "Succeeded" && after.latestRevisionName === revisionName
            && after.latestReadyRevisionName === revisionName, "ACTIVATION_APP_DRIFT");
          return { complete: true, evidence: { role, planSha256, revisionSha256: hash(revisionName),
            imageSha256: hash(plan.roles[role].image), healthSha256: hash(health), probeEvidenceSha256: hash(probe.evidence ?? null) } };
        }
      }
      try {
        await check(); const initial = custody.snapshot();
        if (action === "reconcile" && initial.phase === "TARGET_ACTIVE" && initial.pending === null) {
          // A committed final journal write can lose its acknowledgement. Read
          // the exact retained lineage under the current lease; this deliberately
          // makes no new provider/health claim and never starts a probe or app.
          requireValue(initial.destinationMayHaveWritten === true, "ACTIVATION_LINEAGE_UNPROVEN");
          const entries = phase => initial.history?.filter(e => e.phase === phase) ?? [];
          const activation = entries("TARGET_ACTIVATING"), active = entries("TARGET_ACTIVE");
          requireValue(activation.length === 1 && active.length === 1
            && [...activation, ...active].every(e => GUID.test(e.operationId) && e.intentSha256 === planSha256
              && HASH.test(e.evidenceSha256)), "ACTIVATION_LINEAGE_UNPROVEN");
          const operationId = activation[0].operationId;
          const prefix = `operations/${target.domain}/${intentSha256}/${operationId}/`;
          const read = async (name, limit = 65536) => {
            await check(); await operationStore.assertPrivate();
            const text = await operationStore.readOptional(`${prefix}${name}.json`, signal); await check();
            requireValue(hash(custody.snapshot()) === hash(initial), "ACTIVATION_CUSTODY_MISMATCH");
            requireValue(typeof text === "string" && Buffer.byteLength(text) <= limit, "ACTIVATION_EVIDENCE_MISMATCH");
            return JSON.parse(text);
          };
          const bodies = Object.fromEntries(ROLES.map(role => [role,
            appBody(plan, role, `boot-${operationId.replaceAll("-", "").slice(0, 16)}-${role}`)]));
          if (plan.workerDemand) bodies.scheduler = schedulerBody(bodies.worker);
          const retainedPlan = await read("phase-plan");
          requireValue(exact(retainedPlan, "schemaVersion,planSha256,activationOperationId,environmentDomain,bodies")
            && retainedPlan.schemaVersion === 1 && retainedPlan.planSha256 === planSha256
            && retainedPlan.activationOperationId === operationId
            && /^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(retainedPlan.environmentDomain)
            && hash(retainedPlan.bodies) === hash(bodies), "ACTIVATION_EVIDENCE_MISMATCH");
          for (const entry of [activation[0], active[0]]) {
            const evidence = await read(`phase-evidence-${entry.evidenceSha256}`, 32 * 1024 * 1024);
            requireValue(hash(evidence) === entry.evidenceSha256 && evidence.schemaVersion === 1
              && evidence.domain === target.domain && evidence.intentSha256 === intentSha256 && evidence.planSha256 === planSha256
              && evidence.activationOperationId === operationId && evidence.retainedPlanSha256 === hash(retainedPlan), "ACTIVATION_EVIDENCE_MISMATCH");
            for (const role of ROLES) {
              const proof = evidence.finalProofs?.[role], value = proof?.evidence;
              const revision = `${target.apps[role]}--${bodies[role].properties.template.revisionSuffix}`;
              requireValue(proof?.complete === true && value?.role === role && value.planSha256 === planSha256
                && value.revisionSha256 === hash(revision) && value.imageSha256 === hash(plan.roles[role].image)
                && HASH.test(value.healthSha256) && HASH.test(value.probeEvidenceSha256), "ACTIVATION_EVIDENCE_MISMATCH");
            }
            if (plan.workerDemand) {
              const scheduler = evidence.finalProofs?.scheduler, proof = scheduler?.proof;
              requireValue(scheduler?.complete === true && scheduler.jobId === schedulerId
                && scheduler.bodySha256 === hash(schedulerJobWithRelease(bodies.scheduler, plan.roles.worker.image, plan.release, "Schedule"))
                && proof?.complete === true && proof.jobId === schedulerId && proof.image === plan.roles.worker.image
                && hash(proof.release) === hash(plan.release) && HASH.test(proof.receiptSha256)
                && proof.context === `activation-${operationId}` && HASH.test(proof.nonce), "ACTIVATION_EVIDENCE_MISMATCH");
            }
            const access = evidence.finalProofs?.postgresAccess;
            requireValue(access?.complete === true && access.domain === target.domain && access.intentSha256 === intentSha256
              && access.targetBindingSha256 === opsCoreAzureTargetBindingSha256(target)
              && access.publicNetworkAccess === "Disabled" && access.firewallRules === 0, "ACTIVATION_EVIDENCE_MISMATCH");
          }
          // Independently retain the original create intents/receipts as the
          // causal record. Opening a pending-phase recorder here would invent a
          // phase; validate its immutable recorded descriptor directly instead.
          for (const role of ROLES) {
            const kind = `azure.create.${role}`, inputSha256 = hash({ planSha256, resourceId: appId(role), bodySha256: hash(bodies[role]) });
            const operationKey = hash({ kind, inputSha256 });
            const intent = await read(`${operationKey}/intent`), receipt = await read(`${operationKey}/receipt`);
            requireValue(intent.schemaVersion === 1 && intent.type === "intent" && intent.kind === kind
              && intent.inputSha256 === inputSha256 && intent.operationKey === operationKey && GUID.test(intent.operationId)
              && hash(intent.binding) === hash({ domain: target.domain, intentSha256, phase: "TARGET_ACTIVATING", phaseOperationId: operationId })
              && receipt.schemaVersion === 1 && receipt.type === "receipt" && receipt.operationId === intent.operationId
              && receipt.intentSha256 === hash(intent) && HASH.test(receipt.evidenceSha256), "ACTIVATION_EVIDENCE_MISMATCH");
          }
          return { complete: true, historical: true, freshAcceptance: false, domain: target.domain, phase: "TARGET_ACTIVE",
            planSha256, evidenceSha256: active[0].evidenceSha256 };
        }
        const fresh = action === "activate";
        const pendingActivation = initial.phase === "VERIFIED" && initial.pending?.to === "TARGET_ACTIVATING";
        const activated = ["TARGET_ACTIVATING", "TARGET_ACTIVE", "ROUTED", "ACCEPTED"].includes(initial.phase);
        requireValue(fresh ? initial.phase === "VERIFIED" && initial.pending === null && !initial.destinationMayHaveWritten
          : initial.destinationMayHaveWritten && (pendingActivation || activated), "ACTIVATION_PHASE_INVALID");
        requireValue(action !== "observe" || activated, "ACTIVATION_PHASE_INVALID");
        requireValue(fresh || action === "observe" || pendingActivation || initial.phase === "TARGET_ACTIVATING",
          "ACTIVATION_PHASE_INVALID");
        if (!fresh && action !== "observe" && initial.phase === "TARGET_ACTIVATING" && !initial.pending) {
          await custody.begin("TARGET_ACTIVE", planSha256);
        }
        await fenced();
        const guard = createOpsCoreAzureTarget({ binding: target, custody, transport });
        if (fresh) {
          await guard.assertInactive(); await absent("web"); await absent("worker");
          if (schedulerId) requireValue((await request(schedulerId)).status === 404, "ACTIVATION_SCHEDULER_NOT_ABSENT");
        }
        await guard.assertPostgresPrivate();
        const environment = await request(target.environmentId);
        requireValue(environment.status === 200 && same(environment.body?.id, target.environmentId)
          && environment.body.properties?.provisioningState === "Succeeded"
          && /^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(environment.body.properties.defaultDomain), "ACTIVATION_ENVIRONMENT_INVALID");
        const domain = environment.body.properties.defaultDomain;
        await fenced();
        const pending = fresh ? await custody.begin("TARGET_ACTIVATING", planSha256)
          : pendingActivation ? initial.pending : initial.history?.find(x => x.phase === "TARGET_ACTIVATING");
        requireValue(GUID.test(pending?.operationId) && pending.intentSha256 === planSha256, "ACTIVATION_LINEAGE_UNPROVEN");
        const prefix = `operations/${target.domain}/${intentSha256}/${pending.operationId}/`;
        const bodies = Object.fromEntries(ROLES.map(role => [role,
          appBody(plan, role, `boot-${pending.operationId.replaceAll("-", "").slice(0, 16)}-${role}`)]));
        if (plan.workerDemand) bodies.scheduler = schedulerBody(bodies.worker);
        const retainedPlan = { schemaVersion: 1, planSha256, activationOperationId: pending.operationId, environmentDomain: domain, bodies };
        async function retain(name, value) {
          await check(); await operationStore.assertPrivate();
          const key = `${prefix}${name}.json`, prior = await operationStore.readOptional(key, signal);
          if (prior === null) { await operationStore.createOnly(key, JSON.stringify(value), signal); }
          else requireValue(hash(JSON.parse(prior)) === hash(value), "ACTIVATION_EVIDENCE_MISMATCH");
          await check();
          requireValue(hash(JSON.parse(await operationStore.readOptional(key, signal))) === hash(value), "ACTIVATION_EVIDENCE_MISMATCH");
        }
        const prior = await operationStore.readOptional(`${prefix}phase-plan.json`, signal);
        if (prior === null) {
          // A lost acknowledgement before phase-plan persistence cannot have
          // dispatched an app. Resume may retain the plan only while both absent.
          requireValue(fresh || action === "resume", "ACTIVATION_PLAN_UNRETAINED");
          await absent("web"); await absent("worker");
          if (schedulerId) requireValue((await request(schedulerId)).status === 404, "ACTIVATION_SCHEDULER_NOT_ABSENT");
          await retain("phase-plan", retainedPlan);
        } else requireValue(hash(JSON.parse(prior)) === hash(retainedPlan), "ACTIVATION_EVIDENCE_MISMATCH");
        const fqdn = role => `${target.apps[role]}.${role === "worker" ? "internal." : ""}${domain}`;
        const receipts = {};
        if (fresh || pendingActivation) {
          const recorder = await openProviderOperationRecorder({ custody, store: operationStore, phase: "TARGET_ACTIVATING", signal });
          for (const role of ROLES) {
            const body = bodies[role], kind = `azure.create.${role}`;
            const input = { planSha256, resourceId: appId(role), bodySha256: hash(body) };
            const status = await recorder.readStatus(kind, input);
            if (!status.intent && action === "reconcile") return { status: "CONTINUATION_AVAILABLE", complete: false,
              domain: target.domain, phase: "TARGET_ACTIVATING", role, nextAction: "resume-activate" };
            await fenced();
            if (role === "worker") await ready("web", bodies.web, fqdn("web"), "web-before-worker");
            receipts[role] = await recorder.runRecordedOperation({ kind, input,
              async apply() {
                requireValue(action !== "reconcile", "ACTIVATION_REPLAY_FORBIDDEN");
                await absent(role); if (role === "web") await absent("worker");
                await guard.assertPostgresPrivate();
                const result = await request(appId(role), { method: "PUT", body });
                requireValue([200, 201, 202].includes(result.status), "ACTIVATION_WRITE_UNCERTAIN");
              }, verify: () => ready(role, body, fqdn(role), `${role}-after-create`) });
          }
        }
        const finalProofs = {};
        for (const role of ROLES) finalProofs[role] = await ready(role, bodies[role], fqdn(role), `${role}-final`);
        if (plan.workerDemand) {
          const scheduled = schedulerJobWithRelease(bodies.scheduler, plan.roles.worker.image, plan.release, "Schedule");
          const scheduler = createManagedAzureWorkerDemandLifecycle({ jobId: schedulerId, target, proofStore: operationStore, proofPrefix: prefix,
            operations: fresh || pendingActivation ? await openProviderOperationRecorder({ custody, store: operationStore, phase: "TARGET_ACTIVATING", signal }) : null,
            request, check: async () => { await check(); await fenced(); }, signal, schedulerProof, now,
            wait: ms => wait(ms, signal) });
          if (fresh || pendingActivation) {
            await scheduler.write("WORKER_SCHEDULER_CREATE", null, bodies.scheduler, action !== "reconcile");
            const proof = await scheduler.prove(bodies.scheduler, plan.release, `activation-${pending.operationId}`, action !== "reconcile");
            await scheduler.write("WORKER_SCHEDULER_ENABLE", bodies.scheduler, scheduled, action !== "reconcile", false);
            finalProofs.scheduler = { ...await scheduler.observe(scheduled), proof };
          } else finalProofs.scheduler = await scheduler.observe(scheduled);
        }
        finalProofs.postgresAccess = await guard.assertPostgresPrivate();
        await fenced(); await check();
        const evidence = { schemaVersion: 1, domain: target.domain, intentSha256, planSha256,
          activationOperationId: pending.operationId, retainedPlanSha256: hash(retainedPlan), receipts, finalProofs };
        const evidenceSha256 = hash(evidence);
        await retain(`phase-evidence-${evidenceSha256}`, evidence);
        if (action === "observe") return { complete: true, domain: target.domain, phase: initial.phase, intentSha256, targetBindingSha256: hash(target), planSha256, evidenceSha256,
          release: plan.release, origins: Object.fromEntries(ROLES.map(role => [role, `https://${fqdn(role)}`])), images: Object.fromEntries(ROLES.map(role => [role, plan.roles[role].image])), evidence };
        if (fresh || pendingActivation) await custody.complete(pending.operationId, evidenceSha256);
        const state = custody.snapshot();
        if (state.phase === "TARGET_ACTIVATING") {
          const active = state.pending ?? await custody.begin("TARGET_ACTIVE", planSha256);
          requireValue(active.to === "TARGET_ACTIVE" && active.intentSha256 === planSha256, "ACTIVATION_PHASE_INVALID");
          await custody.complete(active.operationId, evidenceSha256);
        }
        return { complete: true, domain: target.domain, phase: "TARGET_ACTIVE", planSha256, evidenceSha256 };
      } catch (error) {
        throw error instanceof ActivationError ? error : new ActivationError("ACTIVATION_RECONCILIATION_REQUIRED");
      }
    }
  return Object.freeze({ planSha256, activate: () => run("activate"), reconcile: () => run("reconcile"),
    resume: () => run("resume"), observe: options => run("observe", options) });
}
