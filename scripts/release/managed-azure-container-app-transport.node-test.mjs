import assert from "node:assert/strict";
import { test } from "node:test";
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
