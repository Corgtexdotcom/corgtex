import { AzureCliCredential } from "@azure/identity";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { openProviderOperationRecorder } from "./ops-core-provider-operations.mjs";
import { HEALTH_PROBE_PREFIX, validateHealthTarget, validateHealthChallenge, projectWorkerHealth } from "./ops-core-health-probe.mjs";

import { validateManagedAzureWorkerDemand, assertManagedAzureWorkerDemandApp } from "../release/managed-azure-worker-demand.mjs";

const API="2025-07-01",HASH=/^[a-f0-9]{64}$/,GUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROOT="^/subscriptions/([a-f0-9-]{36})/resourcegroups/[a-z0-9_.()-]{1,90}/providers/";
const equalId=(a,b)=>typeof a==="string"&&typeof b==="string"&&a.toLowerCase()===b.toLowerCase();
const same=(a,b)=>hash(a)===hash(b);
const exact=(v,keys)=>v&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===keys.split(",").sort().join(",");
const clean=list=>Array.isArray(list)?list.map(v=>Object.fromEntries(Object.entries(v).filter(([,x])=>x!==null))):list;
class HealthJobError extends Error{}
const need=(v,code)=>{if(!v)throw new HealthJobError(code);};
export const healthJobDiagnostic=error=>error instanceof HealthJobError?error.message:null;
function plan(value){
  need(exact(value,"worker,jobResourceId,environmentResourceId,infrastructureSubnetId,workspaceId,identityResourceId,image,probeSha256,location"),"HEALTH_JOB_PLAN_INVALID");
  const p=structuredClone(value);validateHealthTarget(p.worker);
  const id=(value,type)=>new RegExp(`${ROOT}${type}/[a-z0-9-]{1,80}$`,"i").test(value);
  need(id(p.jobResourceId,"microsoft\\.app/jobs")&&/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(p.jobResourceId.split("/").at(-1))
    &&id(p.environmentResourceId,"microsoft\\.app/managedenvironments")&&id(p.identityResourceId,"microsoft\\.managedidentity/userassignedidentities")
    &&new RegExp(`${ROOT}microsoft\\.network/virtualnetworks/[a-z0-9-]{1,80}/subnets/[a-z0-9-]{1,80}$`,"i").test(p.infrastructureSubnetId)
    &&GUID.test(p.workspaceId)&&HASH.test(p.probeSha256)&&/^[a-z0-9]{2,32}$/.test(p.location)
    &&/^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9][a-z0-9/_.-]{0,150}@sha256:[a-f0-9]{64}$/.test(p.image)
    &&[p.environmentResourceId,p.identityResourceId,p.infrastructureSubnetId,p.worker.appId].every(v=>equalId(v.split("/")[2],p.jobResourceId.split("/")[2])),"HEALTH_JOB_PLAN_INVALID");
  return p;
}
const identity=p=>({jobResourceId:p.jobResourceId,imageDigest:p.image.split("@")[1],probeSha256:p.probeSha256});
const pathFor=id=>`${id}?api-version=${API}`;
function template(p,challenge=null){return{containers:[{name:"health-probe",image:p.image,command:["node","/app/scripts/migration/ops-core-health-probe.mjs"],args:[],
  resources:{cpu:0.25,memory:"0.5Gi"},env:[{name:"CORGTEX_HEALTH_TARGET",value:JSON.stringify(p.worker)},
    {name:"CORGTEX_HEALTH_PROBE_IDENTITY",value:JSON.stringify(identity(p))},
    ...(challenge?[{name:"CORGTEX_HEALTH_CHALLENGE",value:JSON.stringify(challenge)}]:[])]}],initContainers:[]};}
/** Exact precreated Manual job. No job creation/replacement/deletion is performed.
 * The only MI is platform-only for ACR; there are no runtime or data credentials. */
export function buildHealthProbeJobDefinition(value){const p=plan(value);return{location:p.location,
  identity:{type:"UserAssigned",userAssignedIdentities:{[p.identityResourceId]:{}}},properties:{environmentId:p.environmentResourceId,workloadProfileName:"Consumption",
    configuration:{triggerType:"Manual",replicaTimeout:120,replicaRetryLimit:0,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1},
      identitySettings:[{identity:p.identityResourceId,lifecycle:"None"}],secrets:[],registries:[{server:p.image.split("/")[0],identity:p.identityResourceId}]},template:template(p)}};}
async function jsonBody(response){
  need(response.body?.getReader,"HEALTH_JOB_RESPONSE_INVALID");const reader=response.body.getReader();let size=0;const chunks=[];
  try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;need(size<=1024*1024,"HEALTH_JOB_RESPONSE_TOO_LARGE");chunks.push(Buffer.from(value));}
    return size?JSON.parse(Buffer.concat(chunks).toString("utf8")):null;
  }finally{void reader.cancel().catch(()=>{});}
}
/** Executable default transport, constrained to this job, environment, worker,
 * exact revisions, and workspace. No redirects or automatic mutation retries. */
export function createHealthJobTransport(value,{credential=new AzureCliCredential({processTimeoutInMs:10000}),fetchImpl=fetch}={}){
  const p=plan(value);
  return async({method,path,body,signal})=>{try{
    need(signal instanceof AbortSignal&&!signal.aborted,"HEALTH_JOB_ABORTED");
    const logs=path===`/v1/workspaces/${p.workspaceId}/query`;
    const url=new URL(path,logs?"https://api.loganalytics.azure.com":"https://management.azure.com");
    const oneChild=(base)=>url.pathname.toLowerCase().startsWith(`${base}/`.toLowerCase())&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(url.pathname.slice(base.length+1));
    const revisionBase=`${p.worker.appId}/revisions/`;
    const revisionReplicas=url.pathname.toLowerCase().startsWith(revisionBase.toLowerCase())
      &&new RegExp(`^${p.worker.appId.split("/").at(-1)}--[a-z0-9][a-z0-9-]{0,79}/replicas$`).test(url.pathname.slice(revisionBase.length));
    const allowed=logs?method==="POST":(method==="POST"&&equalId(url.pathname,`${p.jobResourceId}/start`))
      ||(method==="GET"&&([p.jobResourceId,p.environmentResourceId,p.worker.appId,`${p.jobResourceId}/executions`].some(v=>equalId(v,url.pathname))
        ||oneChild(`${p.jobResourceId}/executions`)||oneChild(`${p.worker.appId}/revisions`)||revisionReplicas));
    need(allowed&&url.origin===(logs?"https://api.loganalytics.azure.com":"https://management.azure.com")&&!url.hash&&!url.username&&!url.password
      &&(logs||url.searchParams.get("api-version")===API),"HEALTH_JOB_ENDPOINT_DENIED");
    const timeout=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
    const auth=await credential.getToken(logs?"https://api.loganalytics.io/.default":"https://management.azure.com/.default",{abortSignal:timeout});
    need(typeof auth?.token==="string"&&auth.token.length>0&&!timeout.aborted,"HEALTH_JOB_AUTH_FAILED");
    const response=await fetchImpl(url.href,{method,redirect:"error",signal:timeout,headers:{Authorization:`Bearer ${auth.token}`,"Content-Type":"application/json"},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    need(!response.redirected&&response.url===url.href,"HEALTH_JOB_ENDPOINT_DENIED");
    if(response.status===404){void response.body?.cancel().catch(()=>{});return{status:404,body:null};}
    need([200,202].includes(response.status),"HEALTH_JOB_PROVIDER_REJECTED");const result=await jsonBody(response);need(!timeout.aborted,"HEALTH_JOB_ABORTED");
    return{status:response.status,body:result};
  }catch(error){throw error instanceof HealthJobError?error:new HealthJobError("HEALTH_JOB_TRANSPORT_FAILED");}};
}
function verifyTemplate(actual,expected){
  need(actual&&Object.entries(actual).every(([k,v])=>["containers","initContainers","volumes"].includes(k)||v===null)
    &&actual.containers?.length===1&&(!actual.initContainers||actual.initContainers.length===0)&&(!actual.volumes||actual.volumes.length===0),"HEALTH_JOB_TEMPLATE_CHANGED");
  const c=actual.containers[0],e=expected.containers[0];
  need(Object.keys(c).every(k=>["name","image","imageType","command","args","resources","env"].includes(k))
    &&c.name===e.name&&c.image===e.image&&(c.imageType==null||c.imageType==="ContainerImage")&&same(c.command,e.command)&&same(c.args??[],e.args)
    &&c.resources?.cpu===0.25&&c.resources.memory==="0.5Gi"&&Array.isArray(c.env)
    &&same(clean(c.env).sort((a,b)=>a.name.localeCompare(b.name)),[...e.env].sort((a,b)=>a.name.localeCompare(b.name))),"HEALTH_JOB_TEMPLATE_CHANGED");
}
function verifyJob(j,p){
  const c=j?.properties?.configuration,ids=Object.keys(j?.identity?.userAssignedIdentities??{});
  need(equalId(j?.id,p.jobResourceId)&&j.properties?.provisioningState==="Succeeded"&&typeof j.location==="string"&&j.location.replaceAll(" ","").toLowerCase()===p.location
    &&equalId(j.properties.environmentId,p.environmentResourceId)&&j.properties.workloadProfileName==="Consumption"&&j.identity?.type==="UserAssigned"
    &&ids.length===1&&equalId(ids[0],p.identityResourceId)&&c&&Object.entries(c).every(([k,v])=>["triggerType","replicaTimeout","replicaRetryLimit","manualTriggerConfig",
      "scheduleTriggerConfig","eventTriggerConfig","identitySettings","secrets","registries"].includes(k)||v===null)
    &&c.triggerType==="Manual"&&c.replicaTimeout===120&&c.replicaRetryLimit===0&&!c.scheduleTriggerConfig&&!c.eventTriggerConfig
    &&same(c.manualTriggerConfig,{parallelism:1,replicaCompletionCount:1})&&(!c.secrets||c.secrets.length===0)
    &&c.identitySettings?.length===1&&equalId(c.identitySettings[0].identity,p.identityResourceId)&&c.identitySettings[0].lifecycle==="None"
    &&c.registries?.length===1&&same(clean(c.registries).map(r=>({...r,identity:r.identity?.toLowerCase()})),
      [{server:p.image.split("/")[0],identity:p.identityResourceId.toLowerCase()}]),"HEALTH_JOB_CONFIG_CHANGED");
  verifyTemplate(j.properties.template,template(p));
}
function execution(value,p){
  need(value&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.name)&&value.properties&&(!value.id||equalId(value.id,`${p.jobResourceId}/executions/${value.name}`)),"HEALTH_JOB_EXECUTION_INVALID");
  // The stable list schema can omit id; only the exact bound endpoint grants it.
  return{...value,id:`${p.jobResourceId}/executions/${value.name}`};
}
function parseLogs(response,p,run,challenge){
  const columns=["TimeGenerated","EnvironmentName_s","ContainerGroupName_s","ContainerName_s","ContainerImage_s","Log_s","_ResourceId"];
  need(!response?.error&&response?.tables?.length===1&&same(response.tables[0].columns?.map(c=>c.name),columns)&&Array.isArray(response.tables[0].rows),"HEALTH_JOB_LOG_INVALID");
  const rows=response.tables[0].rows;if(!rows.length)return null;need(rows.length===1,"HEALTH_JOB_LOG_AMBIGUOUS");const r=rows[0],at=Date.parse(r[0]);
  need(r.length===7&&r[1]===p.environmentResourceId.split("/").at(-1)&&typeof r[2]==="string"&&r[2].startsWith(`${run.name}-`)
    &&/^[a-z0-9-]{1,120}$/.test(r[2])&&r[3]==="health-probe"&&r[4]===p.image&&typeof r[5]==="string"&&Buffer.byteLength(r[5])<=16384
    &&r[5].startsWith(HEALTH_PROBE_PREFIX)&&[p.environmentResourceId,p.jobResourceId].some(id=>equalId(r[6],id))
    &&Number.isFinite(at)&&at>=challenge.issuedAt&&at<=challenge.expiresAt&&at>=Date.parse(run.properties.startTime)&&at<=Date.parse(run.properties.endTime),"HEALTH_JOB_LOG_BINDING_MISMATCH");
  let receipt;try{receipt=JSON.parse(r[5].slice(HEALTH_PROBE_PREFIX.length));}catch{throw new HealthJobError("HEALTH_JOB_RECEIPT_INVALID");}
  need(exact(receipt,`schemaVersion,type,challengeSha256,nonce,domain,intentSha256,sourceFenceSha256,targetSha256,identity,request,observedAt,health,ready${challenge.authority?",authority":""}`)
    &&receipt.schemaVersion===challenge.schemaVersion&&same(receipt.authority??null,challenge.authority??null)&&receipt.type==="WORKER_HEALTH_OBSERVATION"&&receipt.challengeSha256===hash(challenge)&&receipt.nonce===challenge.nonce
    &&receipt.domain===challenge.domain&&receipt.intentSha256===challenge.intentSha256&&receipt.sourceFenceSha256===challenge.sourceFenceSha256
    &&receipt.targetSha256===hash(p.worker)&&same(receipt.identity,identity(p))&&same(receipt.request,challenge.request)
    &&Number.isSafeInteger(receipt.observedAt)&&receipt.observedAt>=Date.parse(run.properties.startTime)&&receipt.observedAt<=Date.parse(run.properties.endTime)
    &&receipt.health?.status===200&&receipt.ready?.status===200,"HEALTH_JOB_RECEIPT_INVALID");
  need(same(projectWorkerHealth(receipt.health.body,receipt.ready.body,p.worker,Date.now()),{health:receipt.health,ready:receipt.ready}),"HEALTH_JOB_RECEIPT_INVALID");
  return receipt;
}
function query(p,run,c){return`ContainerAppConsoleLogs_CL\n| where TimeGenerated between (datetime(${new Date(c.issuedAt).toISOString()}) .. datetime(${new Date(c.expiresAt).toISOString()}))\n`
  +`| where tolower(_ResourceId) in ('${p.environmentResourceId.toLowerCase()}', '${p.jobResourceId.toLowerCase()}')\n`
  +`| where EnvironmentName_s == '${p.environmentResourceId.split("/").at(-1)}' and ContainerGroupName_s startswith '${run.name}-'\n`
  +`| where ContainerName_s == 'health-probe' and ContainerImage_s == '${p.image}'\n`
  +`| where (Log_s startswith '${HEALTH_PROBE_PREFIX}' and Log_s contains '${c.nonce}') or Log_s == 'CORGTEX_HEALTH_PROBE_FAILED'\n`
  +"| project TimeGenerated, EnvironmentName_s, ContainerGroupName_s, ContainerName_s, ContainerImage_s, Log_s, _ResourceId\n| take 3";}

/** Bounded worker health observations during pending TARGET_ACTIVATING only.
 * Source assertions and the external lease remain outside the probe container.
 * Explicit mode:'release' instead uses pending RELEASING and the independently
 * verified assertDeploymentAuthority callback. releaseContext retains accepted
 * migration evidence; SOURCE_FENCED is HISTORICAL provenance, never a claim that
 * Railway is currently observed or fenced. Baseline/release/recovery contexts
 * and exact static worker plans are bound in distinct version-2 challenges.
 * Explicit mode:'acceptance' supports only real pending TARGET_ACTIVE, ROUTED
 * or ACCEPTED custody, retaining the live source observer. It uses the unchanged
 * worker-final probe request; durable slots also bind the exact current phase.
 * Up to ten immutable sequential attempts support activation's repeat checks.
 * A previous exact start intent must reconcile to a terminal execution before
 * another nonce can start; missing/unknown/running state cannot trigger replay.
 * Log Analytics must provide a fresh exact receipt. This is point-in-time health,
 * not proof of all business workflows, sustained uptime, or a no-write interval.
 */
function createBoundHealthJobDispatcher({mode="migration",releaseContext,assertDeploymentAuthority,
  plan:value,custody,assertSourceFenced,descriptorStore,operations,transport,workerDemand,pollIntervalMs=1000,timeoutMs=180000}){
  const p=plan(value),send=transport??createHealthJobTransport(p),initial=custody?.snapshot?.();
  const releaseMode=mode==="release",acceptanceMode=mode==="acceptance";
  if(workerDemand){
    need(exact(workerDemand,"plan,target"),"HEALTH_JOB_DEMAND_INVALID");
    validateManagedAzureWorkerDemand(workerDemand.plan,workerDemand.target);
    need(equalId(p.worker.appId,`/subscriptions/${workerDemand.target.subscriptionId}/resourceGroups/${workerDemand.target.resourceGroupName}/providers/Microsoft.App/containerApps/${workerDemand.target.apps.worker}`)
      &&equalId(p.environmentResourceId,workerDemand.target.environmentId),"HEALTH_JOB_DEMAND_INVALID");
  }
  const phase=releaseMode?"RELEASING":acceptanceMode?initial.pending?.to:"TARGET_ACTIVATING";
  const expectedPhase=releaseMode?"RELEASE_PREPARED":acceptanceMode?({TARGET_ACTIVE:"TARGET_ACTIVATING",ROUTED:"TARGET_ACTIVE",ACCEPTED:"ROUTED"})[phase]:"VERIFIED";
  need(["migration","release","acceptance"].includes(mode),"HEALTH_JOB_MODE_INVALID");
  need(!releaseMode||(exact(releaseContext,"migrationSourceFenceSha256,acceptedMigrationSha256")
    &&HASH.test(releaseContext.migrationSourceFenceSha256)&&HASH.test(releaseContext.acceptedMigrationSha256)),"HEALTH_JOB_RELEASE_CONTEXT_INVALID");
  need(custody?.signal instanceof AbortSignal&&[custody.assertOwned,releaseMode?assertDeploymentAuthority:assertSourceFenced,descriptorStore?.assertPrivate,descriptorStore?.readOptional,
    descriptorStore?.createOnly,operations?.readIntent,operations?.runRecordedOperation,send].every(f=>typeof f==="function")
    &&Number.isInteger(pollIntervalMs)&&pollIntervalMs>=0&&pollIntervalMs<=5000&&Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=300000,"HEALTH_JOB_CUSTODY_REQUIRED");
  const context={domain:initial.domain,intentSha256:initial.intentSha256,
    sourceFenceSha256:releaseMode?releaseContext.migrationSourceFenceSha256:initial.history?.find(x=>x.phase==="SOURCE_FENCED")?.evidenceSha256,
    phaseOperationId:initial.pending?.operationId,...(workerDemand?{workerDemandSha256:hash(workerDemand)}:{}),...(acceptanceMode?{mode,phase}:{}),...(releaseMode?{mode,acceptedMigrationSha256:releaseContext.acceptedMigrationSha256}:{})};
  need(["core","ops"].includes(context.domain)&&HASH.test(context.intentSha256)&&HASH.test(context.sourceFenceSha256)&&GUID.test(context.phaseOperationId)
    &&expectedPhase!==undefined&&initial.phase===expectedPhase&&initial.pending?.to===phase
    &&(releaseMode||initial.destinationMayHaveWritten===true),"HEALTH_JOB_PHASE_INVALID");
  const authority=releaseMode?{mode:"release",acceptedMigrationSha256:context.acceptedMigrationSha256,releaseId:context.phaseOperationId,
    targetSha256:hash(p.worker),sourceFenceProvenance:"historical-migration"}:null;
  const authorityRequest=releaseMode?{domain:context.domain,intentSha256:context.intentSha256,releaseId:context.phaseOperationId,
    targetSha256:hash(p.worker),acceptedMigrationSha256:context.acceptedMigrationSha256,migrationSourceFenceSha256:context.sourceFenceSha256}:null;
  const prefix=`operations/${context.domain}/${context.intentSha256}/${context.phaseOperationId}`;let busy=false;
  function snapshotCheck(){const j=custody.snapshot();need(j.domain===context.domain&&j.intentSha256===context.intentSha256
    &&j.phase===expectedPhase&&j.pending?.to===phase&&j.pending?.operationId===context.phaseOperationId
    &&(releaseMode||(j.destinationMayHaveWritten===true&&j.history?.find(x=>x.phase==="SOURCE_FENCED")?.evidenceSha256===context.sourceFenceSha256)),"HEALTH_JOB_CUSTODY_CHANGED");}
  async function check(signal){need(!signal.aborted&&!custody.signal.aborted,"HEALTH_JOB_ABORTED");await custody.assertOwned();snapshotCheck();
    if(releaseMode){
      // This asserts retained migration acceptance, exact deployment target and
      // the CURRENT release lease. The source-fence hash is historical provenance;
      // there is deliberately no call to a live Railway/source fence observer.
      const result=await assertDeploymentAuthority(structuredClone(authorityRequest));
      need(result?.complete===true&&Object.entries(authorityRequest).every(([key,value])=>result[key]===value),"HEALTH_JOB_DEPLOYMENT_AUTHORITY_UNPROVEN");
    }else{
      const s=await assertSourceFenced();need(s?.complete===true&&s.domain===context.domain&&s.intentSha256===context.intentSha256&&s.sourceFenceSha256===context.sourceFenceSha256,"HEALTH_JOB_SOURCE_UNFENCED");
    }
    await custody.assertOwned();snapshotCheck();need(!signal.aborted&&!custody.signal.aborted,"HEALTH_JOB_ABORTED");}
  async function request(method,path,signal,body){await check(signal);const r=await send({method,path,signal,...(body===undefined?{}:{body})});await check(signal);
    need(r&&[200,202,404].includes(r.status),"HEALTH_JOB_TRANSPORT_INVALID");return r;}
  async function prepare(signal = custody.signal) { return prepareHealthJob(p, request, signal); }
  async function assertWorker(r,signal,allowCold=false){
    const a=await request("GET",pathFor(p.worker.appId),signal),ap=a.body?.properties,ingress=ap?.configuration?.ingress;
    need(a.status===200&&equalId(a.body?.id,p.worker.appId)&&equalId(ap?.environmentId??ap?.managedEnvironmentId,p.environmentResourceId)
      &&ap.provisioningState==="Succeeded"&&ap.configuration?.activeRevisionsMode==="Single"&&ap.latestRevisionName===r.revisionName&&(ap.latestReadyRevisionName===r.revisionName||workerDemand&&allowCold)
      &&ingress?.external===false&&`https://${ingress.fqdn}`===p.worker.origin&&ingress.allowInsecure===false
      &&ingress.traffic?.length===1&&ingress.traffic[0].weight===100
      &&(ingress.traffic[0].revisionName===r.revisionName||ingress.traffic[0].latestRevision===true),"HEALTH_JOB_WORKER_BINDING_CHANGED");
    if(workerDemand)assertManagedAzureWorkerDemandApp(a.body,workerDemand.plan,workerDemand.target);
    const rev=await request("GET",pathFor(`${p.worker.appId}/revisions/${r.revisionName}`),signal),rp=rev.body?.properties;
    let cold=false;
    if(workerDemand&&allowCold){
      const replicas=await request("GET",pathFor(`${p.worker.appId}/revisions/${r.revisionName}/replicas`),signal);
      need(replicas.status===200&&Array.isArray(replicas.body?.value)&&!replicas.body.nextLink&&replicas.body.value.length<=1,"HEALTH_JOB_DEMAND_REPLICAS_INVALID");
      cold=replicas.body.value.length===0&&["Stopped","ScaleToZero","Running","Activating"].includes(rp?.runningState);
    }
    need(rev.status===200&&rev.body?.name===r.revisionName&&(!rev.body.id||equalId(rev.body.id,`${p.worker.appId}/revisions/${r.revisionName}`))
      &&rp?.active===true&&rp.provisioningState==="Provisioned"&&(cold||rp.healthState==="Healthy"&&["Running","RunningAtMaxScale"].includes(rp.runningState))
      &&rp.template?.containers?.length===1&&rp.template.containers[0].name==="worker"&&rp.template.containers[0].image===p.worker.image,"HEALTH_JOB_WORKER_REVISION_CHANGED");
    return hash({appId:p.worker.appId,revisionName:r.revisionName,image:p.worker.image,origin:p.worker.origin});
  }
  async function inventory(signal){let path=pathFor(`${p.jobResourceId}/executions`);const visited=new Set(),rows=[];
    for(let page=0;path;page++){need(page<20&&!visited.has(path),"HEALTH_JOB_PAGE_BOUND");visited.add(path);const r=await request("GET",path,signal);
      need(r.status===200&&Array.isArray(r.body?.value)&&rows.length+r.body.value.length<=1000,"HEALTH_JOB_EXECUTIONS_INVALID");rows.push(...r.body.value.map(v=>execution(v,p)));
      if(r.body.nextLink){const u=new URL(r.body.nextLink,"https://management.azure.com");need(u.origin==="https://management.azure.com"&&equalId(u.pathname,`${p.jobResourceId}/executions`)
        &&u.searchParams.get("api-version")===API&&!u.hash&&!u.username&&!u.password,"HEALTH_JOB_NEXT_LINK_DENIED");path=u.pathname+u.search;}else path=null;
    }need(new Set(rows.map(v=>v.id.toLowerCase())).size===rows.length,"HEALTH_JOB_EXECUTIONS_INVALID");return rows;}
  const slotKey=index=>`${prefix}/${hash({kind:"AZURE_HEALTH_PROBE_SLOT",inputSha256:hash({plan:p,context,index})})}/descriptor.json`;
  async function readSlot(index,signal){await check(signal);await descriptorStore.assertPrivate();const text=await descriptorStore.readOptional(slotKey(index),signal);await check(signal);
    if(text===null)return null;need(typeof text==="string"&&text.length<65536,"HEALTH_JOB_DESCRIPTOR_INVALID");const record=JSON.parse(text);
    need(exact(record,"kind,input")&&record.kind==="AZURE_HEALTH_PROBE_START"&&exact(record.input,"plan,context,index,challenge,template")
      &&same(record.input.plan,p)&&same(record.input.context,context)&&record.input.index===index,"HEALTH_JOB_DESCRIPTOR_INVALID");
    validateHealthChallenge(record.input.challenge,p.worker,identity(p),{fresh:false});
    need(same(record.input.challenge.authority??null,authority)&&record.input.challenge.domain===context.domain
      &&record.input.challenge.intentSha256===context.intentSha256&&record.input.challenge.sourceFenceSha256===context.sourceFenceSha256,"HEALTH_JOB_DESCRIPTOR_INVALID");
    need(same(record.input.template,template(p,record.input.challenge)),"HEALTH_JOB_DESCRIPTOR_INVALID");return record;}
  async function retain(record,index,signal){await check(signal);await descriptorStore.assertPrivate();const text=JSON.stringify(record);
    await descriptorStore.createOnly(slotKey(index),text,signal);need(same(await readSlot(index,signal),record),"HEALTH_JOB_DESCRIPTOR_INVALID");
    const key=`${prefix}/${hash({kind:record.kind,inputSha256:hash(record.input)})}/descriptor.json`;
    await check(signal);await descriptorStore.createOnly(key,text,signal);await check(signal);
    need((await descriptorStore.readOptional(key,signal))===text,"HEALTH_JOB_DESCRIPTOR_INVALID");}
  async function locate(record,signal){const c=record.input.challenge;const matches=(await inventory(signal)).filter(row=>row.properties.template?.containers?.some(v=>v.env?.some(e=>
    e.name==="CORGTEX_HEALTH_CHALLENGE"&&e.value===JSON.stringify(c))));need(matches.length<=1,"HEALTH_JOB_EXECUTION_AMBIGUOUS");if(!matches.length)return null;
    const found=matches[0];verifyTemplate(found.properties.template,record.input.template);need(Date.parse(found.properties.startTime)>=c.issuedAt,"HEALTH_JOB_EXECUTION_STALE");return found;}
  async function reconcile(record,signal){need(await operations.readIntent(record.kind,record.input),"HEALTH_JOB_START_INTENT_UNPROVEN");let found;
    await operations.runRecordedOperation({...record,apply:async()=>{throw new HealthJobError("HEALTH_JOB_REPLAY_DENIED");},verify:async()=>{
      found=await locate(record,signal);return{complete:!!found,evidence:found?{executionResourceId:found.id,challengeSha256:hash(record.input.challenge)}:{}};
    }});return found;}
  async function readRetainedStart(){let last=null;for(let index=0;index<10;index++){const r=await readSlot(index,custody.signal);if(!r)break;last=r;}return last;}
  const safe=async action=>{try{return await action();}catch(e){throw e instanceof HealthJobError?e:new HealthJobError("HEALTH_JOB_RECONCILE_REQUIRED");}};
  async function probeHealth({role,origin,release,appId,revisionName,invocationContext,signal}){
    need(!busy,"HEALTH_JOB_CONCURRENT");busy=true;
    try{
      need(signal instanceof AbortSignal,"HEALTH_JOB_SIGNAL_REQUIRED");signal=AbortSignal.any([signal,custody.signal,AbortSignal.timeout(timeoutMs)]);
      const requested={role,origin,release,appId,revisionName,invocationContext};const now=Date.now();const challenge={schemaVersion:releaseMode?2:1,...(authority?{authority}:{}),nonce:randomBytes(32).toString("hex"),
        domain:context.domain,intentSha256:context.intentSha256,sourceFenceSha256:context.sourceFenceSha256,targetSha256:hash(p.worker),identity:identity(p),
        issuedAt:now,expiresAt:now+timeoutMs,request:structuredClone(requested)};
      validateHealthChallenge(challenge,p.worker,identity(p));await prepare(signal);await assertWorker(requested,signal,true);
      let index;
      for(index=0;index<10;index++){const old=await readSlot(index,signal);if(!old)break;
        const previous=await reconcile(old,signal);need(["Succeeded","Failed","Stopped"].includes(previous.properties.status),"HEALTH_JOB_PREVIOUS_EXECUTION_PENDING");}
      need(index<10,"HEALTH_JOB_ATTEMPT_BOUND");
      need((await inventory(signal)).every(r=>["Succeeded","Failed","Stopped"].includes(r.properties.status)),"HEALTH_JOB_FOREIGN_EXECUTION");
      const record={kind:"AZURE_HEALTH_PROBE_START",input:{plan:p,context,index,challenge,template:template(p,challenge)}};await retain(record,index,signal);let found,acceptedId;
      await operations.runRecordedOperation({...record,apply:async()=>{
        await prepare(signal);await assertWorker(requested,signal,true);const boundary=Math.ceil(challenge.issuedAt/1000)*1000;
        if(Date.now()<boundary)await delay(boundary-Date.now(),undefined,{signal});validateHealthChallenge(challenge,p.worker,identity(p));
        const r=await request("POST",pathFor(`${p.jobResourceId}/start`),signal,record.input.template);
        if(r.body){need(typeof r.body.name==="string"&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.body.name)&&(!r.body.id||equalId(r.body.id,`${p.jobResourceId}/executions/${r.body.name}`)),"HEALTH_JOB_EXECUTION_INVALID");acceptedId=`${p.jobResourceId}/executions/${r.body.name}`;}
      },verify:async()=>{for(;;){validateHealthChallenge(challenge,p.worker,identity(p));found=await locate(record,signal);
        if(found){need(!acceptedId||equalId(found.id,acceptedId),"HEALTH_JOB_EXECUTION_CHANGED");return{complete:true,evidence:{executionResourceId:found.id,challengeSha256:hash(challenge)}};}
        await delay(pollIntervalMs,undefined,{signal});}}});
      for(;;){validateHealthChallenge(challenge,p.worker,identity(p));const r=await request("GET",pathFor(found.id),signal);need(r.status===200,"HEALTH_JOB_EXECUTION_CHANGED");
        const next=execution(r.body,p);need(equalId(next.id,found.id),"HEALTH_JOB_EXECUTION_CHANGED");found=next;verifyTemplate(found.properties.template,record.input.template);
        need(["Running","Processing","Succeeded"].includes(found.properties.status),"HEALTH_JOB_EXECUTION_FAILED");
        if(found.properties.status==="Succeeded"){
          const start=Date.parse(found.properties.startTime),end=Date.parse(found.properties.endTime);need(Number.isFinite(start)&&Number.isFinite(end)&&start>=challenge.issuedAt&&end>=start&&end<=Date.now()&&end<=challenge.expiresAt,"HEALTH_JOB_EXECUTION_STALE");
          const logs=await request("POST",`/v1/workspaces/${p.workspaceId}/query`,signal,{query:query(p,found,challenge),timespan:`${new Date(challenge.issuedAt).toISOString()}/${new Date(challenge.expiresAt).toISOString()}`});
          need(logs.status===200,"HEALTH_JOB_LOG_UNAVAILABLE");const receipt=parseLogs(logs.body,p,found,challenge);
          if(receipt){await prepare(signal);const workerSha256=await assertWorker(requested,signal);const last=await request("GET",pathFor(found.id),signal);
            need(last.status===200&&same(execution(last.body,p),found),"HEALTH_JOB_EXECUTION_CHANGED");validateHealthChallenge(challenge,p.worker,identity(p));
            return{health:receipt.health,ready:receipt.ready,evidence:{challengeSha256:hash(challenge),receiptSha256:hash(receipt),executionSha256:hash(found),workerSha256,
              jobIdentitySha256:hash(identity(p)),sourceFenceSha256:context.sourceFenceSha256,intentSha256:context.intentSha256,
              ...(releaseMode?{mode:"release",invocationContext,sourceFenceProvenance:"historical-migration",authoritySha256:hash(authority),requestSha256:hash(requested)}:{})}};}
        }await delay(pollIntervalMs,undefined,{signal});
      }
    }finally{busy=false;}
  }
  return{identity:identity(p),prepare:()=>safe(()=>prepare()),probeHealth:args=>safe(()=>probeHealth(args)),readRetainedStart:()=>safe(readRetainedStart),
    reconcileStart:()=>safe(async()=>{need(!busy,"HEALTH_JOB_CONCURRENT");busy=true;try{const record=await readRetainedStart();need(record,"HEALTH_JOB_START_INTENT_UNPROVEN");
      const found=await reconcile(record,custody.signal);return{executionResourceId:found.id,status:found.properties.status,expired:Date.now()>=record.input.challenge.expiresAt};}finally{busy=false;}})};
}

/** Construction does not require activation to have begun. The recorder opens
 * only after custody.begin(TARGET_ACTIVATING), or pending RELEASING in explicit
 * release mode, immediately before first use. Mode is never inferred from a
 * journal: migration defaults retain their existing source-observer semantics.
 *
 * Release options require releaseContext:{migrationSourceFenceSha256,
 * acceptedMigrationSha256} and assertDeploymentAuthority(request). The request
 * contains domain,intentSha256,releaseId,targetSha256,acceptedMigrationSha256,
 * migrationSourceFenceSha256. The callback must freshly verify the active lease,
 * accepted migration and exact target, returning {complete:true,...request}.
 * A release caller must bind each baseline/forward/recovery static worker plan
 * to its own expected release; baseline health is never promoted to forward proof.
 */
export function createHealthJobDispatcher(options) {
  const p=plan(options.plan),mode=options.mode??"migration";need(["migration","release","acceptance"].includes(mode),"HEALTH_JOB_MODE_INVALID");
  let bound=null;let opening=null;
  const get=async()=>{
    if(bound)return bound;
    if(!opening)opening=(async()=>{
      const operationStore=options.operationStore??options.descriptorStore;
      const operations=options.operations??await openProviderOperationRecorder({custody:options.custody,store:operationStore,phase:mode==="release"?"RELEASING":mode==="acceptance"?options.custody.snapshot().pending?.to:"TARGET_ACTIVATING",signal:options.custody.signal});
      bound=createBoundHealthJobDispatcher({...options,plan:p,descriptorStore:operationStore,operations});return bound;
    })();
    try{return await opening;}catch{opening=null;throw new HealthJobError("HEALTH_JOB_INITIALIZATION_FAILED");}
  };
  return{identity:identity(p),prepare:async()=> (await get()).prepare(),probeHealth:async args=>(await get()).probeHealth(args),
    readRetainedStart:async()=> (await get()).readRetainedStart(),reconcileStart:async()=> (await get()).reconcileStart()};
}

async function prepareHealthJob(p, request, signal) {
    const j=await request("GET",pathFor(p.jobResourceId),signal);need(j.status===200,"HEALTH_JOB_NOT_PREPARED");verifyJob(j.body,p);
    const e=await request("GET",pathFor(p.environmentResourceId),signal),props=e.body?.properties;
    need(e.status===200&&equalId(e.body?.id,p.environmentResourceId)&&props?.provisioningState==="Succeeded"
      &&equalId(props.vnetConfiguration?.infrastructureSubnetId,p.infrastructureSubnetId)&&props.appLogsConfiguration?.destination==="log-analytics"
      &&props.appLogsConfiguration.logAnalyticsConfiguration?.customerId===p.workspaceId
      &&p.worker.origin===`https://${p.worker.appId.split("/").at(-1)}.internal.${props.defaultDomain}`,"HEALTH_JOB_ENVIRONMENT_CHANGED");
    return{identity:identity(p),planSha256:hash(p),definitionSha256:hash(buildHealthProbeJobDefinition(p))};

}

/** Read-only resource and query-access proof before a source fence. No probe
 * execution, provider intent, synthetic custody phase or runtime effects. */
export async function preflightHealthJob({plan: value, signal, assertOwned, transport}) {
  const p = plan(value), send = transport ?? createHealthJobTransport(p);
  need(signal instanceof AbortSignal && typeof assertOwned === "function", "HEALTH_JOB_CUSTODY_REQUIRED");
  const check = async () => { signal.throwIfAborted(); await assertOwned(); signal.throwIfAborted(); };
  const request = async (method, path, signal, body) => {
    await check(); const response = await send({method,path,signal,...(body === undefined ? {} : {body})});
    await check(); return response;
  };
  try {
    const prepared = await prepareHealthJob(p, request, signal);
    const logs = await request("POST", `/v1/workspaces/${p.workspaceId}/query`, signal, {query:"print preflight = 1"});
    need(logs?.status === 200 && !logs.body?.error && logs.body?.tables?.length === 1
      && logs.body.tables[0].columns?.length === 1 && logs.body.tables[0].columns[0].name === "preflight"
      && same(logs.body.tables[0].rows, [[1]]), "HEALTH_JOB_LOG_ACCESS_UNPROVEN");
    return {...prepared,workspaceId:p.workspaceId,logQueryAccess:true};
  } catch (error) { throw error instanceof HealthJobError ? error : new HealthJobError("HEALTH_JOB_PREFLIGHT_FAILED"); }
}
