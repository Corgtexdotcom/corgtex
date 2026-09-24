import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { createOpsCoreSourceHealthObserver, createRailwaySourceHealthRemoteRead, validateOpsCoreSourceHealthPlan } from "./ops-core-source-health.mjs";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const release = { gitSha:"a".repeat(40),imageTag:`sha-${"a".repeat(40)}`,version:"1.2.3" };
const healthPlan = () => ({schemaVersion:1,projectId:id(1),environmentId:id(2),services:[
  {role:"web",serviceId:id(3),deploymentId:id(4),port:3000,release},
  {role:"worker",serviceId:id(5),deploymentId:id(6),port:9090,release},
]});
function releaseBody(role) { return {...release,service:role,runtime:{gitSha:release.gitSha,source:"baked",evidence:"baked"},drift:{gitSha:false,imageTag:false,version:false,details:[]}}; }
function webBody() { return {status:"ok",service:"web",database:"up",schema:"ready",app:"corgtex",release:releaseBody("web"),runtime:{privateValue:"PRIVATE_ENV"}}; }
function workerBody(observedAt = Date.now()) { return {status:"ok",phase:"running",lastError:null,tickCount:3,lastSuccessfulTickAt:new Date(observedAt).toISOString(),workerId:"PRIVATE_WORKER_ID",release:releaseBody("worker")}; }
const baked = role => ({schemaVersion:1,role,gitSha:release.gitSha});
const fileHash = role => createHash("sha256").update(JSON.stringify(baked(role))).digest("hex");
function fixture() {
  const health=healthPlan(),writerBinding={projectId:id(1),environmentId:id(2),serviceIds:[id(3),id(5),id(9)]};
  const plan={schemaVersion:1,domain:"core",source:{health,writers:{binding:writerBinding}}};
  const writerBaseline={binding:writerBinding,services:health.services.map(s=>({serviceId:s.serviceId,activeDeploymentIds:[s.deploymentId],deploymentIds:[s.deploymentId]}))};
  writerBaseline.services.push({serviceId:id(9),activeDeploymentIds:[],completedScheduledDeploymentIds:[id(10)],deploymentIds:[id(10)]});
  const abort=new AbortController(),state={providerReads:0,remoteReads:0,owned:0,providerMutate:null,remoteMutate:null,instanceOffset:0,queries:[]};
  const options={plan,signal:abort.signal,assertOwned:async()=>{state.owned++;},transport:async q=>{
    state.providerReads++;state.queries.push(q);assert(q.query.startsWith("query SourceHealth"));assert(!q.query.includes("config")&&!q.query.includes("mutation"));
    const s=health.services.find(s=>s.serviceId===q.variables.serviceId);
    const data={environment:{id:health.environmentId,projectId:health.projectId},serviceInstance:{serviceId:s.serviceId,environmentId:health.environmentId,
      service:{id:s.serviceId,projectId:health.projectId},activeDeployments:[{id:s.deploymentId,projectId:health.projectId,environmentId:health.environmentId,
        serviceId:s.serviceId,status:"SUCCESS",deploymentStopped:false,instances:[{id:id((s.role==="web"?7:8)+state.instanceOffset),status:"RUNNING"}]}]}};
    state.providerMutate?.(data,state.providerReads);return data;
  },runRemoteRead:async r=>{
    state.remoteReads++;const observedAt=Date.now(),response={schemaVersion:1,nonce:r.nonce,role:r.service.role,deploymentId:r.service.deploymentId,instanceId:r.instanceId,observedAt,buildIdentity:baked(r.service.role),buildFileSha256:fileHash(r.service.role),
      health:{status:200,body:r.service.role==="web"?webBody():workerBody(observedAt)},ready:r.service.role==="web"?null:{status:200,body:{ready:true,phase:"running"}}};
    state.remoteMutate?.(response);return JSON.stringify(response);
  }};
  return {plan,health,writerBaseline,abort,state,options,observer:()=>createOpsCoreSourceHealthObserver(options),
    run:()=>createOpsCoreSourceHealthObserver(options)({stage:"baseline",baseline:null,writerBaseline})};
}

test("baseline binds exact current deployment/instance, legacy web DB/schema and running worker tick without private fields",async()=>{
  const f=fixture(),proof=await f.run();assert.equal(proof.complete,true);assert.equal(proof.sourceHealthBindingSha256,hash(f.health));
  const {evidenceSha256,...body}=proof;assert.equal(evidenceSha256,hash(body));assert.equal(proof.intentSha256,hash(f.plan));
  assert.equal(f.state.providerReads,6);assert.equal(f.state.remoteReads,2);assert(f.state.owned>=16);
  assert.equal(proof.services[0].health.body.database,"up");assert.equal(proof.services[1].ready.body.ready,true);
  assert(!JSON.stringify(proof).includes("PRIVATE_"));
});
test("recovery retains original deployment/release and baseline while independently binding restarted instance",async()=>{
  const f=fixture(),baseline=await f.run();f.state.instanceOffset=20;
  const recovered=await f.observer()({stage:"recovery",baseline,writerBaseline:f.writerBaseline});
  assert.equal(recovered.baselineEvidenceSha256,baseline.evidenceSha256);assert.notEqual(recovered.services[0].instanceId,baseline.services[0].instanceId);
  assert.equal(recovered.services[0].deploymentId,baseline.services[0].deploymentId);assert.equal(f.state.remoteReads,4);
});
for(const[name,change]of[
  ["foreign environment",d=>{d.environment.id=id(99);}],["foreign service project",d=>{d.serviceInstance.service.projectId=id(99);} ],
  ["replacement deployment",d=>{d.serviceInstance.activeDeployments[0].id=id(99);} ],
  ["multiple deployments",d=>{d.serviceInstance.activeDeployments.push(structuredClone(d.serviceInstance.activeDeployments[0]));}],
  ["stopped deployment",d=>{d.serviceInstance.activeDeployments[0].deploymentStopped=true;}],
  ["queued deployment",d=>{d.serviceInstance.activeDeployments[0].status="QUEUED";}],
  ["no running instance",d=>{d.serviceInstance.activeDeployments[0].instances[0].status="STOPPED";}],
  ["multiple running instances",d=>{d.serviceInstance.activeDeployments[0].instances.push({id:id(99),status:"RUNNING"});}],
])test(`rejects ${name} before remote reads`,async()=>{const f=fixture();f.state.providerMutate=change;await assert.rejects(f.run(),/SOURCE_HEALTH_/);assert.equal(f.state.remoteReads,0);});
test("instance drift after SSH and web drift during worker observation are rejected",async()=>{
  for(const boundary of [2,5]){const f=fixture();f.state.providerMutate=(d,n)=>{if(n===boundary)d.serviceInstance.activeDeployments[0].instances[0].id=id(99);};await assert.rejects(f.run(),/SOURCE_HEALTH_INSTANCE_CHANGED/);}
});
for(const[name,change]of[
  ["wrong nonce",r=>{r.nonce="f".repeat(64);}],["wrong instance",r=>{r.instanceId=id(99);}],["stale response",r=>{r.observedAt=1;}],
  ["web DB down",r=>{if(r.role==="web")r.health.body.database="down";}],
  ["web schema unready",r=>{if(r.role==="web")r.health.body.schema="pending";}],
  ["foreign release",r=>{r.health.body.release.gitSha="b".repeat(40);}],
  ["environment release assertion",r=>{r.health.body.release.runtime.source="environment";}],
  ["release drift",r=>{r.health.body.release.drift.details=["PRIVATE_DRIFT"]; }],
  ["worker error",r=>{if(r.role==="worker")r.health.body.lastError="PRIVATE_CUSTOMER_ERROR";}],
  ["worker stale tick",r=>{if(r.role==="worker")r.health.body.lastSuccessfulTickAt=new Date(0).toISOString();}],
  ["worker not ready",r=>{if(r.role==="worker")r.ready.status=503;}],
])test(`rejects ${name} without returning raw contents`,async()=>{const f=fixture();f.state.remoteMutate=change;await assert.rejects(f.run(),e=>{assert(!e.message.includes("PRIVATE_"));return /SOURCE_HEALTH_/.test(e.message);});});
test("recovery rejects tampered baseline, foreign global intent, or changed original writer deployment",async()=>{
  const f=fixture(),baseline=await f.run();const before=f.state.remoteReads;
  for(const mutate of [b=>{b.services[0].release.version="foreign";},b=>{b.intentSha256="f".repeat(64);const {evidenceSha256,...body}=b;b.evidenceSha256=hash(body);}]){
    const b=structuredClone(baseline);mutate(b);await assert.rejects(f.observer()({stage:"recovery",baseline:b,writerBaseline:f.writerBaseline}),/BASELINE_INVALID/);
  }
  f.writerBaseline.services[0].activeDeploymentIds=[id(99)];await assert.rejects(f.observer()({stage:"recovery",baseline,writerBaseline:f.writerBaseline}),/WRITER_CHANGED/);
  assert.equal(f.state.remoteReads,before);
});
test("plan forbids injected IDs/ports/releases, duplicated roles and foreign writer binding",()=>{
  for(const mutate of [p=>{p.services[0].serviceId="'; touch /tmp/no; '";},p=>{p.services[0].port="3000;env";},p=>{p.services[0].release={...release,version:"x'$(env)"};},p=>{p.services[1].role="web";}]){
    const p=healthPlan();mutate(p);assert.throws(()=>validateOpsCoreSourceHealthPlan(p),/PLAN_INVALID/);
  }
  assert.throws(()=>validateOpsCoreSourceHealthPlan(healthPlan(),{projectId:id(99),environmentId:id(2),serviceIds:[id(3),id(5)]}),/WRITER_BINDING_CHANGED/);
});
test("abort/ownership/provider/SSH failures redact raw errors and stop before new reads",async()=>{
  for(const failAt of ["abort","owner","provider","remote"]){const f=fixture();
    if(failAt==="abort")f.abort.abort();if(failAt==="owner")f.options.assertOwned=async()=>{throw Error("PRIVATE_LEASE");};
    if(failAt==="provider")f.options.transport=async()=>{throw Error("PRIVATE_PROVIDER");};if(failAt==="remote")f.options.runRemoteRead=async()=>{throw Error("PRIVATE_REMOTE");};
    await assert.rejects(f.run(),e=>{assert(!e.message.includes("PRIVATE_"));return /SOURCE_HEALTH_UNPROVEN/.test(e.message);});
    assert.equal(f.state.remoteReads,0);
  }
});

async function runActualRemoteScript({role="worker",busy=false,mutateResponse,authError=false,legacy=false,buildOverride}={}) {
  const binding=healthPlan(),service=binding.services.find(s=>s.role===role),signal=new AbortController().signal;
  let args,opts,calls=0,reads=[],delays=0;
  const remote=createRailwaySourceHealthRemoteRead({execFileImpl(command,a,o,callback){args=a;opts=o;assert.equal(command,"railway");
    if(authError){callback(Error("PRIVATE_CLI_ERROR"));return;}
    const quoted=a.at(-1);assert(quoted.startsWith("'")&&quoted.endsWith("'"));
    let script=quoted.slice(1,-1).replaceAll(`'"'"'`,"'");let stdout="",stderr="";
    // Execute the actual generated program with only its fixed file/import I/O
    // substituted; no local /app or customer runtime is opened by this test.
    assert(script.includes("await import('node:fs/promises')"));
    script=script.replace("await import('node:fs/promises')","fixtureFs").replace("await import('node:crypto')","fixtureCrypto");
    const process={stdout:{write:v=>{stdout+=v;}},stderr:{write:v=>{stderr+=v;}},exitCode:0};
    const context={fixtureCrypto:{createHash},fixtureFs:{open:async path=>{assert.equal(path,"/app/release-build.json");return {
      async read(buffer,offset,length,position){assert.equal(length,4097);assert.equal(position,0);const content=Buffer.from(JSON.stringify(buildOverride??baked(role)));content.copy(buffer);return {bytesRead:Math.min(content.length,length)};},async close(){} };}},Buffer,AbortSignal,Date,JSON,Number,Error,Promise,process,setTimeout:callback=>{delays++;callback();},fetch:async(url,options)=>{
      calls++;reads.push(url);assert.equal(options.redirect,"error");assert.equal(options.method,"GET");assert.match(url,/^http:\/\/127\.0\.0\.1:(3000|9090)\/(api\/health|health|ready)$/);
      const ready=url.endsWith("/ready"),starting=busy&&calls<=2;
      let body=ready?{ready:!starting,phase:"running"}:role==="web"?webBody():workerBody();
      if(legacy&&!ready)body.release.runtime={gitSha:null,source:"missing"};
      const response={status:ready&&starting?503:200,url,redirected:false,headers:{get:()=>"application/json"},body:(async function*(){yield Buffer.from(JSON.stringify(body));})()};
      mutateResponse?.(response);return response;
    }};
    new vm.Script(`(async()=>{${script}})()`).runInNewContext(context).then(()=>callback(process.exitCode?Error(stderr):null,stdout),callback);
  }});
  let value,error;try{value=JSON.parse(await remote({binding,service,instanceId:id(7),nonce:"f".repeat(64),signal}));}catch(e){error=e;}
  return{value,error,args,opts,calls,reads,delays};
}
test("actual remote Node script polls ordinary worker busy readiness in same explicit SSH instance",async()=>{
  const f=await runActualRemoteScript({busy:true});assert.ifError(f.error);assert.equal(f.calls,4);assert.equal(f.delays,1);assert.equal(f.value.ready.body.ready,true);
  assert.deepEqual(f.args.slice(0,10),["ssh","-p",id(1),"-e",id(2),"-s",id(5),"-d",id(7),"--"]);
  assert.deepEqual(f.args.slice(10,16),["env","-i","PATH=/usr/local/bin:/usr/bin:/bin","node","--input-type=module","-e"]);
  assert.equal(f.opts.shell,false);assert.equal(f.opts.maxBuffer,32768);assert.equal(f.opts.timeout,110000);assert(!JSON.stringify(f.value).includes("PRIVATE_"));
});
test("actual remote web script reads only loopback DB/schema health and strips unrelated runtime fields",async()=>{
  const f=await runActualRemoteScript({role:"web"});assert.ifError(f.error);assert.equal(f.calls,1);assert.equal(f.value.health.body.schema,"ready");assert(!JSON.stringify(f.value).includes("PRIVATE_"));
});
for(const[name,options]of[["redirect",{mutateResponse:r=>{r.redirected=true;}}],["foreign URL",{mutateResponse:r=>{r.url="https://foreign.invalid";}}],["oversized response",{mutateResponse:r=>{r.body=(async function*(){yield Buffer.alloc(32769);})();}}],["authentication failure",{authError:true}]])
  test(`actual remote executor rejects ${name} with opaque failure`,async()=>{const f=await runActualRemoteScript(options);assert.match(f.error?.message??"",/^SOURCE_HEALTH_REMOTE_READ_FAILED$/);assert.equal(f.value,undefined);});


test("actual legacy source health accepts missing runtime only with independent exact baked role and commit",async()=>{
  const f=fixture();f.state.remoteMutate=r=>{r.health.body.release.runtime={gitSha:null,source:"missing"};};
  const proof=await f.run();for(const service of proof.services){assert.deepEqual(service.health.body.release.runtime,{gitSha:null,source:"missing"});
    assert.equal(service.releaseProvenance.healthRuntime,"legacy-missing");assert.equal(service.releaseProvenance.commitAndRole,"/app/release-build.json");
    assert.deepEqual(service.buildIdentity,baked(service.role));}
  const actual=await runActualRemoteScript({legacy:true,busy:true});assert.ifError(actual.error);
  assert.deepEqual(actual.value.health.body.release.runtime,{gitSha:null,source:"missing"});assert.deepEqual(actual.value.buildIdentity,baked("worker"));
});
for(const[name,change]of[["missing build",r=>{delete r.buildIdentity;}],["wrong build role",r=>{r.buildIdentity.role="other";}],
  ["wrong build commit",r=>{r.buildIdentity.gitSha="b".repeat(40);}],["unknown build schema",r=>{r.buildIdentity.schemaVersion=2;}]])
  test(`legacy configured health cannot substitute ${name}`,async()=>{const f=fixture();f.state.remoteMutate=r=>{r.health.body.release.runtime={gitSha:null,source:"missing"};change(r);};await assert.rejects(f.run(),/BUILD_CHANGED/);});
test("legacy recovery rejects changed baked bytes even when health release labels agree",async()=>{
  const f=fixture(),baseline=await f.run();f.state.remoteMutate=r=>{r.buildFileSha256="f".repeat(64);};
  await assert.rejects(f.observer()({stage:"recovery",baseline,writerBaseline:f.writerBaseline}),/BUILD_CHANGED/);
});
test("actual remote baked file mismatch fails before any health GET",async()=>{
  const f=await runActualRemoteScript({legacy:true,buildOverride:{...baked("worker"),gitSha:"b".repeat(40)}});
  assert.match(f.error?.message??"",/^SOURCE_HEALTH_REMOTE_READ_FAILED$/);assert.equal(f.calls,0);
});


test("global v2 uses the real source health observer and preserves independent v1 health receipts", async () => {
  const f = fixture();
  f.plan.schemaVersion = 2;
  f.plan.azure = { sharedStateBackend: "postgres", redis: null };
  f.plan.sharedState = { backend: "postgres", sourceRedis: {
    mode: "standalone", resourceId: null, server: { version: "8.2.9", runId: "a".repeat(40) },
    connection: { host: "source.local", port: 6379, database: 0, username: "default", tls: false },
  } };
  const password = randomBytes(32).toString("base64");
  f.options.redisSourceCredentials = { password, tlsCa: null };
  f.state.remoteMutate = r => { r.redis = {
    server: { version: "8.2.9", runIdSha256: createHash("sha256").update("a".repeat(40)).digest("hex") },
    database: 0, username: "default", tls: false, endpointSha256: "d".repeat(64),
    credentialProof: createHmac("sha256", password).update(JSON.stringify([r.nonce, hash(f.plan), r.role,
      f.health.services.find(s => s.role === r.role).serviceId, r.deploymentId, r.instanceId])).digest("hex"),
  }; };
  const baseline = await f.run();
  assert.equal(baseline.complete, true);
  assert.equal(baseline.services.every(service => service.redis.credentialMatched), true);
  assert.equal(JSON.stringify(baseline).includes(password), false);
  assert.equal(JSON.stringify(baseline).includes("credentialProof"), false);
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.intentSha256, hash(f.plan));
  const recovery = await f.observer()({ stage: "recovery", baseline, writerBaseline: f.writerBaseline });
  assert.equal(recovery.complete, true);
  assert.equal(recovery.baselineEvidenceSha256, baseline.evidenceSha256);
  assert.equal(f.state.remoteReads, 4);
  const before = f.state.providerReads;
  f.plan.redis = {};
  assert.throws(() => f.observer(), /SOURCE_HEALTH_OPTIONS_INVALID/);
  assert.equal(f.state.providerReads, before);
});
