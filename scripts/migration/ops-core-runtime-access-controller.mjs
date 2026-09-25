import pg from "pg";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { nodeClientConfig } from "./run-postgres-restore-rehearsal.mjs";
import { openPostgresMaintenance } from "./ops-core-postgres-maintenance.mjs";
import { preparePostgresRuntimeAccess, applyPostgresRuntimeAccess, reconcilePostgresRuntimeAccess,
  preparePostgresRuntimeAccessPreflight, validatePostgresRuntimeAccessIntent,
  monitorPostgresRuntimeAccessDrift } from "./ops-core-postgres-runtime-access.mjs";

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

function azureParameterReader(plan, signal, options) {
  if (plan.policy.schemaVersion !== 2) return undefined;
  if (options.readAzureParameters) return options.readAzureParameters;
  const credential = options.azureCredential ?? new AzureCliCredential({ processTimeoutInMs: 10_000 });
  return async () => {
    try {
      signal.throwIfAborted();
      const token = await credential.getToken("https://management.azure.com/.default", { abortSignal: signal });
      need(typeof token?.token === "string", "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
      const uri = `https://management.azure.com${plan.serverResourceId}/configurations?api-version=2024-08-01`;
      const parameters = []; let next = uri;
      while (next) {
        need(next === uri || next.startsWith(`https://management.azure.com${plan.serverResourceId}/configurations?`),
          "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
        const response = await fetch(next, { headers: { Authorization: `Bearer ${token.token}` }, signal });
        need(response.ok, "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
        const page = await response.json();
        need(Array.isArray(page.value) && page.value.length <= 1000, "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
        for (const row of page.value) parameters.push({ name: row.name, value: row.properties?.value });
        need(parameters.length <= 1000, "RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID");
        next = page.nextLink || null;
      }
      signal.throwIfAborted();
      return parameters;
    } catch { throw new Error("RUNTIME_ACCESS_AZURE_PARAMETER_READBACK_INVALID"); }
  };
}

const QUERY_STORE_VIEWS = Object.freeze([
  "query_store.query_texts_view", "query_store.qs_view", "query_store.query_plans_view",
  "query_store.pgms_wait_sampling_view",
]);
function azureQueryStoreInspector(plan, signal, options) {
  if (plan.policy.schemaVersion !== 2) return undefined;
  if (options.inspectAzureQueryStore) return options.inspectAzureQueryStore;
  const source = options.targetAdminConfig;
  need(source?.sslmode === "verify-full" && source.host === plan.host && Number(source.port) === plan.port
    && source.user === plan.administrator, "RUNTIME_ACCESS_AZURE_QUERY_STORE_CONNECTION_INVALID");
  return async () => {
    const config = nodeClientConfig({ ...source, database: "azure_sys" }, "corgtex_runtime_access_query_store", 10_000, 15_000);
    const client = options.clientFactory ? options.clientFactory(config) : new pg.Client(config);
    let began = false;
    try {
      signal.throwIfAborted(); await client.connect();
      need(client.connection?.stream?.encrypted === true && client.connection.stream.authorized === true
        && client.connectionParameters?.host === plan.host && Number(client.connectionParameters.port) === plan.port
        && client.connectionParameters.user === plan.administrator
        && client.connectionParameters.database === "azure_sys", "RUNTIME_ACCESS_AZURE_QUERY_STORE_CONNECTION_INVALID");
      const provider = plan.policy.isolation.databases.find(row => row.name === "azure_sys");
      need(provider?.action === "allow-provider-connect", "RUNTIME_ACCESS_PROVIDER_EXCEPTION_INVALID");
      const identity = (await client.query(`SELECT current_database() AS database,current_user AS administrator,
        session_user AS "sessionUser",current_setting('server_version_num')::int AS version,
        oid::text AS oid FROM pg_catalog.pg_database WHERE datname=current_database()`)).rows;
      need(identity.length === 1 && identity[0].database === "azure_sys" && identity[0].oid === provider.oid
        && identity[0].administrator === plan.administrator && identity[0].sessionUser === plan.administrator
        && Math.floor(identity[0].version / 10000) === 18, "RUNTIME_ACCESS_AZURE_QUERY_STORE_CONNECTION_INVALID");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); began = true;
      for (const view of QUERY_STORE_VIEWS) {
        signal.throwIfAborted();
        const result = await client.query(`SELECT EXISTS(SELECT 1 FROM ${view} LIMIT 1) AS "hasRows"`);
        need(result.rows.length === 1 && typeof result.rows[0].hasRows === "boolean",
          "RUNTIME_ACCESS_AZURE_QUERY_STORE_READBACK_INVALID");
        if (result.rows[0].hasRows) return true;
      }
      return false;
    } catch { throw new Error("RUNTIME_ACCESS_AZURE_QUERY_STORE_READBACK_INVALID"); }
    finally { if (began) await client.query("ROLLBACK").catch(() => {}); await client.end().catch(() => {}); }
  };
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
    const common = { ...guards, resolveSecretVersion: options.resolveSecretVersion, assertSourceFenced, assertTargetInactive,
      readAzureParameters: azureParameterReader(expected, guards.signal, options),
      inspectAzureQueryStore: azureQueryStoreInspector(expected, guards.signal, options) };
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
        assertSourceFenced, assertTargetInactive: options.assertTargetInactive,
        readAzureParameters: azureParameterReader(expected, guards.signal, options),
        inspectAzureQueryStore: azureQueryStoreInspector(expected, guards.signal, options) });
      need(result.status === "APPLIED" && same(result, record.result), "RUNTIME_ACCESS_FRESH_READBACK_UNPROVEN");
    });
  }
  return { complete: true, domain: plan.domain, intentSha256: snapshot.intentSha256,
    policySha256: record.policySha256, receiptSha256: archiveEvidenceHash(record), freshAcceptance: fresh };
}

export async function monitorOpsCoreRuntimeAccessDrift(options) {
  const { plan, custody, operationStore } = options;
  need(plan.transfer.postgres.runtimeAccess?.schemaVersion === 2, "RUNTIME_ACCESS_AZURE_PROFILE_REQUIRED");
  await assertOpsCoreRuntimeAccessForActivation({ ...options, fresh: false });
  const snapshot = custody.snapshot(), phase = snapshot.history.find(entry => entry.phase === "VERIFIED");
  const check = async () => {
    custody.signal.throwIfAborted(); await custody.assertOwned();
    const current = custody.snapshot();
    need(current.domain === plan.domain && current.intentSha256 === snapshot.intentSha256
      && same(current.history.find(entry => entry.phase === "VERIFIED"), phase), "RUNTIME_ACCESS_CUSTODY_CHANGED");
  };
  const prefix = `operations/${plan.domain}/${snapshot.intentSha256}/${phase.operationId}/`;
  const store = records({ operationStore, prefix, signal: custody.signal, check });
  const [record, retained] = await Promise.all([store.read("runtime-access-receipt"), store.readRecords()]);
  const expected = accessPlan(plan, snapshot, phase, record.databaseOid);
  need(same(retained.intent.plan, expected), "RUNTIME_ACCESS_INTENT_CHANGED");
  return withAccessClient({ ...options, database: expected.database, assertOwned: check }, async guards =>
    monitorPostgresRuntimeAccessDrift({ ...guards, intent: retained.intent, expectedAfter: retained.expectedAfter,
      readAzureParameters: azureParameterReader(expected, guards.signal, options),
      inspectAzureQueryStore: azureQueryStoreInspector(expected, guards.signal, options) }));
}

export async function preflightOpsCoreRuntimeAccess(options) {
  const { plan, custody, assertOwned, assertTargetInactive } = options;
  return withAccessClient({ ...options, database: "postgres", assertOwned }, async guards => {
    await assertTargetInactive();
    const access = { schemaVersion: 1, domain: plan.domain, serverResourceId: plan.azure.postgres.resourceId,
        host: plan.transfer.postgres.target.host, port: plan.transfer.postgres.target.port,
        administrator: plan.transfer.postgres.target.user, runtimeVaultUri: plan.activation.runtimeVaultUri,
        policy: plan.transfer.postgres.runtimeAccess };
    return preparePostgresRuntimeAccessPreflight({ ...guards, resolveSecretVersion: options.resolveSecretVersion,
      plan: access, assertTargetInactive, readAzureParameters: azureParameterReader(access, guards.signal, options),
      inspectAzureQueryStore: azureQueryStoreInspector(access, guards.signal, options) });
  });
}
