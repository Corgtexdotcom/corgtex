import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { archiveEvidenceHash as hash } from "./ops-core-archive.mjs";
import { createRailwayFenceTransport } from "./railway-source-fence.mjs";

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).sort().join() === keys.split(",").sort().join();
const same = (a, b) => hash(a) === hash(b);
class SourceHealthError extends Error {}
const need = (v, code) => { if (!v) throw new SourceHealthError(code); };
export const opsCoreSourceHealthDiagnostic = e => e instanceof SourceHealthError ? e.message : null;
const QUERY = `query SourceHealth($projectId:String!,$environmentId:String!,$serviceId:String!) {
  environment(id:$environmentId,projectId:$projectId) { id projectId }
  serviceInstance(environmentId:$environmentId,serviceId:$serviceId) {
    serviceId environmentId service { id projectId }
    activeDeployments { id projectId environmentId serviceId status deploymentStopped instances { id status } }
  }
}`;

/** source.health contains precisely one active web and worker daemon; completed
 * scheduled deployments remain in writerBaseline and are never treated as ready.
 * Instance IDs are resolved freshly under the fixed deployment so a legitimate
 * restart can replace a replica. Every remote read binds that exact instance. */
export function validateOpsCoreSourceHealthPlan(value, railwayBinding) {
  const p = structuredClone(value);
  need(exact(p, "schemaVersion,projectId,environmentId,services") && p.schemaVersion === 1
    && ID.test(p.projectId) && ID.test(p.environmentId) && Array.isArray(p.services) && p.services.length === 2
    && p.services.map(s => s?.role).sort().join() === "web,worker", "SOURCE_HEALTH_PLAN_INVALID");
  for (const s of p.services) {
    need(exact(s, "role,serviceId,deploymentId,port,release") && ID.test(s.serviceId) && ID.test(s.deploymentId)
      && Number.isInteger(s.port) && s.port > 0 && s.port <= 65535
      && exact(s.release, "gitSha,imageTag,version") && /^[a-f0-9]{40}$/.test(s.release.gitSha)
      && s.release.imageTag === `sha-${s.release.gitSha}` && /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(s.release.version), "SOURCE_HEALTH_PLAN_INVALID");
  }
  need(new Set(p.services.map(s => s.serviceId)).size === 2 && new Set(p.services.map(s => s.deploymentId)).size === 2,
    "SOURCE_HEALTH_PLAN_INVALID");
  if (railwayBinding !== undefined) need(railwayBinding?.projectId === p.projectId && railwayBinding.environmentId === p.environmentId
    && Array.isArray(railwayBinding.serviceIds) && p.services.every(s => railwayBinding.serviceIds.includes(s.serviceId)), "SOURCE_HEALTH_WRITER_BINDING_CHANGED");
  return p;
}

const quote = s => `'${s.replaceAll("'", `'"'"'`)}'`;
// Runs entirely inside the selected source container. The only I/O is bounded
// loopback GET. No environment dump, application import, migration or DB write.
function remoteScript(request) {
  return `const c=${JSON.stringify(request)};
const fail=()=>{throw Error('SOURCE_HEALTH_REMOTE_UNPROVEN')};
const end=Date.now()+100000;
const bakedRead=async()=>{const fs=await import('node:fs/promises'),crypto=await import('node:crypto');const f=await fs.open('/app/release-build.json','r');try{const bytes=Buffer.alloc(4097);const n=(await f.read(bytes,0,4097,0)).bytesRead;if(n===0||n>4096)fail();const raw=bytes.subarray(0,n),identity=JSON.parse(raw.toString('utf8'));if(Object.keys(identity).sort().join(',')!=='gitSha,role,schemaVersion'||identity.schemaVersion!==1||identity.role!==c.role||identity.gitSha!==c.release.gitSha)fail();return {identity,fileSha256:crypto.createHash('sha256').update(raw).digest('hex')};}finally{await f.close();}};
const release=r=>{const runtime=r?.runtime;const baked=runtime?.gitSha===c.release.gitSha&&runtime.source==='baked'&&runtime.evidence==='baked';const legacy=runtime?.gitSha===null&&runtime.source==='missing'&&(runtime.evidence===undefined||runtime.evidence==='missing');if(!r||r.gitSha!==c.release.gitSha||r.imageTag!==c.release.imageTag||r.version!==c.release.version||r.service!==c.role||(!baked&&!legacy)||r.drift?.gitSha!==false||r.drift.imageTag!==false||r.drift.version!==false||!Array.isArray(r.drift.details)||r.drift.details.length)fail();return {...c.release,service:c.role,runtime:{gitSha:runtime.gitSha,source:runtime.source,...(runtime.evidence===undefined?{}:{evidence:runtime.evidence})},drift:{gitSha:false,imageTag:false,version:false,details:[]}};};
const read=async path=>{const url='http://127.0.0.1:'+c.port+path;const r=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(Math.max(1,Math.min(10000,end-Date.now()))),headers:{Accept:'application/json'}});if(r.url!==url||r.redirected||![200,503].includes(r.status)||!/^application\\/json(?:;|$)/i.test(r.headers.get('content-type')||''))fail();let size=0;const chunks=[];for await(const part of r.body){size+=part.length;if(size>32768)fail();chunks.push(Buffer.from(part));}return {status:r.status,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};};
try {const baked=await bakedRead();for(;;){if(Date.now()>=end)fail();const h=await read(c.role==='web'?'/api/health':'/health');const b=h.body;const r=release(b.release);let health,ready=null;
if(c.role==='web'){if(h.status!==200||b.status!=='ok'||b.service!=='web'||b.database!=='up'||b.schema!=='ready'||b.app!=='corgtex')fail();health={status:200,body:{status:'ok',service:'web',database:'up',schema:'ready',app:'corgtex',release:r}};}
else {if(h.status!==200||b.status!=='ok'||!['starting','running'].includes(b.phase)||b.lastError!==null||!Number.isSafeInteger(b.tickCount)||b.tickCount<0)fail();const rr=await read('/ready');const rb=rr.body;if(rr.status===503){if(rb.ready!==false||!['starting','running'].includes(rb.phase))fail();}else if(rb.ready!==true||rb.phase!=='running')fail();
if(rr.status===503||b.phase!=='running'||b.tickCount===0){await new Promise(r=>setTimeout(r,1000));continue;}
const tick=Date.parse(b.lastSuccessfulTickAt);if(!Number.isFinite(tick)||tick>Date.now()||Date.now()-tick>120000)fail();health={status:200,body:{status:'ok',phase:'running',tickCount:b.tickCount,lastSuccessfulTickAt:new Date(tick).toISOString(),lastError:null,release:r}};ready={status:200,body:{ready:true,phase:'running'}};}
process.stdout.write(JSON.stringify({schemaVersion:1,nonce:c.nonce,role:c.role,deploymentId:c.deploymentId,instanceId:c.instanceId,observedAt:Date.now(),buildIdentity:baked.identity,buildFileSha256:baked.fileSha256,health,ready}));break;}}
catch{process.stderr.write('SOURCE_HEALTH_REMOTE_UNPROVEN');process.exitCode=1;}`;
}

/** Railway SSH joins its remote argv. Quote the entire Node script, use explicit
 * project/environment/service/instance IDs, clear inherited Node options, cap
 * output and wall time, and suppress all raw CLI/provider errors. */
export function createRailwaySourceHealthRemoteRead({ execFileImpl = execFile } = {}) {
  return async ({ binding, service, instanceId, nonce, signal }) => {
    validateOpsCoreSourceHealthPlan(binding);
    need(binding.services.some(s => same(s, service)) && ID.test(instanceId) && HASH.test(nonce)
      && signal instanceof AbortSignal && !signal.aborted, "SOURCE_HEALTH_REMOTE_BINDING_INVALID");
    const request = { ...service, instanceId, nonce };
    const args = ["ssh", "-p", binding.projectId, "-e", binding.environmentId, "-s", service.serviceId,
      "-d", instanceId, "--", "env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "node", "--input-type=module", "-e", quote(remoteScript(request))];
    try {
      const output = await new Promise((resolve, reject) => execFileImpl("railway", args,
        { encoding: "utf8", timeout: 110000, maxBuffer: 32768, signal, shell: false },
        (error, stdout) => error ? reject(error) : resolve(stdout)));
      need(!signal.aborted && typeof output === "string" && Buffer.byteLength(output) <= 32768, "SOURCE_HEALTH_REMOTE_RESPONSE_INVALID");
      return output;
    } catch (e) { throw e instanceof SourceHealthError ? e : new SourceHealthError("SOURCE_HEALTH_REMOTE_READ_FAILED"); }
  };
}

function providerIdentity(data, p, s) {
  const v = data?.serviceInstance;
  need(data?.environment?.id === p.environmentId && data.environment.projectId === p.projectId
    && v?.serviceId === s.serviceId && v.environmentId === p.environmentId && v.service?.id === s.serviceId
    && v.service.projectId === p.projectId, "SOURCE_HEALTH_PROVIDER_BINDING_CHANGED");
  need(Array.isArray(v.activeDeployments) && v.activeDeployments.length === 1, "SOURCE_HEALTH_DEPLOYMENT_CHANGED");
  const d = v.activeDeployments[0];
  need(d.id === s.deploymentId && d.projectId === p.projectId && d.environmentId === p.environmentId
    && d.serviceId === s.serviceId && d.status === "SUCCESS" && d.deploymentStopped === false
    && Array.isArray(d.instances) && d.instances.length >= 1 && d.instances.length <= 1000
    && new Set(d.instances.map(i => i.id)).size === d.instances.length
    && d.instances.every(i => ID.test(i.id) && ["RUNNING", "CRASHED", "EXITED", "REMOVED", "SKIPPED", "STOPPED"].includes(i.status)), "SOURCE_HEALTH_DEPLOYMENT_CHANGED");
  const running = d.instances.filter(i => i.status === "RUNNING");
  need(running.length === 1, "SOURCE_HEALTH_INSTANCE_CHANGED");
  return { projectId: p.projectId, environmentId: p.environmentId, serviceId: s.serviceId,
    deploymentId: s.deploymentId, instanceId: running[0].id };
}
function releaseProjection(r, expected, role) {
  const runtime = r?.runtime;
  const baked = runtime?.gitSha === expected.gitSha && runtime.source === "baked" && runtime.evidence === "baked";
  const legacy = runtime?.gitSha === null && runtime.source === "missing" && (runtime.evidence === undefined || runtime.evidence === "missing");
  need(r?.gitSha === expected.gitSha && r.imageTag === expected.imageTag && r.version === expected.version && r.service === role
    && (baked || legacy) && r.drift?.gitSha === false && r.drift.imageTag === false && r.drift.version === false
    && Array.isArray(r.drift.details) && r.drift.details.length === 0, "SOURCE_HEALTH_RELEASE_CHANGED");
  // Preserve observed legacy metadata honestly. The separate image-baked file
  // proves commit/role; configured health tag/version must match the plan.
  return { ...expected, service: role, runtime: { gitSha: runtime.gitSha, source: runtime.source,
    ...(runtime.evidence === undefined ? {} : { evidence: runtime.evidence }) },
    drift: { gitSha: false, imageTag: false, version: false, details: [] } };
}

/** Returns the controller callback, not an observation made at construction.
 * Retained baseline is historical provenance. Every recovery call reads actual
 * current provider identity and live health; no caller-supplied receipt is fresh
 * proof. Only safe projections and hashes are retained, never raw health/errors. */
export function createOpsCoreSourceHealthObserver({ plan: input, signal, assertOwned, transport, token,
  runRemoteRead = createRailwaySourceHealthRemoteRead() }) {
  const plan = structuredClone(input), p = validateOpsCoreSourceHealthPlan(plan?.source?.health, plan?.source?.writers?.binding);
  const domain = plan.domain, intentSha256 = hash(plan), sourceHealthBindingSha256 = hash(p);
  need(plan.schemaVersion === 1 && ["core", "ops"].includes(domain) && signal instanceof AbortSignal && typeof assertOwned === "function"
    && typeof runRemoteRead === "function", "SOURCE_HEALTH_OPTIONS_INVALID");
  const send = transport ?? createRailwayFenceTransport({ token });
  return async ({ stage, baseline, writerBaseline }) => {
    try {
      const check = async () => { signal.throwIfAborted(); await assertOwned(); signal.throwIfAborted(); };
      need(["baseline", "recovery"].includes(stage) && writerBaseline?.binding?.projectId === p.projectId
        && writerBaseline.binding.environmentId === p.environmentId && same(writerBaseline.binding, plan.source.writers.binding)
        && Array.isArray(writerBaseline.services) && new Set(writerBaseline.services.map(s => s.serviceId)).size === writerBaseline.services.length,
      "SOURCE_HEALTH_BASELINE_INVALID");
      for (const s of p.services) {
        const original = writerBaseline.services.find(v => v.serviceId === s.serviceId);
        need(original && same(original.activeDeploymentIds, [s.deploymentId]) && original.deploymentIds.includes(s.deploymentId), "SOURCE_HEALTH_WRITER_CHANGED");
      }
      const writerBaselineSha256 = hash(writerBaseline);
      if (stage === "baseline") need(baseline === null, "SOURCE_HEALTH_BASELINE_INVALID");
      else {
        const { evidenceSha256, ...body } = baseline ?? {};
        need(HASH.test(evidenceSha256) && hash(body) === evidenceSha256 && baseline.schemaVersion === 1 && baseline.complete === true
          && baseline.stage === "baseline" && baseline.domain === domain && baseline.intentSha256 === intentSha256
          && baseline.sourceHealthBindingSha256 === sourceHealthBindingSha256 && baseline.writerBaselineSha256 === writerBaselineSha256
          && Array.isArray(baseline.services) && baseline.services.length === 2
          && p.services.every(s => baseline.services.some(v => v.role === s.role && v.serviceId === s.serviceId
            && v.deploymentId === s.deploymentId && same(v.release, s.release))), "SOURCE_HEALTH_BASELINE_INVALID");
      }
      const read = async s => { await check(); const data = await send({ query: QUERY,
        variables: { projectId: p.projectId, environmentId: p.environmentId, serviceId: s.serviceId }, signal }); await check(); return providerIdentity(data, p, s); };
      const services = [];
      for (const s of p.services) {
        const identity = await read(s), nonce = randomBytes(32).toString("hex"), started = Date.now();
        await check(); const stdout = await runRemoteRead({ binding: p, service: s, instanceId: identity.instanceId, nonce, signal }); await check();
        need(typeof stdout === "string" && Buffer.byteLength(stdout) <= 32768, "SOURCE_HEALTH_REMOTE_RESPONSE_INVALID");
        const r = JSON.parse(stdout);
        need(r.schemaVersion === 1 && r.nonce === nonce && r.role === s.role && r.deploymentId === s.deploymentId
          && r.instanceId === identity.instanceId && Number.isSafeInteger(r.observedAt) && r.observedAt >= started
          && r.observedAt <= Date.now() && Date.now() - started <= 110000 && r.health?.status === 200, "SOURCE_HEALTH_REMOTE_RESPONSE_INVALID");
        need(exact(r.buildIdentity, "schemaVersion,role,gitSha") && r.buildIdentity.schemaVersion === 1
          && r.buildIdentity.role === s.role && r.buildIdentity.gitSha === s.release.gitSha && HASH.test(r.buildFileSha256), "SOURCE_HEALTH_BUILD_CHANGED");
        if (stage === "recovery") need(baseline.services.find(v => v.role === s.role)?.buildFileSha256 === r.buildFileSha256, "SOURCE_HEALTH_BUILD_CHANGED");
        const release = releaseProjection(r.health.body?.release, s.release, s.role);
        let projection;
        if (s.role === "worker") {
          need(r.ready?.status === 200, "SOURCE_HEALTH_WORKER_UNREADY");
          const b = r.health.body, ready = r.ready.body, tick = Date.parse(b.lastSuccessfulTickAt);
          need(b.status === "ok" && b.phase === "running" && b.lastError === null && Number.isSafeInteger(b.tickCount) && b.tickCount > 0
            && Number.isFinite(tick) && tick <= r.observedAt && r.observedAt - tick <= 120000 && ready?.ready === true && ready.phase === "running",
          "SOURCE_HEALTH_WORKER_UNREADY");
          projection = { health: { status: 200, body: { status: "ok", phase: "running", lastError: null, tickCount: b.tickCount,
            lastSuccessfulTickAt: new Date(tick).toISOString(), release } }, ready: { status: 200, body: { ready: true, phase: "running" } } };
        } else {
          const b = r.health.body;
          need(b.status === "ok" && b.service === "web" && b.database === "up" && b.schema === "ready" && b.app === "corgtex" && r.ready === null,
            "SOURCE_HEALTH_WEB_UNREADY");
          projection = { health: { status: 200, body: { status: "ok", service: "web", database: "up", schema: "ready", app: "corgtex", release } }, ready: null };
        }
        need(same(await read(s), identity), "SOURCE_HEALTH_INSTANCE_CHANGED");
        services.push({ role: s.role, ...identity, release: s.release, observedAt: r.observedAt,
          buildIdentity: r.buildIdentity, buildFileSha256: r.buildFileSha256,
          releaseProvenance: { commitAndRole: "/app/release-build.json", tagAndVersion: "configured-health-concordant",
            healthRuntime: release.runtime.source === "missing" ? "legacy-missing" : "baked" }, ...projection });
      }
      // Also recheck both bindings after the pair; the first service must not
      // silently redeploy while the second service is being observed.
      for (const s of p.services) need(same(await read(s), Object.fromEntries(["projectId", "environmentId", "serviceId", "deploymentId", "instanceId"].map(k => [k, services.find(v => v.role === s.role)[k]]))), "SOURCE_HEALTH_INSTANCE_CHANGED");
      await check();
      const proof = { schemaVersion: 1, type: "OPS_CORE_SOURCE_HEALTH", complete: true, stage, domain, intentSha256,
        sourceHealthBindingSha256, writerBaselineSha256, baselineEvidenceSha256: baseline?.evidenceSha256 ?? null,
        observedAt: Date.now(), services };
      return { ...proof, evidenceSha256: hash(proof) };
    } catch (e) { throw e instanceof SourceHealthError ? e : new SourceHealthError("SOURCE_HEALTH_UNPROVEN"); }
  };
}
