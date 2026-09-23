import { mkdtemp, mkdir, lstat, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { postgresRestoreErrorCode, runPostgresRestoreRehearsal, restoreRetainedPostgresArchive } from "./run-postgres-restore-rehearsal.mjs";
import { validatePostgresDatabaseParity } from "./validate-postgres-restore-rehearsal.mjs";
import { archiveEvidenceHash, postgresArchiveDiagnostic, recoverPostgresArchive, retainPostgresArchive, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { postgresCopyCaptureIntent, postgresCopyRestoreIntent, postgresCopyRecordKey, retainPostgresCopyRecord,
  prepareRetainedPostgresCopy, reconcileOpsCorePostgresCopy, retainPostgresCopyParity } from "./ops-core-postgres-reconcile.mjs";

class PostgresCopyError extends Error {
  constructor(code) { super(code); this.code = code; Object.freeze(this); }
}
const fail = (code) => { throw new PostgresCopyError(code); };
const connectionBinding = (config) => ({ host: config.host, port: config.port, database: config.database, user: config.user });
const sameBinding = (config, expected) => archiveEvidenceHash(connectionBinding(config)) === archiveEvidenceHash(expected);
const writeEvidence = (path, evidence) => writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
export function postgresCopyDiagnostic(error, stage) {
  const knownStage = ["CAPTURE", "RETAIN_ARCHIVE", "RECOVER_ARCHIVE", "RESTORE", "VALIDATE_PARITY"].includes(stage) ? stage : "UNKNOWN";
  return { stage: knownStage, ...(postgresArchiveDiagnostic(error) ?? {
    code: error instanceof PostgresCopyError ? error.code : postgresRestoreErrorCode(error) ?? "UNCLASSIFIED_FAILURE",
    operationStage: null, reason: null,
  }) };
}

/** Full retained database copy. Caller supplies verified source fencing and
 * inactive-target checks; both run at every guarded boundary. Promotion and
 * runtime grants are separate operations after this returns RESTORED evidence.
 */
export async function runOpsCorePostgresCopy({ domain, sourceConfig: suppliedSource, targetAdminConfig: suppliedTarget,
  expectedSource, expectedTarget, scratchName, artifactDir, dockerNetwork = null,
  custody, assertSourceFenced, assertTargetInactive, archiveStore, keyVersion, vaultName, maxArchiveBytes,
  resolveKey, operationStore }) {
  const sourceConfig = structuredClone(suppliedSource);
  const targetAdminConfig = structuredClone(suppliedTarget);
  const initial = custody.snapshot();
  if (!["ops", "core"].includes(domain) || initial.domain !== domain || initial.phase !== "SOURCE_FENCED" || initial.pending
    || !sameBinding(sourceConfig, expectedSource) || !sameBinding(targetAdminConfig, expectedTarget)
    || (sourceConfig.host === targetAdminConfig.host && sourceConfig.port === targetAdminConfig.port)
    || !/^corgtex_rehearsal_[a-z0-9_]+$/.test(scratchName) || scratchName.length > 63
    || targetAdminConfig.database !== "postgres" || typeof assertSourceFenced !== "function"
    || typeof assertTargetInactive !== "function" || !Number.isSafeInteger(maxArchiveBytes) || maxArchiveBytes < 1
    || !operationStore || typeof operationStore.createOnly !== "function" || typeof operationStore.readOptional !== "function") {
    fail("POSTGRES_COPY_INTENT_INVALID");
  }
  validateArchiveKeyVersion(keyVersion, vaultName);
  const signal = custody.signal;
  const assertCustody = async () => {
    signal.throwIfAborted();
    await custody.assertOwned();
    await assertSourceFenced();
    await assertTargetInactive();
    signal.throwIfAborted();
  };
  await assertCustody();
  const copyOptions = { domain, expectedSource, expectedTarget, scratchName, archiveStore, keyVersion, maxArchiveBytes, operationStore, custody };
  const captureIntent = postgresCopyCaptureIntent(copyOptions);
  const capture = await custody.begin("CAPTURED", archiveEvidenceHash(captureIntent));
  // All private files are operation-specific. Never reuse a previous interrupted
  // invocation's working directory or cleanup state as fresh ownership evidence.
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const operationDir = await mkdtemp(join(resolve(artifactDir), `${capture.operationId}-postgres-`));
  const tempDir = join(operationDir, "temporary");
  const stateFile = join(operationDir, "scratch-state.json");
  await mkdir(tempDir, { mode: 0o700 });
  await writeEvidence(join(operationDir, "copy-intent.json"), { capture, intent: captureIntent });
  let retainedArchive;
  let checkpoint;
  let restore;
  let stage = "CAPTURE";
  let checkpointDiagnostic;
  const diagnostic = (error) => postgresCopyDiagnostic(error, stage);
  try {
    const result = await runPostgresRestoreRehearsal({ domain, sourceConfig, targetAdminConfig, scratchName,
      artifactDir: operationDir, tempDir, stateFile, dockerNetwork, productionMode: true, signal, assertCustody,
      async afterScratchCreated({ scratchOid, scratchOwner, sourceRef, targetRef }) {
        if (scratchOwner !== expectedTarget.user) fail("POSTGRES_COPY_SCRATCH_OWNER_CHANGED");
        checkpoint = { type: "POSTGRES_COPY_CAPTURE", schemaVersion: 1,
          binding: { domain, operationId: capture.operationId, intentSha256: initial.intentSha256,
            sourceFenceSha256: initial.history.find(entry => entry.phase === "SOURCE_FENCED").evidenceSha256, sourceRef, targetRef },
          captureIntent, captureIntentSha256: capture.intentSha256, scratchOid, scratchOwner };
        await retainPostgresCopyRecord({ operationStore, key: postgresCopyRecordKey(domain, initial.intentSha256, capture.operationId),
          value: checkpoint, check: assertCustody, signal });
      },
      async beforeRestore({ dumpFile, sourceRef, targetRef, sourceEvidence, sourceSequences }) {
        try {
          stage = "RETAIN_ARCHIVE";
          await assertCustody();
          const binding = { domain, operationId: capture.operationId, intentSha256: initial.intentSha256,
            sourceFenceSha256: initial.history.find((entry) => entry.phase === "SOURCE_FENCED").evidenceSha256,
            sourceRef, targetRef };
          if (!checkpoint || archiveEvidenceHash(checkpoint.binding) !== archiveEvidenceHash(binding)) fail("POSTGRES_COPY_CHECKPOINT_MISSING");
          await writeEvidence(join(operationDir, "source-capture.json"), { binding, sourceEvidence, sourceSequences });
          retainedArchive = await retainPostgresArchive({ dumpFile, sourceEvidence, sourceSequences, binding,
            keyVersion, vaultName, store: archiveStore, assertOwned: assertCustody, signal,
            maxBytes: maxArchiveBytes, ...(resolveKey ? { resolveKey } : {}) });
          await writeEvidence(join(operationDir, "archive-manifest.json"), retainedArchive);
          // Actually restore the downloaded/decrypted retained archive, so the
          // recovery path is exercised before destination restoration begins.
          const recoveryPath = join(tempDir, "recovered.dump");
          stage = "RECOVER_ARCHIVE";
          const recovered = await recoverPostgresArchive({ manifest: retainedArchive, expectedBinding: binding,
            store: archiveStore, outputFile: recoveryPath, vaultName, maxBytes: maxArchiveBytes, signal,
            ...(resolveKey ? { resolveKey } : {}) });
          await writeEvidence(join(operationDir, "archive-recovery.json"), recovered);
          if (resolve(dumpFile) !== join(tempDir, "snapshot.dump")) fail("POSTGRES_COPY_DUMP_PATH_CHANGED");
          const original = await lstat(dumpFile);
          if (!original.isFile() || original.size !== recovered.bytes) fail("POSTGRES_COPY_DUMP_CHANGED");
          await assertCustody();
          await rename(recoveryPath, dumpFile);
          await custody.complete(capture.operationId, retainedArchive.sha256);
          stage = "RESTORE";
          restore = await custody.begin("RESTORED", archiveEvidenceHash(postgresCopyRestoreIntent(retainedArchive, copyOptions)));
          await retainPostgresCopyRecord({ operationStore,
            key: postgresCopyRecordKey(domain, initial.intentSha256, restore.operationId),
            value: { type: "POSTGRES_COPY_RESTORE", schemaVersion: 1, captureOperationId: capture.operationId,
              checkpointSha256: archiveEvidenceHash(checkpoint), archiveManifestSha256: retainedArchive.sha256,
              restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256 }, check: assertCustody, signal });
          await assertCustody();
        } catch (error) { checkpointDiagnostic = diagnostic(error); throw error; }
      },
    });
    if (!restore || !retainedArchive) fail("POSTGRES_COPY_ARCHIVE_MISSING");
    stage = "VALIDATE_PARITY";
    await assertCustody();
    const parity = validatePostgresDatabaseParity(result.evidence, { requireFrozenSourceSequences: true });
    await writeEvidence(join(operationDir, "database-parity.json"), parity);
    const proof = await retainPostgresCopyParity({ options: copyOptions, context: { initial, checkpoint,
      binding: checkpoint.binding, manifest: retainedArchive, check: assertCustody }, restore, evidence: result.evidence, parity });
    await custody.complete(restore.operationId, proof.evidenceSha256);
    return { operationDir, stateFile, scratchName, scratchOid: checkpoint.scratchOid, archive: retainedArchive, parity, evidence: result.evidence, ...proof };
  } catch (error) {
    // Partial targets and durable archives remain available. Neither retrying the
    // restore nor dropping/replacing a database is an automatic recovery action.
    const failureDiagnostic = checkpointDiagnostic ?? diagnostic(error);
    await writeEvidence(join(operationDir, "copy-failure.json"), failureDiagnostic).catch(() => {});
    const failure = new Error(`POSTGRES_COPY_${stage}_RECONCILIATION_REQUIRED`);
    failure.code = failure.message;
    failure.diagnostic = failureDiagnostic;
    throw failure;
  }
}

/** Explicit continuation after CAPTURED completion, before any RESTORED intent.
 * Never retries an inherited restore. The only database write is the first
 * restore into this capture's exact, still-empty scratch database.
 */
export async function resumeOpsCorePostgresCopy(options, dependencies = {}) {
  const initial = options.custody.snapshot();
  if (initial.phase !== "CAPTURED" || initial.pending || initial.destinationMayHaveWritten
    || initial.history.some(entry => entry.phase === "RESTORED")) fail("POSTGRES_COPY_RESTORE_ALREADY_ATTEMPTED");
  const c = await prepareRetainedPostgresCopy(options, dependencies);
  if (!c.scratch.empty) fail("POSTGRES_COPY_SCRATCH_NOT_EMPTY");
  await c.check();
  const restore = await options.custody.begin("RESTORED", archiveEvidenceHash(postgresCopyRestoreIntent(c.manifest, options)));
  const pending = options.custody.snapshot();
  const check = async () => {
    options.custody.signal.throwIfAborted(); await options.custody.assertOwned();
    if (archiveEvidenceHash(options.custody.snapshot()) !== archiveEvidenceHash(pending)) fail("POSTGRES_COPY_PHASE_CHANGED");
    await options.assertSourceFenced(); await options.assertTargetInactive(); options.custody.signal.throwIfAborted();
  };
  await retainPostgresCopyRecord({ operationStore: options.operationStore,
    key: postgresCopyRecordKey(options.domain, initial.intentSha256, restore.operationId),
    value: { type: "POSTGRES_COPY_RESTORE", schemaVersion: 1, captureOperationId: c.capture.operationId,
      checkpointSha256: archiveEvidenceHash(c.checkpoint), archiveManifestSha256: c.manifest.sha256,
      restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256 }, check, signal: options.custody.signal });
  const restoreArchive = dependencies.restoreArchive ?? restoreRetainedPostgresArchive;
  await restoreArchive({ targetConfig: c.targetConfig, tempDir: c.tempDir, artifactDir: c.operationDir,
    dockerNetwork: options.dockerNetwork ?? null, scratchOid: c.checkpoint.scratchOid, scratchOwner: c.checkpoint.scratchOwner,
    signal: options.custody.signal, assertCustody: check });
  await check();
  return reconcileOpsCorePostgresCopy(options, dependencies);
}
