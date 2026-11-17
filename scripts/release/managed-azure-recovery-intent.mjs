import { createHash } from "node:crypto";
import {
  buildManagedAzureReleaseTemplate,
  managedAzureTemplateDigest,
} from "./managed-azure-container-app-transport.mjs";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
const hash = (value) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const same = (left, right) => canonicalJson(left) === canonicalJson(right);

export class ManagedAzureRecoveryIntentError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.name = "ManagedAzureRecoveryIntentError";
    this.detail = {};
    for (const [key, outputKey] of [["stage", "providerStage"], ["code", "dependencyCode"], ["providerCode", "providerCode"]]) {
      if (typeof detail[key] === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(detail[key])) this.detail[outputKey] = detail[key];
    }
    if (Number.isInteger(detail.providerStatus)) this.detail.providerStatus = detail.providerStatus;
  }
}
function fail(code, detail) { throw new ManagedAzureRecoveryIntentError(code, detail); }

// The suffix identifies an immutable intended write, not a retry number. The
// server independently derives it and permits at most one intent per role.
export function recoveryIntentRevisionSuffix(base) {
  const length = base.protocolVersion === 1 ? 32 : Math.min(32, 54 - base.appName.length - 5);
  if (![1, 2].includes(base.protocolVersion) || length < 1) fail("RECOVERY_INTENT_TARGET_INVALID");
  return `ri-${hash(base).slice(0, length)}`;
}

export function assertRecoveryIntentName(intent) {
  if (`${intent.appName}--${intent.revisionSuffix}`.length > 54) fail("RECOVERY_INTENT_REVISION_NAME_INVALID");
}

export function buildManagedAzureRecoveryIntent({ originatingLease, target, role, predecessor, release, image, imageDigest, protocolVersion = 2 }) {
  if (!["web", "worker"].includes(role) || predecessor.role !== role
    || predecessor.appName !== target[role === "web" ? "webAppName" : "workerAppName"]
    || image !== `${target.acrServer}/corgtex/${role}@${imageDigest}`) fail("RECOVERY_INTENT_TARGET_INVALID");
  const neutral = buildManagedAzureReleaseTemplate({ baseline: predecessor, role, image, release,
    revisionSuffix: "", migrateWeb: true });
  const base = {
    protocolVersion,
    purpose: "COMPATIBLE_RECOVERY_PATCH",
    role,
    originatingLeaseId: originatingLease.leaseId,
    originatingFence: originatingLease.fence,
    appName: predecessor.appName,
    predecessorRevisionName: predecessor.revisionName,
    predecessorTemplateDigest: predecessor.templateDigest,
    gitSha: release.gitSha,
    imageDigest,
    templateBaseDigest: managedAzureTemplateDigest(neutral),
  };
  const revisionSuffix = recoveryIntentRevisionSuffix(base);
  const template = { ...neutral, revisionSuffix };
  const unsigned = { ...base, revisionSuffix, templateDigest: managedAzureTemplateDigest(template) };
  return { intent: Object.freeze({ ...unsigned, intentDigest: `sha256:${hash(unsigned)}` }), template };
}

export function managedAzureRecoveryIntents(status) {
  const journal = status.recovery;
  if (!journal || journal.schemaVersion === undefined) return [];
  if (journal.schemaVersion !== 2 || !Array.isArray(journal.intents) || journal.intents.length > 2
    || new Set(journal.intents.map((intent) => intent.role)).size !== journal.intents.length) fail("RECOVERY_INTENT_JOURNAL_INVALID");
  return journal.intents;
}

// A resumed operation has no mutable local plan. Recover its exact template
// only from the recorded predecessor or the recorded candidate app snapshot.
export async function readManagedAzureRecoveryIntentPlan(deps, { intent, originatingLease, target, release, image, releases }) {
  if (intent.originatingLeaseId !== originatingLease.leaseId || intent.originatingFence !== originatingLease.fence
    || intent.gitSha !== release.gitSha || image !== `${target.acrServer}/corgtex/${intent.role}@${intent.imageDigest}`
    || intent.appName !== target[intent.role === "web" ? "webAppName" : "workerAppName"]) fail("RECOVERY_INTENT_BINDING_DRIFT");
  let latest;
  for (const identity of releases) {
    try {
      latest = await deps.readAppTemplate({ target, role: intent.role, release: identity.release, imageDigest: identity.imageDigest, originalBaseline: identity.originalBaseline });
      break;
    } catch { /* Only the exact recorded source or candidate may be adopted. */ }
  }
  const state = latest?.state;
  if (!state) fail("RECOVERY_INTENT_APP_UNREADABLE");
  if (state.revisionName === intent.predecessorRevisionName && state.templateDigest === intent.predecessorTemplateDigest) {
    const plan = buildManagedAzureRecoveryIntent({ originatingLease, target, role: intent.role, predecessor: state,
      release, image, imageDigest: intent.imageDigest, protocolVersion: intent.protocolVersion });
    if (!same(plan.intent, intent)) fail("RECOVERY_INTENT_PLAN_DRIFT");
    return plan;
  }
  if (state.revisionName !== `${intent.appName}--${intent.revisionSuffix}`
    || state.templateDigest !== intent.templateDigest) fail("RECOVERY_INTENT_APP_DRIFT");
  const neutral = { ...state.template, revisionSuffix: "" };
  const { intentDigest, templateDigest, revisionSuffix, ...base } = intent;
  if (managedAzureTemplateDigest(neutral) !== intent.templateBaseDigest
    || revisionSuffix !== recoveryIntentRevisionSuffix(base)
    || intentDigest !== `sha256:${hash({ ...base, revisionSuffix, templateDigest })}`) fail("RECOVERY_INTENT_PLAN_DRIFT");
  const expected = buildManagedAzureReleaseTemplate({ baseline: state, role: intent.role, image, release,
    revisionSuffix, migrateWeb: true });
  if (managedAzureTemplateDigest(expected) !== templateDigest) fail("RECOVERY_INTENT_PLAN_DRIFT");
  return { intent, template: expected };
}

/** Only an invalid, unapplied v1 name may be superseded. A complete native
 * census and the exact unchanged predecessor are obtained before any drain. */
export async function supersedeInvalidRecoveryIntent(deps, { handle, reason, intent, originatingLease, target,
  release, image, releases, exclusiveActivation }) {
  if (intent.protocolVersion !== 1 || `${intent.appName}--${intent.revisionSuffix}`.length <= 54) fail("RECOVERY_INTENT_SUPERSESSION_INVALID");
  const clock = deps.intentClock ?? Date.now, startedAt = clock();
  const heartbeat = () => deps.lease("heartbeat_recovery", { ...handle, reason });
  async function readPredecessor() {
    for (const identity of releases) {
      let latest;
      try { latest = await deps.readAppTemplate({ target, role: intent.role, ...identity, exclusiveActivation }); }
      catch { continue; }
      if (latest.state?.revisionName === intent.predecessorRevisionName
        && latest.state.templateDigest === intent.predecessorTemplateDigest
        && latest.latestReadyRevisionName === intent.predecessorRevisionName && latest.provisioningState === "Succeeded") return latest.state;
    }
    fail("RECOVERY_INTENT_SUPERSESSION_PREDECESSOR_CHANGED");
  }
  await heartbeat();
  const predecessor = await readPredecessor();
  const args = { originatingLease, target, role: intent.role, predecessor, release, image, imageDigest: intent.imageDigest };
  if (!same(buildManagedAzureRecoveryIntent({ ...args, protocolVersion: 1 }).intent, intent)) fail("RECOVERY_INTENT_PLAN_DRIFT");
  const plan = buildManagedAzureRecoveryIntent(args);assertRecoveryIntentName(plan.intent);
  const census = await deps.readExclusiveState({ target, role: intent.role, exclusiveActivation, onProgress: heartbeat });
  if (!same(await readPredecessor(), predecessor)) fail("RECOVERY_INTENT_SUPERSESSION_PREDECESSOR_CHANGED");
  if (census.provisioningState !== "Succeeded" || census.latestRevisionName !== intent.predecessorRevisionName
    || census.latestReadyRevisionName !== intent.predecessorRevisionName
    || census.configurationDigest !== exclusiveActivation?.configurationDigests?.[intent.role]
    || !Array.isArray(census.revisions) || census.revisions.length < 1 || census.revisions.length > 256) fail("RECOVERY_INTENT_SUPERSESSION_ABSENCE_UNPROVEN");
  const names = new Set();
  for (const row of census.revisions) {
    if (names.has(row.revisionName) || !row.revisionName.startsWith(`${intent.appName}--`) || typeof row.active !== "boolean"
      || !Number.isInteger(row.replicaCount) || row.replicaCount < 0 || row.replicaCount > 256
      || [intent.revisionSuffix,plan.intent.revisionSuffix].some(suffix => row.revisionName === `${intent.appName}--${suffix}`)
      || row.revisionName !== intent.predecessorRevisionName && (row.active || row.replicaCount !== 0)) fail("RECOVERY_INTENT_SUPERSESSION_ABSENCE_UNPROVEN");
    names.add(row.revisionName);
  }
  if (!names.has(intent.predecessorRevisionName)) fail("RECOVERY_INTENT_SUPERSESSION_ABSENCE_UNPROVEN");
  const evidence = { schemaVersion: 1, startedAt, observedAt: clock(), leaseId: handle.leaseId, fence: handle.fence,
    targetDigest: `sha256:${hash(target)}`, oldIntentDigest: intent.intentDigest, role: intent.role, appName: intent.appName,
    latestRevisionName: census.latestRevisionName, latestReadyRevisionName: census.latestReadyRevisionName,
    templateDigest: predecessor.templateDigest, configurationDigest: census.configurationDigest,
    provisioningState: census.provisioningState,
    revisions: census.revisions.map(row => ({ revisionName: row.revisionName, active: row.active, replicaCount: row.replicaCount })) };
  await heartbeat();
  let receipt;
  try { receipt = await deps.lease("supersede_invalid_recovery_intent", { ...handle, reason,
    oldIntentDigest: intent.intentDigest, intent: plan.intent, evidence }); }
  catch { fail("RECOVERY_INTENT_SUPERSESSION_UNCERTAIN"); }
  if (!receipt || receipt.deploymentId !== handle.deploymentId || receipt.leaseId !== handle.leaseId
    || receipt.fence !== handle.fence || receipt.phase !== "RECOVERY_REQUIRED" || !same(receipt.intent, plan.intent)
    || receipt.created !== true) fail("RECOVERY_INTENT_SUPERSESSION_UNCERTAIN");
  return { ...plan, location: predecessor.location, creationReceipt: receipt };
}

export async function runManagedAzureRecoveryIntent(deps, { handle, reason, target, release, intent, template, location, existing = false, creationReceipt }) {
  const args = { deploymentId: handle.deploymentId, leaseId: handle.leaseId, fence: handle.fence, capability: handle.capability };
  if (managedAzureTemplateDigest(template) !== intent.templateDigest) fail("RECOVERY_INTENT_PLAN_DRIFT");
  assertRecoveryIntentName(intent);
  let created = false;
  if (creationReceipt) {
    if (!existing || creationReceipt.deploymentId !== handle.deploymentId || creationReceipt.leaseId !== handle.leaseId
      || creationReceipt.fence !== handle.fence || creationReceipt.phase !== "RECOVERY_REQUIRED"
      || creationReceipt.created !== true || !same(creationReceipt.intent, intent)) fail("RECOVERY_INTENT_RECEIPT_INVALID");
    created = true;
  } else if (!existing) {
    let receipt;
    try { receipt = await deps.lease("record_recovery_intent", { ...args, intent, reason }); }
    catch { fail("RECOVERY_INTENT_RECORDING_UNCERTAIN"); }
    if (receipt?.deploymentId !== handle.deploymentId || receipt.leaseId !== handle.leaseId || receipt.fence !== handle.fence
      || receipt.phase !== "RECOVERY_REQUIRED" || typeof receipt.created !== "boolean" || !same(receipt.intent, intent)) {
      fail("RECOVERY_INTENT_RECEIPT_INVALID");
    }
    created = receipt.created;
  }
  const heartbeat = async () => {
    try { await deps.lease("heartbeat_recovery", { ...args, reason }); }
    catch { fail("RECOVERY_INTENT_HEARTBEAT_FAILED"); }
  };
  let patch = {};
  if (created) {
    await heartbeat();
    try { patch = await deps.patchTemplate({ target, role: intent.role, location, template, onProgress: heartbeat }); }
    catch (error) {
      if (error instanceof ManagedAzureRecoveryIntentError) throw error;
      patch = { code: "AZURE_PATCH_AMBIGUOUS", stage: "PATCH_REQUEST" };
    }
    if (patch.terminal && !patch.succeeded) fail("RECOVERY_INTENT_PATCH_REJECTED", patch);
  }
  const clock = deps.intentClock ?? Date.now;
  const sleep = deps.intentSleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  let lastCode = "RECOVERY_INTENT_READBACK_TIMEOUT";
  for (let poll = 0; poll < 300 && clock() - started < 300_000; poll += 1) {
    await heartbeat();
    let revision;
    try { revision = await deps.readRevisionState({ target, role: intent.role,
      revisionName: `${intent.appName}--${intent.revisionSuffix}`, expectedTemplate: template }); }
    catch (error) { fail("RECOVERY_INTENT_REVISION_READ_FAILED", { ...patch, code: error?.code ?? patch.code }); }
    if (revision.kind === "ABSENT" && !created) fail("RECOVERY_INTENT_RECORDED_REVISION_ABSENT", patch);
    if (!["ABSENT", "PROVISIONING", "READY"].includes(revision.kind)) fail("RECOVERY_INTENT_REVISION_NOT_READY", patch);
    if (revision.kind === "READY") {
      try {
        const state = await deps.readApp({ target, role: intent.role, release, imageDigest: intent.imageDigest, ambiguous: true });
        if (state.revisionName === `${intent.appName}--${intent.revisionSuffix}` && state.templateDigest === intent.templateDigest) {
          return { intent, state, patched: created };
        }
        if (state.revisionName !== intent.predecessorRevisionName) fail("RECOVERY_INTENT_APP_DRIFT", patch);
      } catch (error) {
        if (error instanceof ManagedAzureRecoveryIntentError) throw error;
        lastCode = "RECOVERY_INTENT_APP_READBACK_FAILED";
      }
    }
    await sleep(1_000);
  }
  fail(lastCode, patch);
}
