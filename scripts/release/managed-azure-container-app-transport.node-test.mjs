import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { canonicalizeManagedAzureContainerAppState, createManagedAzureContainerAppTransport, managedAzureConfigurationDigest } from "./managed-azure-container-app-transport.mjs";
const target={subscriptionId:"00000000-0000-4000-8000-000000000001",resourceGroup:"fixture",acrName:"fixtureacr",acrServer:"fixtureacr.azurecr.io",webAppName:"fixture-web",workerAppName:"fixture-worker"};
const config={activeRevisionsMode:"Single",ingress:{traffic:[{latestRevision:true,weight:100}]}};
const ownership={originalMode:"Single",temporaryMode:"Multiple",configurationDigests:{web:managedAzureConfigurationDigest(config),worker:managedAzureConfigurationDigest(config)}};
const release={gitSha:"a".repeat(40),imageTag:`sha-${"a".repeat(40)}`,version:"1.0.0"};
const template={revisionSuffix:"test",containers:[{name:"worker",image:`fixtureacr.azurecr.io/corgtex/worker@sha256:${"b".repeat(64)}`,env:[{name:"CORGTEX_RELEASE_GIT_SHA",value:release.gitSha},{name:"CORGTEX_RELEASE_IMAGE_TAG",value:release.imageTag},{name:"CORGTEX_RELEASE_VERSION",value:release.version},{name:"WORKER_EXECUTION_MODE",value:"queue-only"}]}]};
const raw=()=>({location:"westus3",properties:{configuration:structuredClone(config),template:structuredClone(template),provisioningState:"Succeeded",latestRevisionName:"fixture-worker--test",latestReadyRevisionName:"fixture-worker--test"}});
test("generic release refuses queue-only worker without scheduler-owning opt-in",()=>{
 const input={target,role:"worker",release};assert.throws(()=>canonicalizeManagedAzureContainerAppState(raw(),input),/AZURE_DEMAND_WORKER_RELEASE_UNSUPPORTED/);
 assert.equal(canonicalizeManagedAzureContainerAppState(raw(),{...input,workerDemandEnabled:true}).revisionName,"fixture-worker--test");
});
function fixture({remainingReplicas=0,loseAck=false,foreignOperation=false}={}){
 let clock=0,runningStatus="Running",posts=0;const calls=[];
 const transport=createManagedAzureContainerAppTransport({getAccessToken:async()=>"synthetic-token",clock:()=>clock,sleep:async()=>{clock+=30000;},fetchImpl:async(url,init)=>{
   const path=new URL(url).pathname;calls.push({url,method:init.method});
   if(init.method==="POST"){
     posts++;runningStatus=path.endsWith("/stop")?"Stopped":"Running";
     assert.equal(new URL(url).searchParams.get("api-version"),"2025-07-01");
     if(loseAck)throw new Error("lost response");
     const name=foreignOperation?"fixture-web":"fixture-worker";
     return new Response("{}",{status:202,headers:{Location:`https://management.azure.com/subscriptions/${target.subscriptionId}/providers/Microsoft.App/containerApps/${name}/operationResults/owned-operation?api-version=2025-07-01`}});
   }
   if(path.includes("operationResults"))return Response.json({status:"Succeeded"});
   if(path.endsWith("/replicas"))return Response.json({value:Array.from({length:runningStatus==="Stopped"?remainingReplicas:1},()=>({name:"replica"}))});
   if(path.endsWith("/revisions"))return Response.json({value:[{name:"fixture-worker--test",properties:{active:true}}]});
   const app=raw();app.properties.runningStatus=runningStatus;return Response.json(app);
 }});
 return{transport,calls,get posts(){return posts;}};
}
const input={target,role:"worker",workerDemandEnabled:true,exclusiveActivation:ownership,runningStatus:"Stopped"};
test("app stop follows exact-app subscription LRO then proves stopped plus zero even if active bit remains",async()=>{
 const f=fixture();const result=await f.transport.setAppRunningState(input);
 assert.equal(result.runningStatus,"Stopped");assert.equal(result.revisions[0].active,true);assert.equal(result.revisions[0].replicaCount,0);
 assert.equal(f.posts,1);assert.ok(f.calls.some(c=>c.url.includes("/fixture-worker/operationResults/")));
 await f.transport.setAppRunningState({...input,runningStatus:"Running"});assert.equal(f.posts,2);
});
test("stop cannot accept terminal app status while any replica remains",async()=>{
 const f=fixture({remainingReplicas:1});await assert.rejects(f.transport.setAppRunningState(input),/AZURE_APP_ACTION_UNPROVEN/);assert.equal(f.posts,1);
});
test("ambiguous stop acknowledgement is reconciled by reads without a second POST",async()=>{
 const f=fixture({loseAck:true});assert.equal((await f.transport.setAppRunningState(input)).runningStatus,"Stopped");assert.equal(f.posts,1);
});
test("a stop LRO cannot forward authorization to the other allowed app",async()=>{
 const f=fixture({foreignOperation:true});await f.transport.setAppRunningState(input);
 assert.ok(!f.calls.some(c=>c.url.includes("operationResults")));assert.equal(f.posts,1);
});
test("app-level lifecycle requires explicit worker-demand ownership before any request",async()=>{
 const f=fixture();await assert.rejects(f.transport.setAppRunningState({...input,workerDemandEnabled:false}),/AZURE_APP_ACTION_UNOWNED/);assert.equal(f.calls.length,0);
});

function censusFixture({ headers = [], revisions = 2, onSleep, requestMs = 0 } = {}) {
  let now = Date.parse("2026-11-17T19:00:00Z"), replicaAttempts = 0, inFlight = 0, maxInFlight = 0;
  const calls = [], sleeps = [], heartbeats = [], controller = new AbortController();
  const options = { target, role: "worker", signal: controller.signal, onProgress: async () => { heartbeats.push(now); now += 200; } };
  const transport = createManagedAzureContainerAppTransport({ clock: () => now, getAccessToken: async () => "synthetic-token",
    sleep: async (ms, signal) => { assert(signal instanceof AbortSignal); sleeps.push(ms); now += ms; await onSleep?.({ms,controller,options}); },
    fetchImpl: async (url, init) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); calls.push({url,method:init.method,at:now}); now += requestMs;
      try {
        if (url.includes("/replicas?")) {
          replicaAttempts++;
          if (replicaAttempts <= headers.length) {
            const value = typeof headers[replicaAttempts - 1] === "function" ? headers[replicaAttempts - 1](now) : headers[replicaAttempts - 1];
            if (value instanceof Error) throw value;
            return Response.json({message:"PRIVATE_PROVIDER_BODY"},{status:429,headers:value===null?{}:{"Retry-After":value}});
          }
          return Response.json({value:url.includes("--old0/")?[{name:"still-writing"}]:[]});
        }
        if (url.includes("/revisions?")) {
          const second = new URL(url).searchParams.has("skipToken"), split = Math.ceil(revisions / 2);
          const appName = new URL(url).pathname.split("/containerApps/")[1].split("/")[0];
          const names = Array.from({length:revisions},(_,i)=>({name:`${appName}--old${i}`,properties:{active:false}}));
          const next = new URL(url);next.searchParams.set("pageSize","20");next.searchParams.set("skipToken","opaque%cursor");
          return Response.json({value:second?names.slice(split):names.slice(0,split),...(!second&&revisions>1?{nextLink:next.href}:{})});
        }
        return Response.json(raw());
      } finally { inFlight--; }
    } });
  return {transport,options,calls,sleeps,heartbeats,controller,get now(){return now;},get replicaAttempts(){return replicaAttempts;},get maxInFlight(){return maxInFlight;}};
}
for (const [name, header] of [["seconds","2"],["HTTP date",now=>new Date(now+2000).toUTCString()]]) {
  test(`census honors ${name} Retry-After on the same exact GET and retains inactive replicas across pages`,async()=>{
    const f=censusFixture({headers:[header]});const result=await f.transport.readExclusiveState(f.options);
    const retry=f.calls.filter(c=>c.url.includes("old0/replicas"));assert.equal(retry.length,2);assert.equal(retry[0].url,retry[1].url);
    // HTTP dates have whole-second precision; elapsed time must reach the actual date.
    const required=typeof header==="function"?Date.parse(header(retry[0].at))-retry[0].at:2000;
    assert(retry[1].at-retry[0].at>=required);assert.equal(f.maxInFlight,1);
    assert.deepEqual(result.revisions.map(r=>[r.active,r.replicaCount]),[[false,1],[false,0]]);
    assert(f.calls.every(c=>c.method==="GET"));
  });
}
test("600-second provider cooldown fails immediately and binds both roles without an early GET",async()=>{
  const f=censusFixture({headers:["600"]});
  await assert.rejects(f.transport.readExclusiveState(f.options),e=>e.code==="AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_600_SECONDS"&&e.retryAfterSeconds===600&&!e.message.includes("PRIVATE"));
  const count=f.calls.length;assert.equal(f.replicaAttempts,1);assert(!f.sleeps.some(ms=>ms>=600000));
  await assert.rejects(f.transport.readExclusiveState({...f.options,role:"web"}),/AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_600_SECONDS/);
  assert.equal(f.calls.length,count);
});
for (const header of [null,"bad","-1","1.5","99999999999999"]) test(`unproven Retry-After ${header} never retries or yields a census`,async()=>{
  const f=censusFixture({headers:[header]});await assert.rejects(f.transport.readExclusiveState(f.options),/AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_UNPROVEN/);assert.equal(f.replicaAttempts,1);
});
test("census bounds HTTP retry count and does not reset its total deadline",async()=>{
  const f=censusFixture({headers:["1","1","1","1"]});await assert.rejects(f.transport.readExclusiveState(f.options),/AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_1_SECONDS/);assert.equal(f.replicaAttempts,3);
  const g=censusFixture({headers:["100","100"]});await assert.rejects(g.transport.readExclusiveState(g.options),/AZURE_EXCLUSIVE_THROTTLED_RETRY_AFTER_100_SECONDS/);assert.equal(g.replicaAttempts,2);
});
test("owner loss during a long backoff stops before the retry",async()=>{
  const f=censusFixture({headers:["30"],onSleep:async({ms,options})=>{if(ms>=15000)options.onProgress=async()=>{throw Error("OWNER_LOST");};}});
  await assert.rejects(f.transport.readExclusiveState(f.options),/OWNER_LOST/);assert.equal(f.replicaAttempts,1);
});
test("abort during a backoff stops before any further provider GET",async()=>{
  const f=censusFixture({headers:["2"],onSleep:async({ms,controller})=>{if(ms>=2000)controller.abort();}});
  await assert.rejects(f.transport.readExclusiveState(f.options),/AZURE_EXCLUSIVE_CENSUS_ABORTED/);assert.equal(f.replicaAttempts,1);
});
test("census deadline rejects a slow provider response rather than returning a partial inventory",async()=>{
  const f=censusFixture({requestMs:180001});await assert.rejects(f.transport.readExclusiveState(f.options),/AZURE_EXCLUSIVE_CENSUS_DEADLINE/);assert.equal(f.calls.length,1);
});
test("census pacing keeps complete history and throttles expensive authority callbacks",async()=>{
  const f=censusFixture({revisions:80});const result=await f.transport.readExclusiveState(f.options);
  assert.equal(result.revisions.length,80);assert.equal(f.calls.length,83);assert.equal(f.maxInFlight,1);
  for(let i=1;i<f.calls.length;i++)assert(f.calls[i].at-f.calls[i-1].at>=500);
  assert(f.heartbeats.length>=3&&f.heartbeats.length<=5);
  for(let i=1;i<f.heartbeats.length-1;i++)assert(f.heartbeats[i]-f.heartbeats[i-1]>=15000);
  const last=f.calls.at(-1).at;await f.transport.readExclusiveState({...f.options,role:"web"});assert(f.calls[83].at-last>=500);
});
test("HTTP throttling on a revision mutation is never automatically retried",async()=>{
  let posts=0;const transport=createManagedAzureContainerAppTransport({getAccessToken:async()=>"synthetic-token",fetchImpl:async(url,init)=>{
    if(init.method==="POST"){posts++;return Response.json({error:{code:"TooManyRequests"}},{status:429,headers:{"Retry-After":"600"}});}
    return Response.json(url.includes("/replicas?")?{value:[]}:{properties:{active:false}});
  }});
  const result=await transport.setRevisionActive({target,role:"worker",revisionName:"fixture-worker--old",active:true});
  assert.equal(result.succeeded,false);assert.equal(result.providerStatus,429);assert.equal(posts,1);
});

test("mixed network rejection and HTTP 429 share three paced GET attempts without inner retry multiplication",async()=>{
  const f=censusFixture({headers:[new Error("PRIVATE_NETWORK"),"1"]});
  assert.equal((await f.transport.readExclusiveState(f.options)).revisions.length,2);
  assert.equal(f.replicaAttempts,4); // three reads for old0, one for old1
  const old=f.calls.filter(c=>c.url.includes("old0/replicas"));assert.equal(old.length,3);
  assert(old[1].at-old[0].at>=500);assert(old[2].at-old[1].at>=1000);
  const g=censusFixture({headers:[new Error("PRIVATE_NETWORK"),"1",new Error("PRIVATE_NETWORK"),"1"]});
  await assert.rejects(g.transport.readExclusiveState(g.options),e=>e.code==="AZURE_REQUEST_AMBIGUOUS"&&!e.message.includes("PRIVATE"));
  assert.equal(g.replicaAttempts,3);assert.equal(g.calls.filter(c=>c.url.includes("old1/replicas")).length,0);
  assert(!g.sleeps.some(ms=>ms===250||ms===750));
});

for (const mode of ["complete", "cooldown", "owner-loss", "abort"]) test(`two overlapping census reads remain globally paced and stop collectively: ${mode}`,async t=>{
  const base=Date.parse("2026-11-17T19:00:00Z");t.mock.timers.enable({apis:["Date","setTimeout"],now:base});
  let inFlight=0,maxInFlight=0,finished=false,reply,error,owner=true;const starts=[],controller=new AbortController();
  const transport=createManagedAzureContainerAppTransport({clock:()=>Date.now(),getAccessToken:async()=>"synthetic-token",
    sleep:(ms,signal)=>new Promise((resolve,reject)=>{const id=setTimeout(resolve,ms);signal?.addEventListener("abort",()=>{clearTimeout(id);reject(Error("aborted"));},{once:true});}),
    fetchImpl:(url,{signal,method})=>new Promise((resolve,reject)=>{
      assert.equal(method,"GET");starts.push({url,at:Date.now()});inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);let done=false;
      const finish=(fn,value)=>{if(!done){done=true;inFlight--;fn(value);}};
      signal.addEventListener("abort",()=>finish(reject,Error("private aborted fetch")),{once:true});
      setTimeout(()=>{
        if(url.includes("/replicas?")) {
          if(mode==="cooldown"&&url.includes("old0/"))return finish(resolve,Response.json({}, {status:429,headers:{"Retry-After":"600"}}));
          if(mode==="owner-loss")owner=false;
          if(mode==="abort")controller.abort();
          return finish(resolve,Response.json({value:[]}));
        }
        if(url.includes("/revisions?"))return finish(resolve,Response.json({value:Array.from({length:4},(_,i)=>({name:`fixture-worker--old${i}`,properties:{active:false}}))}));
        finish(resolve,Response.json(raw()));
      }, mode==="owner-loss"?16000:1500);
    })});
  const pending=transport.readExclusiveState({target,role:"worker",signal:controller.signal,onProgress:async()=>{if(!owner)throw Error("OWNER_LOST");}})
    .then(v=>{reply=v;finished=true;},e=>{error=e;finished=true;});
  for(let i=0;i<1500&&!finished;i++){t.mock.timers.tick(100);await settle();}
  assert(finished);await pending;assert.equal(maxInFlight,2);
  for(let i=1;i<starts.length;i++)assert(starts[i].at-starts[i-1].at>=500);
  if(mode==="complete"){assert.equal(error,undefined);assert.equal(reply.revisions.length,4);}
  else {
    assert(error);assert.equal(reply,undefined);
    assert(!starts.some(v=>v.url.includes("old2/")||v.url.includes("old3/")));
    if(mode==="cooldown")assert.equal(error.retryAfterSeconds,600);
  }
});
