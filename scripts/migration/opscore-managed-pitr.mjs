#!/usr/bin/env node
// Synthetic-only managed backup restore on the isolated Ops/Core target.
// Customer snapshots and production routing are outside this operation.
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AzureCliCredential } from '@azure/identity';
import { ContainerClient } from '@azure/storage-blob';
import { RESOURCE, HOST, ProbeError, connectionConfig, sanitize } from './probe-ops-azure-target.mjs';
import { openOpsCorePitrGuard, OPSCORE_CUSTODY_URL } from './ops-core-pitr-guard.mjs';
import { TARGETS } from './ops-core-target-profile.mjs';
import { Azure, SUBSCRIPTION, GROUP, clock, prepare, qualify, cleanup as cleanupTarget,
  validateEnvironment, validateIntent, validateServer, validateRules, intentComputeSku,
  captureTrialClientConfig, recoveryEvidence, waitState } from './qualify-ops-azure-target.mjs';

const API_VERSION = '2025-08-01';
const assert = (ok, code) => { if (!ok) throw new ProbeError(code); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const exactKeys = (value, keys) => value && Object.keys(value).sort().join() === [...keys].sort().join();
const schemaIdentifier = name => { assert(/^opscore_pitr_[1-9][0-9]*_[1-9][0-9]*$/u.test(name), 'PITR_SCHEMA_INVALID'); return `"${name}"`; };
const ownerComment = i => `opscore-managed-pitr:${i.runId}:${i.runAttempt}`;
async function withPitrGuard(work) {
  const container = new ContainerClient(OPSCORE_CUSTODY_URL,
    new AzureCliCredential({ processTimeoutInMs: 10_000 }), { retryOptions: { maxTries: 1 } });
  // Get Container Properties exposes public access with Contributor RBAC;
  // Get Container ACL would require the broader Blob Data Owner role.
  let properties;
  try { properties = await container.getProperties(); }
  catch { throw new ProbeError('PITR_CUSTODY_READ_UNAVAILABLE'); }
  assert(!properties.blobPublicAccess, 'PITR_CUSTODY_PUBLIC');
  const guard = await openOpsCorePitrGuard(container);
  try { return await work(guard); } finally { await guard.close(); }
}
export const cloneResource = i => `/subscriptions/${SUBSCRIPTION}/resourceGroups/${GROUP}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${i.restoreServerName}`;
export const cloneHost = i => `${i.restoreServerName}.postgres.database.azure.com`;
export const cloneRuleName = i => `opscore-pitr-${i.runId}-${i.runAttempt}`;
export const cloneTags = i => ({ application: 'corgtex', managedBy: 'migration-operator',
  purpose: 'opscore-managed-pitr-qualification', sourceServer: 'corgtex-opscore-pg18',
  sourceRunId: i.runId, sourceRunAttempt: i.runAttempt });
const matchesTags = (actual, expected) => exactKeys(actual, Object.keys(expected))
  && Object.entries(expected).every(([key, value]) => actual[key] === value);

function save(path, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  assert(Buffer.byteLength(bytes) <= 16384, 'PITR_RECEIPT_LIMIT');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.size > 0 && stat.size <= 16384, 'PITR_RECEIPT_LIMIT');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
export function validateClone(value, i, { allowInheritedTags = false } = {}) {
  assert(i.qualificationKind === 'managed-pitr', 'PITR_INTENT_MISMATCH');
  assert(value?.id?.toLowerCase() === cloneResource(i).toLowerCase()
    && value.name === i.restoreServerName && value.location?.replaceAll(' ', '').toLowerCase() === 'westus3'
    && value.type?.toLowerCase() === 'microsoft.dbforpostgresql/flexibleservers'
    && (matchesTags(value.tags, cloneTags(i))
      || (allowInheritedTags && matchesTags(value.tags, TARGETS.opscore.tags))), 'PITR_CLONE_OWNER_MISMATCH');
  const state = value.properties?.state;
  assert(['Creating', 'Provisioning', 'Starting', 'Ready', 'Updating', 'Stopping', 'Stopped', 'Dropping'].includes(state), 'PITR_CLONE_DRIFT');
  if (['Ready', 'Stopped'].includes(state)) {
    assert(value.sku?.name === 'Standard_D2ds_v5' && value.sku?.tier === 'GeneralPurpose'
      && value.properties?.version === '18' && value.properties?.storage?.storageSizeGB === 32
      && ['Enabled', 'Disabled'].includes(value.properties?.network?.publicNetworkAccess), 'PITR_CLONE_DRIFT');
  }
  return value;
}
export function validateCloneRule(rule, i) {
  assert(rule?.id?.toLowerCase() === `${cloneResource(i)}/firewallRules/${cloneRuleName(i)}`.toLowerCase()
    && rule.name === cloneRuleName(i) && rule.properties?.startIpAddress === i.ipv4
    && rule.properties?.endIpAddress === i.ipv4, 'PITR_FIREWALL_OWNER_MISMATCH');
  return rule;
}

export class CloneArm {
  constructor(api, { request = fetch, now = Date.now, pause = sleep } = {}) {
    this.api = api; this.request = request; this.now = now; this.pause = pause;
  }
  async call(method, i, suffix = '', body, deadline = i.workDeadline) {
    validateIntent(i, i.runId, i.runAttempt);
    assert(i.qualificationKind === 'managed-pitr', 'PITR_INTENT_MISMATCH');
    assert(['GET', 'PUT', 'PATCH', 'DELETE'].includes(method)
      && ['', '/firewallRules', `/firewallRules/${cloneRuleName(i)}`].includes(suffix)
      && (suffix !== '/firewallRules' || method === 'GET'), 'PITR_ARM_OPERATION_INVALID');
    assert(this.now() < deadline, 'PITR_DEADLINE');
    if (method !== 'GET') { await this.api.identity(); await this.api.authority(); }
    const token = await this.api.call(['account', 'get-access-token', '--resource', 'https://management.azure.com/']);
    assert(typeof token?.accessToken === 'string' && token.accessToken.length > 100, 'PITR_ARM_TOKEN_INVALID');
    let response;
    try {
      response = await this.request(`https://management.azure.com${cloneResource(i)}${suffix}?api-version=${API_VERSION}`, {
        method, headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(Math.min(30000, deadline - this.now())),
      });
    } catch { throw new ProbeError('PITR_ARM_RESPONSE_UNPROVEN'); }
    if (method === 'PUT' && suffix === '' && [400, 401, 403, 404, 409, 422].includes(response.status))
      throw new ProbeError('PITR_RESTORE_REJECTED');
    if (method === 'DELETE' && suffix === '' && [400, 401, 403, 409, 422].includes(response.status))
      throw new ProbeError('PITR_CLONE_DELETE_REJECTED');
    assert([200, 201, 202, 204, ...(method === 'GET' || method === 'DELETE' ? [404] : [])].includes(response.status),
      'PITR_ARM_RESPONSE_UNPROVEN');
    if (response.status === 404) return { status: 404, value: null };
    if (method !== 'GET') return { status: response.status, value: null };
    const raw = await response.text();
    assert(Buffer.byteLength(raw) <= 131072, 'PITR_ARM_RESPONSE_LIMIT');
    let value;
    try { value = JSON.parse(raw); } catch { throw new ProbeError('PITR_ARM_RESPONSE_INVALID'); }
    return { status: response.status, value };
  }
  async clone(i, deadline = i.workDeadline) {
    const result = await this.call('GET', i, '', undefined, deadline);
    return result.status === 404 ? null : validateClone(result.value, i);
  }
  async adoptRestoredClone(i, accepted, deadline = i.workDeadline) {
    const acceptedAt = Date.parse(accepted?.at);
    assert(accepted?.status === 'ARM_RESTORE_ACCEPTED' && Number.isFinite(acceptedAt)
      && acceptedAt >= i.createdAt && acceptedAt <= this.now(), 'PITR_RESTORE_ACCEPTANCE_UNPROVEN');
    let patched = false;
    while (this.now() < deadline) {
      const result = await this.call('GET', i, '', undefined, deadline);
      if (result.status !== 404) {
        const observed = validateClone(result.value, i, { allowInheritedTags: true });
        const owned = matchesTags(observed.tags, cloneTags(i));
        if (owned && ['Ready', 'Stopped'].includes(observed.properties.state)) return observed;
        if (!owned && ['Ready', 'Stopped'].includes(observed.properties.state) && !patched) {
          assert((await this.rules(i, deadline)).length === 0, 'PITR_FOREIGN_FIREWALL_RULES');
          await this.call('PATCH', i, '', { tags: cloneTags(i) }, deadline);
          patched = true;
        }
      }
      await this.pause(Math.min(10000, deadline - this.now()));
    }
    throw new ProbeError('PITR_CLONE_TAGS_UNPROVEN');
  }
  async waitClone(i, states, deadline = i.workDeadline) {
    while (this.now() < deadline) {
      const clone = await this.clone(i, deadline);
      if (clone && states.includes(clone.properties.state)) return clone;
      await this.pause(Math.min(10000, deadline - this.now()));
    }
    throw new ProbeError('PITR_CLONE_STATE_UNPROVEN');
  }
  async waitCloneNetwork(i, access, deadline = i.workDeadline) {
    while (this.now() < deadline) {
      const clone = await this.clone(i, deadline);
      if (clone?.properties.state === 'Ready' && clone.properties.network.publicNetworkAccess === access) return clone;
      await this.pause(Math.min(5000, deadline - this.now()));
    }
    throw new ProbeError('PITR_CLONE_NETWORK_UNPROVEN');
  }
  async rules(i, deadline = i.workDeadline) {
    const result = await this.call('GET', i, '/firewallRules', undefined, deadline);
    assert(result.status === 200 && Array.isArray(result.value?.value) && !result.value.nextLink
      && result.value.value.length <= 1, 'PITR_FOREIGN_FIREWALL_RULES');
    if (result.value.value.length) validateCloneRule(result.value.value[0], i);
    return result.value.value;
  }
  async waitAbsent(i, deadline) {
    while (this.now() < deadline) {
      const observed = await this.call('GET', i, '', undefined, deadline);
      if (observed.status === 404) return { cloneAbsent: true, firewallAbsent: true };
      validateClone(observed.value, i);
      await this.pause(Math.min(10000, deadline - this.now()));
    }
    throw new ProbeError('PITR_CLONE_DELETE_UNPROVEN');
  }
  async create(i, restoreTime) {
    assert(!(await this.clone(i)), 'PITR_CLONE_ALREADY_EXISTS');
    assert(Number.isFinite(Date.parse(restoreTime)) && Date.parse(restoreTime) > i.createdAt
      && Date.parse(restoreTime) < this.now() - 10000, 'PITR_RESTORE_TIME_INVALID');
    return this.call('PUT', i, '', {
      location: 'westus3', tags: cloneTags(i),
      properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: RESOURCE,
        pointInTimeUTC: restoreTime, network: { publicNetworkAccess: 'Disabled' } },
    });
  }
  async enableRunnerAccess(i) {
    let clone = await this.waitClone(i, ['Ready']);
    if (clone.properties.network.publicNetworkAccess === 'Disabled') {
      await this.call('PATCH', i, '', { properties: { network: { publicNetworkAccess: 'Enabled' } } });
      clone = await this.waitCloneNetwork(i, 'Enabled');
    }
    const rulePath = `/firewallRules/${cloneRuleName(i)}`;
    assert((await this.rules(i)).length === 0, 'PITR_FIREWALL_ALREADY_EXISTS');
    await this.call('PUT', i, rulePath, { properties: { startIpAddress: i.ipv4, endIpAddress: i.ipv4 } });
    while (this.now() < i.workDeadline) {
      const rule = await this.call('GET', i, rulePath);
      if (rule.status === 200) { validateCloneRule(rule.value, i); return; }
      await this.pause(Math.min(5000, i.workDeadline - this.now()));
    }
    throw new ProbeError('PITR_FIREWALL_UNPROVEN');
  }
  async remove(i, deadline, { markDeleteAttempt = async () => {}, deleteAttempted = false, allowAbsent = false } = {}) {
    if (deleteAttempted) return this.waitAbsent(i, deadline); // Never replay an ambiguous DELETE.
    let clone = await this.clone(i, deadline);
    if (!clone) {
      assert(allowAbsent, 'PITR_CLONE_ABSENCE_UNPROVEN');
      return { cloneAbsent: true, firewallAbsent: true };
    }
    if (clone.properties.state === 'Dropping') return this.waitAbsent(i, deadline);
    clone = await this.waitClone(i, ['Ready', 'Stopped'], deadline);
    const rulePath = `/firewallRules/${cloneRuleName(i)}`;
    const rules = await this.rules(i, deadline);
    if (rules.length) {
      await this.call('DELETE', i, rulePath, undefined, deadline);
    }
    while (this.now() < deadline) {
      if ((await this.call('GET', i, rulePath, undefined, deadline)).status === 404) break;
      await this.pause(Math.min(5000, deadline - this.now()));
    }
    assert((await this.call('GET', i, rulePath, undefined, deadline)).status === 404, 'PITR_FIREWALL_NOT_REMOVED');
    if (clone.properties.network.publicNetworkAccess === 'Enabled') {
      await this.call('PATCH', i, '', { properties: { network: { publicNetworkAccess: 'Disabled' } } }, deadline);
      clone = await this.waitCloneNetwork(i, 'Disabled', deadline);
    }
    await markDeleteAttempt();
    await this.call('DELETE', i, '', undefined, deadline);
    return this.waitAbsent(i, deadline);
  }
}

async function adminConfig(api, env) {
  const password = await api.readAdminSecret();
  return captureTrialClientConfig(await connectionConfig({ ...env, TARGET_POSTGRES_ADMIN_PASSWORD: password }));
}
async function withClient(config, work, clientFactory) {
  const { default: pg } = clientFactory ? { default: null } : await import('pg');
  const client = clientFactory ? clientFactory(config) : new pg.Client(config);
  try { await client.connect(); return await work(client); }
  finally { await client.end().catch(() => {}); }
}
export async function assertNoUserContent(client, { allowAzureManagedExtensions = false } = {}) {
  const userObjects = await client.query(`SELECT n.nspname, c.relname
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND c.relkind IN ('r','p','m','v','f','S') LIMIT 1`);
  assert(userObjects.rowCount === 0, 'PITR_TARGET_DATABASE_NOT_EMPTY');
  const userSchemas = await client.query(`SELECT nspname FROM pg_catalog.pg_namespace
    WHERE nspname NOT IN ('public', 'pg_catalog', 'information_schema')
      AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%' LIMIT 1`);
  assert(userSchemas.rowCount === 0, 'PITR_TARGET_DATABASE_NOT_EMPTY');
  const largeObjects = await client.query('SELECT oid FROM pg_catalog.pg_largeobject_metadata LIMIT 1');
  assert(largeObjects.rowCount === 0, 'PITR_TARGET_DATABASE_NOT_EMPTY');
  const extensions = await client.query(`SELECT e.extname AS name, n.nspname AS schema,
    pg_catalog.pg_get_userbyid(e.extowner) AS owner
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname <> 'plpgsql' ORDER BY e.extname LIMIT 3`);
  // The pinned Azure target has these provider-owned extensions in postgres.
  // Their names alone are insufficient: owner and schema must also match.
  const providerExtensions = new Set(['azure', 'pgaadauth']);
  assert(extensions.rowCount <= 2 && extensions.rows.length === extensions.rowCount
    && extensions.rows.every(row => allowAzureManagedExtensions
    && providerExtensions.has(row.name) && row.schema === 'pg_catalog' && row.owner === 'azuresu')
    && new Set(extensions.rows.map(row => row.name)).size === extensions.rowCount,
  'PITR_TARGET_DATABASE_NOT_EMPTY');
  const functions = await client.query(`SELECT p.oid FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' LIMIT 1`);
  assert(functions.rowCount === 0, 'PITR_TARGET_DATABASE_NOT_EMPTY');
  const types = await client.query(`SELECT t.oid FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' LIMIT 1`);
  assert(types.rowCount === 0, 'PITR_TARGET_DATABASE_NOT_EMPTY');
}

export async function createMarker(config, i, clientFactory) {
  const schema = schemaIdentifier(i.probeSchemaName);
  const comment = ownerComment(i);
  // Managed backup restores the full server, including template1.
  await withClient({ ...config, database: 'template1' }, assertNoUserContent, clientFactory);
  return withClient(config, async client => {
    const databases = await client.query('SELECT datname AS name, datallowconn, datistemplate FROM pg_catalog.pg_database ORDER BY datname');
    const system = new Set(['azure_maintenance', 'azure_sys', 'postgres', 'template0', 'template1']);
    assert(databases.rows.length > 0 && databases.rows.length <= system.size
      && databases.rows.some(row => row.name === 'postgres')
      && databases.rows.every(row => system.has(row.name))
      && databases.rows.some(row => row.name === 'template0' && row.datallowconn === false && row.datistemplate === true),
    'PITR_TARGET_DATABASE_NOT_EMPTY');
    await assertNoUserContent(client, { allowAzureManagedExtensions: true });
    const priorProbes = await client.query(`SELECT nspname FROM pg_catalog.pg_namespace
      WHERE nspname LIKE 'opscore\\_pitr\\_%' ESCAPE '\\' LIMIT 1`);
    assert(priorProbes.rowCount === 0, 'PITR_PRIOR_PROBE_UNRESOLVED');
    const existing = await client.query('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1', [i.probeSchemaName]);
    assert(existing.rowCount === 0, 'PITR_PROBE_SCHEMA_EXISTS');
    await client.query('BEGIN');
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`COMMENT ON SCHEMA ${schema} IS '${comment}'`);
      await client.query(`CREATE TABLE ${schema}.marker (phase text PRIMARY KEY)`);
      await client.query(`INSERT INTO ${schema}.marker (phase) VALUES ('before')`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    const result = await client.query('SELECT oid FROM pg_catalog.pg_namespace WHERE nspname=$1', [i.probeSchemaName]);
    assert(result.rowCount === 1 && Number.isInteger(Number(result.rows[0].oid)), 'PITR_PROBE_CREATE_UNPROVEN');
    return { schemaName: i.probeSchemaName, schemaOid: Number(result.rows[0].oid), ownerComment: comment };
  }, clientFactory);
}
export async function markerTimeAndAfter(config, i, pause = sleep) {
  const schema = schemaIdentifier(i.probeSchemaName);
  await pause(15000);
  return withClient(config, async client => {
    const time = (await client.query('SELECT clock_timestamp() AS at')).rows[0]?.at;
    assert(time instanceof Date && Number.isFinite(time.getTime()), 'PITR_RESTORE_TIME_UNPROVEN');
    const restoreTime = time.toISOString();
    await pause(15000);
    const inserted = await client.query(`INSERT INTO ${schema}.marker (phase) VALUES ('after')`);
    assert(inserted.rowCount === 1, 'PITR_AFTER_MARKER_UNPROVEN');
    return restoreTime;
  });
}
export async function verifyMarker(config, i) {
  const schema = schemaIdentifier(i.probeSchemaName);
  return withClient(config, async client => {
    const result = await client.query(`SELECT phase FROM ${schema}.marker ORDER BY phase`);
    assert(result.rowCount === 1 && result.rows[0].phase === 'before', 'PITR_RESTORED_MARKER_MISMATCH');
    return { beforePresent: true, afterAbsent: true };
  });
}
export async function removeMarker(config, i, receipt, clientFactory) {
  const schema = schemaIdentifier(i.probeSchemaName);
  return withClient(config, async client => {
    await client.query('BEGIN');
    try {
      const n = await client.query(`SELECT oid, pg_catalog.obj_description(oid, 'pg_namespace') AS comment
        FROM pg_catalog.pg_namespace WHERE nspname=$1`, [i.probeSchemaName]);
      if (n.rowCount === 0) { await client.query('ROLLBACK'); return { schemaAbsent: true }; }
      assert(n.rowCount === 1 && n.rows[0].comment === ownerComment(i)
        && (!receipt || Number(n.rows[0].oid) === receipt.schemaOid), 'PITR_PROBE_OWNER_MISMATCH');
      const objects = await client.query(`SELECT relname, relkind FROM pg_catalog.pg_class WHERE relnamespace=$1`, [n.rows[0].oid]);
      assert(objects.rowCount === 2 && objects.rows.some(row => row.relname === 'marker' && row.relkind === 'r')
        && objects.rows.some(row => row.relname === 'marker_pkey' && row.relkind === 'i'), 'PITR_PROBE_OBJECT_DRIFT');
      await client.query(`DROP TABLE ${schema}.marker`);
      await client.query(`DROP SCHEMA ${schema}`);
      await client.query('COMMIT');
      return { schemaAbsent: true };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  }, clientFactory);
}

async function reopenForMarkerCleanup(api, i, deadline) {
  await api.identity(); await api.boundary();
  const initial = validateServer(await api.server(), true, intentComputeSku(i));
  const rules = validateRules(await api.rules(), i);
  if (initial.state !== 'Stopped' || initial.network.publicNetworkAccess !== 'Disabled' || rules.length) {
    await cleanupTarget(api, i, clock, true, deadline);
  }
  const closed = validateServer(await api.server(), false, intentComputeSku(i));
  assert(closed.state === 'Stopped' && closed.network.publicNetworkAccess === 'Disabled'
    && validateRules(await api.rules(), i).length === 0, 'PITR_MARKER_REOPEN_BASELINE_UNPROVEN');
  await api.start();
  await waitState(api, 'Ready', deadline, clock, i);
  await api.setPublicAccess('Enabled');
  const opened = await waitState(api, 'Ready', deadline, clock, i);
  assert(opened.network.publicNetworkAccess === 'Enabled', 'PITR_MARKER_REOPEN_UNPROVEN');
  try { await api.createRule(i); }
  catch (error) { if (error.code !== 'AZURE_FIREWALL_CREATE_FAILED') throw error; }
  while (Date.now() < deadline) {
    const current = await waitState(api, 'Ready', deadline, clock, i);
    if (current.ownedRules.length === 1) return;
    await sleep(Math.min(5000, deadline - Date.now()));
  }
  throw new ProbeError('PITR_MARKER_REOPEN_UNPROVEN');
}

export async function verifyNeverStarted(api, arm, i, deadline) {
  await api.identity(); await api.boundary();
  const server = validateServer(await api.server(), false, intentComputeSku(i));
  const rules = validateRules(await api.rules(), i);
  assert(server.state === 'Stopped' && server.network.publicNetworkAccess === 'Disabled'
    && rules.length === 0 && !(await arm.clone(i, deadline)), 'PITR_NEVER_STARTED_BASELINE_UNPROVEN');
  return { serverStopped: true, firewallAbsent: true, cloneAbsent: true };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  assert(args.length === 2 && ['prepare', 'claim', 'run', 'cleanup', 'recover'].includes(args[0]), 'PITR_ARGS_INVALID');
  const [mode, path] = args, recovery = mode === 'recover';
  validateEnvironment(env, recovery);
  assert(env.OPSCORE_QUALIFICATION_KIND === 'managed-pitr', 'PITR_OPERATION_MISMATCH');
  const dir = resolve(path); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const api = new Azure(env), arm = new CloneArm(api);
  const intentPath = `${dir}/qualification-intent.json`;
  if (mode === 'cleanup' && !existsSync(intentPath)) return;
  if (mode === 'prepare') {
    await adminConfig(api, env); // Credential and CA must exist before any provider effect.
    const i = await prepare(api, { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
      ipv4: env.QUALIFY_RUNNER_IPV4 }, clock, { managedPitr: true });
    assert(!(await arm.clone(i)), 'PITR_CLONE_ALREADY_EXISTS');
    save(intentPath, i);
    // Persist the possible START owner with the intent; runner loss cannot erase recovery authority.
    save(`${dir}/start-intent.json`, { runId: i.runId, runAttempt: i.runAttempt });
    console.log(JSON.stringify({ status: 'PITR_PREPARED', deadline: i.deadline, clone: i.restoreServerName }));
    return;
  }
  const i = validateIntent(read(intentPath), recovery ? env.RECOVERY_RUN_ID : env.GITHUB_RUN_ID,
    recovery ? env.RECOVERY_RUN_ATTEMPT : env.GITHUB_RUN_ATTEMPT);
  assert(i.qualificationKind === 'managed-pitr', 'PITR_INTENT_MISMATCH');
  let recoveryProof;
  if (mode === 'claim') {
    await withPitrGuard(guard => guard.create(i));
    console.log(JSON.stringify({ status: 'PITR_GUARD_CLAIMED', runId: i.runId, runAttempt: i.runAttempt }));
    return;
  }
  if (recovery) {
    recoveryProof = await recoveryEvidence(i, env, dir, fetch, 'pitr');
    api.verifyRecovery = async () => {}; // The activity proof above remains valid in this serialized run.
  }
  if (!recoveryProof?.startSkipped && (mode !== 'cleanup' || existsSync(`${dir}/start-attempt.json`)))
    await withPitrGuard(guard => guard.assertOwner(i));
  if (recoveryProof?.startSkipped) {
    assert(!existsSync(`${dir}/start-attempt.json`) && !existsSync(`${dir}/restore-attempt.json`)
      && !existsSync(`${dir}/probe-created.json`), 'PITR_NEVER_STARTED_RECEIPT_CONFLICT');
    const closed = await verifyNeverStarted(api, arm, i, Date.now() + 5 * 60 * 1000);
    await withPitrGuard(guard => guard.clear(i, { allowAbsent: true }));
    save(`${dir}/recovery-cleanup.json`, { status: 'PITR_START_NOT_ATTEMPTED', providerEffects: 0,
      ...closed, productionAccepted: false });
    return;
  }
  if (mode === 'run') {
    const config = await adminConfig(api, env);
    const receipt = await qualify(api, i, async () => {
      const marker = await createMarker(config, i);
      save(`${dir}/probe-created.json`, marker);
      const restoreTime = await markerTimeAndAfter(config, i);
      save(`${dir}/restore-plan.json`, { restoreTime, clone: cloneResource(i), source: RESOURCE });
      await sleep(6 * 60 * 1000); // Azure documents up to five minutes of WAL archive lag.
      save(`${dir}/restore-attempt.json`, { runId: i.runId, runAttempt: i.runAttempt, restoreTime });
      const start = Date.now();
      try { await arm.create(i, restoreTime); } // Never retry an ambiguous create.
      catch (error) {
        if (error.code === 'PITR_RESTORE_REJECTED')
          save(`${dir}/restore-rejected.json`, { runId: i.runId, runAttempt: i.runAttempt, restoreTime });
        throw error;
      }
      const accepted = { status: 'ARM_RESTORE_ACCEPTED', at: new Date().toISOString() };
      save(`${dir}/restore-accepted.json`, accepted);
      await arm.adoptRestoredClone(i, accepted);
      await arm.enableRunnerAccess(i);
      const restored = await verifyMarker({ ...config, host: cloneHost(i) }, i);
      const result = { status: 'OPSCORE_MANAGED_PITR_VERIFIED', source: RESOURCE, clone: cloneResource(i),
        restoreTime, recoveryDurationSeconds: Math.ceil((Date.now() - start) / 1000), ...restored,
        customerDataRestored: false, workloadQualified: false, productionAccepted: false };
      save(`${dir}/pitr-result.json`, result);
      return result;
    }, async () => save(`${dir}/start-attempt.json`, { runId: i.runId, runAttempt: i.runAttempt }));
    console.log(JSON.stringify(receipt));
    return;
  }
  if (!recovery && !existsSync(`${dir}/start-attempt.json`)) {
    await withPitrGuard(guard => guard.clear(i, { allowAbsent: true }));
    save(`${dir}/cleanup.json`, { status: 'PITR_START_NOT_ATTEMPTED', providerEffects: 0 });
    return;
  }
  // Leave the original target's public-window cleanup its own bounded time.
  const deadline = Date.now() + (recovery ? 75 : 35) * 60 * 1000;
  api.deadline = deadline;
  let cloneResult, markerResult, targetResult, firstError;
  try {
    if (recovery && existsSync(`${dir}/marker-cleanup.json`)) {
      markerResult = read(`${dir}/marker-cleanup.json`);
      assert(markerResult.schemaAbsent === true && markerResult.schemaName === i.probeSchemaName,
        'PITR_MARKER_CLEANUP_RECEIPT_INVALID');
    } else {
      const config = await adminConfig(api, env);
      if (recovery) await reopenForMarkerCleanup(api, i, deadline);
      markerResult = await removeMarker(config, i, existsSync(`${dir}/probe-created.json`) ? read(`${dir}/probe-created.json`) : null);
      save(`${dir}/marker-cleanup.json`, { ...markerResult, schemaName: i.probeSchemaName });
    }
  } catch (error) { firstError ??= error; }
  try {
    if (recovery) {
      const prior = existsSync(`${dir}/target-cleanup.json`) ? read(`${dir}/target-cleanup.json`) : null;
      if (prior) assert(prior.status === 'TARGET_QUALIFICATION_CLEANED' && prior.runId === i.runId
        && prior.runAttempt === i.runAttempt && prior.serverStopped === true
        && prior.firewallAbsent === true, 'PITR_TARGET_CLEANUP_RECEIPT_INVALID');
      await api.identity(); await api.boundary();
      const server = validateServer(await api.server(), false, intentComputeSku(i));
      const rules = validateRules(await api.rules(), i);
      if (server.state === 'Stopped' && server.network.publicNetworkAccess === 'Disabled' && rules.length === 0) {
        targetResult = prior ?? { status: 'TARGET_QUALIFICATION_CLEANED', runId: i.runId,
          runAttempt: i.runAttempt, serverStopped: true, firewallAbsent: true };
      } else {
        targetResult = await cleanupTarget(api, i, clock, true, deadline);
      }
    } else {
      targetResult = await cleanupTarget(api, i, clock, recovery, deadline);
      save(`${dir}/target-cleanup.json`, targetResult);
    }
  }
  catch (error) { firstError ??= error; }
  // The clone gets its own bounded deletion window after the original server is closed.
  const cloneDeadline = Date.now() + (recovery ? 25 : 30) * 60 * 1000;
  api.deadline = cloneDeadline;
  try {
    if (recovery && existsSync(`${dir}/clone-cleanup.json`)) {
      const prior = read(`${dir}/clone-cleanup.json`);
      assert(prior.runId === i.runId && prior.runAttempt === i.runAttempt && prior.cloneAbsent === true,
        'PITR_CLONE_CLEANUP_RECEIPT_INVALID');
      assert(!(await arm.clone(i, cloneDeadline)), 'PITR_CLONE_REAPPEARED');
      cloneResult = prior;
    } else if (recovery || existsSync(`${dir}/restore-attempt.json`)) {
      const deleteAttempted = existsSync(`${dir}/clone-delete-attempt.json`);
      const deleteRejected = existsSync(`${dir}/clone-delete-rejected.json`)
        ? read(`${dir}/clone-delete-rejected.json`) : null;
      if (deleteAttempted) {
        const deletion = read(`${dir}/clone-delete-attempt.json`);
        assert(exactKeys(deletion, ['runId', 'runAttempt', 'clone']) && deletion.runId === i.runId
          && deletion.runAttempt === i.runAttempt && deletion.clone === cloneResource(i),
        'PITR_CLONE_DELETE_INTENT_INVALID');
      }
      if (deleteRejected) assert(deleteAttempted && exactKeys(deleteRejected, ['runId', 'runAttempt', 'clone'])
        && deleteRejected.runId === i.runId && deleteRejected.runAttempt === i.runAttempt
        && deleteRejected.clone === cloneResource(i), 'PITR_CLONE_DELETE_REJECTION_INVALID');
      const rejected = existsSync(`${dir}/restore-rejected.json`) ? read(`${dir}/restore-rejected.json`) : null;
      if (rejected) assert(exactKeys(rejected, ['runId', 'runAttempt', 'restoreTime'])
        && rejected.runId === i.runId && rejected.runAttempt === i.runAttempt
        && rejected.restoreTime === read(`${dir}/restore-attempt.json`).restoreTime,
      'PITR_RESTORE_REJECTION_INVALID');
      try {
        if (!deleteAttempted && existsSync(`${dir}/restore-accepted.json`))
          await arm.adoptRestoredClone(i, read(`${dir}/restore-accepted.json`), cloneDeadline);
        cloneResult = await arm.remove(i, cloneDeadline, { deleteAttempted: deleteAttempted && !deleteRejected,
          allowAbsent: Boolean(rejected),
          markDeleteAttempt: async () => {
            if (!deleteAttempted) save(`${dir}/clone-delete-attempt.json`,
              { runId: i.runId, runAttempt: i.runAttempt, clone: cloneResource(i) });
          } });
      } catch (error) {
        if (error.code === 'PITR_CLONE_DELETE_REJECTED' && !deleteRejected)
          save(`${dir}/clone-delete-rejected.json`,
            { runId: i.runId, runAttempt: i.runAttempt, clone: cloneResource(i) });
        throw error;
      }
      save(`${dir}/clone-cleanup.json`, { ...cloneResult, runId: i.runId, runAttempt: i.runAttempt });
    }
    else assert(!(await arm.clone(i, cloneDeadline)), 'PITR_UNEXPECTED_CLONE');
  } catch (error) { firstError ??= error; }
  const cleaned = !firstError && targetResult?.serverStopped && targetResult?.firewallAbsent
    && markerResult?.schemaAbsent && (!existsSync(`${dir}/restore-attempt.json`) || cloneResult?.cloneAbsent);
  const cleanupReceipt = { status: cleaned ? 'OPSCORE_MANAGED_PITR_CLEANED' : 'PITR_CLEANUP_UNPROVEN',
    cloneAbsent: cloneResult?.cloneAbsent ?? null, schemaAbsent: markerResult?.schemaAbsent ?? null,
    serverStopped: targetResult?.serverStopped ?? null, firewallAbsent: targetResult?.firewallAbsent ?? null,
    withinWindow: Date.now() <= i.deadline, productionAccepted: false,
    ...(firstError ? { failureCode: firstError instanceof ProbeError ? firstError.code : 'PITR_CLEANUP_FAILED' } : {}) };
  if (!cleaned) {
    save(`${dir}/${recovery ? 'recovery-cleanup' : 'cleanup'}.json`, cleanupReceipt);
    throw firstError ?? new ProbeError('PITR_CLEANUP_UNPROVEN');
  }
  await withPitrGuard(guard => guard.clear(i));
  save(`${dir}/${recovery ? 'recovery-cleanup' : 'cleanup'}.json`, cleanupReceipt);
  console.log(JSON.stringify({ status: 'OPSCORE_MANAGED_PITR_CLEANED' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify(sanitize(error))); process.exitCode = 1; });
}
