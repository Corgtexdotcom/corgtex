#!/usr/bin/env node
// Protected, bounded Core+Ops source snapshot on the exact stopped B2s target.
// This proves PostgreSQL parity only; it never fences writers or activates apps.
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { Azure, cleanup, prepare, qualify, readIntent, recoveryEvidence, validateIntent, validateRules, validateServer,
  SUBSCRIPTION } from './qualify-ops-azure-target.mjs';
import { GROUP, SERVER } from './qualify-ops-azure-target.mjs';
import { target, TARGET_PROFILE, targetResource } from './ops-core-target-profile.mjs';
import { openPostgresMaintenance } from './ops-core-postgres-maintenance.mjs';
import { connectionConfig } from './probe-ops-azure-target.mjs';
import { ACCESS_SETTING_NAMES, assertDisabledCapture, captureSharedPostgresAccess } from './probe-shared-postgres-access.mjs';
import { nodeClientConfig, parseSourceDatabaseUrl, runPostgresRestoreRehearsal,
  targetDatabaseConfigFromEnv, validateSourceTlsRootCertificate } from './run-postgres-restore-rehearsal.mjs';
import { validatePostgresDatabaseParity } from './validate-postgres-restore-rehearsal.mjs';

const fail = code => { throw new Error(code); };
const need = (value, code) => { if (!value) fail(code); };
const numeric = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const oid = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && BigInt(value) <= 4294967295n;
const exactKeys = (value, keys) => value && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...keys].sort().join();
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const SYSTEM_DATABASES = new Set(['azure_maintenance', 'azure_sys', 'postgres', 'template0', 'template1']);
const SCHEMA_CLASSES = ['EXTENSION', 'TYPE', 'FUNCTION', 'TABLE', 'CONSTRAINT', 'INDEX',
  'TRIGGER', 'POLICY', 'VIEW', 'COMMENT', 'OTHER'];
const TOKEN_DOMAINS = ['DDL_TOKEN', 'STRING_LITERAL', 'DOLLAR_BODY', 'META_COMMAND'];
const CONSTRAINT_FIELDS = new Set(['IDENTITY_SET', 'TYPE', 'VALIDATION', 'ENFORCEMENT',
  'INHERITANCE', 'DEFERRABILITY', 'PERIOD', 'FK_ACTION', 'PARENTAGE', 'BINDING',
  'DEFINITION', 'CHECK_EXPRESSION', 'EXTENSION_OWNERSHIP']);

// The restore runner's full evidence stays ephemeral. This projection contains
// only bounded category counts, so a failed parity check remains diagnosable.
export function projectShadowSchemaDiagnostic(diagnostic) {
  need(diagnostic?.schemaVersion === '1.0.0'
    && diagnostic.classification === 'EXECUTABLE_SCHEMA_DIFFERENCE', 'SHADOW_DIAGNOSTIC_INVALID');
  const counts = (value, keys) => {
    need(exactKeys(value, keys), 'SHADOW_DIAGNOSTIC_INVALID');
    for (const key of keys) need(Number.isSafeInteger(value[key]) && value[key] >= 0
      && value[key] <= 1_000_000, 'SHADOW_DIAGNOSTIC_INVALID');
    return Object.fromEntries(keys.map(key => [key, value[key]]));
  };
  const side = value => ({ statementClasses: counts(value?.statementClasses, SCHEMA_CLASSES),
    tokenDomains: counts(value?.tokenDomains, TOKEN_DOMAINS) });
  const semantics = diagnostic.constraintSemantics;
  need(typeof diagnostic.truncated === 'boolean' && semantics?.schemaVersion === '1.0.0'
    && Number.isSafeInteger(semantics.mismatchCount) && semantics.mismatchCount >= 0
    && semantics.mismatchCount <= 1_000_000 && Array.isArray(semantics.mismatchFields)
    && semantics.mismatchFields.every(field => CONSTRAINT_FIELDS.has(field))
    && new Set(semantics.mismatchFields).size === semantics.mismatchFields.length,
  'SHADOW_DIAGNOSTIC_INVALID');
  return { classification: diagnostic.classification, sourceOnly: side(diagnostic.sourceOnly),
    destinationOnly: side(diagnostic.destinationOnly), constraintMismatchCount: semantics.mismatchCount,
    constraintMismatchFields: semantics.mismatchFields, truncated: diagnostic.truncated || semantics.truncated === true };
}

export function validateShadowDatabaseInventory(databases) {
  need(Array.isArray(databases) && databases.length > 0 && databases.length <= 1000,
    'SHADOW_DATABASE_INVENTORY_INVALID');
  const names = databases.map(row => row?.name);
  need(names.every(name => typeof name === 'string' && SYSTEM_DATABASES.has(name))
    && names.includes('postgres') && new Set(names).size === names.length,
  'SHADOW_DATABASE_INVENTORY_UNRECONCILED');
  return { status: 'SHADOW_DATABASE_INVENTORY_EMPTY', databaseCount: names.length };
}

export async function inspectShadowDatabaseInventory({ config, clientFactory = value => new pg.Client(value) }) {
  need(config.database === 'postgres' && config.user === 'corgtexadmin'
    && config.host === target.host && config.sslmode === 'verify-full', 'SHADOW_INVENTORY_TARGET_INVALID');
  const client = clientFactory(nodeClientConfig({ ...config, statementTimeoutMillis: 25_000 },
    'corgtex_shadow_inventory', 30_000, 30_000));
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database, session_user AS login, current_user AS role');
    need(identity.rows?.length === 1 && identity.rows[0].database === 'postgres'
      && identity.rows[0].login === config.user && identity.rows[0].role === config.user,
    'SHADOW_INVENTORY_SQL_IDENTITY_INVALID');
    const databases = await client.query('SELECT datname AS name FROM pg_database ORDER BY datname');
    return validateShadowDatabaseInventory(databases.rows);
  } finally { await client.end().catch(() => {}); }
}

export function scratchName(runId, attempt, domain) {
  need(numeric(runId) && numeric(attempt) && ['core', 'ops'].includes(domain), 'SHADOW_IDENTITY_INVALID');
  const value = `corgtex_rehearsal_${runId}_${attempt}_${domain}`;
  need(value.length <= 63, 'SHADOW_SCRATCH_NAME_INVALID');
  return value;
}

export function validateShadowEnvironment(env, recovery = false) {
  need(TARGET_PROFILE === 'opscore' && env.TARGET_PROFILE === 'opscore' && env.DOMAIN === 'ops'
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_REPOSITORY === 'Corgtexdotcom/corgtex'
    && env.AZURE_SUBSCRIPTION_ID === SUBSCRIPTION
    && env.TARGET_POSTGRES_RESOURCE_ID === targetResource
    && env.TARGET_POSTGRES_HOST === target.host
    && env.TARGET_POSTGRES_ADMIN_USER === 'corgtexadmin'
    && numeric(env.GITHUB_RUN_ID) && numeric(env.GITHUB_RUN_ATTEMPT), 'SHADOW_PROTECTED_INPUT_INVALID');
  need(!recovery || (numeric(env.RECOVERY_RUN_ID) && numeric(env.RECOVERY_RUN_ATTEMPT)), 'SHADOW_RECOVERY_IDENTITY_INVALID');
  need(recovery || (!env.RECOVERY_RUN_ID && !env.RECOVERY_RUN_ATTEMPT), 'SHADOW_RECOVERY_INPUT_UNEXPECTED');
}

const stateFor = (dir, domain) => `${dir}/${domain}-scratch-state.json`;
const evidenceFor = (dir, domain) => `${dir}/${domain}-evidence`;
const targetConfig = async (api, env) => ({ ...targetDatabaseConfigFromEnv({ ...env,
  TARGET_POSTGRES_ADMIN_PASSWORD: await api.readAdminSecret() }, 'postgres'), statementTimeoutMillis: 120_000 });

export function validateOwnedScratchState(state, expectedName, expectedRef) {
  need(state?.schemaVersion === '1.0.0' && state.scratchName === expectedName
    && state.targetRef === expectedRef, 'SHADOW_SCRATCH_STATE_INVALID');
  if (state.phase === 'MIGRATION_INTENT' || state.phase === 'MIGRATION_ABSENCE_VERIFIED') {
    need(exactKeys(state, ['schemaVersion', 'scratchName', 'targetRef', 'phase']), 'SHADOW_SCRATCH_STATE_INVALID');
    return { phase: state.phase, scratchOid: null, scratchOwner: null };
  }
  need(state.phase === 'MIGRATION_RETAINED'
    && exactKeys(state, ['schemaVersion', 'scratchName', 'targetRef', 'phase', 'scratchOid', 'scratchOwner'])
    && oid(state.scratchOid) && state.scratchOwner === 'corgtexadmin', 'SHADOW_SCRATCH_STATE_INVALID');
  return state;
}

function readState(path, maxBytes = 4096) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    need(stat.isFile() && stat.size > 0 && stat.size <= maxBytes, 'SHADOW_SCRATCH_STATE_INVALID');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export async function cleanupOwnedScratch({ config, stateFile, expectedName, settledRecovery = false,
  clientFactory = value => new pg.Client(value) }) {
  need(/^corgtex_rehearsal_[1-9][0-9]*_[1-9][0-9]*_(core|ops)$/.test(expectedName)
    && expectedName.length <= 63 && config.database === 'postgres' && config.user === 'corgtexadmin'
    && config.host === target.host && config.sslmode === 'verify-full', 'SHADOW_CLEANUP_TARGET_INVALID');
  const expectedRef = `sha256:${createHash('sha256')
    .update(`${config.host}\0${expectedName}`).digest('hex').slice(0, 16)}`;
  const state = existsSync(stateFile) ? validateOwnedScratchState(readState(stateFile), expectedName, expectedRef) : null;
  const client = clientFactory(nodeClientConfig({ ...config, statementTimeoutMillis: 25_000 },
    'corgtex_shadow_cleanup', 30_000, 30_000));
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database, session_user AS login, current_user AS role');
    need(identity.rows?.length === 1 && identity.rows[0].database === 'postgres'
      && identity.rows[0].login === config.user && identity.rows[0].role === config.user,
    'SHADOW_CLEANUP_SQL_IDENTITY_INVALID');
    const rows = (await client.query(`SELECT datname AS name, oid::text AS oid, pg_get_userbyid(datdba) AS owner, datistemplate AS template
      FROM pg_database WHERE datname=$1 OR ($2::oid IS NOT NULL AND oid=$2::oid)`,
    [expectedName, state?.scratchOid ?? null])).rows;
    need(Array.isArray(rows) && rows.length <= 1, 'SHADOW_SCRATCH_IDENTITY_CHANGED');
    if (rows.length === 0) {
      // ABSENCE_VERIFIED precedes CREATE. A lost CREATE acknowledgement may still
      // materialize after this read. Only a later, stopped-and-restarted recovery
      // run can establish terminal absence for that phase.
      need(state?.phase !== 'MIGRATION_ABSENCE_VERIFIED' || settledRecovery, 'SHADOW_CREATE_UNRESOLVED');
      return { name: expectedName, absent: true, dropped: false };
    }
    need(state?.phase === 'MIGRATION_RETAINED' && rows[0].name === expectedName
      && rows[0].oid === state.scratchOid && rows[0].owner === state.scratchOwner
      && rows[0].template === false, 'SHADOW_SCRATCH_OWNERSHIP_UNPROVEN');
    await client.query(`DROP DATABASE "${expectedName}" WITH (FORCE)`);
    const remaining = (await client.query('SELECT datname FROM pg_database WHERE datname=$1 OR oid=$2::oid',
      [expectedName, state.scratchOid])).rows;
    need(Array.isArray(remaining) && remaining.length === 0, 'SHADOW_SCRATCH_CLEANUP_UNPROVEN');
    return { name: expectedName, absent: true, dropped: true };
  } finally { await client.end().catch(() => {}); }
}

export async function withScratchMaintenance({ api, intent, config, deadline, work, workAbortReserveMs = 0,
  maintenanceFactory = openPostgresMaintenance }) {
  const controller = new AbortController();
  const workAbort = new AbortController();
  const timer = workAbortReserveMs > 0
    ? setTimeout(() => workAbort.abort(new Error('SHADOW_WORK_DEADLINE')),
      Math.max(1, deadline - Date.now() - workAbortReserveMs)) : null;
  const assertOwned = async () => {
    controller.signal.throwIfAborted();
    need(Date.now() < deadline, 'SHADOW_DEADLINE');
    await api.identity(); await api.boundary(); await api.authority();
    const server = validateServer(await api.server(), true, 'Standard_B2s');
    need(server.state === 'Ready' && server.network.publicNetworkAccess === 'Enabled', 'SHADOW_TARGET_NOT_READY');
    need(validateRules(await api.rules(), intent).length === 1, 'SHADOW_FIREWALL_UNPROVEN');
  };
  let maintenance;
  try {
    maintenance = await maintenanceFactory({ config, expected: { host: target.host, port: config.port,
      database: 'postgres', user: config.user }, signal: controller.signal, assertOwned });
    return await work({ ...maintenance, signal: AbortSignal.any([maintenance.signal, workAbort.signal]) });
  } finally {
    if (timer !== null) clearTimeout(timer);
    // The work deadline may cancel child work, but only settled work releases
    // the maintenance session. Never abort its liveness signal first.
    await maintenance?.close().catch(() => {});
    controller.abort();
  }
}

export function sourceConfigs(env) {
  return Object.fromEntries(['core', 'ops'].map(domain => {
    const sourceUrl = env[`RAILWAY_${domain.toUpperCase()}_POSTGRES_READ_ONLY_URL`];
    const sourceRoot = env[`RAILWAY_${domain.toUpperCase()}_POSTGRES_TLS_ROOT_CERT`];
    need(typeof sourceUrl === 'string' && typeof sourceRoot === 'string', 'SHADOW_SOURCE_CREDENTIAL_MISSING');
    return [domain, { ...parseSourceDatabaseUrl(sourceUrl), statementTimeoutMillis: 120_000,
      sourceTlsRootCert: validateSourceTlsRootCertificate(sourceRoot) }];
  }));
}

export async function admitPrivateCustomerSnapshot({ api, config, directory,
  capture = captureSharedPostgresAccess, assertCapture = assertDisabledCapture }) {
  const parameterNames = new Set(ACCESS_SETTING_NAMES);
  const rows = await api.call(['postgres', 'flexible-server', 'parameter', 'list',
    '--resource-group', GROUP, '--server-name', SERVER]);
  need(Array.isArray(rows) && rows.length <= 1000, 'SHADOW_PARAMETER_READ_INVALID');
  const parameters = rows.filter(row => parameterNames.has(row?.name))
    .map(row => ({ name: row.name, value: String(row.value ?? ''),
      pendingRestart: row.isConfigPendingRestart ?? null }));
  const readonly = await connectionConfig({ TARGET_POSTGRES_RESOURCE_ID: targetResource,
    TARGET_POSTGRES_HOST: target.host, TARGET_POSTGRES_ADMIN_USER: config.user,
    TARGET_POSTGRES_ADMIN_PASSWORD: config.password });
  const receipt = await capture(new pg.Client(readonly), { deadlineMs: 120000,
    azureParameters: parameters, providerClientFactory: database => new pg.Client({ ...readonly, database }) });
  assertCapture(receipt);
  validateShadowDatabaseInventory(receipt.databases);
  const result = { status: 'FRESH_DISABLED_CAPTURE_ADMITTED',
    snapshotSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex') };
  save(`${directory}/capture-admission.json`, result);
  return result;
}

export async function restoreBothDomains({ api, intent, config, sources, directory, tempRoot,
  restore = runPostgresRestoreRehearsal, maintenanceFactory = openPostgresMaintenance,
  verifyParity = validatePostgresDatabaseParity, admitCapture = admitPrivateCustomerSnapshot }) {
  need(intent.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
  return withScratchMaintenance({ api, intent, config, deadline: intent.workDeadline,
    workAbortReserveMs: 120_000, maintenanceFactory,
    work: async maintenance => {
    const captureAdmission = await admitCapture({ api, config, directory });
    need(captureAdmission?.status === 'FRESH_DISABLED_CAPTURE_ADMITTED', 'SHADOW_CAPTURE_ADMISSION_UNPROVEN');
    const summaries = [];
    for (const domain of ['core', 'ops']) {
      const domainTemp = resolve(tempRoot, domain), domainEvidence = evidenceFor(directory, domain);
      mkdirSync(domainTemp, { recursive: true, mode: 0o700 });
      mkdirSync(domainEvidence, { recursive: true, mode: 0o700 });
      try {
        const result = await restore({ domain,
          sourceConfig: { ...sources[domain], shadowSignal: maintenance.signal,
            shadowDeadline: intent.workDeadline - 120_000 },
          targetAdminConfig: { ...config, shadowSignal: maintenance.signal,
            shadowDeadline: intent.workDeadline - 120_000 },
          scratchName: scratchName(intent.runId, intent.runAttempt, domain),
          artifactDir: domainEvidence, tempDir: domainTemp, stateFile: stateFor(directory, domain),
          productionMode: true, signal: maintenance.signal,
          commandDeadline: intent.workDeadline,
          assertCustody: async () => { await maintenance.assertHeld(); },
          beforeRestore: async () => { await maintenance.assertHeld(); },
        });
        const parity = verifyParity(result.evidence, { requireFrozenSourceSequences: true });
        summaries.push({ domain, status: parity.status, tableCount: parity.tableCount,
          totalRowCount: parity.totalRowCount, migrationCount: parity.migrationCount,
          evidenceSha256: parity.evidenceSha256 });
      } catch (error) {
        const code = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'SHADOW_UNEXPECTED_FAILURE';
        const receipt = { domain, code, diagnosticStatus: 'UNAVAILABLE' };
        if (code === 'SCHEMA_DIGEST_MISMATCH' && existsSync(`${domainEvidence}/schema-diagnostic.json`)) {
          try {
            const diagnostic = projectShadowSchemaDiagnostic(readState(`${domainEvidence}/schema-diagnostic.json`, 65_536));
            receipt.diagnosticStatus = 'CATEGORIES_RETAINED';
            receipt.schema = diagnostic;
          } catch { /* Keep the original parity failure and omit unsafe diagnostic data. */ }
        }
        try { save(`${directory}/shadow-failure.json`, receipt); } catch { /* Preserve the original failure. */ }
        throw error;
      } finally {
        rmSync(domainEvidence, { recursive: true, force: true });
        rmSync(domainTemp, { recursive: true, force: true });
      }
    }
    return { status: 'OPSCORE_SHADOW_PARITY_VERIFIED', computeSku: intent.computeSku,
      captureAdmission, domains: summaries, workloadQualified: false, managedBackupRecoveryQualified: false,
      productionAccepted: false };
  } });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  need(args.length === 2 && ['prepare', 'run', 'cleanup', 'recover-close', 'recover-run', 'recover-cleanup'].includes(args[0]),
    'SHADOW_ARGS_INVALID');
  const [mode, directory] = args;
  const recovery = mode.startsWith('recover-');
  validateShadowEnvironment(env, recovery);
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const api = new Azure(env);
  const path = `${dir}/qualification-intent.json`;
  if (mode === 'prepare') {
    await targetConfig(api, env);
    const intent = await prepare(api, { runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT, ipv4: env.QUALIFY_RUNNER_IPV4 });
    need(intent.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
    save(path, intent);
    return { status: 'OPSCORE_SHADOW_PREPARED', deadline: intent.deadline };
  }
  if (recovery) {
    const original = validateIntent(readIntent(path), env.RECOVERY_RUN_ID, env.RECOVERY_RUN_ATTEMPT);
    need(original.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
    const newPath = `${dir}/recovery-intent.json`;
    if (mode === 'recover-close') {
      api.verifyRecovery = () => recoveryEvidence(original, env, dir, fetch, 'shadow');
      await api.verifyRecovery(); // Completed source, unsucceeded cleanup and no intervening protected run.
      await api.identity(); await api.boundary();
      const server = validateServer(await api.server(), true, 'Standard_B2s');
      const rules = validateRules(await api.rules(), original);
      if (!(server.state === 'Stopped' && server.network.publicNetworkAccess === 'Disabled' && rules.length === 0)) {
        const result = await cleanup(api, original, undefined, true);
        need(result.serverStopped && result.firewallAbsent, 'SHADOW_SOURCE_WINDOW_UNPROVEN');
      }
      save(`${dir}/source-window-closure.json`, { status: 'SOURCE_WINDOW_CLOSED',
        runId: original.runId, runAttempt: original.runAttempt });
      api.deadline = undefined;
      const next = await prepare(api, { runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT, ipv4: env.QUALIFY_RUNNER_IPV4 });
      need(next.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
      save(newPath, next);
      return { status: 'OPSCORE_SHADOW_RECOVERY_PREPARED', deadline: next.deadline };
    }
    const closure = readIntent(`${dir}/source-window-closure.json`);
    need(exactKeys(closure, ['status', 'runId', 'runAttempt']) && closure.status === 'SOURCE_WINDOW_CLOSED'
      && closure.runId === original.runId && closure.runAttempt === original.runAttempt,
    'SHADOW_SOURCE_WINDOW_UNPROVEN');
    const next = validateIntent(readIntent(newPath), env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
    need(next.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
    if (mode === 'recover-run') {
      const config = await targetConfig(api, env);
      return qualify(api, next, async () => withScratchMaintenance({ api, intent: next, config,
        deadline: next.workDeadline, work: async maintenance => {
          const outcomes = [];
          for (const domain of ['ops', 'core']) {
            await maintenance.assertHeld();
            outcomes.push(await cleanupOwnedScratch({ config, stateFile: stateFor(dir, domain),
              expectedName: scratchName(original.runId, original.runAttempt, domain), settledRecovery: true }));
          }
          await maintenance.assertHeld();
          const inventory = await inspectShadowDatabaseInventory({ config });
          const receipt = { status: 'SOURCE_SHADOW_SCRATCH_ABSENT',
            names: outcomes.map(outcome => outcome.name), allAbsent: outcomes.every(outcome => outcome.absent),
            databaseInventory: inventory.status };
          save(`${dir}/recovery-scratch.json`, receipt);
          return receipt;
        } }), () => save(`${dir}/recovery-start-attempt.json`, {
        runId: next.runId, runAttempt: next.runAttempt }));
    }
    if (!existsSync(`${dir}/recovery-start-attempt.json`)) {
      save(`${dir}/recovery-cleanup.json`, { status: 'RECOVERY_START_NOT_ATTEMPTED', providerEffects: 0 });
      return { status: 'RECOVERY_START_NOT_ATTEMPTED' };
    }
    let scratch = existsSync(`${dir}/recovery-scratch.json`) ? readIntent(`${dir}/recovery-scratch.json`) : null;
    const failures = [];
    if (scratch?.allAbsent !== true || scratch?.databaseInventory !== 'SHADOW_DATABASE_INVENTORY_EMPTY') {
      try {
        const config = await targetConfig(api, env);
        scratch = await withScratchMaintenance({ api, intent: next, config, deadline: next.deadline,
          work: async maintenance => {
            const outcomes = [];
            for (const domain of ['ops', 'core']) {
              await maintenance.assertHeld();
              outcomes.push(await cleanupOwnedScratch({ config, stateFile: stateFor(dir, domain),
                expectedName: scratchName(original.runId, original.runAttempt, domain), settledRecovery: true }));
            }
            await maintenance.assertHeld();
            const inventory = await inspectShadowDatabaseInventory({ config });
            return { allAbsent: outcomes.every(outcome => outcome.absent), databaseInventory: inventory.status };
          } });
      } catch (error) { failures.push(error.message); }
    }
    let lifecycle;
    try { lifecycle = await cleanup(api, next); }
    catch (error) { failures.push(error.message); }
    const result = { status: lifecycle?.serverStopped && lifecycle?.firewallAbsent && scratch?.allAbsent === true
      && scratch?.databaseInventory === 'SHADOW_DATABASE_INVENTORY_EMPTY'
      ? 'OPSCORE_SHADOW_RECOVERED' : 'OPSCORE_SHADOW_RECOVERY_UNPROVEN',
    serverStopped: lifecycle?.serverStopped ?? false, firewallAbsent: lifecycle?.firewallAbsent ?? false,
    scratchAbsent: scratch?.allAbsent ?? false, databaseInventory: scratch?.databaseInventory ?? 'UNPROVEN',
    withinWindow: lifecycle?.withinWindow ?? false,
    cleanupFailures: failures.length };
    save(`${dir}/recovery-cleanup.json`, result);
    need(result.status === 'OPSCORE_SHADOW_RECOVERED' && result.withinWindow, 'SHADOW_RECOVERY_UNPROVEN');
    return result;
  }
  if (mode === 'cleanup' && !existsSync(`${dir}/start-attempt.json`)) {
    save(`${dir}/cleanup.json`, { status: 'START_NOT_ATTEMPTED', providerEffects: 0 });
    return { status: 'START_NOT_ATTEMPTED' };
  }
  const intent = validateIntent(readIntent(path), env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  need(intent.computeSku === 'Standard_B2s', 'SHADOW_B2S_REQUIRED');
  if (mode === 'run') {
    need(typeof env.SHADOW_TEMP_DIR === 'string' && isAbsolute(env.SHADOW_TEMP_DIR), 'SHADOW_TEMP_DIR_INVALID');
    const sources = sourceConfigs(env); // Reject missing or invalid Railway credentials before START.
    const config = await targetConfig(api, env);
    const result = await qualify(api, intent, async () => restoreBothDomains({ api, intent, config, sources, directory: dir,
      tempRoot: env.SHADOW_TEMP_DIR }), () => { save(`${dir}/start-attempt.json`, {
      runId: intent.runId, runAttempt: intent.runAttempt }); });
    save(`${dir}/shadow-summary.json`, result);
    return result;
  }
  const failures = [];
  let databaseInventory = 'UNPROVEN';
  if (existsSync(`${dir}/start-attempt.json`)) {
    try {
      const config = await targetConfig(api, env);
      await withScratchMaintenance({ api, intent, config, deadline: intent.deadline, work: async maintenance => {
        for (const domain of ['ops', 'core']) {
          try { await maintenance.assertHeld(); await cleanupOwnedScratch({ config, stateFile: stateFor(dir, domain),
            expectedName: scratchName(intent.runId, intent.runAttempt, domain) }); }
          catch (error) { failures.push(error.message); }
        }
        if (failures.length === 0) {
          await maintenance.assertHeld();
          databaseInventory = (await inspectShadowDatabaseInventory({ config })).status;
        }
      } });
    } catch (error) { failures.push(error.message); }
  }
  let lifecycle;
  try { lifecycle = await cleanup(api, intent); }
  catch (error) { failures.push(error.message); }
  const receipt = { status: failures.length === 0 && databaseInventory === 'SHADOW_DATABASE_INVENTORY_EMPTY'
    && lifecycle?.serverStopped && lifecycle?.firewallAbsent
    ? 'OPSCORE_SHADOW_CLEANED' : 'OPSCORE_SHADOW_CLEANUP_UNPROVEN',
  serverStopped: lifecycle?.serverStopped ?? false, firewallAbsent: lifecycle?.firewallAbsent ?? false,
  databaseInventory, withinWindow: lifecycle?.withinWindow ?? false, scratchCleanupFailures: failures.length };
  save(`${dir}/cleanup.json`, receipt);
  need(receipt.status === 'OPSCORE_SHADOW_CLEANED' && receipt.withinWindow, 'SHADOW_CLEANUP_UNPROVEN');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.log(JSON.stringify({ status: 'OPSCORE_SHADOW_FAILED', code: /^[A-Z0-9_]+$/.test(error?.message ?? '')
      ? error.message : 'SHADOW_UNEXPECTED_FAILURE' }));
    process.exitCode = 1;
  });
}
