import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { buildRedisProbeJobDefinition, createRedisJobDispatcher, createRedisJobTransport, preflightRedisJob } from "./ops-core-redis-job.mjs";
import { REDIS_PROBE_PREFIX, redisProbeBuildSha256, runRedisProbeCli } from "./ops-core-redis-probe.mjs";
import { assertOpsCoreRedisEmpty, redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";

const base = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/";
function plan() { return {
  target: { mode:"azure-enterprise-proxy", connection:{host:"fixture.eastus.redis.azure.net",port:10000,database:0,username:"default",tls:true},
    server:{version:"7.4.0",runId:null},resourceId:`${base}Microsoft.Cache/redisEnterprise/fixture/databases/default` },
  jobResourceId:`${base}Microsoft.App/jobs/fixture-probe`,environmentResourceId:`${base}Microsoft.App/managedEnvironments/fixture-env`,
  infrastructureSubnetId:`${base}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,workspaceId:"00000000-0000-4000-8000-000000000002",
  identityResourceId:`${base}Microsoft.ManagedIdentity/userAssignedIdentities/fixture-core`,image:`fixture.azurecr.io/worker@sha256:${"a".repeat(64)}`,
  probeSha256:"b".repeat(64),redisSecretVersion:`https://fixture.vault.azure.net/secrets/redis/${"c".repeat(32)}`,location:"eastus",
}; }
async function fixture() {
  const p = plan(); const records = new Map(); const controller = new AbortController();
  const journal = {domain:"core",intentSha256:"d".repeat(64),phase:"RESTORED",pending:{to:"VERIFIED",operationId:"00000000-0000-4000-8000-000000000003"},
    history:[{phase:"SOURCE_FENCED",evidenceSha256:"e".repeat(64)}]};
  const custody = { signal:controller.signal,assertOwned:async()=>{},snapshot:()=>structuredClone(journal) };
  const store = {assertPrivate:async()=>{},readOptional:async key=>records.get(key)??null,
    createOnly:async(key,text)=>{assert(!records.has(key));records.set(key,text);} };
  const state = {starts:0,requests:[],executions:[],loseStart:false,mutateJob:null,mutateExecution:null,mutateLogs:null,source:true,target:true,policy:true};
  const job = {id:p.jobResourceId,...buildRedisProbeJobDefinition(p)}; job.properties.provisioningState="Succeeded";
  const environment = {id:p.environmentResourceId,properties:{provisioningState:"Succeeded",vnetConfiguration:{infrastructureSubnetId:p.infrastructureSubnetId},
    appLogsConfiguration:{destination:"log-analytics",logAnalyticsConfiguration:{customerId:p.workspaceId}}}};
  const response = (body,status=200)=>({status,body:structuredClone(body)});
  const transport = async request => {
    const {method,path,body}=request; state.requests.push({method,path,body:structuredClone(body)});
    if (path.startsWith(p.environmentResourceId+"?")) return response(environment);
    if (path.startsWith(p.jobResourceId+"?")) {const copy=structuredClone(job);state.mutateJob?.(copy);return response(copy);}
    if (path.startsWith(`${p.jobResourceId}/start?`)) {
      assert.equal(method,"POST"); state.starts++;
      // Full safe descriptor and durable operation intent predate the effect.
      assert([...records.keys()].some(k=>k.endsWith("/descriptor.json")));
      assert([...records.values()].some(t=>JSON.parse(t).kind==="AZURE_REDIS_PROBE_START"&&JSON.parse(t).type==="intent"));
      const start = Date.now();
      state.executions.push({id:`${p.jobResourceId}/executions/fixture-probe-run${state.starts}`,name:`fixture-probe-run${state.starts}`,type:"Microsoft.App/jobs/executions",
        properties:{status:"Succeeded",startTime:new Date(start).toISOString(),endTime:new Date(start).toISOString(),template:structuredClone(body)}});
      if(state.loseStart){state.loseStart=false;throw new Error("PRIVATE_PROVIDER_BODY");}
      return response({id:state.executions.at(-1).id,name:state.executions.at(-1).name});
    }
    if(path.startsWith(`${p.jobResourceId}/executions?`))return response({value:state.executions});
    if(path.startsWith(`${p.jobResourceId}/executions/`)){const copy=structuredClone(state.executions.find(e=>path.startsWith(`${p.jobResourceId}/executions/${e.name}?`)));state.mutateExecution?.(copy);return response(copy);}
    if(path===`/v1/workspaces/${p.workspaceId}/query`){
      const execution=state.executions.find(e=>body.query.includes(`'${e.name}-'`));const challenge=JSON.parse(execution.properties.template.containers[0].env.find(e=>e.name==="CORGTEX_REDIS_CHALLENGE").value);
      assert(body.query.includes(`'${execution.name}-'`));assert(body.query.includes(challenge.nonce));assert(!body.query.includes("latest"));
      const receipt={schemaVersion:1,type:"REDIS_TARGET_EMPTY_OBSERVATION",challengeSha256:hash(challenge),nonce:challenge.nonce,
        domain:challenge.domain,intentSha256:challenge.intentSha256,sourceFenceSha256:challenge.sourceFenceSha256,targetBindingSha256:challenge.targetBindingSha256,
        identity:challenge.identity,observedAt:Date.parse(execution.properties.startTime),observation:{bindingSha256:challenge.targetBindingSha256,
          mode:p.target.mode,server:{version:p.target.server.version,runIdSha256:null},scanPages:1,scannedKeys:0,dbSizeBefore:0,dbSizeAfter:0,scope:"all-proxy-shards"}};
      const table={tables:[{name:"PrimaryResult",columns:["TimeGenerated","EnvironmentName_s","ContainerGroupName_s","ContainerName_s","ContainerImage_s","Log_s","_ResourceId"].map(name=>({name,type:"string"})),
        rows:[[execution.properties.startTime,"fixture-env",`${execution.name}-replica1`,"redis-probe",p.image,REDIS_PROBE_PREFIX+JSON.stringify(receipt),p.environmentResourceId]]}]};
      state.mutateLogs?.(table);return response(table);
    }
    throw new Error("UNEXPECTED_REQUEST");
  };
  const opts={plan:p,custody,descriptorStore:store,transport,pollIntervalMs:0,
    assertSourceFenced:async()=>({complete:state.source,domain:journal.domain,intentSha256:journal.intentSha256,sourceFenceSha256:journal.history[0].evidenceSha256}),
    assertTargetInactive:async()=>({complete:state.target,targetBindingSha256:redisGateBindingSha256(p.target)}),
    assertEnterpriseBinding:async()=>({complete:state.policy,resourceId:p.target.resourceId,host:p.target.connection.host,port:p.target.connection.port,clusteringPolicy:"EnterpriseCluster",geoReplication:"Disabled"})};
  async function reopen(){const operations=await openProviderOperationRecorder({custody,store,phase:"VERIFIED",signal:controller.signal});return createRedisJobDispatcher({...opts,operations});}
  const dispatcher=await reopen();
  const challenge=()=>({schemaVersion:1,nonce:randomBytes(32).toString("hex"),domain:journal.domain,intentSha256:journal.intentSha256,
    sourceFenceSha256:journal.history[0].evidenceSha256,targetBindingSha256:redisGateBindingSha256(p.target),identity:dispatcher.identity,issuedAt:Date.now()-1000,expiresAt:Date.now()+30_000});
  return {p,state,controller,records,store,custody,journal,opts,job,environment,reopen,dispatcher,challenge,
    run:(d=dispatcher,c=challenge())=>d.runProbe({challenge:c,binding:p.target,signal:controller.signal})};
}

test("exact precreated Manual job, independently bounded image/MI/secret and node-only startup",async()=>{
  const f=await fixture();const result=await f.dispatcher.prepare();assert.equal(result.identity.imageDigest,f.p.image.split("@")[1]);
  const d=buildRedisProbeJobDefinition(f.p);assert.equal(d.properties.configuration.replicaRetryLimit,0);
  assert.deepEqual(d.properties.template.containers[0].command,["node","/app/scripts/migration/ops-core-redis-probe.mjs"]);
  assert.deepEqual(d.properties.configuration.identitySettings,[{identity:f.p.identityResourceId,lifecycle:"None"}]);assert.equal(f.state.starts,0);
});
test("actual recorder retains safe descriptor before one start and exact terminal completed logs bind response",async()=>{
  const f=await fixture();const result=await f.run();assert.equal(result.execution.status,"Succeeded");assert.equal(result.execution.replicaCount,1);
  assert.equal(result.receipt.observation.scannedKeys,0);assert.equal(f.state.starts,1);assert.equal([...f.records.keys()].filter(k=>k.endsWith("/receipt.json")).length,1);
  assert(f.state.requests.every(r=>r.method==="GET"||r.path.includes("/start?")||r.path.endsWith("/query")));
});
test("lost start acknowledgement reopens actual recorder and reconciles matching execution without replay",async()=>{
  const f=await fixture();const challenge=f.challenge();f.state.loseStart=true;
  await assert.rejects(f.run(f.dispatcher,challenge),/REDIS_JOB_RECONCILE_REQUIRED/);assert.equal(f.state.starts,1);
  const reopened=await f.reopen();const result=await f.run(reopened,challenge);assert.equal(result.execution.status,"Succeeded");assert.equal(f.state.starts,1);
});
test("name-only ARM execution list, GET and start responses retain exact parent binding",async()=>{
  const f=await fixture(); const original=f.opts.transport;
  f.opts.transport=async request=>{
    const result=await original(request);
    if(request.path.includes("/executions")) {
      if(result.body.value) for(const row of result.body.value) delete row.id;
      else delete result.body.id;
    }
    if(request.path.includes("/start?")) delete result.body.id;
    return result;
  };
  const result=await f.run(await f.reopen());
  assert.equal(result.execution.executionResourceId,`${f.p.jobResourceId}/executions/fixture-probe-run1`);
  assert.equal(f.state.starts,1);
});
test("ARM resource ID casing changes preserve exact job, environment and identity binding",async()=>{
  const f=await fixture(); const original=f.opts.transport;
  const normalize=value=>typeof value==="string"&&value.startsWith("/subscriptions/")?value.toLowerCase()
    :Array.isArray(value)?value.map(normalize):value&&typeof value==="object"
      ?Object.fromEntries(Object.entries(value).map(([key,entry])=>[key.startsWith("/subscriptions/")?key.toLowerCase():key,normalize(entry)])):value;
  f.opts.transport=async request=>{const response=await original(request);return {...response,body:normalize(response.body)};};
  const result=await f.run(await f.reopen());assert.equal(result.execution.status,"Succeeded");assert.equal(f.state.starts,1);
});
test("a present foreign execution ID is rejected even with the expected execution name",async()=>{
  const f=await fixture();f.state.mutateExecution=row=>{row.id=row.id.replace("fixture-probe/executions","other-job/executions");};
  await assert.rejects(f.run(),/REDIS_JOB_EXECUTION_INVALID/);assert.equal(f.state.starts,1);
});
test("name-only execution readback reconciles a lost acknowledgement without another start",async()=>{
  const f=await fixture();const c=f.challenge();f.state.loseStart=true;await assert.rejects(f.run(f.dispatcher,c));
  for(const row of f.state.executions) delete row.id;
  const result=await f.run(await f.reopen(),c);assert.equal(result.execution.status,"Succeeded");assert.equal(f.state.starts,1);
});
for(const [name,mutate] of [
  ["image",j=>j.properties.template.containers[0].image="foreign:latest"],
  ["app startup",j=>j.properties.template.containers[0].command=["node","/app/scripts/start-worker.mjs"]],
  ["extra container",j=>j.properties.template.containers.push(j.properties.template.containers[0])],
  ["init container",j=>j.properties.template.initContainers=[{name:"migration"}]],
  ["volume",j=>j.properties.template.volumes=[{name:"unexpected"}]],
  ["NODE_OPTIONS",j=>j.properties.template.containers[0].env.push({name:"NODE_OPTIONS",value:"--require anything"})],
  ["plaintext secret",j=>j.properties.configuration.secrets[0].value="PRIVATE_SECRET"],
  ["unversioned secret",j=>j.properties.configuration.secrets[0].keyVaultUrl=j.properties.configuration.secrets[0].keyVaultUrl.split("/").slice(0,-1).join("/")],
  ["MI exposed",j=>j.properties.configuration.identitySettings[0].lifecycle="All"],
  ["schedule",j=>j.properties.configuration.triggerType="Schedule"],
  ["retry",j=>j.properties.configuration.replicaRetryLimit=1],
  ["parallelism",j=>j.properties.configuration.manualTriggerConfig.parallelism=2],
  ["memory",j=>j.properties.template.containers[0].resources.memory="1Gi"],
  ["environment",j=>j.properties.environmentId+="-foreign"],
])test(`rejects changed job ${name} before effects`,async()=>{const f=await fixture();f.state.mutateJob=mutate;await assert.rejects(f.run(),/REDIS_JOB_(CONFIG|TEMPLATE)_CHANGED/);assert.equal(f.state.starts,0);});
for(const field of ["nonce","intentSha256","sourceFenceSha256","targetBindingSha256"])test(`rejects receipt ${field} mismatch`,async()=>{
  const f=await fixture();f.state.mutateLogs=logs=>{const row=logs.tables[0].rows[0],r=JSON.parse(row[5].slice(REDIS_PROBE_PREFIX.length));r[field]="f".repeat(64);row[5]=REDIS_PROBE_PREFIX+JSON.stringify(r);};
  await assert.rejects(f.run(),/REDIS_JOB_LOG_RECEIPT_INVALID/);
});
for(const [name,mutate] of [
  ["replica",t=>t.tables[0].rows[0][2]="foreign-replica"],
  ["container",t=>t.tables[0].rows[0][3]="worker"],
  ["image",t=>t.tables[0].rows[0][4]="foreign:latest"],
  ["timestamp",t=>t.tables[0].rows[0][0]="2000-01-01T00:00:00Z"],
  ["duplicate receipt",t=>t.tables[0].rows.push(t.tables[0].rows[0])],
  ["partial result",t=>t.error={message:"PRIVATE_PROVIDER_ERROR"}],
])test(`rejects completed log ${name}`,async()=>{const f=await fixture();f.state.mutateLogs=mutate;await assert.rejects(f.run(),/REDIS_JOB_LOG_/);});
test("absent completed logs cannot prove freshness",async()=>{
  const f=await fixture();const c=f.challenge();c.expiresAt=c.issuedAt+1150;f.state.mutateLogs=t=>{t.tables[0].rows=[];};
  await assert.rejects(f.run(f.dispatcher,c),/REDIS_JOB_CHALLENGE_INVALID/);assert.equal(f.state.starts,1);
});
for(const guard of ["source","target","policy"])test(`${guard} proof required before dispatch and readback`,async()=>{
  const f=await fixture();f.state[guard]=false;await assert.rejects(f.run(),/REDIS_JOB_/);assert.equal(f.state.starts,0);
});
test("changed network or log workspace fails prepare",async()=>{
  const f=await fixture();f.environment.properties.appLogsConfiguration.logAnalyticsConfiguration.customerId="foreign";
  await assert.rejects(f.dispatcher.prepare(),/REDIS_JOB_ENVIRONMENT_CHANGED/);
});
test("descriptor readback failure blocks start",async()=>{
  const f=await fixture();f.store.createOnly=async()=>{};await assert.rejects(f.run(),/REDIS_JOB_DESCRIPTOR_MISMATCH/);assert.equal(f.state.starts,0);
});
test("multiple matching executions never accepted",async()=>{
  const f=await fixture();f.state.loseStart=true;const c=f.challenge();await assert.rejects(f.run(f.dispatcher,c));
  const other=structuredClone(f.state.executions[0]);other.name+="-other";other.id+="-other";f.state.executions.push(other);
  await assert.rejects(f.run(await f.reopen(),c));assert.equal(f.state.starts,1);
});
test("probe hashes actual files and never emits malformed/secret input",async()=>{
  assert.match(await redisProbeBuildSha256(),/^[a-f0-9]{64}$/);let output="";
  assert.equal(await runRedisProbeCli({env:{CORGTEX_REDIS_PROBE_IDENTITY:"PRIVATE_SECRET",REDIS_PROBE_PASSWORD:"PRIVATE_SECRET"},write:s=>output+=s}),false);
  assert.equal(output,"CORGTEX_REDIS_PROBE_FAILED\n");
});
test("default transport authenticates exact ARM/Logs audience, carries start body, rejects foreign endpoints",async()=>{
  const p=plan();const calls=[],tokens=[];const signal=new AbortController().signal;
  const transport=createRedisJobTransport(p,{credential:{getToken:async(scope)=>{tokens.push(scope);return{token:"synthetic-test-credential"};}},
    fetchImpl:async(url,init)=>{calls.push({url,init});const r=new Response(JSON.stringify({name:"fixture"}));Object.defineProperty(r,"url",{value:url});return r;}});
  await transport({method:"POST",path:`${p.jobResourceId}/start?api-version=2025-07-01`,body:{containers:[]},signal});
  await transport({method:"POST",path:`/v1/workspaces/${p.workspaceId}/query`,body:{query:"safe"},signal});
  assert.deepEqual(tokens,["https://management.azure.com/.default","https://api.loganalytics.io/.default"]);assert.equal(calls[0].init.redirect,"error");
  await assert.rejects(transport({method:"GET",path:"https://foreign.invalid/",signal}),/REDIS_JOB_ENDPOINT_DENIED/);assert.equal(calls.length,2);
});
test("transport suppresses raw credentials in provider and fetch errors",async()=>{
  const p=plan(),signal=new AbortController().signal;const transport=createRedisJobTransport(p,{credential:{getToken:async()=>{throw new Error("PRIVATE_SECRET");}}});
  await assert.rejects(transport({method:"GET",path:`${p.jobResourceId}?api-version=2025-07-01`,signal}),e=>e.message==="REDIS_JOB_TRANSPORT_FAILED"&&!String(e.stack).includes("PRIVATE_SECRET"));
});

test("fresh gate nonce cannot bypass unknown start; retained descriptor permits read-only recovery",async()=>{
  const f=await fixture();f.state.loseStart=true;const c=f.challenge();await assert.rejects(f.run(f.dispatcher,c));
  f.state.executions[0].properties.status="Running";
  const reopened=await f.reopen();const retained=await reopened.readRetainedStart();assert.deepEqual(retained.input.challenge,c);
  await assert.rejects(f.run(reopened,f.challenge()),/REDIS_JOB_PRIOR_ATTEMPT_REQUIRES_RECONCILIATION/);
  const recovered=await reopened.reconcileStart();assert.equal(recovered.executionResourceId,f.state.executions[0].id);assert.equal(f.state.starts,1);
});
test("expired retained challenge can reconcile start but cannot pass fresh acceptance",async()=>{
  const f=await fixture();f.state.loseStart=true;const c=f.challenge();c.expiresAt=c.issuedAt+1100;
  await assert.rejects(f.run(f.dispatcher,c));await new Promise(r=>setTimeout(r,Math.max(0,c.expiresAt-Date.now()+5)));
  const reopened=await f.reopen();assert.equal((await reopened.reconcileStart()).expired,true);
  await assert.rejects(f.run(reopened,c),/REDIS_JOB_CHALLENGE_INVALID/);assert.equal(f.state.starts,1);
});
test("pending start absent in provider cannot replay during reconciliation",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());f.state.executions=[];
  await assert.rejects((await f.reopen()).reconcileStart(),/REDIS_JOB_RECONCILE_REQUIRED/);assert.equal(f.state.starts,1);
});
test("post-dispatch abort never issues stop/delete or second start",async()=>{
  const f=await fixture();f.state.mutateExecution=e=>{e.properties.status="Running";f.controller.abort();};
  await assert.rejects(f.run(),/REDIS_JOB_ABORTED/);assert.equal(f.state.starts,1);
  assert(!f.state.requests.some(r=>r.method==="DELETE"||r.path.includes("/stop")));
});

test("real external gate accepts actual dispatcher output and completely rescans only source",async()=>{
  const f=await fixture();let scans=0,connects=0;
  const source={mode:"standalone",connection:{host:"source.fixture.invalid",port:6379,database:0,username:"default",tls:false},server:{version:"8.2.9",runId:"a".repeat(40)},resourceId:null};
  const result=await assertOpsCoreRedisEmpty({source,target:f.p.target,sourceCredentials:{password:randomBytes(20).toString("base64"),tlsCa:null},
    custody:f.custody,assertSourceFenced:f.opts.assertSourceFenced,assertTargetInactive:f.opts.assertTargetInactive,
    assertEnterpriseBinding:f.opts.assertEnterpriseBinding,remoteTarget:{identity:f.dispatcher.identity,runProbe:f.dispatcher.runProbe},
    createClient:options=>{assert.equal(options.socket.host,source.connection.host);return {isOpen:false,on(){},destroy(){},async connect(){connects++;},
      async sendCommand(args){if(args[0]==="INFO")return `redis_version:8.2.9\r\nredis_mode:standalone\r\nrun_id:${source.server.runId}\r\n`;
        if(args[0]==="ROLE")return["master"];if(args[0]==="DBSIZE")return 0;if(args[0]==="SCAN"){scans++;return["0",[]];}throw new Error();}};}});
  assert.equal(result.status,"REDIS_EMPTY_ACCEPTED");assert.equal(scans,2);assert.equal(connects,1);assert.equal(f.state.starts,1);
});
test("log resource ID and job sidecars cannot be confused with exact environment",async()=>{
  const f=await fixture();f.state.mutateLogs=t=>{t.tables[0].rows[0][6]=f.p.environmentResourceId+"-foreign";};
  await assert.rejects(f.run(),/REDIS_JOB_LOG_BINDING_MISMATCH/);
  const g=await fixture();g.job.properties.configuration.dapr={enabled:true};await assert.rejects(g.run(),/REDIS_JOB_CONFIG_CHANGED/);assert.equal(g.state.starts,0);
});
test("job configuration drift after execution blocks proof",async()=>{
  const f=await fixture();f.state.mutateLogs=()=>{f.job.properties.configuration.replicaRetryLimit=1;};
  await assert.rejects(f.run(),/REDIS_JOB_CONFIG_CHANGED/);assert.equal(f.state.starts,1);
});
test("execution response cannot switch image after exact list match",async()=>{
  const f=await fixture();f.state.mutateExecution=e=>{e.properties.template.containers[0].image="foreign:latest";};
  await assert.rejects(f.run(),/REDIS_JOB_TEMPLATE_CHANGED/);
});
test("real transport enforces response byte limit and does not expose response body",async()=>{
  const p=plan(),signal=new AbortController().signal;
  const transport=createRedisJobTransport(p,{credential:{getToken:async()=>({token:"synthetic-test-credential"})},fetchImpl:async url=>{
    const r=new Response("PRIVATE_BODY".repeat(100000));Object.defineProperty(r,"url",{value:url});return r;}});
  await assert.rejects(transport({method:"GET",path:`${p.jobResourceId}?api-version=2025-07-01`,signal}),/REDIS_JOB_RESPONSE_TOO_LARGE/);
});
test("plan rejects unpinned image, missing secret version and injected query values",()=>{
  for(const mutate of [p=>p.image="fixture.azurecr.io/worker:latest",p=>p.redisSecretVersion=p.redisSecretVersion.slice(0,-33),p=>p.environmentResourceId+="' | take 1",p=>p.workspaceId="bad"]){
    const p=plan();mutate(p);assert.throws(()=>buildRedisProbeJobDefinition(p),/REDIS_JOB_PLAN_INVALID/);
  }
});

test("accepts actual ARM harmless ContainerImage, null, and location defaults",async()=>{
  const f=await fixture();f.job.location="East US";f.job.properties.template.containers[0].imageType="ContainerImage";
  f.job.properties.template.containers[0].env[0].value=null;f.job.properties.configuration.secrets[0].value=null;
  f.job.properties.configuration.registries[0].username=null;f.job.properties.configuration.registries[0].passwordSecretRef=null;
  assert.equal((await f.dispatcher.prepare()).identity.probeSha256,f.p.probeSha256);
});
test("recorded start response 202 with no body reconciles through exact executions",async()=>{
  const f=await fixture();const original=f.opts.transport;
  f.opts.transport=async request=>{const result=await original(request);return request.path.includes("/start?")?{status:202,body:null}:result;};
  const result=await f.run(await f.reopen());assert.equal(result.execution.status,"Succeeded");assert.equal(f.state.starts,1);
});
test("execution pagination is complete and constrained to exact job",async()=>{
  const f=await fixture();const original=f.opts.transport;let pages=0;
  f.opts.transport=async request=>{
    if(request.path.startsWith(`${f.p.jobResourceId}/executions?`)){
      pages++;
      return {status:200,body:{value:[],nextLink:"https://foreign.invalid/executions?api-version=2025-07-01"}};
    }return original(request);
  };
  await assert.rejects(f.run(await f.reopen()),/REDIS_JOB_NEXT_LINK_DENIED/);assert.equal(pages,1);assert.equal(f.state.starts,0);
});
test("execution pagination loop cannot silently truncate inventory",async()=>{
  const f=await fixture();const original=f.opts.transport;
  f.opts.transport=async request=>request.path.startsWith(`${f.p.jobResourceId}/executions?`)
    ?{status:200,body:{value:[],nextLink:`https://management.azure.com${f.p.jobResourceId}/executions?api-version=2025-07-01`}}:original(request);
  await assert.rejects(f.run(await f.reopen()),/REDIS_JOB_EXECUTION_PAGE_BOUND/);assert.equal(f.state.starts,0);
});
test("foreign active job execution prevents another start",async()=>{
  const f=await fixture();f.state.executions=[{id:`${f.p.jobResourceId}/executions/foreign`,name:"foreign",properties:{status:"Running",template:{containers:[]}}}];
  await assert.rejects(f.run(),/REDIS_JOB_FOREIGN_EXECUTION/);assert.equal(f.state.starts,0);
});


test("terminal retained observations permit sequential fresh nonces without replay",async()=>{
  const f=await fixture();const first=f.challenge();await f.run(f.dispatcher,first);
  const second=f.challenge();await f.run(await f.reopen(),second);
  const third=f.challenge();const latest=await f.reopen();await f.run(latest,third);
  assert.equal(f.state.starts,3);assert.equal(f.state.executions.length,3);
  assert.deepEqual((await latest.readRetainedStart()).input.challenge,third);
  assert.equal([...f.records.keys()].filter(k=>k.endsWith("/receipt.json")).length,3);
});
test("expired terminal lost acknowledgement is reconciled before a fresh observation",async()=>{
  const f=await fixture();f.state.loseStart=true;const c=f.challenge();c.expiresAt=c.issuedAt+1100;
  await assert.rejects(f.run(f.dispatcher,c));await new Promise(r=>setTimeout(r,Math.max(0,c.expiresAt-Date.now()+5)));
  const fresh=f.challenge();const result=await f.run(await f.reopen(),fresh);
  assert.equal(result.receipt.nonce,fresh.nonce);assert.equal(f.state.starts,2);
  assert.equal([...f.records.keys()].filter(k=>k.endsWith("/receipt.json")).length,2);
});
test("unlocatable retained start blocks new nonce with no second POST",async()=>{
  const f=await fixture();f.state.loseStart=true;await assert.rejects(f.run());f.state.executions=[];
  await assert.rejects(f.run(await f.reopen()),/REDIS_JOB_PRIOR_ATTEMPT_REQUIRES_RECONCILIATION/);
  assert.equal(f.state.starts,1);
});


// Standalone preflight deliberately never creates a dispatcher or a pending
// journal. These traps reject any accidental dependency on source fencing or
// provider-operation recording before mutation authority is established.
function standaloneRedisPreflight(value = plan()) {
  const plan = value, abort = new AbortController(), requests = [];
  const job = {id:plan.jobResourceId,...buildRedisProbeJobDefinition(plan)};
  job.properties.provisioningState = "Succeeded";
  const environment = {id:plan.environmentResourceId,properties:{provisioningState:"Succeeded",
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
  return {plan,abort,requests,job,environment,logs,state,options,run:()=>preflightRedisJob(options)};
}
test("standalone redis preflight validates exact resources and query access before custody phase or fence",async()=>{
  const f=standaloneRedisPreflight();const proof=await f.run();
  assert.equal(proof.logQueryAccess,true);assert.equal(proof.workspaceId,f.plan.workspaceId);
  assert.equal(proof.planSha256,hash(f.plan));assert.equal(proof.definitionSha256,hash(buildRedisProbeJobDefinition(f.plan)));
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
  ["secret version", f => { f.job.properties.configuration.secrets[0].keyVaultUrl = f.plan.redisSecretVersion.replace(/.$/, "d"); }],
  ["secret identity", f => { f.job.properties.configuration.secrets[0].identity += "-foreign"; }],
  ["log access denied",f=>{f.state.logsStatus=403;}],
  ["log partial error",f=>{f.logs.error={message:"PRIVATE_LOG_ERROR"};}],
  ["wrong query result",f=>{f.logs.tables[0].rows=[[0]];}],
  ["unexpected query column",f=>{f.logs.tables[0].columns[0].name="foreign";}],
  ["multiple query tables",f=>{f.logs.tables.push(structuredClone(f.logs.tables[0]));}],
])test(`standalone redis preflight blocks ${name} without starts or journal writes`,async()=>{
  const f=standaloneRedisPreflight();change(f);await assert.rejects(f.run(),error=>{assert(!error.message.includes("PRIVATE_LOG_ERROR"));return /REDIS_JOB_/.test(error.message);});
  assert(f.requests.every(r=>r.method==="GET"||r.method==="POST"&&r.path.endsWith("/query")));
});
test("standalone redis preflight requires ownership before requests and after readback",async()=>{
  for(const after of [false,true]){
    const f=standaloneRedisPreflight();f.options.assertOwned=async()=>{f.state.owned++;if(!after||f.state.owned===2)throw Error("PRIVATE_LEASE_ERROR");};
    await assert.rejects(f.run(),/^Error: REDIS_JOB_PREFLIGHT_FAILED$/);assert.equal(f.requests.length,after?1:0);
  }
});
test("standalone redis preflight abort stops before dispatch or after readback",async()=>{
  for(const after of [false,true]){
    const f=standaloneRedisPreflight();if(after)f.state.afterRequest=()=>f.abort.abort();else f.abort.abort();
    await assert.rejects(f.run(),/REDIS_JOB_PREFLIGHT_FAILED/);assert.equal(f.requests.length,after?1:0);
  }
});
test("standalone redis real authenticated transport redacts auth failure and makes no fetch",async()=>{
  const f=standaloneRedisPreflight();let fetches=0;
  f.options.transport=createRedisJobTransport(f.plan,{credential:{async getToken(){throw Error("PRIVATE_AUTH_ERROR");}},fetchImpl:async()=>{fetches++;throw Error("NETWORK_FORBIDDEN");}});
  await assert.rejects(f.run(),error=>{assert(!error.message.includes("PRIVATE_AUTH_ERROR"));return /REDIS_JOB_/.test(error.message);});assert.equal(fetches,0);
});
