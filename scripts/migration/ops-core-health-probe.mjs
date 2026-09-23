import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";

export const HEALTH_PROBE_PREFIX = "CORGTEX_HEALTH_PROBE_V1 ";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^\/subscriptions\/[a-f0-9-]{36}\/resourcegroups\/[a-z0-9_.()-]{1,90}\/providers\/microsoft\.app\/containerapps\/[a-z][a-z0-9-]{0,30}[a-z0-9]$/i;
class ProbeError extends Error {}
const need = (condition,code) => {if(!condition)throw new ProbeError(code);};
export const healthProbeDiagnostic = error => error instanceof ProbeError ? error.message : null;
export function validateHealthTarget(value) {
  need(value && Object.keys(value).sort().join(",") === "appId,image,origin,release" && ID.test(value.appId)
    && /^https:\/\/[a-z][a-z0-9-]{0,30}[a-z0-9]\.internal\.[a-z0-9.-]+\.azurecontainerapps\.io$/.test(value.origin)
    && new URL(value.origin).hostname.split(".")[0] === value.appId.split("/").at(-1)
    && /^[a-z0-9]{5,50}\.azurecr\.io\/[a-z0-9][a-z0-9/_.-]{0,150}@sha256:[a-f0-9]{64}$/.test(value.image),"HEALTH_PROBE_TARGET_INVALID");
  const r=value.release;
  need(r && Object.keys(r).sort().join(",")==="gitSha,imageTag,version" && /^[a-f0-9]{40}$/.test(r.gitSha)
    && r.imageTag===`sha-${r.gitSha}` && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(r.version),"HEALTH_PROBE_RELEASE_INVALID");
  return structuredClone(value);
}
export async function healthProbeBuildSha256() {
  const files=[];
  for(const name of ["ops-core-archive.mjs","ops-core-health-probe.mjs"])
    files.push({name,sha256:createHash("sha256").update(await readFile(new URL(name,import.meta.url))).digest("hex")});
  return hash(files);
}
export function validateHealthChallenge(c,target,identity,{fresh=true}={}) {
  const releaseMode=c?.schemaVersion===2;
  const names="domain,expiresAt,identity,intentSha256,issuedAt,nonce,request,schemaVersion,sourceFenceSha256,targetSha256";
  need(c && Object.keys(c).sort().join(",") === (releaseMode?`authority,${names}`:names)
    && c.schemaVersion===(releaseMode?2:1) && ["core","ops"].includes(c.domain) && [c.nonce,c.intentSha256,c.sourceFenceSha256].every(v=>HASH.test(v))
    && hash(c.identity)===hash(identity) && c.targetSha256===hash(target)
    && Number.isSafeInteger(c.issuedAt) && Number.isSafeInteger(c.expiresAt)
    && c.expiresAt>c.issuedAt && c.expiresAt-c.issuedAt<=300000
    && (!fresh || (Date.now()>=c.issuedAt && Date.now()<c.expiresAt)),"HEALTH_PROBE_CHALLENGE_INVALID");
  if(releaseMode) {
    const a=c.authority;
    need(a && Object.keys(a).sort().join(",")==="acceptedMigrationSha256,mode,releaseId,sourceFenceProvenance,targetSha256"
      && a.mode==="release" && HASH.test(a.acceptedMigrationSha256)
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(a.releaseId)
      && a.targetSha256===hash(target) && a.sourceFenceProvenance==="historical-migration","HEALTH_PROBE_AUTHORITY_INVALID");
  }
  const contexts=releaseMode?["baseline-worker","release-worker","release-final","recovery-worker","recovery-final"]:["worker-after-create","worker-final"];
  const r=c.request;
  need(r && Object.keys(r).sort().join(",")==="appId,invocationContext,origin,release,revisionName,role" && r.role==="worker" && contexts.includes(r.invocationContext) && r.origin===target.origin
    && r.appId.toLowerCase()===target.appId.toLowerCase() && hash(r.release)===hash(target.release)
    && typeof r.revisionName==="string" && r.revisionName.startsWith(`${target.appId.split("/").at(-1)}--`)
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(r.revisionName),"HEALTH_PROBE_REQUEST_INVALID");
}
function validateWorkerRelease(health,target) {
  const release=health?.release,expected=target.release;
  need(release?.gitSha===expected.gitSha && release.version===expected.version && release.imageTag===expected.imageTag && release.service==="worker"
    && release.runtime?.gitSha===expected.gitSha && release.runtime.source==="baked" && release.runtime.evidence==="baked"
    && release.drift?.gitSha===false && release.drift.version===false && release.drift.imageTag===false
    && Array.isArray(release.drift.details) && release.drift.details.length===0,"HEALTH_PROBE_RELEASE_MISMATCH");
}
export function projectWorkerHealth(health,ready,target,observedAt=Date.now()) {
  const release=health?.release; const expected=target.release; const tick=Date.parse(health?.lastSuccessfulTickAt);
  need(health?.status==="ok" && health.phase==="running" && health.lastError===null && Number.isSafeInteger(health.tickCount) && health.tickCount>0
    && Number.isFinite(tick) && tick<=observedAt && observedAt-tick<=120000
    && ready?.ready===true && ready.phase==="running","HEALTH_PROBE_WORKER_NOT_READY");
  validateWorkerRelease(health,target);
  // lastError/workerId/diagnostic counters can contain private details. Only
  // acceptance fields actually read and validated are retained in the receipt.
  return {health:{status:200,body:{status:health.status,phase:health.phase,lastError:null,tickCount:health.tickCount,
    lastSuccessfulTickAt:new Date(tick).toISOString(),release:{...expected,service:release.service,
      runtime:{gitSha:release.runtime.gitSha,source:release.runtime.source,evidence:release.runtime.evidence},
      drift:{gitSha:false,imageTag:false,version:false,details:[]}}}},ready:{status:200,body:{ready:ready.ready,phase:ready.phase}}};
}
async function readJson(url,signal,fetchImpl) {
  const timeout=AbortSignal.any([signal,AbortSignal.timeout(10000)]);
  let reject;const cancelled=new Promise((_,no)=>{reject=()=>no(new ProbeError("HEALTH_PROBE_ABORTED"));timeout.addEventListener("abort",reject,{once:true});});
  let reader;
  try {
    const action=(async()=>{
      need(!timeout.aborted,"HEALTH_PROBE_ABORTED");
      const response=await fetchImpl(url,{method:"GET",redirect:"error",signal:timeout,headers:{Accept:"application/json"}});
      need(!timeout.aborted && !response.redirected && response.url===url && [200,503].includes(response.status),"HEALTH_PROBE_HTTP_REJECTED");
      need(/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""),"HEALTH_PROBE_CONTENT_INVALID");
      reader=response.body?.getReader();need(reader,"HEALTH_PROBE_CONTENT_INVALID");
      let size=0;const chunks=[];
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;need(size<=32768,"HEALTH_PROBE_RESPONSE_TOO_LARGE");chunks.push(Buffer.from(value));}
      need(!timeout.aborted,"HEALTH_PROBE_ABORTED");return {status:response.status,body:JSON.parse(Buffer.concat(chunks).toString("utf8"))};
    })();
    return await Promise.race([action,cancelled]);
  } finally {timeout.removeEventListener("abort",reject);void reader?.cancel().catch(()=>{});}
}
export async function runWorkerHealthProbe({target:raw,challenge,identity,signal,fetchImpl=fetch,pollIntervalMs=1000}) {
  let timer;
  try {
    const target=validateHealthTarget(raw);
    need(signal instanceof AbortSignal && !signal.aborted && identity && Object.keys(identity).sort().join(",")==="imageDigest,jobResourceId,probeSha256"
      && /^\/subscriptions\/[a-f0-9-]{36}\/resourcegroups\/[a-z0-9_.()-]{1,90}\/providers\/microsoft\.app\/jobs\/[a-z][a-z0-9-]{0,30}[a-z0-9]$/i.test(identity.jobResourceId)
      && HASH.test(identity.probeSha256) && /^sha256:[a-f0-9]{64}$/.test(identity.imageDigest),"HEALTH_PROBE_INPUT_INVALID");
    validateHealthChallenge(challenge,target,identity);
    need(Number.isInteger(pollIntervalMs)&&pollIntervalMs>=0&&pollIntervalMs<=5000,"HEALTH_PROBE_INPUT_INVALID");
    const deadline=new AbortController();
    timer=setTimeout(()=>deadline.abort(),Math.min(110000,challenge.expiresAt-Date.now()));
    signal=AbortSignal.any([signal,deadline.signal]);
    for (;;) {
      need(!signal.aborted,"HEALTH_PROBE_ABORTED");validateHealthChallenge(challenge,target,identity);
      const healthResponse=await readJson(`${target.origin}/health`,signal,fetchImpl),health=healthResponse.body;
      need(healthResponse.status===200,"HEALTH_PROBE_HTTP_REJECTED");validateWorkerRelease(health,target);
      need(health?.status==="ok"&&["starting","running"].includes(health.phase)&&health.lastError===null
        &&Number.isSafeInteger(health.tickCount)&&health.tickCount>=0,"HEALTH_PROBE_WORKER_NOT_READY");
      const readyResponse=await readJson(`${target.origin}/ready`,signal,fetchImpl),ready=readyResponse.body;
      // /ready intentionally returns 503 during an ordinary tick. Keep the
      // same job, nonce and identity; only these recognized startup/busy states
      // may poll. Foreign release/origin, errors and malformed states still fail.
      if (readyResponse.status===503) {
        need(ready?.ready===false&&["starting","running"].includes(ready.phase),"HEALTH_PROBE_WORKER_NOT_READY");
      } else {
        need(ready?.ready===true&&ready.phase==="running","HEALTH_PROBE_WORKER_NOT_READY");
        if (health.phase==="running"&&health.tickCount>0&&health.lastSuccessfulTickAt!==null) {
          const observedAt=Date.now();const projection=projectWorkerHealth(health,ready,target,observedAt);
          validateHealthChallenge(challenge,target,identity);
          return {schemaVersion:challenge.schemaVersion,type:"WORKER_HEALTH_OBSERVATION",challengeSha256:hash(challenge),nonce:challenge.nonce,
            ...(challenge.authority?{authority:structuredClone(challenge.authority)}:{}),
            domain:challenge.domain,intentSha256:challenge.intentSha256,sourceFenceSha256:challenge.sourceFenceSha256,targetSha256:hash(target),
            identity:structuredClone(identity),request:structuredClone(challenge.request),observedAt,...projection};
        }
      }
      await delay(pollIntervalMs,undefined,{signal});
    }
  }catch(error){
    if(error instanceof ProbeError)throw error;
    throw new ProbeError(signal?.aborted?"HEALTH_PROBE_ABORTED":"HEALTH_PROBE_FAILED");
  }finally{clearTimeout(timer);}

}
export async function runHealthProbeCli({env=process.env,write=text=>process.stdout.write(text)}={}) {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),110000);
  try {
    const parse=name=>{need(typeof env[name]==="string"&&Buffer.byteLength(env[name])<=16384,"HEALTH_PROBE_INPUT_INVALID");return JSON.parse(env[name]);};
    const identity=parse("CORGTEX_HEALTH_PROBE_IDENTITY");need(identity.probeSha256===await healthProbeBuildSha256(),"HEALTH_PROBE_BUILD_MISMATCH");
    const receipt=await runWorkerHealthProbe({target:parse("CORGTEX_HEALTH_TARGET"),challenge:parse("CORGTEX_HEALTH_CHALLENGE"),identity,signal:controller.signal});
    write(`${HEALTH_PROBE_PREFIX}${JSON.stringify(receipt)}\n`);
    await delay(1100,undefined,{signal:controller.signal});return true;
  }catch{write("CORGTEX_HEALTH_PROBE_FAILED\n");return false;}finally{clearTimeout(timer);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)process.exitCode=await runHealthProbeCli()?0:1;
