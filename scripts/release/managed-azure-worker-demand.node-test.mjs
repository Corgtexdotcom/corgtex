import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveEvidenceHash as hash } from "../migration/ops-core-archive.mjs";
import { openProviderOperationRecorder } from "../migration/ops-core-provider-operations.mjs";
import { WORKER_DEMAND_QUERY } from "./worker-demand.mjs";
import { validateManagedAzureWorkerDemand, managedAzureWorkerDemandScale, assertManagedAzureWorkerDemandApp,
  buildManagedAzureSchedulerJob, assertManagedAzureSchedulerJob, schedulerJobWithRelease,
  createManagedAzureWorkerDemandLifecycle, createManagedAzureSchedulerProofReader } from "./managed-azure-worker-demand.mjs";

const subscriptionId = "00000000-0000-4000-8000-000000000001";
const stem = `/subscriptions/${subscriptionId}/resourceGroups/fixture/providers/`;
const identity = `${stem}Microsoft.ManagedIdentity/userAssignedIdentities/runtime`;
const target = { subscriptionId, resourceGroupName: "fixture", environmentId: `${stem}Microsoft.App/managedEnvironments/fixture`, apps: { web: "fixture-web", worker: "fixture-worker" } };
const demand = { schedulerJobName: "fixture-scheduler", schedulerResources: { cpu: 0.5, memory: "1Gi" }, scalerConnectionSecret: { name: "worker-scaler-connection", keyVaultUrl: `https://fixture.vault.azure.net/secrets/scaler/${"c".repeat(32)}`, identity } };
const release = { gitSha: "a".repeat(40), imageTag: `sha-${"a".repeat(40)}`, version: "1.0.0" };
const image = `fixtureacr.azurecr.io/corgtex/worker@sha256:${"b".repeat(64)}`;
const jobId = `${stem}Microsoft.App/jobs/${demand.schedulerJobName}`;
function app() {
  return { id: `${stem}Microsoft.App/containerApps/${target.apps.worker}`, location: "westus3",
    identity: { type: "UserAssigned", userAssignedIdentities: { [identity]: {} } },
    properties: { environmentId: target.environmentId, configuration: { activeRevisionsMode: "Single",
      ingress: { external: false, targetPort: 9090, allowInsecure: false },
      registries: [{ server: "fixtureacr.azurecr.io", identity }],
      secrets: [{ name: "runtime-db", keyVaultUrl: `https://fixture.vault.azure.net/secrets/db/${"d".repeat(32)}`, identity }, demand.scalerConnectionSecret] },
    template: { containers: [{ name: "worker", image, resources: { cpu: 1, memory: "2Gi", ephemeralStorage: "4Gi" },
      env: [{ name: "DATABASE_URL", secretRef: "runtime-db" }, { name: "WORKER_EXECUTION_MODE", value: "queue-only" },
        { name: "CORGTEX_RELEASE_GIT_SHA", value: release.gitSha }, { name: "CORGTEX_RELEASE_IMAGE_TAG", value: release.imageTag }, { name: "CORGTEX_RELEASE_VERSION", value: release.version }], probes: [] }], scale: managedAzureWorkerDemandScale(demand) } } };
}
const job = (trigger = "Manual") => buildManagedAzureSchedulerJob({ workerApp: app(), demand, target, trigger });
const actual = body => ({ ...structuredClone(body), id: jobId, name: demand.schedulerJobName, type: "Microsoft.App/jobs", properties: { ...structuredClone(body.properties), provisioningState: "Succeeded" } });

test("fixed PostgreSQL/HTTP scaler and scheduler inherit the exact runtime with separate scaler credentials", () => {
  assert.deepEqual(validateManagedAzureWorkerDemand(demand, target), demand);
  const scale = managedAzureWorkerDemandScale(demand);
  assert.deepEqual([scale.minReplicas, scale.maxReplicas, scale.pollingInterval, scale.cooldownPeriod], [0, 1, 10, 30]);
  assert.equal(scale.rules[0].custom.metadata.query, WORKER_DEMAND_QUERY);
  assert.deepEqual(scale.rules[0].custom.auth, [{ secretRef: "worker-scaler-connection", triggerParameter: "connection" }]);
  const scheduled = job("Schedule"), c = scheduled.properties.template.containers[0];
  assert.equal(c.image, image); assert.deepEqual(c.resources, demand.schedulerResources);
  assert.equal(c.env.find(e => e.name === "WORKER_EXECUTION_MODE").value, "scheduler-once");
  assert.equal(scheduled.properties.configuration.secrets.length, 1);
  assert.deepEqual(scheduled.properties.configuration.scheduleTriggerConfig, { parallelism: 1, replicaCompletionCount: 1, cronExpression: "* * * * *" });
  assert.equal(scheduled.properties.configuration.replicaTimeout, 120); assert.equal(scheduled.properties.configuration.replicaRetryLimit, 0);
  assertManagedAzureSchedulerJob(actual(scheduled), scheduled, jobId);
});

for (const [name, mutate] of [
  ["arbitrary query", a => { a.properties.template.scale.rules[0].custom.metadata.query = "SELECT 0"; }],
  ["public ingress", a => { a.properties.configuration.ingress.external = true; }],
  ["runtime scaler credential", a => { a.properties.template.containers[0].env[0].secretRef = "worker-scaler-connection"; }],
  ["scaler secret drift", a => { a.properties.configuration.secrets[1] = { ...demand.scalerConnectionSecret, keyVaultUrl: demand.scalerConnectionSecret.keyVaultUrl.replace(/c/g, "e") }; }],
  ["continuous worker", a => { a.properties.template.containers[0].env[1].value = "continuous"; }],
  ["command override", a => { a.properties.template.containers[0].command = ["echo"]; }],
]) test(`demand app rejects ${name}`, () => { const a = app(); mutate(a); assert.throws(() => assertManagedAzureWorkerDemandApp(a, demand, target)); });
for (const [name, mutate] of [
  ["image", j => { j.properties.template.containers[0].image += "x"; }],
  ["secret version", j => { j.properties.configuration.secrets[0].keyVaultUrl += "x"; }],
  ["resources", j => { j.properties.template.containers[0].resources.memory = "4Gi"; }],
  ["schedule", j => { j.properties.configuration.scheduleTriggerConfig.cronExpression = "*/5 * * * *"; }],
  ["retry", j => { j.properties.configuration.replicaRetryLimit = 1; }],
]) test(`scheduler readback rejects ${name} drift`, () => { const expected = job("Schedule"), j = actual(expected); mutate(j); assert.throws(() => assertManagedAzureSchedulerJob(j, expected, jobId)); });

async function fixture({ existing = null, mutateProof, mutateExecution, loseAck = false } = {}) {
  const controller = new AbortController(), records = new Map(), calls = [], rows = [];
  let current = existing && actual(existing), clock = Date.now();
  const custody = { signal: controller.signal, snapshot: () => ({ domain: "ops", intentSha256: "f".repeat(64), pending: { to: "RELEASING", operationId: "00000000-0000-4000-8000-000000000002" } }), async assertOwned() { controller.signal.throwIfAborted(); } };
  const store = { async assertPrivate() {}, async readOptional(k) { return records.get(k) ?? null; }, async createOnly(k, v) { assert.equal(records.has(k), false); records.set(k, v); } };
  const make = async () => createManagedAzureWorkerDemandLifecycle({ jobId, target, signal: controller.signal,
    proofStore: store, proofPrefix: `operations/ops/${"f".repeat(64)}/00000000-0000-4000-8000-000000000002/`,
    operations: await openProviderOperationRecorder({ custody, store, phase: "RELEASING", signal: controller.signal }),
    check: () => custody.assertOwned(), now: () => clock, wait: async ms => { clock += ms; },
    request: async (id, request = {}) => {
      calls.push({ id, method: request.method ?? "GET" });
      if (request.method === "PUT") { current = actual(request.body); if (loseAck) { loseAck = false; throw new Error("private provider failure"); } return { status: 202 }; }
      if (id === `${jobId}/start`) {
        const name = "fixture-execution";
        rows.push({ id: `${jobId}/executions/${name}`, name, properties: { status: "Succeeded", startTime: new Date(clock).toISOString(), endTime: new Date(clock + 1).toISOString(), template: structuredClone(request.body) } });
        mutateExecution?.(rows.at(-1));return { status: 202 };
      }
      if (id.endsWith("/executions")) return { status: 200, body: { value: structuredClone(rows) } };
      return current ? { status: 200, body: structuredClone(current) } : { status: 404 };
    },
    schedulerProof: async ({ execution, nonce }) => {
      const proof = { jobId, executionId: execution.id, replicaName: `${execution.name}-replica`, containerName: "scheduler",
        receipt: { event: "scheduler_complete", skipped: false, proofNonce: nonce, executionMode: "scheduler-once", ts: execution.properties.startTime, release: { ...release, evidence: "baked", drift: { gitSha: false, version: false, imageTag: false, details: [] } }, counts: { finalized: 0, dispatched: 0, processed: 0, scheduled: 0, scheduledPeriodic: 0, scheduledDrip: 0 } } };
      mutateProof?.(proof); return proof;
    } });
  return { make, calls, records, rows, controller, get current() { return current; } };
}

test("recorded create → actual nonce-bound scheduler proof → schedule, with read-only reconciliation", async () => {
  const f = await fixture(), c = await f.make(), manual = job(), scheduled = job("Schedule");
  await c.write("CREATE", null, manual, true);
  const proof = await c.prove(manual, release, "activation", true);
  assert.equal(proof.complete, true); assert.equal(proof.image, image);
  await c.write("ENABLE", manual, scheduled, true, false); await c.observe(scheduled);
  const effects = f.calls.filter(c => c.method !== "GET").length;
  const inherited = await f.make();
  await inherited.write("CREATE", null, manual, false);
  await inherited.prove(manual, release, "activation", false);
  await inherited.observe(scheduled);
  assert.equal(f.calls.filter(c => c.method !== "GET").length, effects);
  assert.equal(f.calls.filter(c => c.id.endsWith("/start")).length, 1);
});

test("a lost PUT acknowledgement is reconciled without replay", async () => {
  const f = await fixture({ loseAck: true });
  await assert.rejects((await f.make()).write("CREATE", null, job(), true));
  await (await f.make()).write("CREATE", null, job(), false);
  assert.equal(f.calls.filter(c => c.method === "PUT").length, 1);
});
for (const [name, mutate] of [
  ["skipped scheduler", p => { p.receipt.skipped = true; }],
  ["wrong nonce", p => { p.receipt.proofNonce = "0".repeat(64); }],
  ["wrong execution", p => { p.executionId += "foreign"; }],
  ["wrong baked image", p => { p.receipt.release.gitSha = "0".repeat(40); }],
  ["missing counts", p => { delete p.receipt.counts.finalized; }],
]) test(`never enables on ${name}`, async () => {
  const f = await fixture({ mutateProof: mutate }), c = await f.make();
  await c.write("CREATE", null, job(), true);
  await assert.rejects(c.prove(job(), release, "activation", true));
  assert.equal(f.current.properties.configuration.triggerType, "Manual");
});

test("drain refuses ongoing scheduler writer and custody abort blocks effects", async () => {
  const f = await fixture({ existing: job() }), c = await f.make();
  f.rows.push({ name: "existing", properties: { status: "Running", template: job().properties.template } });
  await assert.rejects(c.drained(job()), /NOT_DRAINED/);
  f.controller.abort(); await assert.rejects(c.write("ENABLE", job(), job("Schedule"), true));
  assert.equal(f.calls.filter(c => c.method !== "GET").length, 0);
});

test("release update preserves secrets/resources and alters only worker image/release/trigger", () => {
  const baseline = job("Schedule"), next = schedulerJobWithRelease(baseline, image.replace(/b/g, "e"), { ...release, gitSha: "c".repeat(40), imageTag: `sha-${"c".repeat(40)}` });
  assert.deepEqual(next.properties.configuration.secrets, baseline.properties.configuration.secrets);
  assert.deepEqual(next.properties.template.containers[0].resources, baseline.properties.template.containers[0].resources);
  assert.equal(next.properties.configuration.triggerType, "Manual");
});

test("direct proof reader binds one exact replica and does not install CLI extensions or expose raw errors", async () => {
  const commands = [];
  const reader = createManagedAzureSchedulerProofReader({ exec: async (program, args, options) => {
    commands.push(args); assert.equal(options.env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
    if (args.includes("replica")) return { stdout: JSON.stringify([{ name: "run-replica" }]) };
    return { stdout: `2026-09-24T05:47:18.5656455Z stdout F ${JSON.stringify({ level: "info", msg: JSON.stringify({ event: "scheduler_complete", proofNonce: "safe" }) })}` };
  } });
  assert.equal((await reader({ jobId, execution: { id: `${jobId}/executions/run`, name: "run" }, signal: new AbortController().signal })).replicaName, "run-replica");
  assert.ok(commands.every(args => args.includes("--execution") && args.includes("run")));
  assert.ok(commands.find(args=>args.includes("logs")).includes("text"));
  const failed = createManagedAzureSchedulerProofReader({ exec: async () => { throw new Error("private secret token"); } });
  await assert.rejects(failed({ jobId, execution: { name: "run" }, signal: new AbortController().signal }), e => !e.message.includes("private secret"));
});

test("recovery cannot race an unobserved manual scheduler start", async () => {
  const f=await fixture({mutateProof:p=>{p.receipt.skipped=true;}}),c=await f.make();
  await c.write("CREATE",null,job(),true);await assert.rejects(c.prove(job(),release,"incoming",true));
  const resumed=await f.make();const execution=f.rows.pop();await assert.rejects(resumed.assertProofStartSettled(job(),release,"incoming"),/START_UNSETTLED/);
  f.rows.push(execution);execution.properties.status="Running";
  await assert.rejects(resumed.assertProofStartSettled(job(),release,"incoming"),/START_UNSETTLED/);
  execution.properties.status="Failed";await resumed.assertProofStartSettled(job(),release,"incoming");
});


test("scheduler ARM location and known Consumption defaults normalize on both sides",()=>{
 const expected=job(),observed=actual(expected);expected.location="West US 3";observed.location="westus3";
 observed.properties.configuration.identitySettings=[];observed.properties.configuration.dapr=null;
 observed.properties.configuration.eventTriggerConfig=null;observed.properties.configuration.scheduleTriggerConfig=null;
 observed.properties.template.containers[0].args=null;observed.properties.template.containers[0].command=[];
 for(const storage of ["", "2Gi"]){observed.properties.template.containers[0].resources.ephemeralStorage=storage;assertManagedAzureSchedulerJob(observed,expected,jobId);}
 observed.location="West US 3";expected.location="westus3";assertManagedAzureSchedulerJob(observed,expected,jobId);
});
for(const [label,mutate]of[
 ["unknown config",j=>{j.properties.configuration.unknown=null;}],
 ["identity lifecycle",j=>{j.properties.configuration.identitySettings=[{identity,lifecycle:"None"}];}],
 ["nondefault storage",j=>{j.properties.template.containers[0].resources.ephemeralStorage="8Gi";}],
 ["unknown resource",j=>{j.properties.template.containers[0].resources.unknown=null;}],
])test(`known-default normalization preserves ${label} drift rejection`,()=>{const expected=job(),observed=actual(expected);mutate(observed);assert.throws(()=>assertManagedAzureSchedulerJob(observed,expected,jobId),/SCHEDULER_DRIFT/);});


test("verified scheduler proof survives expired execution history and logs without another start",async()=>{
 const f=await fixture(),c=await f.make();await c.write("CREATE",null,job(),true);
 const proof=await c.prove(job(),release,"retention",true);f.rows.length=0;f.calls.length=0;
 assert.deepEqual(await (await f.make()).prove(job(),release,"retention",false),proof);
 assert.equal(f.calls.length,0);
 const key=[...f.records.keys()].find(k=>k.endsWith("/descriptor.json"));
 const retained=JSON.parse(f.records.get(key));retained.proof.image+="drift";f.records.set(key,JSON.stringify(retained));
 await assert.rejects((await f.make()).prove(job(),release,"retention",false),/RETAINED_PROOF_INVALID/);
 assert.equal(f.calls.length,0);
});
for(const exactPrecision of [false,true])test(`scheduler receipt permits rounding only for ARM whole-second timestamp: ${exactPrecision}`,async()=>{
 const stamp="2026-09-24T00:00:00";
 const f=await fixture({mutateExecution:e=>{e.properties.startTime=`${stamp}.000Z`;e.properties.endTime=`${stamp}${exactPrecision?".000":""}Z`;},
  mutateProof:p=>{p.receipt.ts=`${stamp}.999Z`;}}),c=await f.make();await c.write("CREATE",null,job(),true);
 if(exactPrecision)await assert.rejects(c.prove(job(),release,"rounded",true));
 else assert.equal((await c.prove(job(),release,"rounded",true)).complete,true);
});

test("native text proof framing ignores connection notices and rejects partial/stderr/unframed records",async()=>{
 const payload=JSON.stringify({level:"info",msg:JSON.stringify({ts:"2026-09-24T05:47:18.560Z",component:"worker",event:"scheduler_complete",proofNonce:"synthetic"})});
 const read=stdout=>createManagedAzureSchedulerProofReader({exec:async(_program,args)=>({stdout:args.includes("replica")?JSON.stringify([{name:"run-replica"}]):stdout})})({jobId,execution:{id:`${jobId}/executions/run`,name:"run"},signal:new AbortController().signal});
 const line=`2026-09-24T05:47:18.5656455Z stdout F ${payload}`;
 const proof=await read(`2026-09-24T05:47:39.86863  Connecting to the container 'scheduler'...\n${line}\n`);
 assert.equal(proof.receipt.event,"scheduler_complete");
 for(const bad of [line.replace(" stdout F "," stderr F "),line.replace(" stdout F "," stdout P "),payload,`untrusted prefix ${line}`,line.replace("05:47:18.5656455Z","05:47:18.5656455"),`${line}\n${line}`]){
  await assert.rejects(read(bad),/WORKER_DEMAND_PROOF_LOG_UNPROVEN/);
 }
});
