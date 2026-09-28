import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import pg from "pg";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { createOpsCoreAzureTarget } from "./ops-core-azure-target.mjs";
import { reconcilePostgresPromotion, postgresPromotionDurableRecord } from "./ops-core-postgres-promotion.mjs";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";
import { DATABASE_SQL, postgresRuntimeAccessIsolationInventory,
  postgresRuntimeAccessPolicySha256, validatePostgresRuntimeAccessPolicy } from "./ops-core-postgres-runtime-access.mjs";
import { inspectPostgresScratch, nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresDatabaseParity } from "./validate-postgres-restore-rehearsal.mjs";

class RetryScratchError extends Error {}
const need = (value, code) => { if (!value) throw new RetryScratchError(code); };
const same = (left, right) => archiveEvidenceHash(left) === archiveEvidenceHash(right);
const opaqueRef = value => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const keyFor = (domain, intentSha256) => `retry-admissions/${domain}/${intentSha256}/predecessor-scratch.json`;
export const retryScratchDiagnostic = error => error instanceof RetryScratchError ? error.message : null;

export function retryCaptureLineage(journal) {
  const pending = journal?.recovery?.abandonedPending;
  if (pending?.to === "CAPTURED") return pending;
  if (journal?.recovery?.from === "CAPTURED" && pending === null) {
    const captured = journal.history?.find(entry => entry.phase === "CAPTURED");
    if (captured?.operationId && captured.intentSha256) return { ...captured, to: "CAPTURED" };
  }
  return null;
}

export function retryRestoredLineage(journal) {
  const pending = journal?.recovery?.abandonedPending;
  const captured = journal?.history?.find(entry => entry.phase === "CAPTURED");
  const restored = journal?.history?.find(entry => entry.phase === "RESTORED");
  return journal?.recovery?.from === "RESTORED" && pending?.to === "VERIFIED"
    && captured?.operationId && restored?.operationId && pending.operationId
    ? { capture: captured, restore: restored, verification: pending } : null;
}

async function restoredScratchLineage({ plan, predecessorPlan, predecessorJournal, operationStore, signal }) {
  const lineage = retryRestoredLineage(predecessorJournal);
  need(lineage, "RETRY_RESTORED_LINEAGE_MISSING");
  const { capture, restore, verification } = lineage;
  const prefix = `operations/${plan.domain}/${predecessorJournal.intentSha256}/${verification.operationId}/`;
  const read = async key => {
    const text = await operationStore.readOptional(key, signal);
    need(typeof text === "string" && Buffer.byteLength(text) <= 32 * 1024 * 1024,
      "RETRY_RESTORED_EVIDENCE_MISSING");
    return JSON.parse(text);
  };
  const phasePlan = await read(`${prefix}phase-plan.json`);
  const durablePromotion = postgresPromotionDurableRecord(phasePlan.promotion);
  need(phasePlan.schemaVersion === 3 && phasePlan.intentSha256 === predecessorJournal.intentSha256
    && durablePromotion.intent.sha256 === verification.intentSha256
    && phasePlan.promotion?.sha256 === verification.intentSha256
    && phasePlan.promotion?.scratchName === predecessorPlan.transfer.postgres.scratchName
    && phasePlan.promotion?.permanentName === `corgtex_${plan.domain}`
    && phasePlan.promotion?.targetIdentity === predecessorPlan.transfer.postgres.targetIdentity
    && same(phasePlan.promotion?.expectedConnection, predecessorPlan.transfer.postgres.target)
    && phasePlan.runtimeAccessPolicySha256 === archiveEvidenceHash(predecessorPlan.transfer.postgres.runtimeAccess)
    && /^[a-f0-9]{64}$/.test(phasePlan.postgresCopyEvidenceSha256)
    && /^[a-f0-9]{64}$/.test(phasePlan.archiveManifestSha256)
    && /^[a-f0-9]{64}$/.test(phasePlan.objectSnapshotEvidenceSha256),
  "RETRY_RESTORED_PHASE_PLAN_INVALID");
  need(await operationStore.readOptional(`${prefix}promotion-intent.json`, signal) === null,
    "RETRY_RESTORED_PROMOTION_INTENT_PRESENT");
  const context = await read(`${prefix}phase-evidence-${phasePlan.postgresCopyEvidenceSha256}.json`);
  need(context.type === "POSTGRES_COPY_CONTEXT" && archiveEvidenceHash(context) === phasePlan.postgresCopyEvidenceSha256,
    "RETRY_RESTORED_COPY_CONTEXT_INVALID");
  const copied = context.copied;
  need(copied?.scratchName === predecessorPlan.transfer.postgres.scratchName
    && copied.scratchOid === phasePlan.promotion.scratchOid
    && copied.archive?.sha256 === capture.evidenceSha256
    && copied.archive.sha256 === phasePlan.archiveManifestSha256
    && copied.evidenceSha256 === restore.evidenceSha256
    && phasePlan.promotion.parityEvidenceSha256 === copied.parity?.evidenceSha256
    && same(validatePostgresDatabaseParity(copied.evidence, { requireFrozenSourceSequences: true }), copied.parity),
  "RETRY_RESTORED_COPY_LINEAGE_INVALID");
  const restoreKeyPrefix = `operations/${plan.domain}/${predecessorJournal.intentSha256}/${restore.operationId}/phase-evidence-`;
  need(typeof copied.evidenceKey === "string" && copied.evidenceKey.startsWith(restoreKeyPrefix)
    && /^[a-f0-9]{64}\.json$/.test(copied.evidenceKey.slice(restoreKeyPrefix.length)),
  "RETRY_RESTORED_RESTORE_PROOF_INVALID");
  const proof = await read(copied.evidenceKey);
  need(archiveEvidenceHash(proof) === copied.evidenceKey.slice(restoreKeyPrefix.length, -5)
    && proof.type === "POSTGRES_COPY_PARITY" && proof.restoreOperationId === restore.operationId
    && proof.restoreIntentSha256 === restore.intentSha256 && proof.scratchOid === copied.scratchOid
    && proof.archiveManifestSha256 === copied.archive.sha256
    && same(proof.evidence, copied.evidence) && same(proof.parity, copied.parity),
  "RETRY_RESTORED_RESTORE_PROOF_INVALID");
  return { capture, restore, verification, phasePlan, copied,
    phasePlanSha256: archiveEvidenceHash(phasePlan), restoreProofSha256: archiveEvidenceHash(proof) };
}

function privateEvidence(directory, name) {
  need(typeof directory === "string" && directory.startsWith("/") && realpathSync(directory) === resolve(directory)
    && statSync(directory).isDirectory() && (statSync(directory).mode & 0o077) === 0,
  "RETRY_SCRATCH_EVIDENCE_DIRECTORY_INVALID");
  const path = join(directory, name), file = statSync(path);
  need(realpathSync(path) === path && file.isFile() && (file.mode & 0o077) === 0
    && file.size > 0 && file.size <= 1024 * 1024, "RETRY_SCRATCH_EVIDENCE_FILE_INVALID");
  const value = JSON.parse(readFileSync(path, "utf8"));
  return { value, sha256: archiveEvidenceHash(value) };
}

export function effectiveRetryScratchPolicy(plan, predecessorPlan, receipt) {
  const base = plan.transfer.postgres.runtimeAccess, predecessor = plan.operator.retryOf;
  const scratch = receipt?.scratch;
  const restored = receipt?.type === "PRESERVED_RESTORED_RETRY_SCRATCH";
  need(predecessor && base?.schemaVersion === 2 && receipt?.schemaVersion === 1
    && (restored || receipt.type === "PRESERVED_RETRY_SCRATCH") && receipt.domain === plan.domain
    && receipt.intentSha256 === archiveEvidenceHash(plan)
    && receipt.predecessorIntentSha256 === predecessor.intentSha256
    && archiveEvidenceHash(predecessorPlan) === predecessor.intentSha256
    && receipt.predecessorJournalSha256 === predecessor.journalSha256
    && receipt.basePolicySha256 === postgresRuntimeAccessPolicySha256(base)
    && scratch?.name === predecessorPlan.transfer.postgres.scratchName
    && scratch.name !== plan.transfer.postgres.scratchName
    && /^[1-9][0-9]{0,9}$/.test(scratch.oid)
    && scratch.owner === plan.transfer.postgres.target.user
    && /^[a-f0-9]{64}$/.test(scratch.aclSha256)
    && /^[a-f0-9]{64}$/.test(receipt.inventorySha256)
    && /^[a-f0-9]{64}$/.test(receipt.copyIntentSha256)
    && /^[a-f0-9]{64}$/.test(receipt.scratchStateSha256)
    && receipt.captureOperationId === (receipt.predecessorCaptureOperationId ?? receipt.predecessorAbandonedOperationId)
    && !(receipt.predecessorCaptureOperationId && receipt.predecessorAbandonedOperationId)
    && (!restored || (/^[a-f0-9]{64}$/.test(receipt.phasePlanSha256)
      && /^[a-f0-9]{64}$/.test(receipt.restoreProofSha256)
      && /^[a-f0-9]{64}$/.test(receipt.promotionIntentSha256)
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.predecessorRestoreOperationId)
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.predecessorVerificationOperationId))),
  "RETRY_SCRATCH_RECEIPT_INVALID");
  const added = { name: scratch.name, oid: scratch.oid, owner: scratch.owner,
    action: "verify-only", beforeAclSha256: scratch.aclSha256, preserveConnectRoles: [] };
  const policy = { ...base, isolation: { inventorySha256: receipt.inventorySha256,
    databases: [...base.isolation.databases, added].sort((a, b) => a.name.localeCompare(b.name)) } };
  validatePostgresRuntimeAccessPolicy(policy, { domain: plan.domain, runtimeVaultUri: plan.activation.runtimeVaultUri });
  need(receipt.effectivePolicySha256 === postgresRuntimeAccessPolicySha256(policy), "RETRY_SCRATCH_POLICY_CHANGED");
  return { policy, receiptSha256: archiveEvidenceHash(receipt), scratch };
}

/** One recovered attempt may retain its empty, protected scratch database.
 * Admission covers an interrupted or completed capture before restore intent.
 * It never changes the immutable global plan. All other database drift fails. */
export async function resolveRetryScratchAdmission({ plan, predecessorPlan, predecessorJournal, custody,
  operationStore, targetAdminConfig, evidenceDirectory, create = false, inspect = inspectPostgresScratch,
  openMaintenance = openPostgresMaintenance, clientFactory = value => new pg.Client(value),
  targetFactory = createOpsCoreAzureTarget }) {
  const restored = retryRestoredLineage(predecessorJournal);
  const capture = restored
    ? { ...restored.capture, to: "CAPTURED" } : retryCaptureLineage(predecessorJournal);
  need(plan.operator.retryOf && predecessorJournal?.phase === "SOURCE_RECOVERED"
    && archiveEvidenceHash(predecessorJournal) === plan.operator.retryOf.journalSha256
    && capture
    && predecessorJournal.destinationMayHaveWritten === false,
  "RETRY_SCRATCH_PREDECESSOR_INVALID");
  const key = keyFor(plan.domain, archiveEvidenceHash(plan));
  const check = async () => {
    custody.signal.throwIfAborted(); await custody.assertOwned(); custody.signal.throwIfAborted();
    need(archiveEvidenceHash(predecessorJournal) === plan.operator.retryOf.journalSha256,
      "RETRY_SCRATCH_PREDECESSOR_CHANGED");
  };
  await check(); await operationStore.assertPrivate();
  const retained = await operationStore.readOptional(key, custody.signal); await check();
  if (retained === null && !create) return null;
  if (retained === null) need(custody.snapshot().phase === "PREPARED" && custody.snapshot().pending === null
    && custody.snapshot().destinationMayHaveWritten === false && typeof evidenceDirectory === "string",
  "RETRY_SCRATCH_ADMISSION_PHASE_INVALID");
  const prior = retained === null ? null : JSON.parse(retained);
  const restoredEvidence = restored ? await restoredScratchLineage({ plan, predecessorPlan,
    predecessorJournal, operationStore, signal: custody.signal }) : null;
  if (prior) {
    need((prior.predecessorCaptureOperationId ?? prior.predecessorAbandonedOperationId) === capture.operationId
      && prior.captureOperationId === capture.operationId
      && (restored ? prior.type === "PRESERVED_RESTORED_RETRY_SCRATCH"
        && prior.predecessorRestoreOperationId === restored.restore.operationId
        && prior.predecessorVerificationOperationId === restored.verification.operationId
        && prior.copyIntentSha256 === restored.capture.intentSha256
        && prior.phasePlanSha256 === restoredEvidence.phasePlanSha256
        && prior.restoreProofSha256 === restoredEvidence.restoreProofSha256
        && prior.promotionIntentSha256 === restoredEvidence.phasePlan.promotion.sha256
        : prior.type === "PRESERVED_RETRY_SCRATCH"),
    "RETRY_SCRATCH_RECEIPT_LINEAGE_CHANGED");
    const resolved = effectiveRetryScratchPolicy(plan, predecessorPlan, prior);
    // Transfer and activation check the complete effective access policy against
    // live catalogs. The original pre-transfer baseline is no longer applicable
    // after the retry creates or promotes its own database.
    if (custody.snapshot().phase !== "PREPARED") return resolved;
  }
  const scratchName = predecessorPlan.transfer.postgres.scratchName;
  let maintenance, client;
  try {
    await check();
    const inactive = await targetFactory({ binding: plan.azure, custody }).assertInactive();
    need(inactive.complete === true, "RETRY_SCRATCH_TARGET_ACTIVE");
    maintenance = await openMaintenance({ config: targetAdminConfig, expected: plan.transfer.postgres.target,
      signal: custody.signal, assertOwned: check });
    const guarded = async () => { await check(); await maintenance.assertHeld(); };
    const evidence = retained === null ? {
      copy: restored ? null : privateEvidence(evidenceDirectory, "copy-intent.json"),
      state: privateEvidence(evidenceDirectory, "scratch-state.json"),
    } : null;
    if (evidence) {
      need((restored || (evidence.copy.value.capture?.operationId === capture.operationId
        && evidence.copy.value.capture?.intentSha256 === capture.intentSha256
        && evidence.copy.value.capture?.to === "CAPTURED"
        && archiveEvidenceHash(evidence.copy.value.intent) === capture.intentSha256
        && evidence.copy.value.intent?.domain === plan.domain
        && evidence.copy.value.intent?.scratchName === scratchName
        && same(evidence.copy.value.intent.source, predecessorPlan.transfer.postgres.source)
        && same(evidence.copy.value.intent.target, predecessorPlan.transfer.postgres.target)
        && evidence.copy.value.intent.archiveStoreId === predecessorPlan.transfer.postgres.archiveStoreId
        && evidence.copy.value.intent.keyVersion === predecessorPlan.transfer.postgres.keyVersion))
        && evidence.state.value.phase === "MIGRATION_RETAINED"
        && evidence.state.value.scratchName === scratchName
        && (evidence.state.value.scratchOwner === targetAdminConfig.user
          || restored && evidence.state.value.scratchOwner === undefined)
        && evidence.state.value.targetRef === opaqueRef(`${targetAdminConfig.host}\0${scratchName}`)
        && (!restored || (restoredEvidence.copied.scratchOid === evidence.state.value.scratchOid
          && restoredEvidence.copied.stateFile === join(evidenceDirectory, "scratch-state.json"))),
      "RETRY_SCRATCH_LOCAL_PROVENANCE_INVALID");
    }
    const oid = prior?.scratch?.oid ?? evidence.state.value.scratchOid;
    need(/^[1-9][0-9]{0,9}$/.test(oid), "RETRY_SCRATCH_OID_INVALID");
    if (restored) {
      client = clientFactory(nodeClientConfig(targetAdminConfig, "opscore_retry_restored_catalog", 15_000, 20_000));
      await client.connect(); await guarded();
      const state = await reconcilePostgresPromotion({ client, intent: restoredEvidence.phasePlan.promotion });
      need(state.status === "PREPARED" && state.connectionCount === 0
        && state.scratchOid === oid, "RETRY_RESTORED_PROMOTION_STATE_INVALID");
      await client.end(); client = null;
    }
    const proof = await inspect({ config: { ...targetAdminConfig, database: scratchName },
      signal: maintenance.signal, assertCustody: guarded, requireEmpty: !restored,
      requireProtectedAccess: true, expectedScratchOid: oid });
    need(proof.databaseOid === oid && proof.databaseOwner === targetAdminConfig.user
      && proof.empty === !restored && proof.protectedAccess === true, "RETRY_SCRATCH_LIVE_PROOF_INVALID");
    client = clientFactory(nodeClientConfig(targetAdminConfig, "opscore_retry_scratch_inventory", 15_000, 20_000));
    await client.connect(); await guarded(); await client.query("BEGIN READ ONLY");
    let databases;
    try { databases = (await client.query(DATABASE_SQL)).rows; }
    finally { await client.query("ROLLBACK"); }
    const scratch = databases.find(row => row.name === scratchName);
    const base = postgresRuntimeAccessIsolationInventory({ databases: databases.filter(row => row !== scratch) }, plan.domain);
    const complete = postgresRuntimeAccessIsolationInventory({ databases }, plan.domain);
    need(scratch?.oid === oid && scratch.owner === targetAdminConfig.user && scratch.allowConnections === true
      && scratch.isTemplate === false && scratch.ownerAuthority === true
      && !scratch.acl.some(entry => entry.grantee === "0" && entry.privilege === "CONNECT")
      && complete.databases.length === plan.transfer.postgres.runtimeAccess.isolation.databases.length + 1
      && base.inventorySha256 === plan.transfer.postgres.runtimeAccess.isolation.inventorySha256
      && base.databases.length === plan.transfer.postgres.runtimeAccess.isolation.databases.length,
    "RETRY_SCRATCH_OTHER_DATABASE_DRIFT");
    const observed = complete.databases.find(row => row.name === scratchName);
    need(observed?.oid === oid && observed.owner === targetAdminConfig.user,
      "RETRY_SCRATCH_INVENTORY_CHANGED");
    const receipt = prior ?? { schemaVersion: 1, type: restored ? "PRESERVED_RESTORED_RETRY_SCRATCH" : "PRESERVED_RETRY_SCRATCH", domain: plan.domain,
      intentSha256: archiveEvidenceHash(plan), predecessorIntentSha256: plan.operator.retryOf.intentSha256,
      predecessorJournalSha256: plan.operator.retryOf.journalSha256,
      predecessorCaptureOperationId: capture.operationId, captureOperationId: capture.operationId,
      ...(restored ? { predecessorRestoreOperationId: restored.restore.operationId,
        predecessorVerificationOperationId: restored.verification.operationId,
        phasePlanSha256: restoredEvidence.phasePlanSha256,
        restoreProofSha256: restoredEvidence.restoreProofSha256,
        promotionIntentSha256: restoredEvidence.phasePlan.promotion.sha256 } : {}),
      copyIntentSha256: restored ? capture.intentSha256 : evidence.copy.sha256,
      scratchStateSha256: evidence.state.sha256,
      basePolicySha256: postgresRuntimeAccessPolicySha256(plan.transfer.postgres.runtimeAccess),
      inventorySha256: complete.inventorySha256,
      scratch: { name: scratchName, oid, owner: targetAdminConfig.user, aclSha256: observed.aclSha256 },
      effectivePolicySha256: "" };
    if (!prior) {
      const added = { name: scratchName, oid, owner: targetAdminConfig.user,
        action: "verify-only", beforeAclSha256: observed.aclSha256, preserveConnectRoles: [] };
      const original = plan.transfer.postgres.runtimeAccess;
      const effective = { ...original, isolation: { inventorySha256: complete.inventorySha256,
        databases: [...original.isolation.databases, added].sort((a, b) => a.name.localeCompare(b.name)) } };
      receipt.effectivePolicySha256 = postgresRuntimeAccessPolicySha256(effective);
    }
    const resolved = effectiveRetryScratchPolicy(plan, predecessorPlan, receipt);
    need(receipt.inventorySha256 === complete.inventorySha256 && receipt.scratch.aclSha256 === observed.aclSha256
      && receipt.scratch.oid === oid, "RETRY_SCRATCH_RECEIPT_DRIFT");
    if (retained === null) {
      const text = JSON.stringify(receipt);
      await guarded();
      try { await operationStore.createOnly(key, text, custody.signal); }
      catch { /* A lost create acknowledgement is resolved by exact readback. */ }
      need(await operationStore.readOptional(key, custody.signal) === text,
        "RETRY_SCRATCH_RECEIPT_UNPROVEN");
    }
    await guarded();
    return resolved;
  } catch (error) { throw error instanceof RetryScratchError ? error : new RetryScratchError("RETRY_SCRATCH_ADMISSION_FAILED", { cause: error }); }
  finally { await client?.end().catch(() => {}); await maintenance?.close().catch(() => {}); }
}
