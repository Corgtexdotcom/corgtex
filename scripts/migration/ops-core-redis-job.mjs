import { AzureCliCredential } from "@azure/identity";
import { setTimeout as delay } from "node:timers/promises";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { REDIS_PROBE_PREFIX } from "./ops-core-redis-probe.mjs";

const API = "2025-07-01";
const GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ROOT = "^/subscriptions/([a-f0-9-]{36})/resourceGroups/[a-zA-Z0-9_.()-]{1,90}/providers/";
const armId = (value, type) => new RegExp(`${ROOT}${type}/[a-zA-Z0-9-]{1,80}$`).test(value);
class JobError extends Error {}
const need = (value, code) => { if (!value) throw new JobError(code); };
const same = (a, b) => hash(a) === hash(b);
const armSame = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const identityRefs = rows => Array.isArray(rows) ? rows.map(row => ({ ...row,
  ...(typeof row.identity === "string" ? { identity: row.identity.toLowerCase() } : {}) })) : rows;
const withoutNullFields = list => Array.isArray(list) ? list.map(row => row && typeof row === "object" && !Array.isArray(row)
  ? Object.fromEntries(Object.entries(row).filter(([,value]) => value !== null)) : row) : list;
const exact = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === names.split(",").sort().join(",");
export const redisJobDiagnostic = error => error instanceof JobError ? error.message : null;
function validatePlan(value) {
  need(exact(value, "target,jobResourceId,environmentResourceId,infrastructureSubnetId,workspaceId,identityResourceId,image,probeSha256,redisSecretVersion,location"), "REDIS_JOB_PLAN_INVALID");
  const p = structuredClone(value);
  need(armId(p.jobResourceId, "Microsoft\\.App/jobs") && /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(p.jobResourceId.split("/").at(-1))
    && armId(p.environmentResourceId, "Microsoft\\.App/managedEnvironments")
    && armId(p.identityResourceId, "Microsoft\\.ManagedIdentity/userAssignedIdentities")
    && new RegExp(`${ROOT}Microsoft\\.Network/virtualNetworks/[a-zA-Z0-9-]{1,80}/subnets/[a-zA-Z0-9-]{1,80}$`).test(p.infrastructureSubnetId)
    && GUID.test(p.workspaceId) && HASH.test(p.probeSha256) && /^[a-z0-9]{2,32}$/.test(p.location)
    && /^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9][a-z0-9/_.-]{0,150}@sha256:[a-f0-9]{64}$/.test(p.image)
    && /^https:\/\/[a-z0-9-]{3,24}\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]{1,127}\/[a-f0-9]{32}$/.test(p.redisSecretVersion), "REDIS_JOB_PLAN_INVALID");
  need([p.environmentResourceId,p.identityResourceId,p.infrastructureSubnetId,p.target.resourceId].every(id => typeof id === "string"
    && id.split("/")[2] === p.jobResourceId.split("/")[2]) && p.target.mode === "azure-enterprise-proxy", "REDIS_JOB_TARGET_INVALID");
  redisGateBindingSha256(p.target);
  return p;
}
function identity(p) { return { jobResourceId: p.jobResourceId, imageDigest: p.image.split("@")[1], probeSha256: p.probeSha256 }; }
function template(p, challenge = null) {
  return { containers: [{ name: "redis-probe", image: p.image,
    command: ["node", "/app/scripts/migration/ops-core-redis-probe.mjs"], args: [],
    resources: { cpu: 0.25, memory: "0.5Gi" }, env: [
      { name: "REDIS_PROBE_PASSWORD", secretRef: "redis-probe-password" },
      { name: "CORGTEX_REDIS_TARGET", value: JSON.stringify(p.target) },
      { name: "CORGTEX_REDIS_PROBE_IDENTITY", value: JSON.stringify(identity(p)) },
      ...(challenge ? [{ name: "CORGTEX_REDIS_CHALLENGE", value: JSON.stringify(challenge) }] : []),
    ] }], initContainers: [] };
}
/** Provision this exact Manual definition before acquiring a fresh challenge.
 * This module deliberately has no replacement PUT or job deletion operation. */
export function buildRedisProbeJobDefinition(value) {
  const p = validatePlan(value);
  return { location: p.location, identity: { type: "UserAssigned", userAssignedIdentities: { [p.identityResourceId]: {} } },
    properties: { environmentId: p.environmentResourceId, workloadProfileName: "Consumption",
      configuration: { triggerType: "Manual", replicaTimeout: 120, replicaRetryLimit: 0,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 },
        identitySettings: [{ identity: p.identityResourceId, lifecycle: "None" }],
        secrets: [{ name: "redis-probe-password", keyVaultUrl: p.redisSecretVersion, identity: p.identityResourceId }],
        registries: [{ server: p.image.split("/")[0], identity: p.identityResourceId }] }, template: template(p) } };
}
const pathFor = id => `${id}?api-version=${API}`;
const limitBytes = 1024 * 1024;
async function responseJson(response) {
  need(response.body && typeof response.body.getReader === "function", "REDIS_JOB_TRANSPORT_INVALID");
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; need(size <= limitBytes, "REDIS_JOB_RESPONSE_TOO_LARGE"); parts.push(Buffer.from(value)); }
    return size ? JSON.parse(Buffer.concat(parts).toString("utf8")) : null;
  } finally { await reader.cancel().catch(() => {}); }
}
/** Real authenticated transport. No retries, redirects, CLI shell commands, raw
 * provider errors or response logging. Only this plan's resources are reachable. */
export function createRedisJobTransport(value, { credential = new AzureCliCredential({ processTimeoutInMs: 10_000 }), fetchImpl = fetch } = {}) {
  const p = validatePlan(value);
  return async ({ method, path, body, signal }) => {
    try {
      need(signal instanceof AbortSignal && !signal.aborted, "REDIS_JOB_ABORTED");
      const logs = path === `/v1/workspaces/${p.workspaceId}/query`;
      const url = new URL(path, logs ? "https://api.loganalytics.azure.com" : "https://management.azure.com");
      const allowed = logs ? method === "POST" : (method === "POST" && armSame(url.pathname, `${p.jobResourceId}/start`))
        || (method === "GET" && [p.jobResourceId,p.environmentResourceId,`${p.jobResourceId}/executions`].some(id => armSame(id, url.pathname)))
        || (method === "GET" && url.pathname.toLowerCase().startsWith(`${p.jobResourceId}/executions/`.toLowerCase())
          && /^[a-z0-9][a-z0-9-]{0,79}$/.test(url.pathname.slice(`${p.jobResourceId}/executions/`.length)));
      need(allowed && url.origin === (logs ? "https://api.loganalytics.azure.com" : "https://management.azure.com")
        && !url.hash && !url.username && !url.password && (logs || url.searchParams.get("api-version") === API), "REDIS_JOB_ENDPOINT_DENIED");
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const auth = await credential.getToken(logs ? "https://api.loganalytics.io/.default" : "https://management.azure.com/.default",
        { abortSignal: boundedSignal });
      need(typeof auth?.token === "string" && auth.token.length > 0 && !boundedSignal.aborted, "REDIS_JOB_AUTH_FAILED");
      const response = await fetchImpl(url.href, { method, redirect: "error", signal: boundedSignal,
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      need(!response.redirected && response.url === url.href, "REDIS_JOB_ENDPOINT_DENIED");
      if (response.status === 404) return { status: 404, body: null };
      need([200,202].includes(response.status), "REDIS_JOB_PROVIDER_REJECTED");
      const result = await responseJson(response);
      need(!boundedSignal.aborted, "REDIS_JOB_ABORTED");
      return { status: response.status, body: result };
    } catch (error) { throw error instanceof JobError ? error : new JobError("REDIS_JOB_TRANSPORT_FAILED"); }
  };
}
function verifyTemplate(actual, expected) {
  need(actual && Object.entries(actual).every(([key,val]) => ["containers","initContainers","volumes"].includes(key) || val === null)
    && Array.isArray(actual.containers) && actual.containers.length === 1
    && (!actual.initContainers || actual.initContainers.length === 0)
    && (!actual.volumes || actual.volumes.length === 0), "REDIS_JOB_TEMPLATE_CHANGED");
  const c = actual.containers[0]; const e = expected.containers[0];
  need(Object.keys(c).every(k => ["name","image","imageType","command","args","env","resources"].includes(k))
    && (c.imageType == null || c.imageType === "ContainerImage")
    && c.name === e.name && c.image === e.image && same(c.command,e.command) && same(c.args ?? [],e.args)
    && c.resources?.cpu === 0.25 && c.resources?.memory === "0.5Gi"
    && Array.isArray(c.env) && same(withoutNullFields(c.env).sort((a,b) => a.name.localeCompare(b.name)), [...e.env].sort((a,b) => a.name.localeCompare(b.name))),
  "REDIS_JOB_TEMPLATE_CHANGED");
}
function verifyJob(actual, p) {
  const wanted = buildRedisProbeJobDefinition(p); const c = actual?.properties?.configuration;
  need(armSame(actual?.id, p.jobResourceId) && typeof actual.location === "string" && actual.location.replaceAll(" ","").toLowerCase() === p.location && actual.properties?.provisioningState === "Succeeded"
    && armSame(actual.properties.environmentId, p.environmentResourceId) && actual.properties.workloadProfileName === "Consumption"
    && actual.identity?.type === "UserAssigned" && same(Object.keys(actual.identity.userAssignedIdentities ?? {}).map(id => id.toLowerCase()),[p.identityResourceId.toLowerCase()])
    && c && Object.entries(c).every(([key,val]) => ["triggerType","replicaTimeout","replicaRetryLimit","manualTriggerConfig",
      "scheduleTriggerConfig","eventTriggerConfig","identitySettings","secrets","registries"].includes(key) || val === null)
    && c.triggerType === "Manual" && c.replicaTimeout === 120 && c.replicaRetryLimit === 0
    && same(c.manualTriggerConfig,wanted.properties.configuration.manualTriggerConfig)
    && !c.scheduleTriggerConfig && !c.eventTriggerConfig && same(identityRefs(c.identitySettings),identityRefs(wanted.properties.configuration.identitySettings))
    && same(identityRefs(withoutNullFields(c.secrets)),identityRefs(wanted.properties.configuration.secrets))
    && same(identityRefs(withoutNullFields(c.registries)),identityRefs(wanted.properties.configuration.registries)), "REDIS_JOB_CONFIG_CHANGED");
  verifyTemplate(actual.properties.template, template(p));
}
function executionId(value, p) {
  need(typeof value?.name === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value.name), "REDIS_JOB_EXECUTION_INVALID");
  const id = `${p.jobResourceId}/executions/${value.name}`;
  // ARM list/GET schemas make id optional. Their constrained request path
  // supplies the parent; a supplied foreign ID remains an error.
  need(value.id === undefined || armSame(value.id, id), "REDIS_JOB_EXECUTION_INVALID");
  return id;
}
const normalizeExecution = (value, p) => ({ ...value, id: executionId(value, p) });
function challengeCheck(challenge, p, context, requireFresh = true) {
  need(exact(challenge,"schemaVersion,nonce,domain,intentSha256,sourceFenceSha256,targetBindingSha256,identity,issuedAt,expiresAt")
    && challenge.schemaVersion === 1 && HASH.test(challenge.nonce) && challenge.domain === context.domain
    && challenge.intentSha256 === context.intentSha256 && challenge.sourceFenceSha256 === context.sourceFenceSha256
    && challenge.targetBindingSha256 === redisGateBindingSha256(p.target) && same(challenge.identity,identity(p))
    && Number.isSafeInteger(challenge.issuedAt) && Number.isSafeInteger(challenge.expiresAt)
    && challenge.expiresAt > challenge.issuedAt && challenge.expiresAt - challenge.issuedAt <= 300_000
    && (!requireFresh || (Date.now() >= challenge.issuedAt && Date.now() < challenge.expiresAt)), "REDIS_JOB_CHALLENGE_INVALID");
}
function logQuery(p, execution, challenge) {
  const q = value => `'${value}'`; // Values below already match restrictive ID/hash/date patterns.
  return `ContainerAppConsoleLogs_CL\n| where TimeGenerated between (datetime(${new Date(challenge.issuedAt).toISOString()}) .. datetime(${new Date(challenge.expiresAt).toISOString()}))\n`
    + `| where tolower(_ResourceId) in (${q(p.environmentResourceId.toLowerCase())}, ${q(p.jobResourceId.toLowerCase())})\n`
    + `| where EnvironmentName_s == ${q(p.environmentResourceId.split("/").at(-1))}\n`
    + `| where ContainerGroupName_s startswith ${q(`${execution.name}-`)} and ContainerName_s == 'redis-probe'\n`
    + `| where ContainerImage_s == ${q(p.image)}\n`
    + `| where (Log_s startswith ${q(REDIS_PROBE_PREFIX)} and Log_s contains ${q(challenge.nonce)}) or Log_s == 'CORGTEX_REDIS_PROBE_FAILED'\n`
    + "| project TimeGenerated, EnvironmentName_s, ContainerGroupName_s, ContainerName_s, ContainerImage_s, Log_s, _ResourceId\n| take 3";
}
function logReceipt(response, p, execution, challenge) {
  need(response && !response.error && Array.isArray(response.tables) && response.tables.length === 1, "REDIS_JOB_LOG_RESPONSE_INVALID");
  const table = response.tables[0];
  need(same(table.columns?.map(c => c.name),["TimeGenerated","EnvironmentName_s","ContainerGroupName_s","ContainerName_s","ContainerImage_s","Log_s","_ResourceId"])
    && Array.isArray(table.rows), "REDIS_JOB_LOG_RESPONSE_INVALID");
  if (table.rows.length === 0) return null;
  need(table.rows.length === 1, "REDIS_JOB_LOG_AMBIGUOUS");
  const row = table.rows[0];
  const time = Date.parse(row[0]);
  need(row.length === 7 && typeof row[6] === "string" && [p.environmentResourceId.toLowerCase(),p.jobResourceId.toLowerCase()].includes(row[6].toLowerCase()) && row[1] === p.environmentResourceId.split("/").at(-1)
    && typeof row[2] === "string" && row[2].startsWith(`${execution.name}-`)
    && /^[a-z0-9-]{1,120}$/.test(row[2]) && row[3] === "redis-probe" && row[4] === p.image
    && Number.isFinite(time) && time >= challenge.issuedAt && time <= challenge.expiresAt
    && time >= Date.parse(execution.properties.startTime) && time <= Date.parse(execution.properties.endTime)
    && typeof row[5] === "string" && row[5].startsWith(REDIS_PROBE_PREFIX) && Buffer.byteLength(row[5]) < 16_384,
  "REDIS_JOB_LOG_BINDING_MISMATCH");
  let receipt;
  try { receipt = JSON.parse(row[5].slice(REDIS_PROBE_PREFIX.length)); } catch { throw new JobError("REDIS_JOB_LOG_RECEIPT_INVALID"); }
  need(receipt.nonce === challenge.nonce && receipt.challengeSha256 === hash(challenge)
    && receipt.domain === challenge.domain && receipt.intentSha256 === challenge.intentSha256
    && receipt.sourceFenceSha256 === challenge.sourceFenceSha256 && receipt.targetBindingSha256 === challenge.targetBindingSha256
    && same(receipt.identity,identity(p)) && Number.isSafeInteger(receipt.observedAt)
    && receipt.observedAt >= Date.parse(execution.properties.startTime) && receipt.observedAt <= Date.parse(execution.properties.endTime),
  "REDIS_JOB_LOG_RECEIPT_INVALID");
  return receipt;
}

/** Uses an already provisioned, exact Manual job. descriptorStore must be private
 * durable storage outside Ops, implementing assertPrivate/readOptional/createOnly.
 * A retained start intent permits only execution reconciliation, never POST replay.
 * On uncertain acknowledgement retain the SAME challenge/descriptor. If that
 * challenge expires, reconcile ownership separately; it cannot prove freshness.
 * Sequential immutable attempt slots prevent a new nonce from bypassing an
 * uncertain start. Every earlier dispatched observation must be proved terminal
 * before another slot opens. readRetainedStart/reconcileStart recover the latest
 * descriptor even after expiry, without yielding acceptance proof.
 * Log Analytics ingestion has no freshness guarantee: missing evidence fails shut.
 * Official completed-log path: learn.microsoft.com/azure/container-apps/jobs-get-started-cli
 * ARM execution templates: learn.microsoft.com/rest/api/resource-manager/containerapps/jobs-executions/list
 */
export function createRedisJobDispatcher({ plan: value, custody, assertSourceFenced, assertTargetInactive, assertEnterpriseBinding,
  descriptorStore, operations, transport, pollIntervalMs = 1000 }) {
  const p = validatePlan(value); const send = transport ?? createRedisJobTransport(p);
  need(custody?.signal instanceof AbortSignal && typeof custody.assertOwned === "function" && typeof custody.snapshot === "function"
    && [assertSourceFenced,assertTargetInactive,assertEnterpriseBinding,descriptorStore?.assertPrivate,descriptorStore?.readOptional,
      descriptorStore?.createOnly,operations?.readIntent,operations?.runRecordedOperation,send].every(f => typeof f === "function")
    && Number.isInteger(pollIntervalMs) && pollIntervalMs >= 0 && pollIntervalMs <= 5000, "REDIS_JOB_CUSTODY_REQUIRED");
  const initial = custody.snapshot();
  const context = { domain: initial.domain, intentSha256: initial.intentSha256,
    sourceFenceSha256: initial.history?.find(v => v.phase === "SOURCE_FENCED")?.evidenceSha256,
    phaseOperationId: initial.pending?.operationId };
  need(["core","ops"].includes(context.domain) && HASH.test(context.intentSha256) && HASH.test(context.sourceFenceSha256)
    && GUID.test(context.phaseOperationId) && initial.pending.to === "VERIFIED", "REDIS_JOB_PHASE_INVALID");
  const prefix = `operations/${context.domain}/${context.intentSha256}/${context.phaseOperationId}`;
  const slotKey = attempt => `${prefix}/${hash({kind:"AZURE_REDIS_PROBE_SLOT",inputSha256:hash({plan:p,context,...(attempt ? {attempt} : {})})})}/descriptor.json`;
  let busy = false;
  function snapshotCheck() {
    const current = custody.snapshot();
    need(current.domain === context.domain && current.intentSha256 === context.intentSha256
      && current.pending?.operationId === context.phaseOperationId && current.pending.to === "VERIFIED"
      && current.history?.find(v => v.phase === "SOURCE_FENCED")?.evidenceSha256 === context.sourceFenceSha256, "REDIS_JOB_CUSTODY_CHANGED");
  }
  async function check(signal) {
    need(!signal.aborted && !custody.signal.aborted,"REDIS_JOB_ABORTED"); await custody.assertOwned();
    snapshotCheck();
    const source = await assertSourceFenced();
    need(source?.complete === true && source.domain === context.domain && source.intentSha256 === context.intentSha256
      && source.sourceFenceSha256 === context.sourceFenceSha256, "REDIS_JOB_SOURCE_UNFENCED");
    const target = await assertTargetInactive();
    need(target?.complete === true && target.targetBindingSha256 === redisGateBindingSha256(p.target), "REDIS_JOB_TARGET_ACTIVE");
    const policy = await assertEnterpriseBinding({ side: "target", binding: structuredClone(p.target) });
    need(policy?.complete === true && policy.resourceId === p.target.resourceId && policy.host === p.target.connection.host
      && policy.port === p.target.connection.port && policy.clusteringPolicy === "EnterpriseCluster"
      && policy.geoReplication === "Disabled", "REDIS_JOB_ENTERPRISE_UNPROVEN");
    await custody.assertOwned(); snapshotCheck(); need(!signal.aborted && !custody.signal.aborted,"REDIS_JOB_ABORTED");
  }
  async function request(method,path,signal,body) {
    await check(signal); const result = await send({method,path,signal,...(body === undefined ? {} : {body})});
    await check(signal); need(result && [200,202,404].includes(result.status),"REDIS_JOB_TRANSPORT_INVALID"); return result;
  }
  async function prepare(signal = custody.signal) { return prepareRedisJob(p, request, signal); }
  async function retain(kind,input,signal) {
    const key = `${prefix}/${hash({kind,inputSha256:hash(input)})}/descriptor.json`;
    const record = {kind,input}; await check(signal); await descriptorStore.assertPrivate();
    let slot;
    for (let attempt = 0; attempt < 100; attempt++) {
      slot = slotKey(attempt);
      const retained = await descriptorStore.readOptional(slot,signal);
      if (retained === null) { await check(signal); await descriptorStore.createOnly(slot,JSON.stringify(record),signal); break; }
      need(typeof retained === "string" && retained.length < 64 * 1024,"REDIS_JOB_DESCRIPTOR_MISMATCH");
      const prior = validateDescriptor(JSON.parse(retained));
      if (same(prior, record)) break;
      // Only a proved terminal observation (or proved never-dispatched slot)
      // permits another nonce. No start intent is replayed.
      const priorIntent = await operations.readIntent(prior.kind, prior.input);
      const rows = await executions(signal);
      const matches = rows.filter(row => row.properties?.template?.containers?.some(c => c.env?.some(e =>
        e.name === "CORGTEX_REDIS_CHALLENGE" && e.value === JSON.stringify(prior.input.challenge))));
      need(matches.length <= 1, "REDIS_JOB_EXECUTION_AMBIGUOUS");
      if (priorIntent) {
        need(matches.length === 1, "REDIS_JOB_PRIOR_ATTEMPT_REQUIRES_RECONCILIATION");
        const execution = matches[0]; verifyTemplate(execution.properties.template, prior.input.template);
        need(["Succeeded", "Failed", "Stopped"].includes(execution.properties.status)
          && Date.parse(execution.properties.startTime) >= prior.input.challenge.issuedAt
          && Number.isFinite(Date.parse(execution.properties.endTime)), "REDIS_JOB_PRIOR_ATTEMPT_REQUIRES_RECONCILIATION");
        const final = await request("GET", pathFor(execution.id), signal);
        need(final.status === 200 && same(normalizeExecution(final.body,p), execution), "REDIS_JOB_EXECUTION_CHANGED");
        await operations.runRecordedOperation({...prior, apply:async()=>{throw new JobError("REDIS_JOB_REPLAY_DENIED");},
          verify:async()=>({complete:true,evidence:{executionResourceId:execution.id,
            challengeSha256:hash(prior.input.challenge),templateSha256:hash(prior.input.template)}})});
      } else need(matches.length === 0, "REDIS_JOB_FOREIGN_EXECUTION");
      need(attempt < 99, "REDIS_JOB_ATTEMPT_LIMIT");
    }
    const saved = await descriptorStore.readOptional(slot,signal);
    need(typeof saved === "string" && saved.length < 64 * 1024 && same(JSON.parse(saved),record),"REDIS_JOB_DESCRIPTOR_MISMATCH");
    const old = await descriptorStore.readOptional(key,signal);
    if (old === null) { await check(signal); await descriptorStore.createOnly(key,JSON.stringify(record),signal); }
    const text = await descriptorStore.readOptional(key,signal);
    need(typeof text === "string" && text.length < 64 * 1024 && same(JSON.parse(text),record),"REDIS_JOB_DESCRIPTOR_MISMATCH"); await check(signal);
  }
  async function executions(signal) {
    let path = pathFor(`${p.jobResourceId}/executions`); const rows = []; const visited = new Set();
    for (let page = 0; path; page++) {
      need(page < 20 && !visited.has(path),"REDIS_JOB_EXECUTION_PAGE_BOUND"); visited.add(path);
      const response = await request("GET",path,signal);
      need(response.status === 200 && Array.isArray(response.body?.value) && rows.length + response.body.value.length <= 1000,"REDIS_JOB_EXECUTION_LIST_INVALID");
      for (const row of response.body.value) rows.push(normalizeExecution(row,p));
      const next = response.body.nextLink;
      if (next) { const url = new URL(next,"https://management.azure.com");
        need(url.origin === "https://management.azure.com" && armSame(url.pathname, `${p.jobResourceId}/executions`)
          && url.searchParams.get("api-version") === API && !url.hash && !url.username && !url.password,"REDIS_JOB_NEXT_LINK_DENIED"); path = url.pathname + url.search; }
      else path = null;
    }
    need(new Set(rows.map(r => r.id)).size === rows.length,"REDIS_JOB_EXECUTION_LIST_INVALID"); return rows;
  }
  function validateDescriptor(record) {
    need(exact(record,"kind,input") && record.kind === "AZURE_REDIS_PROBE_START"
      && exact(record.input,"plan,context,challenge,template") && same(record.input.plan,p)
      && same(record.input.context,context),"REDIS_JOB_DESCRIPTOR_MISMATCH");
    challengeCheck(record.input.challenge,p,context,false);
    need(same(record.input.template,template(p,record.input.challenge)),"REDIS_JOB_DESCRIPTOR_MISMATCH");
    return record;
  }
  async function readRetainedStart() {
    const signal = custody.signal; await check(signal); await descriptorStore.assertPrivate();
    let latest = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      const text = await descriptorStore.readOptional(slotKey(attempt),signal); await check(signal);
      if (text === null) return latest;
      need(typeof text === "string" && text.length < 64 * 1024,"REDIS_JOB_DESCRIPTOR_MISMATCH");
      latest = structuredClone(validateDescriptor(JSON.parse(text)));
    }
    return latest;
  }
  async function reconcileStart() {
    need(!busy,"REDIS_JOB_CONCURRENT"); busy = true;
    try {
      const record = await readRetainedStart();
      need(record && await operations.readIntent(record.kind,record.input),"REDIS_JOB_START_INTENT_UNPROVEN");
      await prepare(); let found;
      await operations.runRecordedOperation({...record,apply:async()=>{throw new JobError("REDIS_JOB_REPLAY_DENIED");},verify:async()=>{
        const challenge = record.input.challenge;
        const matches = (await executions(custody.signal)).filter(row => row.properties?.template?.containers?.some(c=>c.env?.some(e=>
          e.name === "CORGTEX_REDIS_CHALLENGE" && e.value === JSON.stringify(challenge))));
        need(matches.length <= 1,"REDIS_JOB_EXECUTION_AMBIGUOUS");
        if (!matches.length) return {complete:false,evidence:{challengeSha256:hash(challenge)}};
        found=matches[0]; verifyTemplate(found.properties.template,record.input.template);
        need(Date.parse(found.properties.startTime) >= challenge.issuedAt,"REDIS_JOB_EXECUTION_STALE");
        return {complete:true,evidence:{executionResourceId:found.id,challengeSha256:hash(challenge),templateSha256:hash(record.input.template)}};
      }});
      return {executionResourceId:found.id,status:found.properties.status,challengeSha256:hash(record.input.challenge),
        expired:Date.now() >= record.input.challenge.expiresAt};
    } catch(error) { throw error instanceof JobError ? error : new JobError("REDIS_JOB_RECONCILE_REQUIRED"); }
    finally {busy=false;}
  }
  async function runProbe({challenge: raw,binding,signal}) {
    need(!busy,"REDIS_JOB_CONCURRENT"); busy = true;
    try {
      need(signal instanceof AbortSignal && same(binding,p.target),"REDIS_JOB_TARGET_INVALID");
      signal = AbortSignal.any([signal,custody.signal]); const challenge = structuredClone(raw);
      challengeCheck(challenge,p,context); await prepare(signal);
      const expected = template(p,challenge); const kind = "AZURE_REDIS_PROBE_START";
      const input = { plan:p,context,challenge,template:expected };
      await retain(kind,input,signal);
      const inherited = await operations.readIntent(kind,input);
      let acceptedId = null; let found;
      const locate = async () => {
        const rows = await executions(signal);
        const matches = rows.filter(row => row.properties?.template?.containers?.some(c => c.env?.some(e => e.name === "CORGTEX_REDIS_CHALLENGE"
          && e.value === JSON.stringify(challenge))));
        need(matches.length <= 1,"REDIS_JOB_EXECUTION_AMBIGUOUS");
        if (!matches.length) return null;
        const row = matches[0]; verifyTemplate(row.properties.template,expected);
        need(!acceptedId || row.id === acceptedId,"REDIS_JOB_EXECUTION_CHANGED");
        need(Date.parse(row.properties.startTime) >= challenge.issuedAt,"REDIS_JOB_EXECUTION_STALE");
        return row;
      };
      // A prior execution without the exact durable start intent is foreign;
      // never claim it or launch another overlapping execution.
      if (!inherited) need((await executions(signal)).every(r => !["Running","Processing","Unknown"].includes(r.properties?.status)
        && !r.properties?.template?.containers?.some(c => c.env?.some(e => e.name === "CORGTEX_REDIS_CHALLENGE"
          && e.value === JSON.stringify(challenge)))),"REDIS_JOB_FOREIGN_EXECUTION");
      await operations.runRecordedOperation({kind,input,apply:async () => {
        challengeCheck(challenge,p,context); await prepare(signal);
        // ARM execution timestamps may have whole-second precision. Dispatch
        // after this boundary so the reported start cannot precede issuance.
        const boundary = Math.ceil(challenge.issuedAt / 1000) * 1000;
        if (Date.now() < boundary) await delay(boundary - Date.now(),undefined,{signal});
        challengeCheck(challenge,p,context);
        const started = await request("POST",pathFor(`${p.jobResourceId}/start`),signal,expected);
        if (started.body) acceptedId = executionId(started.body,p);
      },verify:async () => {
        for (;;) {
          challengeCheck(challenge,p,context); found = await locate();
          if (found) return {complete:true,evidence:{executionResourceId:found.id,challengeSha256:hash(challenge),templateSha256:hash(expected)}};
          await delay(pollIntervalMs,undefined,{signal});
        }
      }});
      for (;;) {
        challengeCheck(challenge,p,context);
        const read = await request("GET",pathFor(found.id),signal);
        need(read.status === 200 && executionId(read.body,p) === found.id,"REDIS_JOB_EXECUTION_CHANGED"); found = normalizeExecution(read.body,p);
        verifyTemplate(found.properties.template,expected);
        const status = found.properties.status;
        need(["Running","Processing","Succeeded"].includes(status),"REDIS_JOB_EXECUTION_FAILED");
        if (status === "Succeeded") {
          const start = Date.parse(found.properties.startTime), end = Date.parse(found.properties.endTime);
          need(Number.isFinite(start) && Number.isFinite(end) && start >= challenge.issuedAt && end >= start
            && end <= Date.now() && end <= challenge.expiresAt,"REDIS_JOB_EXECUTION_STALE");
          const logs = await request("POST",`/v1/workspaces/${p.workspaceId}/query`,signal,{query:logQuery(p,found,challenge),
            timespan:`${new Date(challenge.issuedAt).toISOString()}/${new Date(challenge.expiresAt).toISOString()}`});
          need(logs.status === 200,"REDIS_JOB_LOG_UNAVAILABLE");
          const receipt = logReceipt(logs.body,p,found,challenge);
          if (receipt) {
            await prepare(signal); challengeCheck(challenge,p,context);
            const final = await request("GET",pathFor(found.id),signal);
            need(final.status === 200 && same(normalizeExecution(final.body,p),found),"REDIS_JOB_EXECUTION_CHANGED");
            // ARM exposes terminal status/template, not aggregate counters.
            // These counts are derived from verified one-completion/parallelism,
            // zero retries, Succeeded, and exactly one bound replica receipt.
            return {receipt,execution:{jobResourceId:p.jobResourceId,executionResourceId:found.id,imageDigest:identity(p).imageDigest,
              probeSha256:p.probeSha256,challengeSha256:hash(challenge),status:"Succeeded",replicaCount:1,completionCount:1,
              startedAt:start,finishedAt:end}};
          }
        }
        await delay(pollIntervalMs,undefined,{signal});
      }
    } catch (error) { throw error instanceof JobError ? error : new JobError("REDIS_JOB_RECONCILE_REQUIRED"); }
    finally { busy = false; }
  }
  return {identity:identity(p),prepare:async () => {
    try { return await prepare(); } catch (error) { throw error instanceof JobError ? error : new JobError("REDIS_JOB_PREPARE_FAILED"); }
  },runProbe,reconcileStart,readRetainedStart:async()=>{
    try {return await readRetainedStart();} catch(error) {throw error instanceof JobError ? error : new JobError("REDIS_JOB_DESCRIPTOR_MISMATCH");}
  }};
}

async function prepareRedisJob(p, request, signal) {
    const job = await request("GET",pathFor(p.jobResourceId),signal);
    need(job.status === 200,"REDIS_JOB_NOT_PREPARED"); verifyJob(job.body,p);
    const env = await request("GET",pathFor(p.environmentResourceId),signal);
    need(env.status === 200 && armSame(env.body?.id, p.environmentResourceId) && env.body.properties?.provisioningState === "Succeeded"
      && armSame(env.body.properties.vnetConfiguration?.infrastructureSubnetId, p.infrastructureSubnetId)
      && env.body.properties.appLogsConfiguration?.destination === "log-analytics"
      && env.body.properties.appLogsConfiguration.logAnalyticsConfiguration?.customerId === p.workspaceId, "REDIS_JOB_ENVIRONMENT_CHANGED");
    return { identity: identity(p), planSha256: hash(p), definitionSha256: hash(buildRedisProbeJobDefinition(p)) };

}

/** Read-only resource and query-access proof before a source fence. No probe
 * execution, provider intent, synthetic custody phase or runtime effects. */
export async function preflightRedisJob({plan: value, signal, assertOwned, transport}) {
  const p = validatePlan(value), send = transport ?? createRedisJobTransport(p);
  need(signal instanceof AbortSignal && typeof assertOwned === "function", "REDIS_JOB_CUSTODY_REQUIRED");
  const check = async () => { signal.throwIfAborted(); await assertOwned(); signal.throwIfAborted(); };
  const request = async (method, path, signal, body) => {
    await check(); const response = await send({method,path,signal,...(body === undefined ? {} : {body})});
    await check(); return response;
  };
  try {
    const prepared = await prepareRedisJob(p, request, signal);
    const logs = await request("POST", `/v1/workspaces/${p.workspaceId}/query`, signal, {query:"print preflight = 1"});
    need(logs?.status === 200 && !logs.body?.error && logs.body?.tables?.length === 1
      && logs.body.tables[0].columns?.length === 1 && logs.body.tables[0].columns[0].name === "preflight"
      && same(logs.body.tables[0].rows, [[1]]), "REDIS_JOB_LOG_ACCESS_UNPROVEN");
    return {...prepared,workspaceId:p.workspaceId,logQueryAccess:true};
  } catch (error) { throw error instanceof JobError ? error : new JobError("REDIS_JOB_PREFLIGHT_FAILED"); }
}
