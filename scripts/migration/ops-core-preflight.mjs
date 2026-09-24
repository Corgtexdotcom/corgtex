import pg from "pg";
import { opsCorePlanSharedStateVariant } from "./ops-core-plan-variant.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { archiveEvidenceHash, readArchiveKeyVersion } from "./ops-core-archive.mjs";
import { createOpsCoreTransferContext } from "./ops-core-transfer-controller.mjs";
import { preflightRedisJob } from "./ops-core-redis-job.mjs";
import { preflightHealthJob } from "./ops-core-health-job.mjs";
import { preflightOpsCorePostgresSource } from "./ops-core-postgres-fence.mjs";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";

class PreflightError extends Error {}
const need = (value, code) => { if (!value) throw new PreflightError(code); };
export const opsCorePreflightDiagnostic = error => error instanceof PreflightError ? error.message : null;

/** Actual TLS authentication and read-only SQL, without creating a database or
 * changing target settings. Later restore and promotion retain their own guards. */
export async function preflightTargetPostgres({ config, expected, signal, assertOwned,
  clientFactory = value => new pg.Client(value) }) {
  let client;
  const check = async () => { signal.throwIfAborted(); await assertOwned(); signal.throwIfAborted(); };
  const abort = () => { void client?.end().catch(() => {}); };
  try {
    need(config?.sslmode === "verify-full" && expected?.database === "postgres"
      && ["host", "port", "database", "user"].every(key => config[key] === expected[key]), "PREFLIGHT_POSTGRES_BINDING_INVALID");
    await check();
    client = clientFactory(nodeClientConfig(config, "corgtex_migration_preflight", 15_000, 20_000));
    signal.addEventListener("abort", abort, { once: true });
    await client.connect(); await check();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const readOnly = await client.query("SHOW transaction_read_only");
    need(readOnly.rows?.[0]?.transaction_read_only === "on", "PREFLIGHT_POSTGRES_READ_ONLY_UNPROVEN");
    const result = await client.query(`SELECT current_database() AS database, current_user AS role,
      current_setting('server_version_num')::int AS version, pg_is_in_recovery() AS recovering,
      (SELECT rolcreatedb OR rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS can_create_database`);
    const row = result.rows?.[0];
    need(result.rows?.length === 1 && row.database === expected.database && row.role === expected.user
      && Number.isInteger(row.version) && Math.floor(row.version / 10000) === 18 && row.recovering === false
      && row.can_create_database === true, "PREFLIGHT_POSTGRES_IDENTITY_UNPROVEN");
    await client.query("ROLLBACK"); await check();
    return { connectionSha256: archiveEvidenceHash(expected), major: 18, tlsVerified: true, readOnly: true, canCreateDatabase: true };
  } catch (error) { throw error instanceof PreflightError ? error : new PreflightError("PREFLIGHT_POSTGRES_UNAVAILABLE"); }
  finally { signal.removeEventListener("abort", abort); await client?.end().catch(() => {}); }
}

async function preflightSourceObjects(source, limits, check) {
  await check(); const inventory = await source.inventory(limits); await check();
  need(Array.isArray(inventory) && inventory.length <= limits.maxObjects, "PREFLIGHT_OBJECT_INVENTORY_INVALID");
  let total = 0;
  for (const entry of inventory) {
    need(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= limits.maxObjectBytes
      && entry.bytes <= limits.maxTotalBytes - total, "PREFLIGHT_OBJECT_LIMIT");
    const object = await source.read(entry.key, entry.etag);
    need(object && object.etag === entry.etag && object.bytes === entry.bytes, "PREFLIGHT_OBJECT_READ_UNPROVEN");
    let bytes = 0;
    const iterator = object.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next(); if (next.done) break;
        await check(); const chunk = next.value;
        need(chunk instanceof Uint8Array && chunk.byteLength <= entry.bytes - bytes, "PREFLIGHT_OBJECT_LIMIT");
        bytes += chunk.byteLength;
      }
      need(bytes === entry.bytes, "PREFLIGHT_OBJECT_READ_UNPROVEN"); total += bytes; await check();
    } finally { await iterator.return?.(); }
  }
  return { inventorySha256: archiveEvidenceHash(inventory), readObjects: inventory.length, readBytes: total, finalSnapshot: false };
}

/** Admission checks run while the source still serves. No source stop, password
 * rotation, DB creation, probe start, or target application write occurs here.
 * This proves current dependency access; it never replaces final fenced proofs. */
export async function runOpsCoreTransferPreflight(options, dependencies = {}) {
  let key;
  try {
    const context = (dependencies.contextFactory ?? createOpsCoreTransferContext)(options);
    const { plan, check, assertTargetInactive } = context, initial = options.custody.snapshot();
    need(initial.phase === "PREPARED" && (!initial.pending || initial.pending.to === "SOURCE_FENCED")
      && !initial.destinationMayHaveWritten, "PREFLIGHT_PHASE_INVALID");
    const guard = async () => {
      await check(); need(archiveEvidenceHash(options.custody.snapshot()) === archiveEvidenceHash(initial), "PREFLIGHT_CUSTODY_CHANGED");
    };
    await guard(); await assertTargetInactive();
    const sourceAdmission = initial.pending ? { fresh: false, reason: "INHERITED_FENCE_REQUIRES_OWN_RECONCILIATION" }
      : { fresh: true, proof: await (dependencies.sourcePreflight ?? preflightOpsCorePostgresSource)({
          ...plan.source.postgres, custody: options.custody, ...options.sourceCredentials }) };
    if (sourceAdmission.fresh) need(sourceAdmission.proof?.complete === true, "PREFLIGHT_SOURCE_UNPROVEN");
    await options.archiveStore.assertPrivate(); await options.objectSource.assertPrivate(); await options.objectTarget.assertPrivate();
    await guard();
    const postgres = await preflightTargetPostgres({ config: options.targetAdminConfig, expected: plan.transfer.postgres.target,
      signal: options.custody.signal, assertOwned: guard, ...(dependencies.clientFactory ? { clientFactory: dependencies.clientFactory } : {}) });
    const pgPlan = plan.transfer.postgres;
    key = await (dependencies.resolveKey ?? readArchiveKeyVersion)(pgPlan.keyVersion, pgPlan.vaultName);
    need(Buffer.isBuffer(key) && key.length === 32, "PREFLIGHT_ARCHIVE_KEY_INVALID");
    key.fill(0); key = null; await guard();
    const objects = await preflightSourceObjects(options.objectSource, plan.transfer.objects.limits, guard);
    const postgresState = opsCorePlanSharedStateVariant(plan) === "postgres";
    let redis, sharedState;
    if (postgresState) {
      // No target Redis job exists in this variant. Source Redis emptiness and
      // promoted PostgreSQL schema/state remain mandatory fenced transfer gates.
      sharedState = { backend: "postgres", targetPostgresPreflightSha256: archiveEvidenceHash(postgres),
        sourceRedisBindingSha256: redisGateBindingSha256(plan.sharedState.sourceRedis), finalAcceptance: false };
    } else {
      redis = await preflightRedisJob({ plan: plan.redis.job, signal: options.custody.signal, assertOwned: guard,
        ...(dependencies.redisTransport ? { transport: dependencies.redisTransport } : {}) });
    }
    const health = await preflightHealthJob({ plan: plan.health, signal: options.custody.signal, assertOwned: guard,
      ...(dependencies.healthTransport ? { transport: dependencies.healthTransport } : {}) });
    await assertTargetInactive(); await guard();
    const evidence = { schemaVersion: 1, type: "MIGRATION_DEPENDENCY_PREFLIGHT", domain: plan.domain,
      intentSha256: initial.intentSha256, observedAt: new Date().toISOString(), sourceAdmission, postgres, objects, health,
      ...(postgresState ? { sharedState } : { redis }),
      archiveKeyVersion: pgPlan.keyVersion, archiveKeyReadable: true, finalAcceptance: false };
    const evidenceSha256 = archiveEvidenceHash(evidence);
    const evidenceKey = `preflights/${plan.domain}/${initial.intentSha256}/${evidenceSha256}.json`;
    need(options.operationStore && typeof options.operationStore.assertPrivate === "function", "PREFLIGHT_EVIDENCE_STORE_REQUIRED");
    await options.operationStore.assertPrivate(); await guard();
    const previous = await options.operationStore.readOptional(evidenceKey, options.custody.signal);
    if (previous === null) await options.operationStore.createOnly(evidenceKey, JSON.stringify(evidence), options.custody.signal);
    const retained = await options.operationStore.readOptional(evidenceKey, options.custody.signal);
    need(typeof retained === "string" && archiveEvidenceHash(JSON.parse(retained)) === evidenceSha256, "PREFLIGHT_EVIDENCE_UNPROVEN");
    await guard();
    return { status: "PREFLIGHT_READY", complete: true, evidence, evidenceSha256, evidenceKey };
  } catch (error) { throw error instanceof PreflightError ? error : new PreflightError("MIGRATION_DEPENDENCY_PREFLIGHT_FAILED"); }
  finally { if (Buffer.isBuffer(key)) key.fill(0); }
}
