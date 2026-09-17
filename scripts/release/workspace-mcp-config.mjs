import { createHash } from "node:crypto";
import { parseReleaseBuildIdentity } from "../../packages/shared/src/release-build.mjs";

export const TARGET = Object.freeze({
  subscription: "227eb707-bc46-415e-a09b-7d2b69fb14b2",
  tenant: "f6f245dd-ad33-4fed-8624-c44efa093b21",
  group: "rg-corgtex-selfserve-production-wus3",
  registry: "acrcorgtexssstgwus3", server: "acrcorgtexssstgwus3.azurecr.io",
  origin: "https://selfserve.corgtex.com",
  workspace: "b1702569-4f4f-4d37-a008-da4d0e8c5742",
});
export const FLAG = "MCP_WORKSPACE_CONNECTIONS_ENABLED";
export const appName = role => `ca-corgtex-ss-prod-${role}`;
export function requireProof(condition, code) { if (!condition) throw new Error(code); }
const shaPattern = /^[a-f0-9]{40}$/;
export function validateInputs(input) {
  requireProof(["preflight", "activate", "disable-ingress"].includes(input.operation), "OPERATION_INVALID");
  requireProof(shaPattern.test(input.acceptedSha || "") && !/^0+$/.test(input.acceptedSha), "ACCEPTED_SHA_INVALID");
  requireProof(shaPattern.test(input.workflowSha || ""), "WORKFLOW_SHA_INVALID");
  requireProof(/^[1-9][0-9]{0,19}$/.test(input.runId || "") && input.attempt === "1", "FRESH_RUN_REQUIRED");
  requireProof(input.writerAcknowledged === "true", "EXCLUSIVE_WRITER_HANDOFF_REQUIRED");
  for (const role of ["web", "worker"]) {
    requireProof(new RegExp(`^${TARGET.server.replaceAll(".", "\\.")}/corgtex/${role}@sha256:[a-f0-9]{64}$`).test(input.images?.[role] || ""), "IMMUTABLE_IMAGE_REQUIRED");
    requireProof(new RegExp(`^${appName(role)}--[a-z0-9][a-z0-9-]{0,50}$`).test(input.baselines?.[role] || ""), "BASELINE_REVISION_INVALID");
  }
  return input;
}
export function assertIdentity(account, clientId) {
  requireProof(account.id === TARGET.subscription && account.tenantId === TARGET.tenant
    && account.state === "Enabled" && account.user?.type === "servicePrincipal"
    && /^[a-f0-9-]{36}$/i.test(clientId || "") && typeof account.user.name === "string"
    && account.user.name.toLowerCase() === clientId.toLowerCase(), "AZURE_IDENTITY_MISMATCH");
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export function configHash(app) {
  const p = app.properties, template = structuredClone(p.template);
  delete template.revisionSuffix;
  for (const c of template.containers) {
    delete c.image;
    c.env = (c.env || []).filter(e => e.name !== FLAG).sort((a, b) => a.name.localeCompare(b.name));
  }
  // Only image spelling, the one activation flag and revision suffix may change.
  const preserved = { template, configuration: p.configuration, identity: app.identity,
    tags: app.tags, location: app.location, environmentId: p.environmentId,
    managedEnvironmentId: p.managedEnvironmentId, workloadProfileName: p.workloadProfileName };
  return createHash("sha256").update(JSON.stringify(canonical(preserved))).digest("hex");
}
export function revisionTemplateHash(app, source = app.properties.template) {
  const template = structuredClone(source);
  delete template.revisionSuffix;
  if (template.customMetricsSettings === null) delete template.customMetricsSettings;
  if (template.scale) {
    template.scale.cooldownPeriod ??= 300;
    template.scale.pollingInterval ??= 30;
  }
  for (const container of template.containers) {
    if (container.imageType === "ContainerImage") delete container.imageType;
    container.env = (container.env || []).map(entry => {
      const env = { ...entry };
      if (env.secretRef && env.value === "") delete env.value;
      return env;
    }).sort((a, b) => a.name.localeCompare(b.name));
    // Consumption storage is derived from CPU and omitted by the revision API.
    const resources = container.resources;
    if (app.properties.workloadProfileName === "Consumption" && resources
      && Number.isFinite(resources.cpu) && resources.cpu > 0 && resources.cpu <= 4) {
      resources.ephemeralStorage ??= resources.cpu <= 0.25 ? "1Gi"
        : resources.cpu <= 0.5 ? "2Gi" : resources.cpu <= 1 ? "4Gi" : "8Gi";
    }
  }
  return createHash("sha256").update(JSON.stringify(canonical(template))).digest("hex");
}
export function flagValue(container) {
  const entries = (container.env || []).filter(e => e.name === FLAG);
  requireProof(entries.length <= 1 && !entries[0]?.secretRef, "FLAG_CONFIG_INVALID");
  const value = entries[0]?.value;
  requireProof(value === undefined || value === "false" || value === "true", "FLAG_CONFIG_INVALID");
  return value === "true";
}
export function assertApp(app, role, revision, image, flag, preservedHash, requireReady = true) {
  const p = app.properties;
  const id = `/subscriptions/${TARGET.subscription}/resourceGroups/${TARGET.group}/providers/Microsoft.App/containerApps/${appName(role)}`;
  requireProof(app.id?.toLowerCase() === id.toLowerCase() && app.name === appName(role), "APP_TARGET_MISMATCH");
  requireProof(p?.configuration?.activeRevisionsMode === "Single" && p.template?.containers?.length === 1
    && !p.template.initContainers?.length && p.template.containers[0].name === role, "APP_TOPOLOGY_UNSUPPORTED");
  requireProof(p.latestRevisionName === revision, "REVISION_DRIFT");
  if (requireReady) requireProof(p.latestReadyRevisionName === revision && p.provisioningState === "Succeeded", "REVISION_NOT_READY");
  requireProof(p.template.containers[0].image === image, "IMAGE_DRIFT");
  requireProof(flagValue(p.template.containers[0]) === flag, "FLAG_DRIFT");
  if (preservedHash) requireProof(configHash(app) === preservedHash, "UNRELATED_CONFIG_DRIFT");
}
export function assertFleet(revisions, replicas, role, revision) {
  requireProof(Array.isArray(revisions) && revisions.length > 0 && new Set(revisions.map(r => r.name)).size === revisions.length, "REVISION_INVENTORY_INVALID");
  const current = revisions.filter(r => r.name === revision);
  requireProof(current.length === 1, "REVISION_INVENTORY_INVALID");
  for (const r of revisions) {
    requireProof(r.name.startsWith(`${appName(role)}--`), "REVISION_INVENTORY_INVALID");
    if (r.name === revision) {
      requireProof(r.properties.active === true && ["Running", "RunningAtMaxScale"].includes(r.properties.runningState)
        && r.properties.healthState === "Healthy" && Number.isInteger(r.properties.replicas)
        && r.properties.replicas > 0, "REVISION_NOT_READY");
    } else requireProof(r.properties.active === false && r.properties.runningState === "Stopped"
      && r.properties.replicas === 0, "OLD_REVISION_NOT_STOPPED");
  }
  requireProof(Array.isArray(replicas) && replicas.length === current[0].properties.replicas
    && new Set(replicas.map(r => r.name)).size === replicas.length, "REPLICA_INVENTORY_INVALID");
  for (const r of replicas) {
    const containers = r.properties?.containers;
    requireProof(r.name.startsWith(`${revision}-`) && containers?.length === 1 && containers[0].name === role
      && containers[0].ready === true && containers[0].runningState === "Running"
      && containers[0].restartCount === 0, "REPLICA_NOT_READY");
  }
}
export function assertHealth(health, role, sha, now = Date.now()) {
  const r = health?.release;
  requireProof(health?.status === "ok" && r?.runtime?.gitSha === sha && r.runtime.source === "baked"
    && r.runtime.evidence === "baked" && r.gitSha === sha && r.drift?.gitSha === false
    && r.drift.imageTag === false && r.drift.version === false && r.drift.details?.length === 0, "HEALTH_RELEASE_INVALID");
  if (role === "web") requireProof(health.service === "web" && health.database === "up" && health.schema === "ready", "WEB_HEALTH_INVALID");
  else {
    const tick = Date.parse(health.lastSuccessfulTickAt);
    requireProof(health.phase === "running" && health.lastError === null && Number.isFinite(tick)
      && tick <= now + 5000 && now - tick <= 120000, "WORKER_HEALTH_INVALID");
  }
}
export function assertRuntime(probe, role, sha, flag) {
  const baked = parseReleaseBuildIdentity(probe.build, role);
  requireProof(baked?.gitSha === sha && probe.flag === flag && probe.origin === TARGET.origin, "RUNTIME_IDENTITY_INVALID");
  requireProof(probe.status === 200, "RUNTIME_HEALTH_FAILED");
  assertHealth(probe.health, role, sha);
}

export async function runConfig(input, io) {
  validateInputs(input);
  const receipt = { schemaVersion: 1, operation: input.operation, acceptedSha: input.acceptedSha,
    workflowSha: input.workflowSha, runId: input.runId, attempt: input.attempt,
    status: "IN_PROGRESS", stages: [], intents: [], baselines: {}, scope: "azure-selfserve-runtime-config-only" };
  const save = () => io.save(structuredClone(receipt));
  save();
  let stage = "identity";
  try {
    await io.identity();
    stage = "source-compatibility"; await io.source(input.acceptedSha, input.workflowSha);
    const live = {}, hashes = {}, flags = {};
    for (const role of ["web", "worker"]) {
      stage = `baseline-${role}`;
      const app = await io.app(role), container = app.properties?.template?.containers?.[0];
      const image = container?.image;
      requireProof(image === input.images[role] || image === `${TARGET.server}/corgtex/${role}:sha-${input.acceptedSha}`, "BASELINE_IMAGE_INVALID");
      requireProof(await io.digest(role, image) === input.images[role].split("@")[1], "REGISTRY_DIGEST_MISMATCH");
      flags[role] = flagValue(container);
      live[role] = { revision: input.baselines[role], image, flag: flags[role] };
      hashes[role] = configHash(app);
      receipt.baselines[role] = { ...live[role], configHash: hashes[role] };
      assertApp(app, role, live[role].revision, image, flags[role], undefined, input.operation !== "disable-ingress");
    }
    if (input.operation === "activate") requireProof(!flags.web && !flags.worker, "ACTIVATION_REQUIRES_BOTH_OFF");
    const prove = async role => {
      const wanted = live[role];
      const app = await io.app(role);
      assertApp(app, role, wanted.revision, wanted.image, wanted.flag, hashes[role]);
      const actual = await io.revision(role, wanted.revision);
      requireProof(actual.name === wanted.revision && actual.properties?.template?.containers?.length === 1, "REVISION_TEMPLATE_INVALID");
      const container = actual.properties.template.containers[0];
      requireProof(container.name === role && container.image === wanted.image && flagValue(container) === wanted.flag, "REVISION_TEMPLATE_DRIFT");
      requireProof(revisionTemplateHash(app, actual.properties.template) === revisionTemplateHash(app), "REVISION_CONFIG_DRIFT");
      const revisions = await io.revisions(role), replicas = await io.replicas(role, wanted.revision);
      assertFleet(revisions, replicas, role, wanted.revision);
      for (const replica of replicas) assertRuntime(await io.runtime(role, wanted.revision, replica.name), role, input.acceptedSha, wanted.flag);
      // Recheck after per-replica health reads, not just before them.
      assertFleet(await io.revisions(role), await io.replicas(role, wanted.revision), role, wanted.revision);
      assertApp(await io.app(role), role, wanted.revision, wanted.image, wanted.flag, hashes[role]);
      receipt.stages.push({ stage, role, revision: wanted.revision, replicas: replicas.length, oldRevisionsStopped: revisions.length - 1 }); save();
    };
    const observeWorker = async () => {
      try { await prove("worker"); receipt.workerReadiness = "VERIFIED"; }
      catch (error) {
        if (input.operation !== "disable-ingress") throw error;
        receipt.workerReadiness = "UNPROVEN_RECOVERY_HANDOFF";
      }
      save();
    };
    stage = "preflight";
    await observeWorker();
    if (input.operation !== "disable-ingress") { await prove("web"); await io.acceptance(flags.web, input.acceptedSha); }
    const update = async (role, flag) => {
      stage = `before-${role}-write`;
      await io.identity(); await observeWorker();
      if (input.operation === "disable-ingress") {
        const wanted = live.web;
        assertApp(await io.app("web"), "web", wanted.revision, wanted.image, wanted.flag, hashes.web, false);
      } else await prove("web");
      const suffix = `mcp-${input.runId}-${input.attempt}-${role}`;
      const revision = `${appName(role)}--${suffix}`;
      requireProof(!(await io.revisions(role)).some(r => r.name === revision), "OPERATION_REVISION_ALREADY_EXISTS");
      const intent = { role, revision, baseline: live[role].revision, image: input.images[role], flag, state: "WRITE_INTENT_RECONCILE_IF_UNCERTAIN" };
      receipt.intents.push(intent); save();
      stage = `${role}-write`;
      // Exactly one submission. Even a timeout retains its deterministic revision intent.
      const result = await io.update(role, suffix, input.images[role], flag);
      requireProof(result.revision === revision && result.image === input.images[role], "UPDATE_RESULT_UNCERTAIN");
      intent.state = "SUBMITTED"; save();
      live[role] = { revision, image: input.images[role], flag };
      stage = `${role}-readiness`;
      await io.wait(role, revision, input.images[role]);
      await io.settle(() => prove(role));
      intent.state = "VERIFIED"; save();
    };
    if (input.operation === "activate") {
      await update("worker", true);
      // Worker stop/readiness proof is refreshed again inside the web update boundary.
      await update("web", true);
    } else if (input.operation === "disable-ingress" && flags.web) {
      await update("web", false);
    }
    stage = "acceptance";
    await io.acceptance(live.web.flag, input.acceptedSha);
    await prove("web");
    receipt.canonicalIngressEnabled = live.web.flag; save();
    await observeWorker();
    receipt.status = input.operation === "disable-ingress" ? "INGRESS_DISABLED_WORKER_RECOVERY_HANDOFF" : input.operation === "preflight" ? "PREFLIGHT_ONLY" : "ACTIVATED";
    receipt.canonicalIngressEnabled = live.web.flag;
    receipt.pendingWorkAssessed = false;
    receipt.nativeConsentAcceptance = false;
    save(); return receipt;
  } catch (error) {
    receipt.status = "STOPPED_OPERATOR_RECONCILIATION_REQUIRED";
    receipt.failure = { stage, code: /^[A-Z][A-Z0-9_]+$/.test(error.message || "") ? error.message : "OPERATION_FAILED" };
    save();
    if (receipt.intents.length) {
      try {
        await io.identity();
        receipt.reconciliation = [];
        for (const intent of receipt.intents) receipt.reconciliation.push({ role: intent.role, intendedRevision: intent.revision,
          observation: await io.reconcile(intent.role, intent.revision), permitsRetry: false });
      } catch { receipt.reconciliationUnavailable = true; }
      save();
    }
    throw new Error(receipt.failure.code);
  }
}
