// Run in a separate process with TARGET_PROFILE=opscore so module pins cannot
// accidentally reuse a rehearsal import cached by another test.
import assert from 'node:assert/strict';
import { targetResource, target } from './ops-core-target-profile.mjs';
import { Azure, prepare, qualify, cleanup, validateIntent, validateServer,
  validateRecoveryEvidence } from './qualify-ops-azure-target.mjs';

assert.equal(process.env.TARGET_PROFILE, 'opscore');
const resource = targetResource;
const original = () => ({
  id: resource, name: target.server, fullyQualifiedDomainName: target.host,
  administratorLogin: 'corgtexadmin', version: '18', location: 'westus3',
  sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' },
  storage: { storageSizeGb: 32, autoGrow: 'Enabled', tier: 'P4', iops: 120 },
  backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' },
  highAvailability: { mode: 'Disabled' }, network: { publicNetworkAccess: 'Disabled' },
  authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' },
  tags: structuredClone(target.tags), state: 'Stopped',
});
const inputs = { runId: '12345', runAttempt: '1', ipv4: '203.0.113.7' };
function setup() {
  const server = original(), events = []; let rules = [];
  const clock = { time: 1700000000000, now() { return this.time; }, async sleep(ms) { this.time += ms; } };
  const api = {
    async identity() { events.push('identity'); }, async boundary() { events.push('boundary'); },
    async server() { events.push('server'); return structuredClone(server); },
    async rules() { events.push('rules'); return structuredClone(rules); },
    async start() { events.push('start'); server.state = 'Ready'; },
    async stop() { events.push('stop'); server.state = 'Stopped'; },
    async setPublicAccess(value) { events.push(`public:${value}`); server.network.publicNetworkAccess = value; },
    async createRule(i) { events.push('create'); rules = [{ id: `${resource}/firewallRules/${i.firewallName}`,
      name: i.firewallName, startIpAddress: i.ipv4, endIpAddress: i.ipv4 }]; },
    async deleteRule() { events.push('delete'); rules = []; },
  };
  return { server, events, clock, api };
}

{
  const { server, events, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  assert.equal(intent.schemaVersion, '1.2.0');
  assert.equal(intent.targetProfile, 'opscore');
  assert.equal(intent.initialPublicAccess, 'Disabled');
  assert.equal(validateIntent(intent, '12345', '1'), intent);
  let probed = false;
  await qualify(api, intent, async () => { probed = true; assert.equal(server.network.publicNetworkAccess, 'Enabled'); },
    async () => events.push('persist'), clock);
  assert.equal(probed, true);
  const cleaned = await cleanup(api, intent, clock);
  assert.equal(cleaned.serverStopped, true);
  assert.equal(server.network.publicNetworkAccess, 'Disabled');
  assert.ok(events.indexOf('persist') < events.indexOf('start'));
  assert.ok(events.indexOf('public:Enabled') < events.indexOf('create'));
  assert.ok(events.indexOf('delete') < events.indexOf('public:Disabled'));
  assert.ok(events.indexOf('public:Disabled') < events.indexOf('stop'));
}

{
  const { server, events, clock, api } = setup();
  server.network.publicNetworkAccess = 'Enabled';
  await assert.rejects(prepare(api, inputs, clock), /TARGET_NETWORK_NOT_BASELINE/);
  assert.equal(events.includes('start'), false);
}
{
  const { server, events, clock, api } = setup();
  server.sku = { name: 'Standard_B1ms', tier: 'Burstable' };
  await assert.rejects(prepare(api, inputs, clock), /TARGET_COMPUTE_UNSUPPORTED/);
  assert.equal(events.includes('start'), false);
}
{
  const { server, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  server.backup.backupRetentionDays = 7;
  await assert.rejects(qualify(api, intent, async () => {}, async () => {}, clock), /TARGET_DRIFT/);
}
{
  const { server, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  await qualify(api, intent, async () => {}, async () => {}, clock);
  server.network.publicNetworkAccess = 'Disabled';
  const cleaned = await cleanup(api, intent, clock);
  assert.equal(cleaned.serverStopped, true);
  assert.equal(server.network.publicNetworkAccess, 'Disabled');
}
{
  const { server, events, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  await qualify(api, intent, async () => {}, async () => {}, clock);
  server.state = 'Stopped';
  const cleaned = await cleanup(api, intent, clock);
  assert.equal(cleaned.serverStopped, true);
  assert.equal(server.network.publicNetworkAccess, 'Disabled');
  assert.equal(events.filter(x => x === 'start').length, 2);
}
{
  const { server, events, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  await qualify(api, intent, async () => {}, async () => {}, clock);
  api.setPublicAccess = async value => { events.push(`public-failed:${value}`); throw new Error('ambiguous provider rejection'); };
  await assert.rejects(cleanup(api, intent, clock), /PUBLIC_ACCESS_NOT_DISABLED/);
  assert.equal(server.state, 'Stopped');
  assert.equal(server.network.publicNetworkAccess, 'Enabled');
  assert.ok(events.indexOf('public-failed:Disabled') < events.indexOf('stop'));
}
{
  const { server, events, clock, api } = setup();
  const intent = await prepare(api, inputs, clock);
  await qualify(api, intent, async () => {}, async () => {}, clock);
  server.state = 'Stopping';
  const originalSleep = clock.sleep.bind(clock);
  clock.sleep = async ms => { await originalSleep(ms); server.state = 'Stopped'; };
  const cleaned = await cleanup(api, intent, clock);
  assert.equal(cleaned.serverStopped, true);
  assert.equal(server.network.publicNetworkAccess, 'Disabled');
  assert.equal(events.filter(x => x === 'start').length, 2);
  assert.ok(events.indexOf('public:Disabled') < events.lastIndexOf('stop'));
}
{
  const server = original();
  server.tags.purpose = 'foreign';
  assert.throws(() => validateServer(server), /TARGET_DRIFT/);
}
{
  const calls = [];
  const azure = new Azure({}, { execute: (_binary, args, _options, done) => {
    calls.push(args);
    done(null, JSON.stringify({ value: [{ id: `${resource}/firewallRules/rule`, name: 'rule',
      properties: { startIpAddress: '203.0.113.7', endIpAddress: '203.0.113.7' } }] }));
  } });
  const rules = await azure.rules();
  assert.equal(rules[0].startIpAddress, '203.0.113.7');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`https://management.azure.com${resource}/firewallRules?api-version=2025-08-01`));
}
{
  const calls = [];
  const azure = new Azure({}, { execute: (_binary, args, options, done) => {
    calls.push({ args, options });
    done(null, JSON.stringify({ id: target.adminSecretId, attributes: { enabled: true }, value: 'x'.repeat(32) }));
  } });
  azure.identity = async () => {};
  azure.authority = async () => {};
  assert.equal(await azure.readAdminSecret(), 'x'.repeat(32));
  assert.deepEqual(calls[0].args.slice(0, 4), ['keyvault', 'secret', 'show', '--id']);
  assert.equal(calls[0].args[4], target.adminSecretId);
  assert.equal(calls[0].options.env.TARGET_POSTGRES_ADMIN_PASSWORD, undefined);
}
{
  const { api, clock } = setup();
  const intent = await prepare(api, inputs, clock);
  const common = { path: '.github/workflows/azure-migration-postgres-rehearsal.yml',
    head_branch: 'main', event: 'workflow_dispatch', workflow_id: 7, run_attempt: 1 };
  const source = { ...common, id: 12345, status: 'completed', created_at: new Date(intent.createdAt - 1000).toISOString() };
  const current = { ...common, id: 12346, status: 'in_progress', created_at: new Date(intent.createdAt + 1000).toISOString() };
  const values = { source, current, runs: { total_count: 2, workflow_runs: [source, current] },
    marker: { runId: '12345', runAttempt: '1' }, receipt: null,
    jobs: { total_count: 1, jobs: [{ name: 'Qualify pinned Ops/Core PG18 target capture', status: 'completed', steps: [
      { name: 'Start Ops/Core target, open single-IP access and test disabled capture', status: 'completed', conclusion: 'failure' },
      { name: 'Remove qualification access and return target to Stopped', status: 'completed', conclusion: 'failure' },
    ] }] } };
  const env = { GITHUB_RUN_ID: '12346', GITHUB_RUN_ATTEMPT: '1' };
  assert.doesNotThrow(() => validateRecoveryEvidence(intent, env, values));
  values.jobs.jobs[0].name = 'Qualify existing Ops target metadata only';
  assert.throws(() => validateRecoveryEvidence(intent, env, values), /RECOVERY_JOB_UNPROVEN/);
}
