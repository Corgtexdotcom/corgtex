// Run through tsx: the existing object-transfer implementation is TypeScript.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { archiveEvidenceHash, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { createOpsCoreAzureTarget, opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { assertOpsCoreSourceFenced } from "./ops-core-source-controller.mjs";
import { runOpsCorePostgresCopy, resumeOpsCorePostgresCopy } from "./ops-core-postgres-copy.mjs";
import { applyPostgresPromotion, preparePostgresPromotion, reconcilePostgresPromotion, postgresPromotionDurableRecord } from "./ops-core-postgres-promotion.mjs";
import { openPostgresPromotionCustody } from "./ops-core-promotion-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { assertOpsCoreRedisEmpty, redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { buildRedisProbeJobDefinition, createRedisJobDispatcher } from "./ops-core-redis-job.mjs";
import { captureOpsCoreObjects, copyOpsCoreObjects, verifyOpsCoreObjects } from "./ops-core-objects.ts";
import { nodeClientConfig, observePostgresDatabase, buildObservedPostgresParityEvidence } from "./run-postgres-restore-rehearsal.mjs";

import { reconcileOpsCorePostgresCopy } from "./ops-core-postgres-reconcile.mjs";
import { validatePostgresDatabaseParity } from "./validate-postgres-restore-rehearsal.mjs";

class TransferError extends Error {}
const fail = code => { throw new TransferError(code); };
const HASH = /^[a-f0-9]{64}$/;
const same = (left, right) => archiveEvidenceHash(left) === archiveEvidenceHash(right);
const connection = config => ({ host: config.host, port: config.port, database: config.database, user: config.user });
const exact = (value, fields) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== fields.split(",").sort().join(",")) fail("TRANSFER_PLAN_INVALID");
};
const localEvidence = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });

/** Actual source/target assertions shared by copy, promotion and final cache
 * acceptance. The Redis-only hash bridge is checked against the full Azure
 * binding before projecting the narrower receipt expected by the Redis gate.
 */
export function validateOpsCoreTransferPlan(input) {
  const plan = structuredClone(input);
  if (plan?.schemaVersion !== 1 || !["core", "ops"].includes(plan.domain)
    || plan.azure?.domain !== plan.domain) fail("TRANSFER_INTENT_MISMATCH");
  exact(plan.transfer, "postgres,objects");
  exact(plan.transfer.postgres, "source,target,scratchName,targetIdentity,archiveStoreId,keyVersion,vaultName,maxArchiveBytes");
  exact(plan.transfer.objects, "sourceStoreId,targetStoreId,limits");
  exact(plan.redis, "source,target,job");
  for (const config of [plan.transfer.postgres.source, plan.transfer.postgres.target]) exact(config, "host,port,database,user");
  const expectedSource = { ...plan.source.postgres.expected.connection, user: plan.source.postgres.expected.readerRole };
  const target = plan.transfer.postgres.target;
  if (!same(plan.transfer.postgres.source, expectedSource)
    || target.host !== plan.azure.postgres.host || target.port !== 5432 || target.database !== "postgres") fail("TRANSFER_STORAGE_BINDING_MISMATCH");
  const pgPlan = plan.transfer.postgres;
  if (expectedSource.host === target.host && expectedSource.port === target.port
    || !new RegExp(`^corgtex_rehearsal_[1-9][0-9]*_[1-9][0-9]*_${plan.domain}$`).test(pgPlan.scratchName)
    || pgPlan.scratchName.length > 63 || !/^[a-zA-Z0-9_-]{1,128}$/.test(pgPlan.targetIdentity)
    || !Number.isSafeInteger(pgPlan.maxArchiveBytes) || pgPlan.maxArchiveBytes < 1) fail("TRANSFER_PLAN_INVALID");
  validateArchiveKeyVersion(pgPlan.keyVersion, pgPlan.vaultName);
  const limits = plan.transfer.objects.limits;
  if (!limits || ["maxPages", "maxObjectBytes", "maxTotalBytes"].some(name => !Number.isSafeInteger(limits[name]) || limits[name] < 1)
    || !Number.isSafeInteger(limits.maxObjects) || limits.maxObjects < 0 || limits.maxObjects > 10_000) fail("TRANSFER_PLAN_INVALID");
  const sourceRedisHash = redisGateBindingSha256(plan.redis.source);
  const targetRedisHash = redisGateBindingSha256(plan.redis.target);
  if (!HASH.test(sourceRedisHash) || plan.redis.target.mode !== "azure-enterprise-proxy"
    || plan.redis.target.resourceId !== plan.azure.redis.databaseId
    || plan.redis.target.connection.host !== plan.azure.redis.host
    || plan.redis.target.connection.port !== plan.azure.redis.port
    || !same(plan.redis.job.target, plan.redis.target)
    || plan.redis.job.environmentResourceId !== plan.azure.environmentId) fail("TRANSFER_REDIS_BINDING_MISMATCH");
  // Reject an invalid pinned probe definition before creating any archive or DB.
  buildRedisProbeJobDefinition(plan.redis.job);
  opsCoreAzureTargetBindingSha256(plan.azure);
  return plan;
}

export function createOpsCoreTransferContext(options) {
  const { custody } = options;
  const plan = validateOpsCoreTransferPlan(options.plan);
  const initial = custody.snapshot();
  if (initial.domain !== plan.domain || initial.intentSha256 !== archiveEvidenceHash(plan)) fail("TRANSFER_INTENT_MISMATCH");
  if (!same(connection(options.sourceCredentials.readerConfig), plan.transfer.postgres.source)
    || !same(connection(options.targetAdminConfig), plan.transfer.postgres.target)
    || options.targetAdminConfig.sslmode !== "verify-full"
    || plan.transfer.postgres.archiveStoreId !== options.archiveStore.identity
    || plan.transfer.objects.sourceStoreId !== options.objectSource.identity
    || plan.transfer.objects.targetStoreId !== options.objectTarget.identity
    || options.objectSource.identity === options.objectTarget.identity
    || options.archiveStore.identity === options.objectTarget.identity) fail("TRANSFER_STORAGE_BINDING_MISMATCH");
  const targetRedisHash = redisGateBindingSha256(plan.redis.target);
  const azureHash = opsCoreAzureTargetBindingSha256(plan.azure);
  const azure = createOpsCoreAzureTarget({ binding: plan.azure, custody,
    ...(options.azureTransport ? { transport: options.azureTransport } : {}) });
  const check = async () => {
    custody.signal.throwIfAborted(); await custody.assertOwned(); custody.signal.throwIfAborted();
    const current = custody.snapshot();
    if (current.domain !== plan.domain || current.intentSha256 !== initial.intentSha256 || current.destinationMayHaveWritten) {
      fail("TRANSFER_CUSTODY_CHANGED");
    }
  };
  const sourceFence = () => {
    const value = custody.snapshot().history.find(entry => entry.phase === "SOURCE_FENCED")?.evidenceSha256;
    if (!HASH.test(value)) fail("TRANSFER_SOURCE_FENCE_MISSING");
    return value;
  };
  const assertSourceFenced = async () => {
    await check();
    const evidence = await assertOpsCoreSourceFenced({ ...options.sourceCredentials,
      plan, custody, ...(options.railway ? { railway: options.railway } : {}) });
    if (evidence.domain !== plan.domain || evidence.intentSha256 !== initial.intentSha256
      || evidence.railway?.complete !== true) fail("TRANSFER_SOURCE_UNPROVEN");
    await check();
    return { complete: true, domain: plan.domain, intentSha256: initial.intentSha256,
      sourceFenceSha256: sourceFence(), evidenceSha256: archiveEvidenceHash(evidence) };
  };
  const assertTargetInactive = async () => {
    await check(); const evidence = await azure.assertInactive(); await check();
    if (evidence.complete !== true || evidence.domain !== plan.domain
      || evidence.intentSha256 !== initial.intentSha256 || evidence.targetBindingSha256 !== azureHash) fail("TRANSFER_TARGET_UNPROVEN");
    return evidence;
  };
  const assertRedisTargetInactive = async () => {
    const evidence = await assertTargetInactive();
    return { ...evidence, azureTargetBindingSha256: evidence.targetBindingSha256, targetBindingSha256: targetRedisHash };
  };
  return { plan, azure, check, sourceFence, assertSourceFenced, assertTargetInactive, assertRedisTargetInactive };
}

function copyOptions(options, context) {
  const config = context.plan.transfer.postgres;
  return { domain: context.plan.domain, sourceConfig: options.sourceCredentials.readerConfig,
    targetAdminConfig: options.targetAdminConfig, expectedSource: config.source, expectedTarget: config.target,
    scratchName: config.scratchName, artifactDir: options.artifactDir, dockerNetwork: options.dockerNetwork ?? null,
    custody: options.custody, operationStore: options.operationStore,
    assertSourceFenced: context.assertSourceFenced, assertTargetInactive: context.assertTargetInactive,
    archiveStore: options.archiveStore, keyVersion: config.keyVersion, vaultName: config.vaultName,
    maxArchiveBytes: config.maxArchiveBytes, resolveKey: options.resolveArchiveKey };
}

/** Fresh transfer starts only SOURCE_FENCED. Explicit resume may dispatch the
 * first, unattempted restore/verification; reconciliation never repeats restore,
 * object writes or ALTER. Redis probes are observational jobs with durable starts. */
export const runOpsCoreDataTransfer = options => transfer(options, "start");
export const resumeOpsCoreDataTransfer = options => transfer(options, "resume");
export const reconcileOpsCoreDataTransfer = options => transfer(options, "reconcile");

async function transfer(options, mode) {
  let client;
  try {
    const context = createOpsCoreTransferContext(options);
    const { custody, operationStore } = options;
    const { plan, check, assertSourceFenced, assertTargetInactive } = context;
    const initial = custody.snapshot(), config = plan.transfer.postgres;
    const reconcilingVerification = mode === "reconcile" && initial.phase === "RESTORED" && initial.pending?.to === "VERIFIED";
    if (mode === "start" && (initial.phase !== "SOURCE_FENCED" || initial.pending)
      || mode === "resume" && (initial.pending || !["CAPTURED", "RESTORED"].includes(initial.phase))) fail("TRANSFER_RECONCILIATION_REQUIRED");
    await check();
    if (mode === "reconcile" && initial.phase === "VERIFIED" && !initial.pending) {
      const entry = initial.history.find(e => e.phase === "VERIFIED");
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry?.operationId)
        || !HASH.test(entry.evidenceSha256) || !HASH.test(entry.intentSha256)) fail("TRANSFER_COMPLETED_LINEAGE_MISSING");
      await operationStore.assertPrivate();
      const prefix = `operations/${plan.domain}/${initial.intentSha256}/${entry.operationId}/`;
      const text = await operationStore.readOptional(`${prefix}phase-evidence-${entry.evidenceSha256}.json`, custody.signal);
      const retainedPlan = await operationStore.readOptional(`${prefix}phase-plan.json`, custody.signal); await check();
      const evidence = typeof text === "string" ? JSON.parse(text) : null;
      const phasePlan = typeof retainedPlan === "string" ? JSON.parse(retainedPlan) : null;
      if (!same(custody.snapshot(), initial) || !evidence || archiveEvidenceHash(evidence) !== entry.evidenceSha256
        || evidence.domain !== plan.domain || evidence.intentSha256 !== initial.intentSha256
        || phasePlan?.intentSha256 !== initial.intentSha256 || phasePlan?.promotion?.sha256 !== entry.intentSha256
        || phasePlan?.azureTargetBindingSha256 !== opsCoreAzureTargetBindingSha256(plan.azure)) fail("TRANSFER_COMPLETED_EVIDENCE_CHANGED");
      return { status: "VERIFIED", historical: true, freshAcceptance: false, evidenceSha256: entry.evidenceSha256, evidence };
    }
    await assertSourceFenced(); await assertTargetInactive();
    if (mode === "reconcile" && !reconcilingVerification) {
      if (!["CAPTURED", "RESTORED"].includes(initial.pending?.to ?? initial.phase)) fail("TRANSFER_RECONCILIATION_REQUIRED");
      return await reconcileOpsCorePostgresCopy(copyOptions(options, context));
    }
    const objectOptions = { limits: plan.transfer.objects.limits,
      assertSourceFenced: async () => { await assertSourceFenced(); await assertTargetInactive(); } };
    let copied, snapshot, intent, phase, prefix;
    const guard = async () => {
      await check();
      if (phase && (custody.snapshot().pending?.operationId !== phase.operationId
        || custody.snapshot().pending?.to !== "VERIFIED" || custody.snapshot().pending?.intentSha256 !== intent.sha256)) fail("TRANSFER_PHASE_CHANGED");
    };
    const read = async name => {
      await guard(); await operationStore.assertPrivate();
      const text = await operationStore.readOptional(`${prefix}${name}.json`, custody.signal); await guard();
      if (typeof text !== "string" || Buffer.byteLength(text) > 32 * 1024 * 1024) fail("TRANSFER_EVIDENCE_MISSING");
      return JSON.parse(text);
    };
    const retain = async (name, value) => {
      await guard(); await operationStore.assertPrivate();
      const key = `${prefix}${name}.json`, old = await operationStore.readOptional(key, custody.signal); await guard();
      if (old === null) await operationStore.createOnly(key, JSON.stringify(value), custody.signal);
      else if (!same(JSON.parse(old), value)) fail("TRANSFER_EVIDENCE_READBACK_MISMATCH");
      if (!same(await read(name), value)) fail("TRANSFER_EVIDENCE_READBACK_MISMATCH");
    };
    if (reconcilingVerification) {
      // The phase plan is independent durable lineage, never reconstructed from
      // local files or a new object inventory after an uncertain copy/promotion.
      prefix = `operations/${plan.domain}/${initial.intentSha256}/${initial.pending.operationId}/`;
      const retained = await read("phase-plan");
      exact(retained, "schemaVersion,intentSha256,promotion,archiveManifestSha256,objectSnapshotSha256,objectSnapshotEvidenceSha256,azureTargetBindingSha256,postgresCopyEvidenceSha256");
      if (retained.schemaVersion !== 2 || retained.intentSha256 !== initial.intentSha256
        || retained.azureTargetBindingSha256 !== opsCoreAzureTargetBindingSha256(plan.azure)) fail("TRANSFER_PHASE_PLAN_CHANGED");
      const copyEvidence = await read(`phase-evidence-${retained.postgresCopyEvidenceSha256}`);
      if (copyEvidence.type !== "POSTGRES_COPY_CONTEXT" || archiveEvidenceHash(copyEvidence) !== retained.postgresCopyEvidenceSha256) fail("TRANSFER_COPY_LINEAGE_CHANGED");
      copied = copyEvidence.copied; intent = retained.promotion; phase = initial.pending;
      if (intent.sha256 !== phase.intentSha256 || intent.domain !== plan.domain || !same(intent.expectedConnection, config.target)
        || intent.scratchName !== config.scratchName || intent.permanentName !== `corgtex_${plan.domain}`
        || intent.targetIdentity !== config.targetIdentity || intent.scratchOid !== copied.scratchOid
        || intent.parityEvidenceSha256 !== copied.parity.evidenceSha256
        || retained.archiveManifestSha256 !== copied.archive.sha256
        || initial.history.find(e => e.phase === "CAPTURED")?.evidenceSha256 !== copied.archive.sha256
        || !same(validatePostgresDatabaseParity(copied.evidence, { requireFrozenSourceSequences: true }), copied.parity)) fail("TRANSFER_PROMOTION_LINEAGE_CHANGED");
      const snapshotEvidence = await read(`phase-evidence-${retained.objectSnapshotEvidenceSha256}`);
      if (archiveEvidenceHash(snapshotEvidence) !== retained.objectSnapshotEvidenceSha256 || snapshotEvidence.type !== "OBJECT_SNAPSHOT"
        || snapshotEvidence.snapshot?.sha256 !== retained.objectSnapshotSha256) fail("TRANSFER_OBJECT_LINEAGE_CHANGED");
      snapshot = snapshotEvidence.snapshot;
      if (snapshot.databaseSnapshotSha256 !== copied.archive.sha256 || snapshot.sourceFenceSha256 !== context.sourceFence()) fail("TRANSFER_OBJECT_LINEAGE_CHANGED");
      // Require the original durable restore receipt and its exact completed
      // journal operation, including full evidence, before reading promoted data.
      const restore = initial.history.find(e => e.phase === "RESTORED");
      const evidencePrefix = `operations/${plan.domain}/${initial.intentSha256}/${restore?.operationId}/phase-evidence-`;
      if (typeof copied.evidenceKey !== "string" || !copied.evidenceKey.startsWith(evidencePrefix)
        || !/^[a-f0-9]{64}\.json$/.test(copied.evidenceKey.slice(evidencePrefix.length))
        || copied.evidenceSha256 !== restore.evidenceSha256
        || archiveEvidenceHash({ parity: copied.parity, archiveManifestSha256: copied.archive.sha256 }) !== restore.evidenceSha256) fail("TRANSFER_RESTORE_LINEAGE_CHANGED");
      const text = await operationStore.readOptional(copied.evidenceKey, custody.signal); await guard();
      const proof = typeof text === "string" ? JSON.parse(text) : null;
      if (!proof || archiveEvidenceHash(proof) !== copied.evidenceKey.slice(evidencePrefix.length, -5)
        || proof.type !== "POSTGRES_COPY_PARITY" || proof.restoreOperationId !== restore.operationId
        || proof.restoreIntentSha256 !== restore.intentSha256 || proof.scratchOid !== copied.scratchOid
        || proof.archiveManifestSha256 !== copied.archive.sha256 || !same(proof.evidence, copied.evidence)
        || !same(proof.parity, copied.parity)) fail("TRANSFER_RESTORE_LINEAGE_CHANGED");
      if (!same(await read("promotion-intent"), postgresPromotionDurableRecord(intent))) fail("TRANSFER_PROMOTION_INTENT_MISSING");
    } else {
      copied = mode === "start" ? await runOpsCorePostgresCopy(copyOptions(options, context))
        : initial.phase === "CAPTURED" ? await resumeOpsCorePostgresCopy(copyOptions(options, context))
          : await reconcileOpsCorePostgresCopy(copyOptions(options, context));
      if (copied.complete === false) return copied;
      await localEvidence(join(copied.operationDir, "transfer-postgres.json"), copied); await check();
      if (custody.snapshot().phase !== "RESTORED" || custody.snapshot().pending
        || !HASH.test(copied.parity?.evidenceSha256) || copied.parity.sourceSequenceParity !== "VERIFIED"
        || !copied.evidenceKey || !HASH.test(copied.evidenceSha256)) fail("TRANSFER_RESTORE_UNPROVEN");
      snapshot = await captureOpsCoreObjects(options.objectSource, { databaseSnapshotSha256: copied.archive.sha256,
        sourceFenceSha256: context.sourceFence() }, objectOptions);
      await localEvidence(join(copied.operationDir, "transfer-object-snapshot.json"), snapshot);
    }
    client = new pg.Client(nodeClientConfig(options.targetAdminConfig, `corgtex_${plan.domain}_promotion`));
    await client.connect(); await guard();
    if (!reconcilingVerification) {
      const found = await client.query("SELECT oid::text AS oid FROM pg_database WHERE datname=$1", [copied.scratchName]);
      if (found.rows.length !== 1 || found.rows[0].oid !== copied.scratchOid) fail("TRANSFER_SCRATCH_IDENTITY_UNPROVEN");
      intent = await preparePostgresPromotion({ client, expectedConnection: config.target, domain: plan.domain,
        scratchName: copied.scratchName, scratchOid: copied.scratchOid, permanentName: `corgtex_${plan.domain}`,
        targetIdentity: config.targetIdentity, parityEvidenceSha256: copied.parity.evidenceSha256 });
      await localEvidence(join(copied.operationDir, "transfer-promotion-intent.json"), intent);
      await assertSourceFenced(); await assertTargetInactive(); phase = await custody.begin("VERIFIED", intent.sha256);
      prefix = `operations/${plan.domain}/${initial.intentSha256}/${phase.operationId}/`;
      const snapshotEvidence = { type: "OBJECT_SNAPSHOT", snapshot }, snapshotHash = archiveEvidenceHash(snapshotEvidence);
      const copyEvidence = { type: "POSTGRES_COPY_CONTEXT", copied }, copyHash = archiveEvidenceHash(copyEvidence);
      const phasePlan = { schemaVersion: 2, intentSha256: initial.intentSha256, promotion: intent,
        archiveManifestSha256: copied.archive.sha256, objectSnapshotSha256: snapshot.sha256,
        objectSnapshotEvidenceSha256: snapshotHash, azureTargetBindingSha256: opsCoreAzureTargetBindingSha256(plan.azure),
        postgresCopyEvidenceSha256: copyHash };
      await retain(`phase-evidence-${copyHash}`, copyEvidence);
      await retain("phase-plan", phasePlan); await retain(`phase-evidence-${snapshotHash}`, snapshotEvidence);
    }
    const objects = reconcilingVerification
      ? await verifyOpsCoreObjects(options.objectSource, options.objectTarget, snapshot, objectOptions)
      : await copyOpsCoreObjects(options.objectSource, options.objectTarget, snapshot,
        `ops-core-${plan.domain}-${initial.intentSha256.slice(0, 32)}`, objectOptions);
    let promotion, parity = copied.parity, parityEvidence = copied.evidence;
    if (reconcilingVerification) {
      await assertSourceFenced(); await assertTargetInactive();
      const promoted = await reconcilePostgresPromotion({ client, intent });
      if (promoted.status !== "PROMOTED" || promoted.connectionCount !== 0) fail("TRANSFER_PROMOTION_UNPROVEN");
      // These read-only observations export snapshots and compare full rows,
      // schema, queues, migrations, large objects and sequence state. They do not
      // replay archive sequence values or rely on an old parity result.
      await mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
      const operationDir = await mkdtemp(join(resolve(options.artifactDir), `${phase.operationId}-verify-`));
      const observe = async (config, name) => { const tempDir = join(operationDir, name); await mkdir(tempDir, { mode: 0o700 });
        return observePostgresDatabase({ config, tempDir, dockerNetwork: options.dockerNetwork ?? null, signal: custody.signal,
          assertCustody: async () => { await guard(); await assertSourceFenced(); await assertTargetInactive(); } }); };
      const source = await observe(options.sourceCredentials.readerConfig, "source");
      if (!same(source.evidence, copied.evidence.source) || !same(source.sequences, copied.evidence.frozenSourceSequences)) fail("TRANSFER_FROZEN_SOURCE_CHANGED");
      const destination = await observe({ ...options.targetAdminConfig, database: intent.permanentName }, "destination");
      if (destination.databaseOid !== intent.scratchOid) fail("TRANSFER_PERMANENT_IDENTITY_CHANGED");
      parityEvidence = buildObservedPostgresParityEvidence({ domain: plan.domain, sourceRef: copied.evidence.sourceRef,
        targetRef: copied.evidence.targetRef, source, destination, tocEntryCount: copied.evidence.archiveSequences.tocEntryCount });
      parity = validatePostgresDatabaseParity(parityEvidence, { requireFrozenSourceSequences: true });
      await guard(); await assertSourceFenced(); await assertTargetInactive();
      const final = await reconcilePostgresPromotion({ client, intent });
      if (final.status !== "PROMOTED" || final.connectionCount !== 0) fail("TRANSFER_PROMOTION_UNPROVEN");
      const record = { schemaVersion: 1, intentSha256: intent.sha256, scratchOid: intent.scratchOid,
        targetIdentity: intent.targetIdentity, status: "PROMOTED", connectionCount: 0 };
      await retain("promotion-receipt", record); promotion = { record, sha256: archiveEvidenceHash(record) };
      copied = { ...copied, operationDir };
    } else {
      const promotionCustody = await openPostgresPromotionCustody({ custody, store: operationStore,
        stateFile: copied.stateFile, intent, assertSourceFenced, assertTargetInactive });
      promotion = await promotionCustody.recordResult(await applyPostgresPromotion({ client, intent, ...promotionCustody }));
    }
    const operations = await openProviderOperationRecorder({ custody, store: operationStore, phase: "VERIFIED", signal: custody.signal });
    const dispatcher = createRedisJobDispatcher({ plan: plan.redis.job, custody, operations, descriptorStore: operationStore,
      assertSourceFenced, assertTargetInactive: context.assertRedisTargetInactive, assertEnterpriseBinding: context.azure.assertEnterpriseBinding,
      ...(options.redisJobTransport ? { transport: options.redisJobTransport } : {}) });
    await dispatcher.prepare();
    const redis = await assertOpsCoreRedisEmpty({ source: plan.redis.source, target: plan.redis.target,
      sourceCredentials: options.redisSourceCredentials, custody, assertSourceFenced,
      assertTargetInactive: context.assertRedisTargetInactive, assertEnterpriseBinding: context.azure.assertEnterpriseBinding,
      remoteTarget: { identity: dispatcher.identity, runProbe: dispatcher.runProbe }, remoteTimeoutMs: 300_000 });
    if (redis.status !== "REDIS_EMPTY_ACCEPTED" || redis.domain !== plan.domain
      || redis.intentSha256 !== initial.intentSha256 || redis.sourceFenceSha256 !== context.sourceFence()) fail("TRANSFER_REDIS_UNPROVEN");
    if (reconcilingVerification) {
      await assertSourceFenced(); await assertTargetInactive();
      const final = await reconcilePostgresPromotion({ client, intent });
      if (final.status !== "PROMOTED" || final.connectionCount !== 0) fail("TRANSFER_PROMOTION_UNPROVEN");
    }
    const evidence = { schemaVersion: 1, domain: plan.domain, intentSha256: initial.intentSha256,
      archiveManifestSha256: copied.archive.sha256, parity, parityEvidence, objects, promotion, redis,
      sourceFence: await assertSourceFenced(), target: await assertTargetInactive() };
    const digest = archiveEvidenceHash(evidence); await retain(`phase-evidence-${digest}`, evidence);
    await localEvidence(join(copied.operationDir, "transfer-verification.json"), evidence);
    await guard(); await custody.complete(phase.operationId, digest);
    return { status: "VERIFIED", evidenceSha256: digest, evidence, operationDir: copied.operationDir };
  } catch (error) {
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_RECONCILIATION_REQUIRED");
  } finally { await client?.end().catch(() => {}); }
}
