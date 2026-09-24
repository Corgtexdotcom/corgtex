import pg from "pg";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";
import { preparePostgresRuntimeAccess, applyPostgresRuntimeAccess, reconcilePostgresRuntimeAccess,
  preparePostgresRuntimeAccessPreflight, validatePostgresRuntimeAccessIntent } from "./ops-core-postgres-runtime-access.mjs";

const HASH = /^[a-f0-9]{64}$/;
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need = (value, code) => { if (!value) throw new Error(code); };
const same = (a, b) => archiveEvidenceHash(a) === archiveEvidenceHash(b);

/** Fixed-version reads only. The result is consumed in memory by the SQL
 * adapter; neither values nor driver diagnostics enter migration evidence. */
export function createRuntimeSecretResolver({ vaultUri, signal, secretClient }) {
  const client = secretClient ?? new SecretClient(vaultUri,
    new AzureCliCredential({ processTimeoutInMs: 10_000 }), { retryOptions: { maxRetries: 0 } });
  return async reference => {
    try {
      need(typeof reference === "string" && reference.startsWith(`${vaultUri}secrets/`), "RUNTIME_ACCESS_SECRET_INVALID");
      const suffix = reference.slice(`${vaultUri}secrets/`.length);
      need(/^[a-zA-Z0-9-]{1,127}\/[a-f0-9]{32}$/.test(suffix), "RUNTIME_ACCESS_SECRET_INVALID");
      const [name, version] = suffix.split("/"); signal.throwIfAborted();
      const found = await client.getSecret(name, { version, abortSignal: signal }); signal.throwIfAborted();
      need(found?.properties?.id === reference && found.properties.version === version
        && found.properties.enabled !== false && typeof found.value === "string" && found.value.length > 0
        && (!found.properties.expiresOn || found.properties.expiresOn.getTime() > Date.now())
        && (!found.properties.notBefore || found.properties.notBefore.getTime() <= Date.now()), "RUNTIME_ACCESS_SECRET_UNAVAILABLE");
      return found.value;
    } catch { throw new Error("RUNTIME_ACCESS_SECRET_UNAVAILABLE"); }
  };
}

function accessPlan(plan, snapshot, phase, databaseOid) {
  return { schemaVersion: 1, domain: plan.domain, intentSha256: snapshot.intentSha256,
    operationId: phase.operationId, serverResourceId: plan.azure.postgres.resourceId,
    host: plan.transfer.postgres.target.host, port: plan.transfer.postgres.target.port,
    database: `corgtex_${plan.domain}`, databaseOid, administrator: plan.transfer.postgres.target.user,
    runtimeVaultUri: plan.activation.runtimeVaultUri, policy: plan.transfer.postgres.runtimeAccess };
}

async function withAccessClient(options, work) {
  const { plan, custody, targetAdminConfig, assertOwned, database } = options;
  let maintenance, client;
  try {
    maintenance = options.maintenance ?? await openPostgresMaintenance({ config: targetAdminConfig, expected: plan.transfer.postgres.target,
      signal: custody.signal, assertOwned,
      ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}) });
    const config = nodeClientConfig({ ...targetAdminConfig, database }, "corgtex_runtime_access", 15_000, 30_000);
    client = options.clientFactory ? options.clientFactory(config) : new pg.Client(config);
    const stop = () => { void client.end().catch(() => {}); };
    maintenance.signal.addEventListener("abort", stop, { once: true });
    try { await client.connect(); return await work({ client, signal: maintenance.signal, assertHeld: maintenance.assertHeld }); }
    finally { maintenance.signal.removeEventListener("abort", stop); }
  } finally { await client?.end().catch(() => {}); if (!options.maintenance) await maintenance?.close(); }
}

function records({ operationStore, prefix, signal, check }) {
  async function read(name) {
    await check(); await operationStore.assertPrivate();
    const text = await operationStore.readOptional(`${prefix}${name}.json`, signal); await check();
    if (text === null) return null;
    need(typeof text === "string" && Buffer.byteLength(text) <= 32 * 1024 * 1024, "RUNTIME_ACCESS_RECORD_INVALID");
    return JSON.parse(text);
  }
  async function retain(name, value) {
    const old = await read(name);
    if (old === null) { await check(); await operationStore.createOnly(`${prefix}${name}.json`, JSON.stringify(value), signal); }
    else need(same(old, value), "RUNTIME_ACCESS_RECORD_CHANGED");
    need(same(await read(name), value), "RUNTIME_ACCESS_RECORD_UNPROVEN");
  }
  return { read, retain, readRecords: async () => ({ intent: await read("runtime-access-intent"),
    expectedAfter: await read("runtime-access-expected-after") }) };
}

export async function runOpsCoreRuntimeAccess(options) {
  const { plan, custody, operationStore, phase, databaseOid, assertSourceFenced, assertTargetInactive, reconcile = false } = options;
  need(plan.transfer.postgres.runtimeAccess && phase?.to === "VERIFIED" && GUID.test(phase.operationId), "RUNTIME_ACCESS_PHASE_INVALID");
  const snapshot = custody.snapshot();
  const check = async () => {
    custody.signal.throwIfAborted(); await custody.assertOwned();
    const current = custody.snapshot();
    need(current.domain === plan.domain && current.intentSha256 === snapshot.intentSha256
      && current.pending?.operationId === phase.operationId && current.pending.to === "VERIFIED"
      && !current.destinationMayHaveWritten, "RUNTIME_ACCESS_CUSTODY_CHANGED");
  };
  await check();
  const expected = accessPlan(plan, snapshot, phase, databaseOid);
  const prefix = `operations/${plan.domain}/${snapshot.intentSha256}/${phase.operationId}/`;
  const store = records({ operationStore, prefix, signal: custody.signal, check });
  return withAccessClient({ ...options, database: expected.database, assertOwned: check }, async guards => {
    const common = { ...guards, resolveSecretVersion: options.resolveSecretVersion, assertSourceFenced, assertTargetInactive };
    let intent = await store.read("runtime-access-intent");
    const inherited = intent !== null;
    if (intent === null) {
      if (reconcile) return { complete: false, status: "CONTINUATION_AVAILABLE", domain: plan.domain,
        phase: "RESTORED", nextAction: "resume-transfer" };
      intent = await preparePostgresRuntimeAccess({ ...common, plan: expected });
    }
    need(same(intent.plan, expected), "RUNTIME_ACCESS_INTENT_CHANGED");
    const operation = { ...common, intent, readRecords: store.readRecords };
    const result = reconcile || inherited ? await reconcilePostgresRuntimeAccess(operation)
      : await applyPostgresRuntimeAccess({ ...operation,
        persistIntent: value => store.retain("runtime-access-intent", value),
        persistExpectedAfter: value => store.retain("runtime-access-expected-after", value) });
    need(result.status === "APPLIED", "RUNTIME_ACCESS_RECONCILIATION_REQUIRED");
    const record = { schemaVersion: 1, domain: plan.domain, globalIntentSha256: snapshot.intentSha256,
      phaseOperationId: phase.operationId, targetBindingSha256: opsCoreAzureTargetBindingSha256(plan.azure),
      policySha256: archiveEvidenceHash(expected.policy), databaseOid, accessIntentSha256: intent.sha256,
      result };
    await store.retain("runtime-access-receipt", record);
    return { record, sha256: archiveEvidenceHash(record) };
  });
}

export async function assertOpsCoreRuntimeAccessForActivation(options) {
  const { plan, custody, operationStore, assertSourceFenced, fresh } = options;
  const policy = plan.transfer.postgres.runtimeAccess;
  need(policy, "RUNTIME_ACCESS_POLICY_REQUIRED");
  const snapshot = custody.snapshot(), entry = snapshot.history.filter(x => x.phase === "VERIFIED");
  need(entry.length === 1 && GUID.test(entry[0].operationId) && HASH.test(entry[0].evidenceSha256), "RUNTIME_ACCESS_VERIFICATION_MISSING");
  const phase = entry[0];
  const check = async () => {
    custody.signal.throwIfAborted(); await custody.assertOwned();
    const current = custody.snapshot();
    need(current.domain === plan.domain && current.intentSha256 === snapshot.intentSha256
      && same(current.history.find(x => x.phase === "VERIFIED"), phase), "RUNTIME_ACCESS_CUSTODY_CHANGED");
  };
  const prefix = `operations/${plan.domain}/${snapshot.intentSha256}/${phase.operationId}/`;
  const store = records({ operationStore, prefix, signal: custody.signal, check });
  const evidence = await store.read(`phase-evidence-${phase.evidenceSha256}`);
  const record = await store.read("runtime-access-receipt");
  const retained = await store.readRecords();
  validatePostgresRuntimeAccessIntent(retained.intent);
  need(evidence && archiveEvidenceHash(evidence) === phase.evidenceSha256 && record
    && same(evidence.runtimeAccess, { record, sha256: archiveEvidenceHash(record) })
    && record.globalIntentSha256 === snapshot.intentSha256 && record.phaseOperationId === phase.operationId
    && record.domain === plan.domain && record.targetBindingSha256 === opsCoreAzureTargetBindingSha256(plan.azure)
    && record.policySha256 === archiveEvidenceHash(policy) && record.result?.status === "APPLIED"
    && retained.intent?.sha256 === record.accessIntentSha256 && retained.expectedAfter
    && retained.expectedAfter.intentSha256 === retained.intent.sha256
    && retained.expectedAfter.manifestSha256 === archiveEvidenceHash(retained.expectedAfter.manifest)
    && retained.expectedAfter.manifestSha256 === record.result.manifestSha256,
  "RUNTIME_ACCESS_RECEIPT_UNPROVEN");
  const expected = accessPlan(plan, snapshot, phase, record.databaseOid);
  need(same(retained.intent.plan, expected), "RUNTIME_ACCESS_INTENT_CHANGED");
  if (fresh) {
    // After activation may have written, retained evidence is historical. Exact
    // pre-migration catalogs must not be compared to legitimate new migrations.
    need(!snapshot.destinationMayHaveWritten, "RUNTIME_ACCESS_ALREADY_ACTIVE");
    await withAccessClient({ ...options, database: expected.database, assertOwned: check }, async guards => {
      const result = await reconcilePostgresRuntimeAccess({ ...guards, intent: retained.intent,
        resolveSecretVersion: options.resolveSecretVersion, readRecords: store.readRecords,
        assertSourceFenced, assertTargetInactive: options.assertTargetInactive });
      need(result.status === "APPLIED" && same(result, record.result), "RUNTIME_ACCESS_FRESH_READBACK_UNPROVEN");
    });
  }
  return { complete: true, domain: plan.domain, intentSha256: snapshot.intentSha256,
    policySha256: record.policySha256, receiptSha256: archiveEvidenceHash(record), freshAcceptance: fresh };
}

export async function preflightOpsCoreRuntimeAccess(options) {
  const { plan, custody, assertOwned, assertTargetInactive } = options;
  return withAccessClient({ ...options, database: "postgres", assertOwned }, async guards => {
    await assertTargetInactive();
    return preparePostgresRuntimeAccessPreflight({ ...guards, resolveSecretVersion: options.resolveSecretVersion,
      plan: { schemaVersion: 1, domain: plan.domain, serverResourceId: plan.azure.postgres.resourceId,
        host: plan.transfer.postgres.target.host, port: plan.transfer.postgres.target.port,
        administrator: plan.transfer.postgres.target.user, runtimeVaultUri: plan.activation.runtimeVaultUri,
        policy: plan.transfer.postgres.runtimeAccess }, assertTargetInactive });
  });
}
