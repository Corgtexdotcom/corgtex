import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { createRailwayFenceTransport } from "./railway-source-fence.mjs";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const need = (value, code) => { if (!value) throw new Error(code); };
const runHash = binding => createHash("sha256").update(binding.server.runId).digest("hex");

/** The HMAC is a single-use challenge response, checked only in memory. It is
 * deliberately omitted from retained evidence along with the Redis URL/password.
 * Host aliases are permitted only because the runtime itself observed the same
 * Redis server run ID/version and logical database as the operator's binding. */
export function verifyRuntimeRedisObservation({ observed, binding, credentials, nonce, context }) {
  redisGateBindingSha256(binding);
  need(binding.mode === "standalone" && HASH.test(nonce) && typeof credentials?.password === "string"
    && credentials.password.length > 0, "SOURCE_REDIS_CREDENTIALS_REQUIRED");
  need(observed?.server?.version === binding.server.version && observed.server.runIdSha256 === runHash(binding)
    && observed.database === binding.connection.database && observed.username === binding.connection.username
    && typeof observed.tls === "boolean" && HASH.test(observed.endpointSha256) && HASH.test(observed.credentialProof),
  "SOURCE_REDIS_RUNTIME_BINDING_MISMATCH");
  need(context && [context.intentSha256, context.role, context.serviceId, context.deploymentId, context.instanceId].every(value => typeof value === "string" && value.length > 0), "SOURCE_REDIS_CHALLENGE_INVALID");
  const challenge = JSON.stringify([nonce, context.intentSha256, context.role, context.serviceId, context.deploymentId, context.instanceId]);
  const expected = createHmac("sha256", credentials.password).update(challenge).digest();
  need(timingSafeEqual(expected, Buffer.from(observed.credentialProof, "hex")), "SOURCE_REDIS_RUNTIME_CREDENTIAL_MISMATCH");
  return { bindingSha256: redisGateBindingSha256(binding), server: { version: observed.server.version, runIdSha256: observed.server.runIdSha256 },
    database: observed.database, username: observed.username, tls: observed.tls,
    endpointSha256: observed.endpointSha256, credentialMatched: true };
}

// Inserted in the existing exact-instance, bounded source-health remote script.
// env -i prevents inherited SSH variables from being mistaken for app state.
// Resolve the process actually listening on the application's pinned health port.
export function redisRuntimeObservationScript() {
  return `async function observeRuntimeRedis() {
const fs=await import('node:fs/promises'),crypto=await import('node:crypto');
const boundedFile=async(path,max)=>{const f=await fs.open(path,'r');try{const b=Buffer.alloc(max+1);const n=(await f.read(b,0,b.length,0)).bytesRead;if(n>max)fail();return b.subarray(0,n).toString('utf8');}finally{await f.close();}};
const sockets=new Set();for(const path of ['/proc/net/tcp','/proc/net/tcp6']){const text=await boundedFile(path,1048576);for(const line of text.trim().split('\\n').slice(1)){const v=line.trim().split(/\\s+/);if(v[3]==='0A'&&Number.parseInt(v[1].split(':')[1],16)===c.port)sockets.add(v[9]);}}
if(!sockets.size)fail();const entries=(await fs.readdir('/proc')).filter(x=>/^[0-9]+$/.test(x));if(entries.length>256)fail();let inspected=0;const pids=new Set();
for(const pid of entries){let fds;try{fds=await fs.readdir('/proc/'+pid+'/fd');}catch{continue;}for(const fd of fds){if(++inspected>4096)fail();let link;try{link=await fs.readlink('/proc/'+pid+'/fd/'+fd);}catch{continue;}const m=/^socket:\\[([0-9]+)\\]$/.exec(link);if(m&&sockets.has(m[1]))pids.add(pid);}}
if(pids.size!==1)fail();const raw=await boundedFile('/proc/'+[...pids][0]+'/environ',262144);const selected={};for(const entry of raw.split('\\0')){const i=entry.indexOf('=');const name=entry.slice(0,i);if(['REDIS_URL','SHARED_STATE_BACKEND'].includes(name)){if(Object.hasOwn(selected,name))fail();selected[name]=entry.slice(i+1);}}
if((selected.SHARED_STATE_BACKEND||'redis')!=='redis'||!selected.REDIS_URL)fail();const u=new URL(selected.REDIS_URL);if(!['redis:','rediss:'].includes(u.protocol)||u.search||u.hash||!/^\\/(?:[0-9]|1[0-5])?$/.test(u.pathname||'/'))fail();
const username=decodeURIComponent(u.username)||'default',password=decodeURIComponent(u.password),database=Number((u.pathname||'/').slice(1)||'0');if(!password)fail();
const {createRequire}=await import('node:module');const {createClient}=createRequire('/app/package.json')('redis');const client=createClient({url:selected.REDIS_URL,disableOfflineQueue:true,disableClientInfo:true,socket:{connectTimeout:10000,reconnectStrategy:false}});client.on('error',()=>{});let timer;
try{return await Promise.race([(async()=>{await client.connect();const text=await client.sendCommand(['INFO','server'],{timeout:10000});const role=await client.sendCommand(['ROLE'],{timeout:10000});if(!Array.isArray(role)||role[0]!=='master'||typeof text!=='string'||text.length>65536)fail();const values={};for(const line of text.split(/\\r?\\n/)){const i=line.indexOf(':');if(i>0&&['run_id','redis_version','redis_mode'].includes(line.slice(0,i))){if(Object.hasOwn(values,line.slice(0,i)))fail();values[line.slice(0,i)]=line.slice(i+1);}}if(values.redis_mode!=='standalone'||!/^[a-f0-9]{40}$/.test(values.run_id)||!/^\\d+\\.\\d+\\.\\d+$/.test(values.redis_version))fail();
return {server:{version:values.redis_version,runIdSha256:crypto.createHash('sha256').update(values.run_id).digest('hex')},database,username,tls:u.protocol==='rediss:',endpointSha256:crypto.createHash('sha256').update(JSON.stringify([u.hostname,Number(u.port||6379),database,username,u.protocol])).digest('hex'),credentialProof:crypto.createHmac('sha256',password).update(JSON.stringify([c.nonce,c.redisIntentSha256,c.role,c.serviceId,c.deploymentId,c.instanceId])).digest('hex')};})(),new Promise((_,reject)=>{timer=setTimeout(()=>{try{client.destroy();}catch{}reject(Error('SOURCE_REDIS_RUNTIME_TIMEOUT'));},15000);})]);}finally{clearTimeout(timer);try{client.destroy();}catch{}}
}`;
}

const QUERY = `query SourceRedisDeployment($projectId:String!,$environmentId:String!,$deploymentId:String!) {
  environment(id:$environmentId,projectId:$projectId) { id projectId }
  deployment(id:$deploymentId) { id projectId environmentId serviceId status deploymentStopped instances { id status } }
}`;

/** Fresh stopped-deployment readbacks link the immutable pre-fence runtime Redis
 * observation to the currently fenced writers. The final gate scans that same
 * server run ID/database now, so an unrelated empty endpoint cannot substitute. */
export async function assertOpsCoreSourceRedisBound({ plan, custody, operationStore, assertSourceFenced, railway = {} }) {
  try {
    const initial = custody.snapshot(), initialHash = hash(initial), source = plan.sharedState?.sourceRedis;
    const bindingSha256 = redisGateBindingSha256(source);
    const fence = initial.history?.find(entry => entry.phase === "SOURCE_FENCED");
    need(plan.schemaVersion === 2 && plan.sharedState.backend === "postgres" && plan.domain === initial.domain
      && hash(plan) === initial.intentSha256 && ID.test(fence?.operationId) && HASH.test(fence.evidenceSha256)
      && !initial.destinationMayHaveWritten, "SOURCE_REDIS_FENCE_REQUIRED");
    const check = async () => {
      custody.signal.throwIfAborted(); await custody.assertOwned(); custody.signal.throwIfAborted();
      need(hash(custody.snapshot()) === initialHash, "SOURCE_REDIS_CUSTODY_CHANGED");
      const proof = await assertSourceFenced(); custody.signal.throwIfAborted();
      need(proof?.complete === true && proof.domain === initial.domain && proof.intentSha256 === initial.intentSha256
        && proof.sourceFenceSha256 === fence.evidenceSha256 && hash(custody.snapshot()) === initialHash, "SOURCE_REDIS_FENCE_CHANGED");
    };
    await check(); await operationStore.assertPrivate();
    const prefix = `operations/${initial.domain}/${initial.intentSha256}/${fence.operationId}/`;
    const read = async name => {
      const text = await operationStore.readOptional(`${prefix}${name}.json`, custody.signal);
      need(typeof text === "string" && Buffer.byteLength(text) <= 32 * 1024 * 1024, "SOURCE_REDIS_BASELINE_MISSING");
      await check(); return JSON.parse(text);
    };
    const recorded = await read(`phase-evidence-${fence.evidenceSha256}`), phasePlan = await read("phase-plan");
    const health = phasePlan.recoveryBaseline?.health;
    const { evidenceSha256, ...healthBody } = health ?? {};
    need(hash(recorded) === fence.evidenceSha256 && recorded.intentSha256 === initial.intentSha256 && recorded.domain === initial.domain
      && recorded.sourceRuntimeRedisBaselineSha256 === hash(health) && phasePlan.intentSha256 === initial.intentSha256
      && phasePlan.domain === initial.domain && hash(phasePlan.source) === hash(plan.source)
      && HASH.test(evidenceSha256) && hash(healthBody) === evidenceSha256 && health.complete === true
      && health.type === "OPS_CORE_SOURCE_HEALTH" && health.stage === "baseline" && health.domain === plan.domain
      && health.intentSha256 === initial.intentSha256 && health.sourceHealthBindingSha256 === hash(plan.source.health)
      && health.writerBaselineSha256 === hash(phasePlan.recoveryBaseline.writers)
      && hash(phasePlan.recoveryBaseline.writers.binding) === hash(plan.source.writers.binding)
      && Array.isArray(health.services) && health.services.length === 2, "SOURCE_REDIS_BASELINE_UNPROVEN");
    const transport = railway.transport ?? createRailwayFenceTransport({ token: railway.token });
    const identities = [];
    for (const role of ["web", "worker"]) {
      const pinned = plan.source.health.services.find(value => value.role === role), observed = health.services.find(value => value.role === role);
      const writer = phasePlan.recoveryBaseline.writers.services.find(value => value.serviceId === pinned?.serviceId);
      need(pinned && observed && writer && hash(writer.activeDeploymentIds) === hash([pinned.deploymentId]) && observed.projectId === plan.source.writers.binding.projectId
        && observed.environmentId === plan.source.writers.binding.environmentId && observed.serviceId === pinned.serviceId
        && observed.deploymentId === pinned.deploymentId && plan.source.writers.binding.serviceIds.includes(pinned.serviceId)
        && observed.redis?.bindingSha256 === bindingSha256 && observed.redis.credentialMatched === true
        && observed.redis.server?.version === source.server.version && observed.redis.server.runIdSha256 === runHash(source)
        && observed.redis.database === source.connection.database && observed.redis.username === source.connection.username,
      "SOURCE_REDIS_RUNTIME_BINDING_MISMATCH");
      await check();
      const data = await transport({ query: QUERY, variables: { projectId: observed.projectId, environmentId: observed.environmentId,
        deploymentId: pinned.deploymentId }, signal: custody.signal });
      await check();
      const d = data?.deployment;
      need(data?.environment?.id === observed.environmentId && data.environment.projectId === observed.projectId
        && d?.id === pinned.deploymentId && d.serviceId === pinned.serviceId && d.projectId === observed.projectId
        && d.environmentId === observed.environmentId && d.deploymentStopped === true
        && ["SUCCESS", "REMOVED", "CRASHED", "FAILED"].includes(d.status) && Array.isArray(d.instances)
        && d.instances.every(value => ID.test(value.id) && ["CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"].includes(value.status)),
      "SOURCE_REDIS_DEPLOYMENT_NOT_FENCED");
      identities.push({ role, serviceId: pinned.serviceId, deploymentId: pinned.deploymentId });
    }
    await check();
    return { complete: true, domain: initial.domain, intentSha256: initial.intentSha256,
      sourceFenceSha256: fence.evidenceSha256, bindingSha256, runtimeBaselineSha256: hash(health), services: identities };
  } catch (error) {
    if (/^SOURCE_REDIS_[A-Z_]+$/.test(error?.message ?? "")) throw error;
    throw new Error("SOURCE_REDIS_RUNTIME_UNPROVEN");
  }
}
