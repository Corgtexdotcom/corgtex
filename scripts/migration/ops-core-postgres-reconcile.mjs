import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { archiveEvidenceHash as hash, recoverPostgresArchive, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { observePostgresDatabase, inspectPostgresScratch, inspectRetainedArchiveSequences, buildObservedPostgresParityEvidence, postgresRestoreErrorCode } from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresDatabaseParity } from "./validate-postgres-restore-rehearsal.mjs";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OID = /^[1-9][0-9]{0,9}$/;
const same = (a, b) => hash(a) === hash(b);
class ReconcileError extends Error {}
const need = (value, code) => { if (!value) throw new ReconcileError(code); };
const ref = value => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const connection = c => ({ host: c.host, port: c.port, database: c.database, user: c.user });
export const postgresCopyReconcileDiagnostic = error => error instanceof ReconcileError ? error.message
  : postgresRestoreErrorCode(error) ?? "POSTGRES_RECONCILIATION_UNPROVEN";
export const postgresCopyRecordKey = (domain, intentSha256, operationId) => {
  need(["ops", "core"].includes(domain) && HASH.test(intentSha256) && UUID.test(operationId), "POSTGRES_RECORD_BINDING_INVALID");
  return `operations/${domain}/${intentSha256}/${operationId}/phase-plan.json`;
};
export async function retainPostgresCopyRecord({ operationStore, key, value, check, signal }) {
  await check(); await operationStore.assertPrivate();
  const before = await operationStore.readOptional(key, signal);
  if (before === null) await operationStore.createOnly(key, JSON.stringify(value), signal);
  else need(same(JSON.parse(before), value), "POSTGRES_RECORD_CHANGED");
  await check();
  const text = await operationStore.readOptional(key, signal);
  need(typeof text === "string" && same(JSON.parse(text), value), "POSTGRES_RECORD_UNPROVEN");
  await check();
}
export const postgresCopyCaptureIntent = o => ({ domain: o.domain, source: o.expectedSource, target: o.expectedTarget,
  scratchName: o.scratchName, archiveStoreId: o.archiveStore.identity, keyVersion: o.keyVersion, maxArchiveBytes: o.maxArchiveBytes });
export const postgresCopyRestoreIntent = (manifest, o) => ({ archiveManifestSha256: manifest.sha256,
  target: o.expectedTarget, scratchName: o.scratchName });

/** Shared read-only preparation for reconciliation and explicit first restore.
 * The independent phase-plan is mandatory; a local scratch marker cannot prove
 * that the current database is the one this operation created.
 */
export async function prepareRetainedPostgresCopy(options, dependencies = {}) {
  const o = options, initial = o.custody.snapshot(), signal = o.custody.signal;
  need(["ops", "core"].includes(o.domain) && initial.domain === o.domain && HASH.test(initial.intentSha256)
    && initial.destinationMayHaveWritten === false && ["SOURCE_FENCED", "CAPTURED", "RESTORED"].includes(initial.phase)
    && (!initial.pending || ["CAPTURED", "RESTORED"].includes(initial.pending.to))
    && same(connection(o.sourceConfig), o.expectedSource) && same(connection(o.targetAdminConfig), o.expectedTarget)
    && o.targetAdminConfig.database === "postgres" && (o.sourceConfig.host !== o.targetAdminConfig.host || o.sourceConfig.port !== o.targetAdminConfig.port)
    && /^corgtex_rehearsal_[a-z0-9_]{1,45}$/.test(o.scratchName)
    && Number.isSafeInteger(o.maxArchiveBytes) && o.maxArchiveBytes > 0
    && typeof o.assertSourceFenced === "function" && typeof o.assertTargetInactive === "function"
    && o.operationStore && signal instanceof AbortSignal, "POSTGRES_RECONCILIATION_BINDING_INVALID");
  validateArchiveKeyVersion(o.keyVersion, o.vaultName);
  const check = async () => {
    signal.throwIfAborted(); await o.custody.assertOwned();
    need(same(o.custody.snapshot(), initial), "POSTGRES_RECONCILIATION_PHASE_CHANGED");
    await o.assertSourceFenced(); await o.assertTargetInactive(); signal.throwIfAborted();
  };
  await check(); await o.operationStore.assertPrivate(); await o.archiveStore.assertPrivate();
  const capture = initial.pending?.to === "CAPTURED" ? initial.pending : initial.history?.find(e => e.phase === "CAPTURED");
  need(capture && UUID.test(capture.operationId) && HASH.test(capture.intentSha256), "POSTGRES_CAPTURE_OPERATION_MISSING");
  const captureIntent = postgresCopyCaptureIntent(o), sourceFenceSha256 = initial.history?.find(e => e.phase === "SOURCE_FENCED")?.evidenceSha256;
  need(HASH.test(sourceFenceSha256) && capture.intentSha256 === hash(captureIntent), "POSTGRES_CAPTURE_INTENT_CHANGED");
  const key = postgresCopyRecordKey(o.domain, initial.intentSha256, capture.operationId);
  const text = await o.operationStore.readOptional(key, signal);
  need(typeof text === "string" && Buffer.byteLength(text) <= 65536, "POSTGRES_CAPTURE_CHECKPOINT_MISSING");
  const checkpoint = JSON.parse(text);
  const binding = { domain: o.domain, operationId: capture.operationId, intentSha256: initial.intentSha256,
    sourceFenceSha256, sourceRef: ref(`${o.sourceConfig.host}\0${o.sourceConfig.database}`),
    targetRef: ref(`${o.targetAdminConfig.host}\0${o.scratchName}`) };
  need(checkpoint.type === "POSTGRES_COPY_CAPTURE" && checkpoint.schemaVersion === 1
    && same(checkpoint.binding, binding) && same(checkpoint.captureIntent, captureIntent)
    && checkpoint.captureIntentSha256 === capture.intentSha256
    && OID.test(checkpoint.scratchOid) && BigInt(checkpoint.scratchOid) <= 4294967295n
    && checkpoint.scratchOwner === o.expectedTarget.user, "POSTGRES_CAPTURE_CHECKPOINT_CHANGED");
  async function archiveJson(name) {
    await check(); const stream = await o.archiveStore.read(name), chunks = []; let size = 0;
    for await (const chunk of stream) {
      signal.throwIfAborted(); size += Buffer.byteLength(chunk); need(size <= 32 * 1024 * 1024, "POSTGRES_ARCHIVE_RECORD_TOO_LARGE");
      chunks.push(Buffer.from(chunk));
    }
    await check(); return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const manifest = await archiveJson(`${capture.operationId}.manifest.json`);
  const archiveEvidence = await archiveJson(`${capture.operationId}.evidence.json`);
  need(manifest.aad?.evidenceSha256 === hash(archiveEvidence) && manifest.aad?.keyVersion === o.keyVersion,
    "POSTGRES_ARCHIVE_EVIDENCE_CHANGED");
  if (initial.pending?.to !== "CAPTURED") need(capture.evidenceSha256 === manifest.sha256, "POSTGRES_CAPTURE_RECEIPT_CHANGED");
  await mkdir(o.artifactDir, { recursive: true, mode: 0o700 });
  const operationDir = await mkdtemp(join(resolve(o.artifactDir), `${capture.operationId}-reconcile-`));
  const tempDir = join(operationDir, "archive"); await mkdir(tempDir, { mode: 0o700 });
  const recovered = await recoverPostgresArchive({ manifest, expectedBinding: binding, store: o.archiveStore,
    outputFile: join(tempDir, "snapshot.dump"), vaultName: o.vaultName, maxBytes: o.maxArchiveBytes, signal,
    ...(o.resolveKey ? { resolveKey: o.resolveKey } : {}) });
  await check();
  const inspectArchive = dependencies.inspectArchive ?? inspectRetainedArchiveSequences;
  const archive = await inspectArchive({ config: o.sourceConfig, tempDir, dockerNetwork: o.dockerNetwork ?? null, signal, assertCustody: check });
  need(archive.tocEntryCount === archiveEvidence.sourceSequences?.length, "POSTGRES_ARCHIVE_SEQUENCE_COVERAGE_CHANGED");
  const observe = dependencies.observe ?? observePostgresDatabase;
  async function observation(config, name) {
    const dir = join(operationDir, name); await mkdir(dir, { mode: 0o700 });
    await check();
    const value = await observe({ config, tempDir: dir, dockerNetwork: o.dockerNetwork ?? null, signal, assertCustody: check });
    await check(); return value;
  }
  const source = await observation(o.sourceConfig, "source");
  need(same(source.evidence, archiveEvidence.sourceEvidence) && same(source.sequences, archiveEvidence.sourceSequences), "POSTGRES_FROZEN_SOURCE_CHANGED");
  const targetConfig = { ...o.targetAdminConfig, database: o.scratchName };
  const inspect = dependencies.inspectScratch ?? inspectPostgresScratch;
  const scratch = await inspect({ config: targetConfig, signal, assertCustody: check, requireProtectedAccess: true, expectedScratchOid: checkpoint.scratchOid });
  need(scratch.protectedAccess === true, "POSTGRES_SCRATCH_ACCESS_UNPROTECTED");
  need(scratch.databaseOid === checkpoint.scratchOid && scratch.databaseOwner === checkpoint.scratchOwner,
    "POSTGRES_SCRATCH_IDENTITY_CHANGED");
  await check();
  return { initial, capture, checkpoint, binding, manifest, archiveEvidence, archive, source, scratch, targetConfig,
    operationDir, tempDir, recovered, check, observation };
}

export async function retainPostgresCopyParity({ options: o, context: c, restore, evidence, parity }) {
  const value = { type: "POSTGRES_COPY_PARITY", schemaVersion: 1, binding: c.binding,
    restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256,
    checkpointSha256: hash(c.checkpoint), archiveManifestSha256: c.manifest.sha256, scratchOid: c.checkpoint.scratchOid, evidence, parity };
  const evidenceSha256 = hash({ parity, archiveManifestSha256: c.manifest.sha256 });
  const key = postgresCopyRecordKey(o.domain, c.initial.intentSha256, restore.operationId)
    .replace("phase-plan.json", `phase-evidence-${hash(value)}.json`);
  await retainPostgresCopyRecord({ operationStore: o.operationStore, key, value, check: c.check, signal: o.custody.signal });
  return { evidenceSha256, evidenceKey: key };
}

export function postgresCopyObservedParity(c, destination) {
  need(destination.databaseOid === c.checkpoint.scratchOid, "POSTGRES_SCRATCH_IDENTITY_CHANGED");
  // Historical sequence field names are shared with the validator; observations
  // prove stability by two reads and never replay a sequence.
  const evidence = buildObservedPostgresParityEvidence({ ...c.binding, source: c.source, destination, tocEntryCount: c.archive.tocEntryCount });
  return { evidence, parity: validatePostgresDatabaseParity(evidence, { requireFrozenSourceSequences: true }) };
}

/** Reads databases and archives only. Writes are limited to immutable custody
 * evidence and completion of the exact already-pending phase. Any missing,
 * changed or unobservable proof leaves the journal pending and returns INCOMPLETE.
 */
export async function reconcileOpsCorePostgresCopy(options, dependencies = {}) {
  try {
    const c = await prepareRetainedPostgresCopy(options, dependencies), o = options;
    if (c.initial.pending?.to === "CAPTURED") {
      const proof = { type: "POSTGRES_CAPTURE_RECONCILIATION", binding: c.binding, checkpointSha256: hash(c.checkpoint),
        manifestSha256: c.manifest.sha256, recovered: c.recovered, sourceEvidenceSha256: hash(c.source.evidence),
        sourceSequencesSha256: hash(c.source.sequences), scratch: c.scratch };
      await retainPostgresCopyRecord({ operationStore: o.operationStore,
        key: postgresCopyRecordKey(o.domain, c.initial.intentSha256, c.capture.operationId)
          .replace("phase-plan.json", `phase-evidence-${hash(proof)}.json`), value: proof, check: c.check, signal: o.custody.signal });
      await c.check(); await o.custody.complete(c.capture.operationId, c.manifest.sha256);
      return { complete: true, phase: "CAPTURED", nextAction: "RESTORE_RETAINED_ARCHIVE", archiveManifestSha256: c.manifest.sha256 };
    }
    if (c.initial.phase === "CAPTURED" && !c.initial.pending) return { complete: true, phase: "CAPTURED",
      nextAction: "RESTORE_RETAINED_ARCHIVE", archiveManifestSha256: c.manifest.sha256 };
    const restore = c.initial.pending?.to === "RESTORED" ? c.initial.pending : c.initial.history.find(e => e.phase === "RESTORED");
    need(restore?.intentSha256 === hash(postgresCopyRestoreIntent(c.manifest, o)), "POSTGRES_RESTORE_INTENT_CHANGED");
    const key = postgresCopyRecordKey(o.domain, c.initial.intentSha256, restore.operationId);
    const text = await o.operationStore.readOptional(key, o.custody.signal);
    need(typeof text === "string" && same(JSON.parse(text), { type: "POSTGRES_COPY_RESTORE", schemaVersion: 1,
      captureOperationId: c.capture.operationId, checkpointSha256: hash(c.checkpoint), archiveManifestSha256: c.manifest.sha256,
      restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256 }), "POSTGRES_RESTORE_CHECKPOINT_CHANGED");
    const destination = await c.observation(c.targetConfig, "destination");
    const { evidence, parity } = postgresCopyObservedParity(c, destination);
    await c.check();
    const proof = await retainPostgresCopyParity({ options: o, context: c, restore, evidence, parity });
    if (c.initial.pending?.to === "RESTORED") await o.custody.complete(restore.operationId, proof.evidenceSha256);
    else need(restore.evidenceSha256 === proof.evidenceSha256, "POSTGRES_RESTORE_RECEIPT_CHANGED");
    const stateFile = join(c.operationDir, "scratch-state.json");
    await writeFile(stateFile, JSON.stringify({ schemaVersion: "1.0.0", phase: "MIGRATION_RETAINED", scratchName: o.scratchName,
      scratchOid: c.checkpoint.scratchOid, targetRef: c.binding.targetRef }), { mode: 0o600, flag: "wx" });
    return { complete: true, phase: "RESTORED", nextAction: "VERIFY_TRANSFER", operationDir: c.operationDir,
      stateFile, scratchName: o.scratchName, scratchOid: c.checkpoint.scratchOid, archive: c.manifest, parity, evidence, ...proof };
  } catch (error) {
    return { complete: false, status: "INCOMPLETE", code: postgresCopyReconcileDiagnostic(error) };
  }
}
