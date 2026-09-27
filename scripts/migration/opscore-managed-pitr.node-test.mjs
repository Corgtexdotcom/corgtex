import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESOURCE, HOST } from './probe-ops-azure-target.mjs';
import { target } from './ops-core-target-profile.mjs';
import { CloneArm, cloneResource, cloneRuleName, cloneTags, createMarker, removeMarker, validateClone,
  verifyNeverStarted } from './opscore-managed-pitr.mjs';
import { firewallName, pitrServerName, pitrSchemaName } from './qualify-ops-azure-target.mjs';

assert.equal(process.env.TARGET_PROFILE, 'opscore');
const now = Date.now();
const i = {
  schemaVersion: '1.3.0', kind: target.kind, resource: RESOURCE, host: HOST, database: 'postgres',
  runId: '12345', runAttempt: '1', initialState: 'Stopped', firewallName: firewallName('12345', '1'),
  ipv4: '203.0.113.7', createdAt: now - 90000, deadline: now - 90000 + 4 * 60 * 60 * 1000,
  workDeadline: now - 90000 + 3 * 60 * 60 * 1000, transitionCapUsd: 5,
  computeSku: 'Standard_D2ds_v5', targetProfile: 'opscore', initialPublicAccess: 'Disabled',
  qualificationKind: 'managed-pitr', restoreServerName: pitrServerName('12345', '1'),
  probeSchemaName: pitrSchemaName('12345', '1'),
};
const clone = () => ({ id: cloneResource(i), name: i.restoreServerName, type: 'Microsoft.DBforPostgreSQL/flexibleServers',
  location: 'westus3', tags: cloneTags(i), sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' },
  properties: { state: 'Ready', version: '18', storage: { storageSizeGB: 32 },
    network: { publicNetworkAccess: 'Disabled' } } });
const token = 'x'.repeat(150);
const api = { async identity() {}, async authority() {}, async call() { return { accessToken: token }; } };
const reply = (status, value = null) => ({ status, async text() { return JSON.stringify(value); } });

test('no-START recovery verifies a closed target and absent clone without opening either', async () => {
  const events = [];
  const server = { id: RESOURCE, name: target.server, fullyQualifiedDomainName: HOST, administratorLogin: 'corgtexadmin',
    version: '18', location: 'westus3', sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' },
    storage: { storageSizeGb: 32, autoGrow: 'Enabled', tier: 'P4', iops: 120 },
    highAvailability: { mode: 'Disabled' }, backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' },
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' },
    network: { publicNetworkAccess: 'Disabled' }, tags: target.tags, state: 'Stopped' };
  const read = { async identity() { events.push('identity'); }, async boundary() { events.push('boundary'); },
    async server() { events.push('server'); return server; }, async rules() { events.push('rules'); return []; } };
  const cloneRead = { async clone() { events.push('clone'); return null; } };
  assert.deepEqual(await verifyNeverStarted(read, cloneRead, i, Date.now() + 1000),
    { serverStopped: true, firewallAbsent: true, cloneAbsent: true });
  assert.deepEqual(events, ['identity', 'boundary', 'server', 'rules', 'clone']);
  server.state = 'Ready';
  await assert.rejects(verifyNeverStarted(read, cloneRead, i, Date.now() + 1000), /PITR_NEVER_STARTED_BASELINE_UNPROVEN/);
});

test('a restored server with changed owner tags is never eligible for deletion', async () => {
  const foreign = clone(); foreign.tags.sourceRunAttempt = '2';
  assert.throws(() => validateClone(foreign, i), /PITR_CLONE_OWNER_MISMATCH/);
  const methods = [];
  const arm = new CloneArm(api, { now: () => now,
    request: async (_url, options) => { methods.push(options.method); return reply(200, foreign); } });
  await assert.rejects(arm.remove(i, now + 60000), /PITR_CLONE_OWNER_MISMATCH/);
  assert.deepEqual(methods, ['GET']);
});

test('PITR creation pins source and timestamp, and rejects an existing clone before PUT', async () => {
  const writes = [];
  const arm = new CloneArm(api, { now: () => now,
    request: async (url, options) => {
      if (options.method === 'GET') return reply(404);
      writes.push({ url, body: JSON.parse(options.body) });
      return reply(202);
    } });
  const restoreTime = new Date(now - 30000).toISOString();
  await arm.create(i, restoreTime);
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.includes(i.restoreServerName));
  assert.deepEqual(writes[0].body.properties, { createMode: 'PointInTimeRestore',
    sourceServerResourceId: RESOURCE, pointInTimeUTC: restoreTime,
    network: { publicNetworkAccess: 'Disabled' } });
  assert.deepEqual(writes[0].body.tags, cloneTags(i));
  const occupied = new CloneArm(api, { now: () => now,
    request: async (_url, options) => { assert.equal(options.method, 'GET'); return reply(200, clone()); } });
  await assert.rejects(occupied.create(i, restoreTime), /PITR_CLONE_ALREADY_EXISTS/);
});

test('owned clone deletion requires final ARM absence and never changes the source server', async () => {
  const methods = [];
  let exists = true;
  const arm = new CloneArm(api, { now: () => now, pause: async () => {},
    request: async (url, options) => {
      methods.push({ method: options.method, url });
      if (url.endsWith('/firewallRules?api-version=2025-08-01')) return reply(200, { value: [] });
      if (url.includes('/firewallRules/')) {
        assert.ok(url.includes(cloneRuleName(i)));
        return reply(404);
      }
      if (options.method === 'DELETE') { exists = false; return reply(202); }
      return exists ? reply(200, clone()) : reply(404);
    } });
  assert.deepEqual(await arm.remove(i, now + 60000), { cloneAbsent: true, firewallAbsent: true });
  assert.equal(methods.filter(x => x.method === 'DELETE').length, 1);
  assert.ok(methods.every(x => x.url.includes(i.restoreServerName)));
  assert.ok(methods.every(x => !x.url.includes('corgtex-opscore-pg18?')));
});

test('ambiguous restore absence cannot be declared clean, while definitive rejection can', async () => {
  const arm = new CloneArm(api, { now: () => now,
    request: async () => reply(404) });
  await assert.rejects(arm.remove(i, now + 60000), /PITR_CLONE_ABSENCE_UNPROVEN/);
  assert.deepEqual(await arm.remove(i, now + 60000, { allowAbsent: true }),
    { cloneAbsent: true, firewallAbsent: true });
});

test('owned clone already Dropping settles to absence without another DELETE', async () => {
  let reads = 0;
  const dropping = clone(); dropping.properties.state = 'Dropping';
  const arm = new CloneArm(api, { now: () => now, pause: async () => {},
    request: async (_url, options) => {
      assert.equal(options.method, 'GET');
      reads++;
      return reads < 3 ? reply(200, dropping) : reply(404);
    } });
  assert.deepEqual(await arm.remove(i, now + 60000), { cloneAbsent: true, firewallAbsent: true });
  assert.equal(reads, 3);
});

test('template1 user data blocks synthetic-only restore before marker creation', async () => {
  const statements = [];
  const factory = config => ({
    async connect() {}, async end() {},
    async query(sql) {
      statements.push({ database: config.database, sql });
      return sql.includes('FROM pg_catalog.pg_class') ? { rowCount: 1, rows: [{ nspname: 'private', relname: 'data' }] }
        : { rowCount: 0, rows: [] };
    },
  });
  await assert.rejects(createMarker({ database: 'postgres' }, i, factory), /PITR_TARGET_DATABASE_NOT_EMPTY/);
  assert.ok(statements.every(entry => entry.database === 'template1'));
  assert.ok(!statements.some(entry => entry.sql.startsWith('CREATE')));
});

test('marker cleanup refuses foreign ownership and extra objects before DROP', async () => {
  for (const scenario of ['foreign-comment', 'extra-object']) {
    const statements = [];
    const factory = () => ({
      async connect() {}, async end() {},
      async query(sql) {
        statements.push(sql);
        if (sql.includes('obj_description')) return { rowCount: 1, rows: [{ oid: 42,
          comment: scenario === 'foreign-comment' ? 'foreign' : 'opscore-managed-pitr:12345:1' }] };
        if (sql.includes('FROM pg_catalog.pg_class')) return { rowCount: 3, rows: [
          { relname: 'marker', relkind: 'r' }, { relname: 'marker_pkey', relkind: 'i' },
          { relname: 'foreign_table', relkind: 'r' }] };
        return { rowCount: 0, rows: [] };
      },
    });
    await assert.rejects(removeMarker({}, i, { schemaOid: 42 }, factory),
      new RegExp(scenario === 'foreign-comment' ? 'PITR_PROBE_OWNER_MISMATCH' : 'PITR_PROBE_OBJECT_DRIFT'));
    assert.ok(statements.includes('ROLLBACK'));
    assert.ok(!statements.some(sql => sql.startsWith('DROP')));
  }
});
