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
export function buildManagedAzureRecoveryIntent({ originatingLease, target, role, predecessor, release, image, imageDigest }) {
  if (!["web", "worker"].includes(role) || predecessor.role !== role
    || predecessor.appName !== target[role === "web" ? "webAppName" : "workerAppName"]
    || image !== `${target.acrServer}/corgtex/${role}@${imageDigest}`) fail("RECOVERY_INTENT_TARGET_INVALID");
  const neutral = buildManagedAzureReleaseTemplate({ baseline: predecessor, role, image, release,
    revisionSuffix: "", migrateWeb: true });
  const base = {
    protocolVersion: 1,
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
  const revisionSuffix = `ri-${hash(base).slice(0, 32)}`;
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
      latest = await deps.readAppTemplate({ target, role: intent.role, release: identity.release, imageDigest: identity.imageDigest });
      break;
    } catch { /* Only the exact recorded source or candidate may be adopted. */ }
  }
  const state = latest?.state;
  if (!state) fail("RECOVERY_INTENT_APP_UNREADABLE");
  if (state.revisionName === intent.predecessorRevisionName && state.templateDigest === intent.predecessorTemplateDigest) {
    const plan = buildManagedAzureRecoveryIntent({ originatingLease, target, role: intent.role, predecessor: state,
      release, image, imageDigest: intent.imageDigest });
    if (!same(plan.intent, intent)) fail("RECOVERY_INTENT_PLAN_DRIFT");
    return plan;
  }
  if (state.revisionName !== `${intent.appName}--${intent.revisionSuffix}`
    || state.templateDigest !== intent.templateDigest) fail("RECOVERY_INTENT_APP_DRIFT");
  const neutral = { ...state.template, revisionSuffix: "" };
  const { intentDigest, templateDigest, revisionSuffix, ...base } = intent;
  if (managedAzureTemplateDigest(neutral) !== intent.templateBaseDigest
    || revisionSuffix !== `ri-${hash(base).slice(0, 32)}`
    || intentDigest !== `sha256:${hash({ ...base, revisionSuffix, templateDigest })}`) fail("RECOVERY_INTENT_PLAN_DRIFT");
  const expected = buildManagedAzureReleaseTemplate({ baseline: state, role: intent.role, image, release,
    revisionSuffix, migrateWeb: true });
  if (managedAzureTemplateDigest(expected) !== templateDigest) fail("RECOVERY_INTENT_PLAN_DRIFT");
  return { intent, template: expected };
}

export async function runManagedAzureRecoveryIntent(deps, { handle, reason, target, release, intent, template, location, existing = false }) {
  const args = { deploymentId: handle.deploymentId, leaseId: handle.leaseId, fence: handle.fence, capability: handle.capability };
  if (managedAzureTemplateDigest(template) !== intent.templateDigest) fail("RECOVERY_INTENT_PLAN_DRIFT");
  let created = false;
  if (!existing) {
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
