// Run through tsx: the existing object-transfer implementation is TypeScript.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { archiveEvidenceHash, validateArchiveKeyVersion } from "./ops-core-archive.mjs";
import { createOpsCoreAzureTarget, opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { assertOpsCoreSourceFenced } from "./ops-core-source-controller.mjs";
import { runOpsCorePostgresCopy } from "./ops-core-postgres-copy.mjs";
import { applyPostgresPromotion, preparePostgresPromotion } from "./ops-core-postgres-promotion.mjs";
import { openPostgresPromotionCustody } from "./ops-core-promotion-custody.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { assertOpsCoreRedisEmpty, redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { buildRedisProbeJobDefinition, createRedisJobDispatcher } from "./ops-core-redis-job.mjs";
import { captureOpsCoreObjects, copyOpsCoreObjects } from "./ops-core-objects.ts";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";

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

/** Forward-only complete data-transfer path. An interrupted capture/restore or
 * promotion leaves its archive, target and durable intent intact for explicit
 * reconciliation. This function never retries a partially completed transfer,
 * starts an app, changes routing, drops a database or advances the write boundary.
 */
export async function runOpsCoreDataTransfer(options) {
  let client;
  let context;
  try {
    context = createOpsCoreTransferContext(options);
    const { custody, operationStore } = options;
    const { plan, check, assertSourceFenced, assertTargetInactive } = context;
    const initial = custody.snapshot();
    if (initial.phase !== "SOURCE_FENCED" || initial.pending) fail("TRANSFER_RECONCILIATION_REQUIRED");
    await check(); await assertSourceFenced(); await assertTargetInactive();
    const config = plan.transfer.postgres;
    const copied = await runOpsCorePostgresCopy({ domain: plan.domain,
      sourceConfig: options.sourceCredentials.readerConfig, targetAdminConfig: options.targetAdminConfig,
      expectedSource: config.source, expectedTarget: config.target, scratchName: config.scratchName,
      artifactDir: options.artifactDir, dockerNetwork: options.dockerNetwork ?? null,
      custody, assertSourceFenced, assertTargetInactive, archiveStore: options.archiveStore,
      keyVersion: config.keyVersion, vaultName: config.vaultName, maxArchiveBytes: config.maxArchiveBytes,
      resolveKey: options.resolveArchiveKey });
    await localEvidence(join(copied.operationDir, "transfer-postgres.json"), copied);
    await check();
    if (custody.snapshot().phase !== "RESTORED" || custody.snapshot().pending
      || !HASH.test(copied.parity?.evidenceSha256) || copied.parity.sourceSequenceParity !== "VERIFIED") fail("TRANSFER_RESTORE_UNPROVEN");
    const objectOptions = { limits: plan.transfer.objects.limits,
      assertSourceFenced: async () => { await assertSourceFenced(); await assertTargetInactive(); } };
    const snapshot = await captureOpsCoreObjects(options.objectSource, {
      databaseSnapshotSha256: copied.archive.sha256, sourceFenceSha256: context.sourceFence() }, objectOptions);
    await localEvidence(join(copied.operationDir, "transfer-object-snapshot.json"), snapshot);
    client = new pg.Client(nodeClientConfig(options.targetAdminConfig, `corgtex_${plan.domain}_promotion`));
    await client.connect();
    const found = await client.query("SELECT oid::text AS oid FROM pg_database WHERE datname=$1", [copied.scratchName]);
    if (found.rows.length !== 1) fail("TRANSFER_SCRATCH_IDENTITY_UNPROVEN");
    const intent = await preparePostgresPromotion({ client, expectedConnection: config.target,
      domain: plan.domain, scratchName: copied.scratchName, scratchOid: found.rows[0].oid,
      permanentName: `corgtex_${plan.domain}`, targetIdentity: config.targetIdentity,
      parityEvidenceSha256: copied.parity.evidenceSha256 });
    await localEvidence(join(copied.operationDir, "transfer-promotion-intent.json"), intent);
    await assertSourceFenced(); await assertTargetInactive();
    const phase = await custody.begin("VERIFIED", intent.sha256);
    const prefix = `operations/${plan.domain}/${initial.intentSha256}/${phase.operationId}/`;
    const retain = async (name, value, expectedDigest) => {
      await check(); await operationStore.assertPrivate();
      const key = `${prefix}${name}.json`;
      const text = JSON.stringify(value);
      await operationStore.createOnly(key, text, custody.signal);
      await check();
      const retained = await operationStore.readOptional(key, custody.signal);
      if (retained === null || archiveEvidenceHash(JSON.parse(retained)) !== expectedDigest) fail("TRANSFER_EVIDENCE_READBACK_MISMATCH");
      await check();
    };
    const phasePlan = { schemaVersion: 1, intentSha256: initial.intentSha256, promotion: intent,
      archiveManifestSha256: copied.archive.sha256, objectSnapshotSha256: snapshot.sha256,
      azureTargetBindingSha256: opsCoreAzureTargetBindingSha256(plan.azure) };
    await retain("phase-plan", phasePlan, archiveEvidenceHash(phasePlan));
    // Full private object evidence is retained before any destination object write.
    const snapshotEvidence = { type: "OBJECT_SNAPSHOT", snapshot };
    const snapshotHash = archiveEvidenceHash(snapshotEvidence);
    await retain(`phase-evidence-${snapshotHash}`, snapshotEvidence, snapshotHash);
    const objects = await copyOpsCoreObjects(options.objectSource, options.objectTarget, snapshot,
      `ops-core-${plan.domain}-${initial.intentSha256.slice(0, 32)}`, objectOptions);
    const promotionCustody = await openPostgresPromotionCustody({ custody, store: operationStore,
      stateFile: copied.stateFile, intent, assertSourceFenced, assertTargetInactive });
    const promoted = await applyPostgresPromotion({ client, intent, ...promotionCustody });
    const promotion = await promotionCustody.recordResult(promoted);
    const operations = await openProviderOperationRecorder({ custody, store: operationStore,
      phase: "VERIFIED", signal: custody.signal });
    const dispatcher = createRedisJobDispatcher({ plan: plan.redis.job, custody, operations,
      descriptorStore: operationStore, assertSourceFenced, assertTargetInactive: context.assertRedisTargetInactive,
      assertEnterpriseBinding: context.azure.assertEnterpriseBinding,
      ...(options.redisJobTransport ? { transport: options.redisJobTransport } : {}) });
    await dispatcher.prepare();
    const redis = await assertOpsCoreRedisEmpty({ source: plan.redis.source, target: plan.redis.target,
      sourceCredentials: options.redisSourceCredentials, custody, assertSourceFenced,
      assertTargetInactive: context.assertRedisTargetInactive, assertEnterpriseBinding: context.azure.assertEnterpriseBinding,
      remoteTarget: { identity: dispatcher.identity, runProbe: dispatcher.runProbe }, remoteTimeoutMs: 300_000 });
    if (redis.status !== "REDIS_EMPTY_ACCEPTED" || redis.domain !== plan.domain
      || redis.intentSha256 !== initial.intentSha256 || redis.sourceFenceSha256 !== context.sourceFence()) fail("TRANSFER_REDIS_UNPROVEN");
    const evidence = { schemaVersion: 1, domain: plan.domain, intentSha256: initial.intentSha256,
      archiveManifestSha256: copied.archive.sha256, parity: copied.parity, objects, promotion, redis,
      sourceFence: await assertSourceFenced(), target: await assertTargetInactive() };
    const digest = archiveEvidenceHash(evidence);
    await retain(`phase-evidence-${digest}`, evidence, digest);
    await localEvidence(join(copied.operationDir, "transfer-verification.json"), evidence);
    await check(); await custody.complete(phase.operationId, digest);
    return { status: "VERIFIED", evidenceSha256: digest, evidence, operationDir: copied.operationDir };
  } catch (error) {
    throw error instanceof TransferError ? error : new TransferError("TRANSFER_RECONCILIATION_REQUIRED");
  } finally { await client?.end().catch(() => {}); }
}
