import assert from "node:assert/strict";
import {test} from "node:test";
import {archiveEvidenceHash as hash} from "./ops-core-archive.mjs";
import {openProviderOperationRecorder} from "./ops-core-provider-operations.mjs";
import {buildHealthProbeJobDefinition,createHealthJobDispatcher,createHealthJobTransport,preflightHealthJob} from "./ops-core-health-job.mjs";
import {HEALTH_PROBE_PREFIX,healthProbeBuildSha256,projectWorkerHealth,runWorkerHealthProbe,runHealthProbeCli} from "./ops-core-health-probe.mjs";
import { managedAzureWorkerDemandScale } from "../release/managed-azure-worker-demand.mjs";
const base="/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/";
const release={gitSha:"a".repeat(40),imageTag:`sha-${"a".repeat(40)}`,version:"main-fixture"};
const image=`fixture.azurecr.io/worker@sha256:${"b".repeat(64)}`;
const p={worker:{appId:`${base}Microsoft.App/containerApps/fixture-worker`,origin:"https://fixture-worker.internal.fixture.eastus.azurecontainerapps.io",image,release},
  jobResourceId:`${base}Microsoft.App/jobs/fixture-health`,environmentResourceId:`${base}Microsoft.App/managedEnvironments/fixture-env`,
  infrastructureSubnetId:`${base}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,workspaceId:"00000000-0000-4000-8000-000000000002",
  identityResourceId:`${base}Microsoft.ManagedIdentity/userAssignedIdentities/fixture-core`,image,probeSha256:"c".repeat(64),location:"eastus"};
const revision="fixture-worker--fixture";
function body(){return{status:"ok",phase:"running",tickCount:3,lastError:null,lastSuccessfulTickAt:new Date().toISOString(),workerId:"PRIVATE_WORKER_ID",
  release:{...release,service:"worker",runtime:{gitSha:release.gitSha,source:"baked",evidence:"baked"},drift:{gitSha:false,version:false,imageTag:false,details:[]}}};}
const ready={ready:true,phase:"running"};
async function fixture({releaseMode=false,acceptancePhase=null}={}){
  const controller=new AbortController(),records=new Map();
  const journal={domain:"core",intentSha256:"d".repeat(64),phase:releaseMode?"RELEASE_PREPARED":"VERIFIED",...(releaseMode?{}:{destinationMayHaveWritten:true}),
    pending:{to:releaseMode?"RELEASING":"TARGET_ACTIVATING",operationId:"00000000-0000-4000-8000-000000000003"},
    ...(releaseMode?{}:{history:[{phase:"SOURCE_FENCED",evidenceSha256:"e".repeat(64)}]})};
  if(acceptancePhase){journal.phase=({TARGET_ACTIVE:"TARGET_ACTIVATING",ROUTED:"TARGET_ACTIVE",ACCEPTED:"ROUTED"})[acceptancePhase];journal.pending.to=acceptancePhase;}
  const custody={signal:controller.signal,assertOwned:async()=>{},snapshot:()=>structuredClone(journal)};
  const store={assertPrivate:async()=>{},readOptional:async k=>records.get(k)??null,createOnly:async(k,v)=>{assert(!records.has(k));records.set(k,v);}};
  const state={starts:0,requests:[],runs:[],loseStart:false,source:true,authority:true,authorityCalls:[],sourceCalls:0,authorityMutation:null,jobMutation:null,appMutation:null,revMutation:null,logMutation:null,runMutation:null,omitIds:false};
  const job={id:p.jobResourceId,...buildHealthProbeJobDefinition(p)};job.properties.provisioningState="Succeeded";
  const env={id:p.environmentResourceId,properties:{provisioningState:"Succeeded",defaultDomain:"fixture.eastus.azurecontainerapps.io",
    vnetConfiguration:{infrastructureSubnetId:p.infrastructureSubnetId},appLogsConfiguration:{destination:"log-analytics",logAnalyticsConfiguration:{customerId:p.workspaceId}}}};
  const app={id:p.worker.appId,properties:{provisioningState:"Succeeded",managedEnvironmentId:p.environmentResourceId,latestRevisionName:revision,latestReadyRevisionName:revision,
    configuration:{activeRevisionsMode:"Single",ingress:{external:false,allowInsecure:false,fqdn:p.worker.origin.slice(8),traffic:[{latestRevision:true,weight:100}]}}}};
  const rev={id:`${p.worker.appId}/revisions/${revision}`,name:revision,properties:{active:true,provisioningState:"Provisioned",healthState:"Healthy",runningState:"Running",
    template:{containers:[{name:"worker",image:p.worker.image}]}}};
  const response=(value,status=200)=>({status,body:structuredClone(value)});
  const transport=async request=>{
    const{method,path,body:input}=request;state.requests.push({method,path,body:structuredClone(input)});
    if(path.startsWith(p.jobResourceId+"?")){const v=structuredClone(job);state.jobMutation?.(v);return response(v);}
    if(path.startsWith(p.environmentResourceId+"?"))return response(env);
    if(path.startsWith(p.worker.appId+"?")){const v=structuredClone(app);state.appMutation?.(v);return response(v);}
    if(path.includes("/replicas?")&&state.replicaCount!==undefined)return response({value:Array.from({length:state.replicaCount},()=>({name:"worker-replica"}))});
    if(path.startsWith(`${p.worker.appId}/revisions/`)){const v=structuredClone(rev);state.revMutation?.(v);return response(v);}
    if(path.includes(`${p.jobResourceId}/start?`)){
      assert.equal(method,"POST");state.starts++;
      if(state.wakeOnStart){state.replicaCount=1;rev.properties.healthState="Healthy";rev.properties.runningState="Running";app.properties.latestReadyRevisionName=revision;}
      assert([...records.keys()].some(k=>k.endsWith("/descriptor.json")));assert([...records.values()].some(v=>JSON.parse(v).kind==="AZURE_HEALTH_PROBE_START"&&JSON.parse(v).type==="intent"));
      const timestamp=new Date().toISOString();const name=`fixture-health-run${state.starts}`;
      state.runs.push({id:`${p.jobResourceId}/executions/${name}`,name,properties:{status:"Succeeded",startTime:timestamp,endTime:timestamp,template:structuredClone(input)}});
      if(state.loseStart){state.loseStart=false;throw new Error("PRIVATE_PROVIDER_MESSAGE");}
      return response({name,...(state.omitIds?{}:{id:state.runs.at(-1).id})});
    }
    if(path.startsWith(`${p.jobResourceId}/executions?`)){const rows=structuredClone(state.runs);if(state.omitIds)for(const r of rows)delete r.id;return response({value:rows});}
    if(path.startsWith(`${p.jobResourceId}/executions/`)){const name=path.split("/executions/")[1].split("?")[0];const run=structuredClone(state.runs.find(r=>r.name===name));state.runMutation?.(run);if(state.omitIds)delete run.id;return response(run);}
    if(path===`/v1/workspaces/${p.workspaceId}/query`){
      const run=state.runs.at(-1);const c=JSON.parse(run.properties.template.containers[0].env.find(e=>e.name==="CORGTEX_HEALTH_CHALLENGE").value);
      assert(input.query.includes(c.nonce));assert(input.query.includes(run.name+"-"));assert(!input.query.includes("latest"));
      const observedAt=Date.parse(run.properties.startTime),raw=body();raw.lastSuccessfulTickAt=new Date(observedAt).toISOString();
      const receipt={schemaVersion:c.schemaVersion,...(c.authority?{authority:c.authority}:{}),type:"WORKER_HEALTH_OBSERVATION",challengeSha256:hash(c),nonce:c.nonce,domain:c.domain,intentSha256:c.intentSha256,sourceFenceSha256:c.sourceFenceSha256,
        targetSha256:hash(p.worker),identity:c.identity,request:c.request,observedAt,...projectWorkerHealth(raw,ready,p.worker,observedAt)};
      const logs={tables:[{name:"PrimaryResult",columns:["TimeGenerated","EnvironmentName_s","ContainerGroupName_s","ContainerName_s","ContainerImage_s","Log_s","_ResourceId"].map(name=>({name,type:"string"})),
        rows:[[run.properties.startTime,"fixture-env",run.name+"-replica1","health-probe",p.image,HEALTH_PROBE_PREFIX+JSON.stringify(receipt),p.environmentResourceId]]}]};state.logMutation?.(logs);return response(logs);
    }throw new Error("UNEXPECTED_REQUEST");
  };
  const opts={...(acceptancePhase?{mode:"acceptance"}:{}),plan:p,custody,descriptorStore:store,transport,pollIntervalMs:0,timeoutMs:10000,
    ...(releaseMode?{mode:"release",releaseContext:{migrationSourceFenceSha256:"e".repeat(64),acceptedMigrationSha256:"f".repeat(64)},
      assertDeploymentAuthority:async request=>{state.authorityCalls.push(structuredClone(request));const result={complete:state.authority,...request};state.authorityMutation?.(result);return result;}}:{}),
    assertSourceFenced:async()=>{state.sourceCalls++;if(releaseMode)throw new Error("LIVE_SOURCE_OBSERVER_MUST_NOT_RUN");
      return{complete:state.source,domain:journal.domain,intentSha256:journal.intentSha256,sourceFenceSha256:journal.history[0].evidenceSha256};}};
  async function reopen(){const operations=await openProviderOperationRecorder({custody,store,phase:releaseMode?"RELEASING":acceptancePhase??"TARGET_ACTIVATING",signal:controller.signal});return createHealthJobDispatcher({...opts,operations});}
  const dispatcher=await reopen();const args={role:"worker",origin:p.worker.origin,release,appId:p.worker.appId,revisionName:revision,invocationContext:releaseMode?"release-worker":"worker-after-create",signal:controller.signal};
  return{controller,records,journal,custody,store,state,job,env,app,rev,opts,reopen,dispatcher,args,run:d=>(d??dispatcher).probeHealth(args)};
}

test("precreated secretless ACR-only health job uses Node-only entrypoint and no creation effects",async()=>{
  const f=await fixture();await f.dispatcher.prepare();assert.equal(f.state.starts,0);
  const d=buildHealthProbeJobDefinition(p);assert.deepEqual(d.properties.configuration.secrets,[]);
  assert.deepEqual(d.properties.configuration.identitySettings,[{identity:p.identityResourceId,lifecycle:"None"}]);
  assert.deepEqual(d.properties.template.containers[0].command,["node","/app/scripts/migration/ops-core-health-probe.mjs"]);
});
test("exact worker/release fresh completed receipt reaches activation callback shape",async()=>{
  const f=await fixture();const result=await f.run();assert.equal(result.health.status,200);assert.equal(result.health.body.phase,"running");assert.deepEqual(result.ready,{status:200,body:ready});
  assert(!JSON.stringify(result).includes("PRIVATE_WORKER_ID"));assert.equal(f.state.starts,1);assert([...f.records.keys()].some(k=>k.endsWith("receipt.json")));
});
test("two activation health reads use sequential reconciled immutable attempts",async()=>{
  const f=await fixture();await f.run();f.args.invocationContext="worker-final";await f.run();assert.equal(f.state.starts,2);assert.equal((await f.dispatcher.readRetainedStart()).input.index,1);
});
test("unknown start acknowledgement and still running execution cannot create duplicate",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());assert.equal(f.state.starts,1);f.state.runs[0].properties.status="Running";
  await assert.rejects(f.run(await f.reopen()),/HEALTH_JOB_PREVIOUS_EXECUTION_PENDING/);assert.equal(f.state.starts,1);
});
test("unknown start acknowledgement terminal execution reconciles before independently fresh second probe",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());const d=await f.reopen();const record=await d.readRetainedStart();
  assert.equal(record.kind,"AZURE_HEALTH_PROBE_START");assert.equal((await d.reconcileStart()).status,"Succeeded");assert.equal(f.state.starts,1);
  await f.run(d);assert.equal(f.state.starts,2);
});
test("absent prior execution cannot replay or bypass with a new nonce",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());f.state.runs=[];await assert.rejects(f.run(await f.reopen()));assert.equal(f.state.starts,1);
});
test("actual ARM omitted execution IDs and case-insensitive resource IDs are accepted",async()=>{
  const f=await fixture();f.state.omitIds=true;f.state.jobMutation=j=>{j.id=j.id.toLowerCase();j.properties.environmentId=j.properties.environmentId.toLowerCase();
    const old=j.identity.userAssignedIdentities;j.identity.userAssignedIdentities={[p.identityResourceId.toLowerCase()]:old[p.identityResourceId]};
    j.properties.configuration.identitySettings[0].identity=p.identityResourceId.toLowerCase();j.properties.configuration.registries[0].identity=p.identityResourceId.toLowerCase();};
  f.env.id=f.env.id.toLowerCase();f.app.id=f.app.id.toLowerCase();f.rev.id=f.rev.id.toLowerCase();assert.equal((await f.run()).health.status,200);
});
for(const[name,change]of[
  ["runtime secret",j=>j.properties.configuration.secrets=[{name:"database"}]],
  ["runtime MI",j=>j.properties.configuration.identitySettings[0].lifecycle="All"],
  ["worker startup",j=>j.properties.template.containers[0].command=["node","/app/scripts/start-worker.mjs"]],
  ["env secret",j=>j.properties.template.containers[0].env.push({name:"DATABASE_URL",secretRef:"database"})],
  ["sidecar",j=>j.properties.template.containers.push({name:"writer"})],
  ["init",j=>j.properties.template.initContainers=[{name:"migrate"}]],
  ["retry",j=>j.properties.configuration.replicaRetryLimit=1],
  ["image",j=>j.properties.template.containers[0].image="other:latest"],
])test(`changed job ${name} blocks start`,async()=>{const f=await fixture();f.state.jobMutation=change;await assert.rejects(f.run(),/HEALTH_JOB_(CONFIG|TEMPLATE)_CHANGED/);assert.equal(f.state.starts,0);});
for(const[name,change]of[
  ["public ingress",a=>a.properties.configuration.ingress.external=true],
  ["wrong origin",a=>a.properties.configuration.ingress.fqdn="foreign.internal.fixture.eastus.azurecontainerapps.io"],
  ["latest revision",a=>a.properties.latestRevisionName+="-old"],
  ["multiple mode",a=>a.properties.configuration.activeRevisionsMode="Multiple"],
  ["traffic split",a=>a.properties.configuration.ingress.traffic[0].weight=50],
  ["other environment",a=>a.properties.managedEnvironmentId+="-foreign"],
])test(`worker ${name} blocks probe`,async()=>{const f=await fixture();f.state.appMutation=change;await assert.rejects(f.run(),/HEALTH_JOB_WORKER_BINDING_CHANGED/);assert.equal(f.state.starts,0);});
test("wrong revision image or inactive revision blocks before dispatch",async()=>{
  for(const change of [r=>r.properties.template.containers[0].image="other:latest",r=>r.properties.active=false]){const f=await fixture();f.state.revMutation=change;await assert.rejects(f.run(),/HEALTH_JOB_WORKER_REVISION_CHANGED/);assert.equal(f.state.starts,0);}
});
test("worker drift after completed logs blocks acceptance",async()=>{const f=await fixture();f.state.logMutation=()=>{f.app.properties.latestReadyRevisionName+="-changed";};await assert.rejects(f.run(),/HEALTH_JOB_WORKER_BINDING_CHANGED/);});
test("source fence lost after dispatch blocks health proof",async()=>{const f=await fixture();f.state.runMutation=()=>{f.state.source=false;};await assert.rejects(f.run(),/HEALTH_JOB_SOURCE_UNFENCED/);assert.equal(f.state.starts,1);});
for(const field of ["nonce","intentSha256","sourceFenceSha256","targetSha256"])test(`receipt ${field} drift rejected`,async()=>{
  const f=await fixture();f.state.logMutation=t=>{const row=t.tables[0].rows[0],r=JSON.parse(row[5].slice(HEALTH_PROBE_PREFIX.length));r[field]="f".repeat(64);row[5]=HEALTH_PROBE_PREFIX+JSON.stringify(r);};
  await assert.rejects(f.run(),/HEALTH_JOB_RECEIPT_INVALID/);
});
for(const [name,change]of[
  ["other resource",r=>r[6]+="-foreign"],["other replica",r=>r[2]="foreign-replica"],["image",r=>r[4]="foreign:latest"],["old time",r=>r[0]="2000-01-01T00:00:00Z"],
])test(`logs ${name} rejected`,async()=>{const f=await fixture();f.state.logMutation=t=>change(t.tables[0].rows[0]);await assert.rejects(f.run(),/HEALTH_JOB_LOG_BINDING_MISMATCH/);});
test("duplicate success receipts rejected",async()=>{const f=await fixture();f.state.logMutation=t=>t.tables[0].rows.push(t.tables[0].rows[0]);await assert.rejects(f.run(),/HEALTH_JOB_LOG_AMBIGUOUS/);});

function probeFixture(){const identity={jobResourceId:p.jobResourceId,imageDigest:p.image.split("@")[1],probeSha256:p.probeSha256};const c={schemaVersion:1,nonce:"f".repeat(64),domain:"core",intentSha256:"d".repeat(64),
  sourceFenceSha256:"e".repeat(64),targetSha256:hash(p.worker),identity,issuedAt:Date.now()-1000,expiresAt:Date.now()+30000,
  request:{role:"worker",origin:p.worker.origin,release,appId:p.worker.appId,revisionName:revision,invocationContext:"worker-after-create"}};
  const requests=[];let health=body();const controller=new AbortController();
  const fetchImpl=async(url,options)=>{requests.push({url,options});const response=Response.json(url.endsWith("/health")?health:ready);Object.defineProperty(response,"url",{value:url});return response;};
  return{identity,challenge:c,requests,health,controller,opts:{target:p.worker,challenge:c,identity,signal:controller.signal,fetchImpl}};}
test("probe requests only exact health/ready GETs and emits safe actual acceptance fields",async()=>{
  const f=probeFixture();const receipt=await runWorkerHealthProbe(f.opts);assert.deepEqual(f.requests.map(r=>r.url),[p.worker.origin+"/health",p.worker.origin+"/ready"]);
  assert(f.requests.every(r=>r.options.method==="GET"&&r.options.redirect==="error"));assert(!JSON.stringify(receipt).includes("PRIVATE_WORKER_ID"));assert.equal(receipt.health.body.tickCount,3);
});
for(const[name,change]of[
  ["stale tick",h=>h.lastSuccessfulTickAt="2000-01-01T00:00:00Z"],["future tick",h=>h.lastSuccessfulTickAt=new Date(Date.now()+5000).toISOString()],
  ["last error",h=>h.lastError="PRIVATE_ERROR"],["configured SHA",h=>h.release.runtime.source="configured"],["legacy evidence",h=>h.release.runtime.evidence="legacy_provider"],
  ["version",h=>h.release.version="old"],["git",h=>h.release.gitSha="f".repeat(40)],["tag",h=>h.release.imageTag="latest"],["drift",h=>h.release.drift.version=true],
])test(`probe rejects worker ${name} without private error content`,async()=>{const f=probeFixture();change(f.health);await assert.rejects(runWorkerHealthProbe(f.opts),e=>e.message.startsWith("HEALTH_PROBE_")&&!e.message.includes("PRIVATE"));});
test("redirect and wrong final URL cannot escape target",async()=>{
  for(const foreign of [false,true]){const f=probeFixture();f.opts.fetchImpl=async url=>{const r=Response.json(body(),{status:foreign?200:302});Object.defineProperty(r,"url",{value:foreign?"https://foreign.invalid/health":url});return r;};
    await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_HTTP_REJECTED/);}
});
test("bounded response and abort suppress untrusted body",async()=>{
  const f=probeFixture();f.opts.fetchImpl=async url=>{const r=new Response("PRIVATE_BODY".repeat(4000),{headers:{"content-type":"application/json"}});Object.defineProperty(r,"url",{value:url});return r;};
  await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_RESPONSE_TOO_LARGE/);
  const g=probeFixture();g.opts.fetchImpl=async()=>new Promise(()=>{});const pending=runWorkerHealthProbe(g.opts);g.controller.abort();await assert.rejects(pending,/HEALTH_PROBE_ABORTED/);
});
test("CLI verifies independently hashed files and suppresses malformed secrets",async()=>{assert.match(await healthProbeBuildSha256(),/^[a-f0-9]{64}$/);let output="";
  assert.equal(await runHealthProbeCli({env:{CORGTEX_HEALTH_PROBE_IDENTITY:"PRIVATE_ENV"},write:s=>output+=s}),false);assert.equal(output,"CORGTEX_HEALTH_PROBE_FAILED\n");});
test("transport binds actual Azure token audience and rejects arbitrary control-plane endpoints",async()=>{
  const calls=[],scopes=[];const transport=createHealthJobTransport(p,{credential:{getToken:async s=>{scopes.push(s);return{token:"synthetic-test-credential"};}},fetchImpl:async(url,options)=>{
    calls.push({url,options});const r=Response.json({});Object.defineProperty(r,"url",{value:url});return r;}});const signal=new AbortController().signal;
  await transport({method:"GET",path:`${p.worker.appId}/revisions/${revision}?api-version=2025-07-01`,signal});
  await transport({method:"POST",path:`/v1/workspaces/${p.workspaceId}/query`,body:{query:"safe"},signal});
  assert.deepEqual(scopes,["https://management.azure.com/.default","https://api.loganalytics.io/.default"]);assert(calls.every(c=>c.options.redirect==="error"));
  await assert.rejects(transport({method:"GET",path:"https://foreign.invalid",signal}),/HEALTH_JOB_ENDPOINT_DENIED/);
});
test("root provider errors never leak into diagnostics",async()=>{
  const f=await fixture();f.opts.transport=async()=>{throw new Error("PRIVATE_PROVIDER_SECRET");};await assert.rejects((await f.reopen()).prepare(),e=>e.message==="HEALTH_JOB_RECONCILE_REQUIRED"&&!e.stack.includes("PRIVATE_PROVIDER_SECRET"));
});

test("factory can precede activation and opens actual recorder lazily in correct phase",async()=>{
  const f=await fixture();f.journal.pending=null;f.journal.destinationMayHaveWritten=false;
  const d=createHealthJobDispatcher({plan:p,custody:f.custody,operationStore:f.store,assertSourceFenced:f.opts.assertSourceFenced,transport:f.opts.transport,pollIntervalMs:0,timeoutMs:10000});
  assert.equal(f.records.size,0);
  f.journal.pending={to:"TARGET_ACTIVATING",operationId:"00000000-0000-4000-8000-000000000003"};f.journal.destinationMayHaveWritten=true;
  assert.equal((await f.run(d)).health.status,200);assert.equal(f.state.starts,1);
});
test("execution ID present but foreign is never accepted",async()=>{
  const f=await fixture();f.state.runMutation=r=>{r.id+="-foreign";};await assert.rejects(f.run(),/HEALTH_JOB_EXECUTION_INVALID/);
});
test("private origin rejects credentials, path, HTTP, public ingress, and query before request",async()=>{
  for(const origin of ["http://fixture-worker.internal.fixture.eastus.azurecontainerapps.io",p.worker.origin+"/private",p.worker.origin+"?secret=x",p.worker.origin.replace("internal.",""),p.worker.origin.replace("https://","https://user:pass@")]){
    const f=probeFixture();f.opts.target={...p.worker,origin};let calls=0;f.opts.fetchImpl=async()=>{calls++;throw new Error();};
    await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_TARGET_INVALID/);assert.equal(calls,0);
  }
});
test("probe refuses expired challenge, extra identity fields and stale readiness",async()=>{
  const f=probeFixture();f.challenge.expiresAt=Date.now()-1;await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_CHALLENGE_INVALID/);
  const g=probeFixture();g.identity.private="PRIVATE_VALUE";await assert.rejects(runWorkerHealthProbe(g.opts),/HEALTH_PROBE_INPUT_INVALID/);
  const h=probeFixture();h.opts.fetchImpl=async url=>{const r=Response.json(url.endsWith("/health")?h.health:{ready:false,phase:"running"});Object.defineProperty(r,"url",{value:url});return r;};
  await assert.rejects(runWorkerHealthProbe(h.opts),/HEALTH_PROBE_WORKER_NOT_READY/);
});
test("recorded start without provider execution cannot claim reconciliation",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());f.state.runs=[];await assert.rejects((await f.reopen()).reconcileStart());assert.equal(f.state.starts,1);
});
test("completed logs missing until abort cannot yield health proof or duplicate start",async()=>{
  const f=await fixture();f.state.logMutation=t=>{t.tables[0].rows=[];f.controller.abort();};await assert.rejects(f.run(),/HEALTH_JOB_ABORTED/);assert.equal(f.state.starts,1);
});

test("ready worker at maximum scale is a supported running revision",async()=>{
  const f=await fixture();f.rev.properties.runningState="RunningAtMaxScale";assert.equal((await f.run()).health.status,200);
});
test("callback context is explicit and bound in durable challenge",async()=>{
  const f=await fixture();f.args.invocationContext="worker-final";await f.run();assert.equal((await f.dispatcher.readRetainedStart()).input.challenge.request.invocationContext,"worker-final");
  const g=await fixture();delete g.args.invocationContext;await assert.rejects(g.run());assert.equal(g.state.starts,0);
});
test("safe health timestamp cannot retain private free-form suffix",async()=>{
  const f=probeFixture();f.health.lastSuccessfulTickAt=new Date().toUTCString()+" (PRIVATE_SUFFIX)";
  const result=await runWorkerHealthProbe(f.opts);assert(!JSON.stringify(result).includes("PRIVATE_SUFFIX"));
});

test("ordinary running tick readiness 503 polls same nonce until 200",async()=>{
  const f=probeFixture();let readyCalls=0;
  f.opts.pollIntervalMs=0;f.opts.fetchImpl=async url=>{
    const isReady=url.endsWith("/ready");if(isReady)readyCalls++;const busy=isReady&&readyCalls===1;
    const response=Response.json(isReady?{ready:!busy,phase:"running"}:f.health,{status:busy?503:200});Object.defineProperty(response,"url",{value:url});return response;
  };
  const receipt=await runWorkerHealthProbe(f.opts);assert.equal(readyCalls,2);assert.equal(receipt.nonce,f.challenge.nonce);assert.equal(receipt.ready.status,200);
});
test("startup and first successful tick can become ready inside same bounded probe",async()=>{
  const f=probeFixture();let polls=0;f.opts.pollIntervalMs=0;
  f.opts.fetchImpl=async url=>{
    const isReady=url.endsWith("/ready");if(!isReady)polls++;
    const starting=polls===1;const h={...f.health,...(starting?{phase:"starting",tickCount:0,lastSuccessfulTickAt:null}:{})};
    const response=Response.json(isReady?{ready:!starting,phase:starting?"starting":"running"}:h,{status:isReady&&starting?503:200});
    Object.defineProperty(response,"url",{value:url});return response;
  };
  const receipt=await runWorkerHealthProbe(f.opts);assert.equal(polls,2);assert.equal(receipt.health.body.phase,"running");assert.equal(receipt.nonce,f.challenge.nonce);
});
test("busy readiness honors challenge deadline and never produces success",async()=>{
  const f=probeFixture();f.challenge.expiresAt=Date.now()+25;f.opts.pollIntervalMs=5;let polls=0;
  f.opts.fetchImpl=async url=>{const isReady=url.endsWith("/ready");if(isReady)polls++;
    const response=Response.json(isReady?{ready:false,phase:"running"}:f.health,{status:isReady?503:200});Object.defineProperty(response,"url",{value:url});return response;};
  const started=Date.now();await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_(ABORTED|CHALLENGE_INVALID)/);assert(Date.now()-started<500);assert(polls>0&&polls<30);
});
test("abort interrupts busy wait without another health request",async()=>{
  const f=probeFixture();let readyCalls=0;f.opts.pollIntervalMs=1000;
  f.opts.fetchImpl=async url=>{const isReady=url.endsWith("/ready");if(isReady){readyCalls++;setTimeout(()=>f.controller.abort(),5);}
    const response=Response.json(isReady?{ready:false,phase:"running"}:f.health,{status:isReady?503:200});Object.defineProperty(response,"url",{value:url});return response;};
  await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_ABORTED/);assert.equal(readyCalls,1);
});
test("busy response cannot conceal foreign release or worker errors",async()=>{
  for(const change of [h=>h.release.gitSha="f".repeat(40),h=>h.lastError="PRIVATE_WORKER_ERROR"]){
    const f=probeFixture();change(f.health);let calls=0;f.opts.pollIntervalMs=0;
    f.opts.fetchImpl=async url=>{calls++;const response=Response.json(url.endsWith("/health")?f.health:{ready:false,phase:"running"},{status:url.endsWith("/health")?200:503});Object.defineProperty(response,"url",{value:url});return response;};
    await assert.rejects(runWorkerHealthProbe(f.opts),e=>e.message.startsWith("HEALTH_PROBE_")&&!e.message.includes("PRIVATE_WORKER_ERROR"));assert.equal(calls,1);
  }
});
test("dispatcher actual probe busy polling performs exactly one durable provider start",async()=>{
  const f=await fixture();const original=f.opts.transport;let receipt,readyCalls=0;
  f.opts.transport=async request=>{
    const response=await original(request);
    if(request.path.includes("/start?")){
      const challenge=JSON.parse(request.body.containers[0].env.find(e=>e.name==="CORGTEX_HEALTH_CHALLENGE").value);
      receipt=await runWorkerHealthProbe({target:p.worker,challenge,identity:challenge.identity,signal:f.controller.signal,pollIntervalMs:0,
        fetchImpl:async url=>{const isReady=url.endsWith("/ready");if(isReady)readyCalls++;const busy=isReady&&readyCalls===1;
          const r=Response.json(isReady?{ready:!busy,phase:"running"}:body(),{status:busy?503:200});Object.defineProperty(r,"url",{value:url});return r;}});
      f.state.runs[0].properties.endTime=new Date().toISOString();
    }
    if(request.path.endsWith("/query")){const row=response.body.tables[0].rows[0];row[0]=f.state.runs[0].properties.endTime;row[5]=HEALTH_PROBE_PREFIX+JSON.stringify(receipt);}
    return response;
  };
  const result=await f.run(await f.reopen());assert.equal(result.health.status,200);assert.equal(readyCalls,2);assert.equal(f.state.starts,1);
});

test("release mode uses current deployment authority and historical provenance without live source observer",async()=>{
  const f=await fixture({releaseMode:true});assert.equal(f.journal.history,undefined);const result=await f.run();
  assert.equal(f.state.sourceCalls,0);assert(f.state.authorityCalls.length>0);
  assert.deepEqual(f.state.authorityCalls[0],{domain:"core",intentSha256:f.journal.intentSha256,releaseId:f.journal.pending.operationId,
    targetSha256:hash(p.worker),acceptedMigrationSha256:"f".repeat(64),migrationSourceFenceSha256:"e".repeat(64)});
  const record=await f.dispatcher.readRetainedStart();const c=record.input.challenge;
  assert.equal(c.schemaVersion,2);assert.equal(c.authority.mode,"release");assert.equal(c.authority.sourceFenceProvenance,"historical-migration");
  assert.equal(record.input.context.mode,"release");assert.equal(result.evidence.mode,"release");assert.equal(result.evidence.invocationContext,"release-worker");
  assert.equal(result.evidence.authoritySha256,hash(c.authority));assert.equal(result.evidence.requestSha256,hash(c.request));
  const intent=[...f.records.values()].map(v=>JSON.parse(v)).find(r=>r.type==="intent");assert.equal(intent.binding.phase,"RELEASING");
});
test("migration default still uses live source observer and original version-one challenge",async()=>{
  const f=await fixture();await f.run();assert(f.state.sourceCalls>0);assert.equal(f.state.authorityCalls.length,0);
  const c=(await f.dispatcher.readRetainedStart()).input.challenge;assert.equal(c.schemaVersion,1);assert.equal(c.authority,undefined);
});
test("release factory opens recorder lazily in RELEASING without migration journal flags",async()=>{
  const f=await fixture({releaseMode:true});f.journal.pending=null;
  const d=createHealthJobDispatcher({...f.opts,operations:undefined,descriptorStore:undefined,operationStore:f.store});
  assert.equal(f.records.size,0);f.journal.pending={to:"RELEASING",operationId:"00000000-0000-4000-8000-000000000003"};
  assert.equal((await f.run(d)).health.status,200);assert.equal(f.state.sourceCalls,0);
});
for(const field of ["domain","intentSha256","releaseId","targetSha256","acceptedMigrationSha256","migrationSourceFenceSha256"])
  test(`release authority rejects mismatched ${field} before any provider request`,async()=>{
    const f=await fixture({releaseMode:true});f.state.authorityMutation=a=>a[field]="foreign";
    await assert.rejects(f.run(),/HEALTH_JOB_DEPLOYMENT_AUTHORITY_UNPROVEN/);assert.equal(f.state.starts,0);assert.equal(f.state.requests.length,0);
  });
test("release authority incomplete or absent cannot be replaced by historical source evidence",async()=>{
  const f=await fixture({releaseMode:true});f.state.authority=false;await assert.rejects(f.run(),/HEALTH_JOB_DEPLOYMENT_AUTHORITY_UNPROVEN/);assert.equal(f.state.starts,0);
  const g=await fixture({releaseMode:true});delete g.opts.assertDeploymentAuthority;
  await assert.rejects(g.run(await g.reopen()),/HEALTH_JOB_INITIALIZATION_FAILED/);assert.equal(g.state.sourceCalls,0);assert.equal(g.state.starts,0);
});
test("release lease/phase drift after dispatch blocks result",async()=>{
  const f=await fixture({releaseMode:true});f.state.runMutation=()=>{f.state.authority=false;};await assert.rejects(f.run(),/HEALTH_JOB_DEPLOYMENT_AUTHORITY_UNPROVEN/);assert.equal(f.state.starts,1);
  const g=await fixture({releaseMode:true});g.state.authorityMutation=()=>{g.journal.pending.operationId="00000000-0000-4000-8000-000000000099";};
  await assert.rejects(g.run(),/HEALTH_JOB_CUSTODY_CHANGED/);assert.equal(g.state.starts,0);
});
test("release lost acknowledgement preserves exact durable slot and refuses another running job",async()=>{
  const f=await fixture({releaseMode:true});f.state.loseStart=true;await assert.rejects(f.run());f.state.runs[0].properties.status="Running";
  const d=await f.reopen();assert.equal((await d.readRetainedStart()).input.context.mode,"release");
  f.args.invocationContext="release-final";await assert.rejects(f.run(d),/HEALTH_JOB_PREVIOUS_EXECUTION_PENDING/);assert.equal(f.state.starts,1);
});
test("release terminal reconciliation permits a new fresh final health observation",async()=>{
  const f=await fixture({releaseMode:true});await f.run();f.args.invocationContext="release-final";const result=await f.run(await f.reopen());
  assert.equal(f.state.starts,2);assert.equal(result.evidence.invocationContext,"release-final");assert.equal((await f.dispatcher.readRetainedStart()).input.index,1);
});
test("release baseline health cannot be substituted for forward proof",async()=>{
  const f=await fixture({releaseMode:true});f.state.logMutation=t=>{const row=t.tables[0].rows[0],receipt=JSON.parse(row[5].slice(HEALTH_PROBE_PREFIX.length));
    receipt.request.invocationContext="baseline-worker";row[5]=HEALTH_PROBE_PREFIX+JSON.stringify(receipt);};
  await assert.rejects(f.run(),/HEALTH_JOB_RECEIPT_INVALID/);
});
test("release authority provenance must be echoed exactly by private probe receipt",async()=>{
  const f=await fixture({releaseMode:true});f.state.logMutation=t=>{const row=t.tables[0].rows[0],receipt=JSON.parse(row[5].slice(HEALTH_PROBE_PREFIX.length));
    receipt.authority.acceptedMigrationSha256="a".repeat(64);row[5]=HEALTH_PROBE_PREFIX+JSON.stringify(receipt);};
  await assert.rejects(f.run(),/HEALTH_JOB_RECEIPT_INVALID/);
});
function releaseProbeFixture(context="release-worker"){
  const f=probeFixture();f.challenge.schemaVersion=2;f.challenge.request.invocationContext=context;
  f.challenge.authority={mode:"release",acceptedMigrationSha256:"f".repeat(64),releaseId:"00000000-0000-4000-8000-000000000003",
    targetSha256:hash(p.worker),sourceFenceProvenance:"historical-migration"};return f;
}
for(const context of ["baseline-worker","release-worker","release-final","recovery-worker","recovery-final"])
  test(`release probe binds exact ${context} and target release`,async()=>{
    const f=releaseProbeFixture(context),result=await runWorkerHealthProbe(f.opts);assert.equal(result.schemaVersion,2);
    assert.deepEqual(result.authority,f.challenge.authority);assert.equal(result.request.invocationContext,context);
  });
test("release and migration invocation contexts are not interchangeable",async()=>{
  const f=releaseProbeFixture("worker-final");await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_REQUEST_INVALID/);
  const g=probeFixture();g.challenge.request.invocationContext="release-final";await assert.rejects(runWorkerHealthProbe(g.opts),/HEALTH_PROBE_REQUEST_INVALID/);
});
test("release private probe rejects missing historical provenance or wrong target/release",async()=>{
  for(const mutate of [f=>delete f.challenge.authority,f=>f.challenge.authority.sourceFenceProvenance="currently-fenced",f=>f.challenge.authority.targetSha256="a".repeat(64),
    f=>f.challenge.request.release={...release,gitSha:"f".repeat(40)}]){
    const f=releaseProbeFixture();mutate(f);await assert.rejects(runWorkerHealthProbe(f.opts),/HEALTH_PROBE_(CHALLENGE|AUTHORITY|REQUEST)_INVALID/);assert.equal(f.requests.length,0);
  }
});
test("release mode is explicit and cannot silently accept migration phase",async()=>{
  const f=await fixture({releaseMode:true});delete f.opts.mode;await assert.rejects(f.run(await f.reopen()),/HEALTH_JOB_INITIALIZATION_FAILED/);assert.equal(f.state.starts,0);
  const g=await fixture({releaseMode:true});g.opts.releaseContext.migrationSourceFenceSha256="invalid";
  await assert.rejects(g.run(await g.reopen()),/HEALTH_JOB_INITIALIZATION_FAILED/);assert.equal(g.state.starts,0);
});

test("release current lease loss fails safely even with positive authority callback",async()=>{
  const f=await fixture({releaseMode:true});f.custody.assertOwned=async()=>{throw new Error("PRIVATE_LEASE_ERROR");};
  await assert.rejects(f.run(),e=>e.message==="HEALTH_JOB_RECONCILE_REQUIRED"&&!e.stack.includes("PRIVATE_LEASE_ERROR"));assert.equal(f.state.starts,0);
});
test("release worker image/metadata plan must match exact precreated private job",async()=>{
  const f=await fixture({releaseMode:true});f.opts.plan=structuredClone(p);f.opts.plan.worker.image=p.worker.image.replace("b".repeat(64),"a".repeat(64));
  await assert.rejects(f.run(await f.reopen()),/HEALTH_JOB_TEMPLATE_CHANGED/);assert.equal(f.state.starts,0);
});

for(const phase of ["TARGET_ACTIVE","ROUTED","ACCEPTED"])test(`acceptance mode probes under actual pending ${phase} custody`,async()=>{
  const f=await fixture({acceptancePhase:phase});f.args.invocationContext="worker-final";
  const d=createHealthJobDispatcher({...f.opts,operationStore:f.store});
  assert.equal((await f.run(d)).health.status,200);assert(f.state.sourceCalls>0);
  const record=await d.readRetainedStart();assert.equal(record.input.context.mode,"acceptance");assert.equal(record.input.context.phase,phase);
  const intent=[...f.records.values()].map(JSON.parse).find(r=>r.type==="intent");assert.equal(intent.binding.phase,phase);
  f.journal.pending.to="ACCEPTED";f.journal.pending.operationId="00000000-0000-4000-8000-000000000004";
  await assert.rejects(f.run(d),/HEALTH_JOB_CUSTODY_CHANGED/);assert.equal(f.state.starts,1);
});
test("default migration mode cannot borrow later acceptance phase",async()=>{
  const f=await fixture({acceptancePhase:"ROUTED"});const d=createHealthJobDispatcher({...f.opts,mode:"migration",operationStore:f.store});
  await assert.rejects(d.prepare(),/HEALTH_JOB_INITIALIZATION_FAILED/);assert.equal(f.state.starts,0);
});
test("acceptance cannot bypass live source fencing",async()=>{
  const f=await fixture({acceptancePhase:"ACCEPTED"});f.state.source=false;
  await assert.rejects(f.run(),/HEALTH_JOB_SOURCE_UNFENCED/);assert.equal(f.state.starts,0);
});


// Standalone preflight deliberately never creates a dispatcher or a pending
// journal. These traps reject any accidental dependency on source fencing or
// provider-operation recording before mutation authority is established.
function standaloneHealthPreflight() {
  const plan = structuredClone(p), abort = new AbortController(), requests = [];
  const job = {id:plan.jobResourceId,...buildHealthProbeJobDefinition(plan)};
  job.properties.provisioningState = "Succeeded";
  const environment = {id:plan.environmentResourceId,properties:{provisioningState:"Succeeded",defaultDomain:"fixture.eastus.azurecontainerapps.io",
    vnetConfiguration:{infrastructureSubnetId:plan.infrastructureSubnetId},
    appLogsConfiguration:{destination:"log-analytics",logAnalyticsConfiguration:{customerId:plan.workspaceId}}}};
  const logs = {tables:[{name:"PrimaryResult",columns:[{name:"preflight",type:"int"}],rows:[[1]]}]};
  const state = {owned:0,jobStatus:200,environmentStatus:200,logsStatus:200,afterRequest:null};
  const options = {plan,signal:abort.signal,assertOwned:async()=>{state.owned++;},
    get custody() { throw Error("NO_CUSTODY_PHASE_REQUIRED"); },
    get operations() { throw Error("NO_PROVIDER_RECORD_ALLOWED"); },
    get assertSourceFenced() { throw Error("NO_SOURCE_FENCE_REQUIRED"); },
    transport:async request=>{
      requests.push(structuredClone({method:request.method,path:request.path,body:request.body}));
      let response;
      if(request.method==="GET"&&request.path.startsWith(plan.jobResourceId+"?")) response={status:state.jobStatus,body:job};
      else if(request.method==="GET"&&request.path.startsWith(plan.environmentResourceId+"?")) response={status:state.environmentStatus,body:environment};
      else if(request.method==="POST"&&request.path===`/v1/workspaces/${plan.workspaceId}/query`) {
        assert.deepEqual(request.body,{query:"print preflight = 1"});response={status:state.logsStatus,body:logs};
      } else throw Error("PREFLIGHT_MUST_NOT_START_OR_WRITE");
      state.afterRequest?.(request); return structuredClone(response);
    } };
  return {plan,abort,requests,job,environment,logs,state,options,run:()=>preflightHealthJob(options)};
}
test("standalone health preflight validates exact resources and query access before custody phase or fence",async()=>{
  const f=standaloneHealthPreflight();const proof=await f.run();
  assert.equal(proof.logQueryAccess,true);assert.equal(proof.workspaceId,f.plan.workspaceId);
  assert.equal(proof.planSha256,hash(f.plan));assert.equal(proof.definitionSha256,hash(buildHealthProbeJobDefinition(f.plan)));
  assert.equal(proof.identity.imageDigest,f.plan.image.split("@")[1]);assert.equal(proof.identity.probeSha256,f.plan.probeSha256);
  assert.deepEqual(f.requests.map(r=>r.method),["GET","GET","POST"]);assert.equal(f.state.owned,6);
  assert(f.requests.every(r=>!r.path.includes("/start")&&!r.path.includes("/executions")));
});
for(const[name,change]of[
  ["missing job",f=>{f.state.jobStatus=404;}],
  ["missing environment",f=>{f.state.environmentStatus=404;}],
  ["foreign job",f=>{f.job.id+="-foreign";}],
  ["image drift",f=>{f.job.properties.template.containers[0].image="foreign:latest";}],
  ["platform identity drift",f=>{f.job.properties.configuration.identitySettings[0].identity+="-foreign";}],
  ["runtime identity enabled",f=>{f.job.properties.configuration.identitySettings[0].lifecycle="All";}],
  ["VNet drift",f=>{f.environment.properties.vnetConfiguration.infrastructureSubnetId+="-foreign";}],
  ["log workspace drift",f=>{f.environment.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId="00000000-0000-4000-8000-000000000099";}],
  ["runtime secret", f => { f.job.properties.configuration.secrets = [{name:"runtime-secret"}]; }],
  ["worker hostname", f => { f.environment.properties.defaultDomain = "foreign.eastus.azurecontainerapps.io"; }],
  ["log access denied",f=>{f.state.logsStatus=403;}],
  ["log partial error",f=>{f.logs.error={message:"PRIVATE_LOG_ERROR"};}],
  ["wrong query result",f=>{f.logs.tables[0].rows=[[0]];}],
  ["unexpected query column",f=>{f.logs.tables[0].columns[0].name="foreign";}],
  ["multiple query tables",f=>{f.logs.tables.push(structuredClone(f.logs.tables[0]));}],
])test(`standalone health preflight blocks ${name} without starts or journal writes`,async()=>{
  const f=standaloneHealthPreflight();change(f);await assert.rejects(f.run(),error=>{assert(!error.message.includes("PRIVATE_LOG_ERROR"));return /HEALTH_JOB_/.test(error.message);});
  assert(f.requests.every(r=>r.method==="GET"||r.method==="POST"&&r.path.endsWith("/query")));
});
test("standalone health preflight requires ownership before requests and after readback",async()=>{
  for(const after of [false,true]){
    const f=standaloneHealthPreflight();f.options.assertOwned=async()=>{f.state.owned++;if(!after||f.state.owned===2)throw Error("PRIVATE_LEASE_ERROR");};
    await assert.rejects(f.run(),/^Error: HEALTH_JOB_PREFLIGHT_FAILED$/);assert.equal(f.requests.length,after?1:0);
  }
});
test("standalone health preflight abort stops before dispatch or after readback",async()=>{
  for(const after of [false,true]){
    const f=standaloneHealthPreflight();if(after)f.state.afterRequest=()=>f.abort.abort();else f.abort.abort();
    await assert.rejects(f.run(),/HEALTH_JOB_PREFLIGHT_FAILED/);assert.equal(f.requests.length,after?1:0);
  }
});
test("standalone health real authenticated transport redacts auth failure and makes no fetch",async()=>{
  const f=standaloneHealthPreflight();let fetches=0;
  f.options.transport=createHealthJobTransport(f.plan,{credential:{async getToken(){throw Error("PRIVATE_AUTH_ERROR");}},fetchImpl:async()=>{fetches++;throw Error("NETWORK_FORBIDDEN");}});
  await assert.rejects(f.run(),error=>{assert(!error.message.includes("PRIVATE_AUTH_ERROR"));return /HEALTH_JOB_/.test(error.message);});assert.equal(fetches,0);
});


async function coldDemandFixture() {
  const f=await fixture({releaseMode:true});
  const target={subscriptionId:base.split("/")[2],resourceGroupName:"fixture",environmentId:p.environmentResourceId,apps:{web:"fixture-web",worker:"fixture-worker"}};
  const demand={schedulerJobName:"fixture-scheduler",schedulerResources:{cpu:0.5,memory:"1Gi"},scalerConnectionSecret:{name:"worker-scaler-connection",identity:p.identityResourceId,keyVaultUrl:`https://fixture.vault.azure.net/secrets/scaler/${"a".repeat(32)}`}};
  f.opts.workerDemand={plan:demand,target};
  f.app.identity={type:"UserAssigned",userAssignedIdentities:{[p.identityResourceId]:{}}};
  const c=f.app.properties.configuration;c.ingress.targetPort=9090;
  c.secrets=[demand.scalerConnectionSecret,{name:"db",identity:p.identityResourceId,keyVaultUrl:`https://fixture.vault.azure.net/secrets/db/${"b".repeat(32)}`}];
  f.app.properties.template={containers:[{name:"worker",image:p.worker.image,env:[{name:"DATABASE_URL",secretRef:"db"},{name:"WORKER_EXECUTION_MODE",value:"queue-only"}]}],scale:managedAzureWorkerDemandScale(demand)};
  f.app.properties.latestReadyRevisionName="previous";
  f.rev.properties.healthState="None";f.rev.properties.runningState="Stopped";
  f.state.replicaCount=0;f.state.wakeOnStart=true;
  return f;
}
test("demand private health probe wakes a zero-replica revision before strict post-probe health",async()=>{
  const f=await coldDemandFixture();const result=await f.run(await f.reopen());
  assert.equal(result.health.status,200);assert.equal(f.state.starts,1);assert.equal(f.state.replicaCount,1);
  assert.ok(f.state.requests.some(r=>r.path.includes("/replicas?")));
});
test("demand cold preflight cannot turn an idle revision into a serving claim without actual wake",async()=>{
  const f=await coldDemandFixture();f.state.wakeOnStart=false;
  await assert.rejects(f.run(await f.reopen()),/HEALTH_JOB_WORKER_(BINDING|REVISION)_CHANGED/);
  assert.equal(f.state.starts,1);
});
test("demand cold preflight refuses scaler drift before starting observation",async()=>{
  const f=await coldDemandFixture();f.app.properties.template.scale.rules[0].custom.metadata.query="SELECT 0";
  await assert.rejects(f.run(await f.reopen()));assert.equal(f.state.starts,0);
});


test("default health transport allows only exact worker revision replica GETs",async()=>{
 const calls=[];const transport=createHealthJobTransport(p,{credential:{getToken:async()=>({token:"synthetic"})},fetchImpl:async(url,options)=>{
  calls.push({url,method:options.method});const response=Response.json({value:[]});Object.defineProperty(response,"url",{value:url});return response;
 }});const signal=new AbortController().signal;
 const path=`${p.worker.appId}/revisions/${revision}/replicas?api-version=2025-07-01`;
 assert.deepEqual(await transport({method:"GET",path,signal}),{status:200,body:{value:[]}});
 for(const [method,denied]of[["POST",path],["GET",path.replace("/containerApps/fixture-worker/","/containerApps/foreign-worker/")],["GET",path.replace(`/revisions/${revision}/`,`/revisions/foreign-worker--fixture/`)],["GET",path.replace("/replicas?","/replicas/other?")]]){
  await assert.rejects(transport({method,path:denied,signal}),/HEALTH_JOB_ENDPOINT_DENIED/);
 }
 assert.equal(calls.length,1);
});

test("cold demand probe crosses the actual default transport replica allowlist",async()=>{
 const f=await coldDemandFixture(),provider=f.opts.transport;
 f.opts.transport=createHealthJobTransport(p,{credential:{getToken:async()=>({token:"synthetic"})},fetchImpl:async(url,options)=>{
  const parsed=new URL(url),result=await provider({method:options.method,path:parsed.pathname+parsed.search,signal:options.signal,...(options.body?{body:JSON.parse(options.body)}:{})});
  const response=Response.json(result.body,{status:result.status});Object.defineProperty(response,"url",{value:url});return response;
 }});
 assert.equal((await f.run(await f.reopen())).health.status,200);
 assert.ok(f.state.requests.some(r=>r.path.includes(`/revisions/${revision}/replicas?`)));
 assert.equal(f.state.starts,1);
});
