// Separate process preserves the exact Ops/Core target profile module pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { target, targetResource } from './ops-core-target-profile.mjs';
import { cleanupOwnedScratch, inspectShadowDatabaseInventory, restoreBothDomains, scratchName,
  withScratchMaintenance, projectShadowSchemaDiagnostic,
  validateOwnedScratchState, validateShadowDatabaseInventory, validateShadowEnvironment } from './qualify-opscore-shadow.mjs';
import { validateRecoveryEvidence } from './qualify-ops-azure-target.mjs';

assert.equal(process.env.TARGET_PROFILE, 'opscore');
const name = scratchName('12345', '1', 'core');
assert.equal(name, 'corgtex_rehearsal_12345_1_core');
assert.throws(() => scratchName('0', '1', 'core'), /SHADOW_IDENTITY_INVALID/);
assert.throws(() => scratchName('12345', '1', 'admin'), /SHADOW_IDENTITY_INVALID/);
const expectedRef = `sha256:${createHash('sha256').update(`${target.host}\0${name}`).digest('hex').slice(0, 16)}`;
const retained = { schemaVersion: '1.0.0', scratchName: name, targetRef: expectedRef,
  phase: 'MIGRATION_RETAINED', scratchOid: '16384', scratchOwner: 'corgtexadmin' };
assert.equal(validateOwnedScratchState(retained, name, expectedRef).scratchOid, '16384');
for (const changed of [{ ...retained, scratchName: 'corgtex_core' }, { ...retained, scratchOid: '1; DROP DATABASE postgres' },
  { ...retained, scratchOwner: 'other' }, { ...retained, phase: 'CREATED' }]) {
  assert.throws(() => validateOwnedScratchState(changed, name, expectedRef), /SHADOW_SCRATCH_STATE_INVALID/);
}
const env = { TARGET_PROFILE: 'opscore', DOMAIN: 'ops', GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'Corgtexdotcom/corgtex', AZURE_SUBSCRIPTION_ID: '227eb707-bc46-415e-a09b-7d2b69fb14b2',
  TARGET_POSTGRES_RESOURCE_ID: targetResource, TARGET_POSTGRES_HOST: target.host,
  TARGET_POSTGRES_ADMIN_USER: 'corgtexadmin', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' };
validateShadowEnvironment(env);
for (const change of [{ GITHUB_REF: 'refs/heads/feature' }, { TARGET_POSTGRES_RESOURCE_ID: 'other' },
  { TARGET_PROFILE: 'rehearsal' }, { DOMAIN: 'core' }, { GITHUB_RUN_ID: '0' }]) {
  assert.throws(() => validateShadowEnvironment({ ...env, ...change }), /SHADOW_PROTECTED_INPUT_INVALID/);
}

const temp = mkdtempSync(join(tmpdir(), 'corgtex-shadow-fixture-'));
try {
  const stateFile = join(temp, 'core-state.json');
  writeFileSync(stateFile, JSON.stringify(retained), { mode: 0o600 });
  const config = { host: target.host, port: 5432, user: 'corgtexadmin', database: 'postgres',
    password: 'fixture', sslmode: 'verify-full', targetTlsRootCert: 'fixture' };
  const systemDatabases = ['azure_maintenance', 'azure_sys', 'postgres', 'template0', 'template1']
    .map(databaseName => ({ name: databaseName }));
  const lockEvents = [];
  const maintenanceDeadline = Date.now() + 40;
  let lockSignal;
  await withScratchMaintenance({ api: {}, intent: {}, config, deadline: maintenanceDeadline,
    workAbortReserveMs: 20,
    maintenanceFactory: async ({ signal }) => {
      lockSignal = signal;
      return { signal, async close() { lockEvents.push('close'); } };
    },
    work: async maintenance => {
      await new Promise(resolve => setTimeout(resolve, 70));
      assert.equal(maintenance.signal.aborted, true);
      assert.equal(lockSignal.aborted, false);
      lockEvents.push('work-complete');
    } });
  assert.deepEqual(lockEvents, ['work-complete', 'close']);
  assert.equal(validateShadowDatabaseInventory(systemDatabases).status, 'SHADOW_DATABASE_INVENTORY_EMPTY');
  for (const extra of [name, 'corgtex_core', 'unrecognized_database']) {
    assert.throws(() => validateShadowDatabaseInventory([...systemDatabases, { name: extra }]),
      /SHADOW_DATABASE_INVENTORY_UNRECONCILED/);
  }
  const inventoryClientFactory = inventory => () => ({ async connect() {}, async end() {}, async query(sql) {
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: 'postgres', login: 'corgtexadmin', role: 'corgtexadmin' }] };
    if (sql.startsWith('SELECT datname AS name FROM pg_database')) return { rows: inventory };
    throw Error('unexpected SQL');
  } });
  assert.equal((await inspectShadowDatabaseInventory({ config,
    clientFactory: inventoryClientFactory(systemDatabases) })).status, 'SHADOW_DATABASE_INVENTORY_EMPTY');
  await assert.rejects(inspectShadowDatabaseInventory({ config,
    clientFactory: inventoryClientFactory([...systemDatabases, { name }]) }),
  /SHADOW_DATABASE_INVENTORY_UNRECONCILED/);
  const calls = [];
  const rows = { present: [{ name, oid: '16384', owner: 'corgtexadmin', template: false }] };
  const clientFactory = () => ({ async connect() {}, async end() {}, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ database: 'postgres', login: 'corgtexadmin', role: 'corgtexadmin' }] };
    if (sql.startsWith('SELECT datname AS name')) return { rows: rows.present };
    if (sql.startsWith('DROP DATABASE')) { rows.present = []; return { rows: [] }; }
    if (sql.startsWith('SELECT datname FROM')) return { rows: rows.present };
    throw Error('unexpected SQL');
  } });
  const result = await cleanupOwnedScratch({ config, stateFile, expectedName: name, clientFactory });
  assert.equal(result.dropped, true);
  assert.equal(calls.filter(call => call.sql.startsWith('DROP DATABASE')).length, 1);
  rows.present = [{ name, oid: '16385', owner: 'corgtexadmin', template: false }];
  await assert.rejects(cleanupOwnedScratch({ config, stateFile, expectedName: name, clientFactory }),
    /SHADOW_SCRATCH_OWNERSHIP_UNPROVEN/);
  assert.equal(calls.filter(call => call.sql.startsWith('DROP DATABASE')).length, 1);
  await assert.rejects(cleanupOwnedScratch({ config, stateFile: join(temp, 'missing.json'),
    expectedName: name, clientFactory }), /SHADOW_SCRATCH_OWNERSHIP_UNPROVEN/);
  rows.present = [];
  const ambiguousState = join(temp, 'ambiguous-state.json');
  writeFileSync(ambiguousState, JSON.stringify({ schemaVersion: '1.0.0', scratchName: name,
    targetRef: expectedRef, phase: 'MIGRATION_ABSENCE_VERIFIED' }), { mode: 0o600 });
  await assert.rejects(cleanupOwnedScratch({ config, stateFile: ambiguousState,
    expectedName: name, clientFactory }), /SHADOW_CREATE_UNRESOLVED/);
  assert.equal((await cleanupOwnedScratch({ config, stateFile: ambiguousState,
    expectedName: name, clientFactory, settledRecovery: true })).absent, true);

  const order = [];
  const intent = { runId: '12345', runAttempt: '1', computeSku: 'Standard_B2s',
    workDeadline: Date.now() + 60_000 };
  const restored = await restoreBothDomains({ api: {}, intent, config, sources: { core: {}, ops: {} },
    directory: temp, tempRoot: temp,
    maintenanceFactory: async () => ({ signal: new AbortController().signal,
      async assertHeld() { order.push('lock'); }, async close() { order.push('close'); } }),
    restore: async options => { order.push(options.domain); assert.equal(options.productionMode, true);
      assert.equal(options.scratchName, scratchName('12345', '1', options.domain));
      await options.assertCustody(); return { evidence: {} }; },
    verifyParity: () => ({ status: 'POSTGRES_DATABASE_PARITY_VERIFIED', tableCount: 1,
      totalRowCount: 2, migrationCount: 3, evidenceSha256: 'a'.repeat(64) }),
    admitCapture: async () => { order.push('capture'); return { status: 'FRESH_DISABLED_CAPTURE_ADMITTED' }; },
  });
  assert.equal(restored.status, 'OPSCORE_SHADOW_PARITY_VERIFIED');
  assert.deepEqual(order, ['capture', 'core', 'lock', 'ops', 'lock', 'close']);
  const classes = ['EXTENSION', 'TYPE', 'FUNCTION', 'TABLE', 'CONSTRAINT', 'INDEX',
    'TRIGGER', 'POLICY', 'VIEW', 'COMMENT', 'OTHER'];
  const tokens = ['DDL_TOKEN', 'STRING_LITERAL', 'DOLLAR_BODY', 'META_COMMAND'];
  const side = () => ({ statementClasses: Object.fromEntries(classes.map(key => [key, key === 'INDEX' ? 1 : 0])),
    tokenDomains: Object.fromEntries(tokens.map(key => [key, key === 'DDL_TOKEN' ? 3 : 0])) });
  const diagnostic = { schemaVersion: '1.0.0', classification: 'EXECUTABLE_SCHEMA_DIFFERENCE',
    sourceOnly: side(), destinationOnly: side(), truncated: false,
    constraintSemantics: { schemaVersion: '1.0.0', mismatchCount: 0, mismatchFields: [], truncated: false },
    customerPayload: 'CLIENT_PRIVATE_SENTINEL' };
  assert.equal(projectShadowSchemaDiagnostic(diagnostic).sourceOnly.statementClasses.INDEX, 1);
  assert.throws(() => projectShadowSchemaDiagnostic({ ...diagnostic, sourceOnly: {
    ...side(), statementClasses: { ...side().statementClasses, INDEX: -1 } } }), /SHADOW_DIAGNOSTIC_INVALID/);
  assert.throws(() => projectShadowSchemaDiagnostic({ ...diagnostic, constraintSemantics: {
    ...diagnostic.constraintSemantics, truncated: 'CLIENT_PRIVATE_SENTINEL' } }), /SHADOW_DIAGNOSTIC_INVALID/);
  await assert.rejects(restoreBothDomains({ api: {}, intent, config, sources: { core: {}, ops: {} },
    directory: temp, tempRoot: temp,
    maintenanceFactory: async () => ({ signal: new AbortController().signal,
      async assertHeld() {}, async close() {} }),
    restore: async options => {
      if (options.domain === 'ops') writeFileSync(join(options.artifactDir, 'schema-diagnostic.json'),
        JSON.stringify(diagnostic), { mode: 0o600 });
      return { evidence: { domain: options.domain } };
    },
    verifyParity: evidence => {
      if (evidence.domain === 'ops') throw Error('SCHEMA_DIGEST_MISMATCH');
      return { status: 'POSTGRES_DATABASE_PARITY_VERIFIED', tableCount: 1,
        totalRowCount: 2, migrationCount: 3, evidenceSha256: 'a'.repeat(64) };
    },
    admitCapture: async () => ({ status: 'FRESH_DISABLED_CAPTURE_ADMITTED' }),
  }), /SCHEMA_DIGEST_MISMATCH/);
  const failureText = readFileSync(join(temp, 'shadow-failure.json'), 'utf8');
  const failure = JSON.parse(failureText);
  assert.deepEqual({ domain: failure.domain, code: failure.code, diagnosticStatus: failure.diagnosticStatus },
    { domain: 'ops', code: 'SCHEMA_DIGEST_MISMATCH', diagnosticStatus: 'CATEGORIES_RETAINED' });
  assert.equal(failure.schema.constraintMismatchCount, 0);
  assert.ok(!failureText.includes('CLIENT_PRIVATE_SENTINEL'));
  const denied = [];
  await assert.rejects(restoreBothDomains({ api: {}, intent, config, sources: { core: {}, ops: {} },
    directory: temp, tempRoot: temp,
    maintenanceFactory: async () => ({ signal: new AbortController().signal,
      async assertHeld() {}, async close() { denied.push('close'); } }),
    admitCapture: async () => { throw Error('CAPTURE_TRIAL_SETTINGS_UNSAFE'); },
    restore: async () => { denied.push('customer-bytes'); return { evidence: {} }; },
  }), /CAPTURE_TRIAL_SETTINGS_UNSAFE/);
  assert.deepEqual(denied, ['close']);
  denied.length = 0;
  await assert.rejects(restoreBothDomains({ api: {}, intent, config, sources: { core: {}, ops: {} },
    directory: temp, tempRoot: temp,
    maintenanceFactory: async () => ({ signal: new AbortController().signal,
      async assertHeld() {}, async close() { denied.push('close'); } }),
    admitCapture: async () => validateShadowDatabaseInventory([...systemDatabases, { name }]),
    restore: async () => { denied.push('customer-bytes'); return { evidence: {} }; },
  }), /SHADOW_DATABASE_INVENTORY_UNRECONCILED/);
  assert.deepEqual(denied, ['close']);
} finally { rmSync(temp, { recursive: true, force: true }); }

const workflow = parse(readFileSync('.github/workflows/azure-migration-postgres-rehearsal.yml', 'utf8'));
assert.ok(workflow.on.workflow_dispatch.inputs.operation.options.includes('qualify-opscore-shadow'));
const job = workflow.jobs['qualify-opscore-shadow'];
assert.equal(job.environment, 'azure-migration-foundation');
assert.equal(job['timeout-minutes'], 110);
assert.equal(job.env.DOMAIN, '${{ inputs.domain }}');
assert.equal(job.env.TARGET_PROFILE, 'opscore');
assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));
assert.ok(job.steps.some(step => step.name?.includes('Persist shadow lifecycle intent before START')));
assert.ok(job.steps.some(step => step.name?.includes('Drop only owned scratch databases')));
assert.ok(job.steps.find(step => step.name?.includes('Upload private shadow receipts'))?.with?.path
  .includes('core-scratch-state.json'));
assert.ok(job.steps.find(step => step.name?.includes('Upload private shadow receipts'))?.with?.path
  .includes('shadow-failure.json'));
assert.ok(!job.steps.find(step => step.name?.includes('Upload private shadow receipts'))?.with?.path
  .includes('core-evidence'));
const recoveryJob = workflow.jobs['recover-opscore-shadow'];
assert.equal(recoveryJob['timeout-minutes'], 100);
assert.equal(recoveryJob.env.DOMAIN, '${{ inputs.domain }}');
assert.ok(recoveryJob.if.includes("inputs.recovery_kind == 'opscore-shadow'"));
assert.ok(recoveryJob.steps.find(step => step.name?.includes('Persist scratch recovery intent')));
assert.ok(recoveryJob.steps.find(step => step.name?.includes('Close recovery window'))?.if.includes('always()'));

const createdAt = Date.now();
const common = { path: '.github/workflows/azure-migration-postgres-rehearsal.yml', head_branch: 'main',
  event: 'workflow_dispatch', workflow_id: 7, run_attempt: 1 };
const source = { ...common, id: 12345, status: 'completed', created_at: new Date(createdAt - 1000).toISOString() };
const current = { ...common, id: 12346, status: 'in_progress', created_at: new Date(createdAt + 1000).toISOString() };
const original = { runId: '12345', runAttempt: '1', createdAt, targetProfile: 'opscore' };
const recoveryEvidence = () => ({ source, current, runs: { total_count: 2, workflow_runs: [source, current] },
  marker: { runId: '12345', runAttempt: '1' }, receipt: { status: 'OPSCORE_SHADOW_CLEANUP_UNPROVEN' },
  jobs: { total_count: 1, jobs: [{ name: 'Shadow restore Core and Ops on pinned B2s without cutover', status: 'completed',
    steps: [
      { name: 'Restore both read-only Railway snapshots to protected scratch databases', status: 'completed', conclusion: 'failure' },
      { name: 'Drop only owned scratch databases and close the public window', status: 'completed', conclusion: 'failure' },
    ] }] } });
assert.doesNotThrow(() => validateRecoveryEvidence(original, { GITHUB_RUN_ID: '12346', GITHUB_RUN_ATTEMPT: '1' },
  recoveryEvidence(), 'shadow'));
assert.throws(() => validateRecoveryEvidence(original, { GITHUB_RUN_ID: '12346', GITHUB_RUN_ATTEMPT: '1' },
  { ...recoveryEvidence(), receipt: { status: 'OPSCORE_SHADOW_CLEANED' } }, 'shadow'), /RECOVERY_ALREADY_CLEANED/);
