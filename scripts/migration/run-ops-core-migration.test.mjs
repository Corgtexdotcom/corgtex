import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUTOVER_PHASES } from "./ops-core-custody.mjs";
import { createHash, randomUUID } from "node:crypto";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { readPrivateMigrationJson, runOpsCoreMigration, fetchWebActivationHealth } from "./run-ops-core-migration.mjs";

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const domain = "core"; const base = "/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/fixture/providers/";
  const azure = { domain, subscriptionId: "00000000-0000-4000-8000-000000000001", resourceGroupName: "fixture",
    environmentId: `${base}Microsoft.App/managedEnvironments/fixture`, apps: { web: "fixture-web", worker: "fixture-worker" },
    postgres: { resourceId: `${base}Microsoft.DBforPostgreSQL/flexibleServers/fixture`, host: "fixture.postgres.database.azure.com",
      major: 18, privateEndpointId: `${base}Microsoft.Network/privateEndpoints/postgres` },
    redis: { resourceId: `${base}Microsoft.Cache/redisEnterprise/fixture`, databaseId: `${base}Microsoft.Cache/redisEnterprise/fixture/databases/default`,
      host: "fixture.westus3.redis.azure.net", port: 10000, privateEndpointId: `${base}Microsoft.Network/privateEndpoints/redis` } };
  const image = `fixture.azurecr.io/corgtex/worker@sha256:${"b".repeat(64)}`;
  const release = { gitSha: "c".repeat(40), imageTag: `sha-${"c".repeat(40)}`, version: "fixture-1" };
  const identity = `${base}Microsoft.ManagedIdentity/userAssignedIdentities/fixture`;
  const role = name => ({ image: image.replace("/worker@", `/${name}@`),
    env: [{ name: "DATABASE_URL", secretRef: "database" }, { name: "REDIS_URL", secretRef: "redis" }],
    secrets: ["database", "redis"].map(key => ({ name: key, keyVaultUrl: `https://fixture.vault.azure.net/secrets/${key}/${"a".repeat(32)}`, identity })) });
  const sourceConnection = { host: "source.local", port: 5432, database: "railway", user: "postgres" };
  const targetRedis = { mode: "azure-enterprise-proxy", resourceId: azure.redis.databaseId,
    server: { version: "7.4.0", runId: null }, connection: { host: azure.redis.host, port: 10000, database: 0, username: "default", tls: true } };
  const job = { environmentResourceId: azure.environmentId, infrastructureSubnetId: `${base}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,
    workspaceId: "00000000-0000-4000-8000-000000000004", identityResourceId: identity, image, probeSha256: "d".repeat(64), location: "westus3" };
  const plan = { schemaVersion: 1, domain, azure,
    source: { postgres: { expected: { connection: sourceConnection, readerRole: "reader" } } },
    activation: { schemaVersion: 1, target: structuredClone(azure), release, roles: { web: role("web"), worker: role("worker") },
      location: "westus3", managedIdentityId: identity, managedIdentityClientId: "00000000-0000-4000-8000-000000000003",
      runtimeVaultUri: "https://fixture.vault.azure.net/", acrServer: "fixture.azurecr.io" },
    redis: { source: { mode: "standalone", resourceId: null, server: { version: "8.2.9", runId: "a".repeat(40) },
      connection: { host: "source.local", port: 6379, database: 0, username: "default", tls: false } }, target: targetRedis,
      job: { ...job, target: targetRedis, jobResourceId: `${base}Microsoft.App/jobs/fixture-redis`,
        redisSecretVersion: `https://fixture.vault.azure.net/secrets/redis/${"a".repeat(32)}` } },
    health: { worker: { appId: `${base}Microsoft.App/containerApps/fixture-worker`,
      origin: "https://fixture-worker.internal.environment.westus3.azurecontainerapps.io", image, release },
      jobResourceId: `${base}Microsoft.App/jobs/fixture-health`, environmentResourceId: azure.environmentId,
      infrastructureSubnetId: `${base}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,
      workspaceId: "00000000-0000-4000-8000-000000000004", identityResourceId: `${base}Microsoft.ManagedIdentity/userAssignedIdentities/fixture`,
      image, probeSha256: "d".repeat(64), location: "westus3" },
    transfer: { postgres: { source: { ...sourceConnection, user: "reader" },
      target: { host: azure.postgres.host, port: 5432, database: "postgres", user: "target_admin" },
      scratchName: "corgtex_rehearsal_10_1_core", targetIdentity: "fixture", archiveStoreId: "archive-fixture",
      keyVersion: `https://fixture.vault.azure.net/secrets/archive/${"a".repeat(32)}`, vaultName: "fixture", maxArchiveBytes: 10000 },
    objects: { sourceStoreId: "source-fixture", targetStoreId: "target-fixture",
      limits: { maxPages: 2, maxObjects: 5, maxObjectBytes: 100, maxTotalBytes: 500 } } }, operator: {
      custodyContainerUrl: "https://fixturecustody.blob.core.windows.net/custody",
      archiveContainerUrl: "https://fixturecustody.blob.core.windows.net/archives",
      targetObjectContainerUrl: "https://fixtureobjects.blob.core.windows.net/objects",
      sourceObjects: { identity: "source-fixture", endpoint: "https://t3.storageapi.dev", bucket: "fixture" },
      azureIdentity: { subscriptionId: azure.subscriptionId, tenantId: "00000000-0000-4000-8000-000000000002", principalName: "fixture@example.test" } } };
  plan.transfer.postgres.archiveStoreId = createHash("sha256").update(plan.operator.archiveContainerUrl).digest("hex");
  plan.transfer.objects.targetStoreId = createHash("sha256").update(plan.operator.targetObjectContainerUrl).digest("hex");
  const blobs = new Map(); let writes = 0; let releases = 0;
  const containerFactory = url => ({ url,
    async getAccessPolicy() { return {}; },
    getBlockBlobClient(key) {
      return {
        getBlobLeaseClient() {
          const leaseId = randomUUID();
          return { async acquireLease() { const row = blobs.get(key); expect(row.lease).toBeNull(); row.lease = leaseId; return { leaseId }; },
            async renewLease() { expect(blobs.get(key).lease).toBe(leaseId); },
            async releaseLease() { expect(blobs.get(key).lease).toBe(leaseId); blobs.get(key).lease = null; releases++; } };
        },
        async upload(text, bytes, { conditions }) {
          const old = blobs.get(key);
          if (conditions.ifNoneMatch) expect(old).toBeUndefined();
          else { expect(old.etag).toBe(conditions.ifMatch); expect(old.lease).toBe(conditions.leaseId); }
          expect(Buffer.byteLength(text)).toBe(bytes); writes++;
          const value = { text, etag: `etag-${writes}`, lease: old?.lease ?? null }; blobs.set(key, value); return { etag: value.etag };
        },
        async download(_offset, _count, options) {
          const row = blobs.get(key); if (!row) throw { statusCode: 404, code: "BlobNotFound" };
          if (options?.conditions) expect(row.lease).toBe(options.conditions.leaseId);
          return { etag: row.etag, contentLength: Buffer.byteLength(row.text), readableStreamBody: (async function* () { yield Buffer.from(row.text); })() };
        },
      };
    },
  });
  return { plan, blobs, containerFactory, writes: () => writes, releases: () => releases,
    options: { plan, containerFactory, identityCheck: async () => {} } };
}

function stage(f, phase) {
  const index = CUTOVER_PHASES.indexOf(phase), row = f.blobs.get("cutovers/core.json");
  const journal = JSON.parse(row.text);
  journal.phase = phase; journal.sequence = index * 2; journal.pending = null;
  journal.destinationMayHaveWritten = index >= CUTOVER_PHASES.indexOf("TARGET_ACTIVATING");
  journal.history = CUTOVER_PHASES.slice(0,index+1).map(p=>({phase:p,evidenceSha256:"e".repeat(64),
    ...(p === "PREPARED" ? {} : {operationId:randomUUID(),intentSha256:archiveEvidenceHash(f.plan.activation)})}));
  row.text = JSON.stringify(journal); return journal;
}

describe("Ops/Core executable operator", () => {
  it("retains exact plan and one stable domain journal, then reopens it without effects", async () => {
    const f = fixture(); const first = await runOpsCoreMigration({ ...f.options, action: "initialize" });
    expect(first.status).toBe("PREPARED"); expect(first.destinationMayHaveWritten).toBe(false);
    expect(f.blobs.has("cutovers/core.json")).toBe(true);
    expect(f.blobs.has(`plans/core/${archiveEvidenceHash(f.plan)}.json`)).toBe(true);
    const writes = f.writes(); const current = await runOpsCoreMigration({ ...f.options, action: "status" });
    expect(current).toEqual(first); expect(f.writes()).toBe(writes); expect(f.releases()).toBe(2);
  });
  it("checks Azure identity before creating any plan or journal", async () => {
    const f = fixture();
    await expect(runOpsCoreMigration({ ...f.options, action: "initialize", identityCheck: async () => { throw new Error("private token response"); } }))
      .rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(f.writes()).toBe(0);
  });
  it("reconciles an existing exact plan before journal creation, then an uncertain initialized journal without overwrites", async () => {
    const f = fixture(); const key = `plans/core/${archiveEvidenceHash(f.plan)}.json`;
    // Simulate a process exit after retaining the plan but before journal PUT.
    f.blobs.set(key, { text: JSON.stringify(f.plan), etag: "existing-plan", lease: null });
    const state = await runOpsCoreMigration({ ...f.options, action: "initialize" });
    expect(state.status).toBe("PREPARED"); expect(f.writes()).toBe(1);
    expect(f.blobs.get(key).etag).toBe("existing-plan");
    // The initialization acknowledgement may also have been lost after PUT.
    expect(await runOpsCoreMigration({ ...f.options, action: "initialize" })).toEqual(state);
    expect(f.writes()).toBe(1);
  });
  it("rejects an activation binding different from the retained transfer target", async () => {
    const f = fixture(); f.plan.activation.target.domain = "ops";
    await expect(runOpsCoreMigration({ ...f.options, action: "initialize" })).rejects.toThrow("MIGRATION_PLAN_INVALID");
    expect(f.writes()).toBe(0);
  });
  it("rejects cross-domain plans and shared runtime/custody accounts before retaining anything", async () => {
    for (const change of [f => { f.plan.azure.domain = "ops"; f.plan.activation.target.domain = "ops"; },
      f => { f.plan.operator.custodyContainerUrl = "https://fixtureobjects.blob.core.windows.net/custody"; },
      f => { f.plan.operator.archiveContainerUrl = "https://fixtureobjects.blob.core.windows.net/archives"; }]) {
      const f = fixture(); change(f);
      await expect(runOpsCoreMigration({ ...f.options, action: "initialize" })).rejects.toThrow("MIGRATION_PLAN_INVALID");
      expect(f.writes()).toBe(0);
    }
  });
  it("validates transfer and activation static contracts before freezing the global plan", async () => {
    for (const change of [f => { f.plan.transfer.postgres.scratchName = "corgtex_core"; },
      f => { f.plan.transfer.postgres.maxArchiveBytes = 0; },
      f => { f.plan.activation.roles.web.env.push({ name: "CORGTEX_STARTUP_MODE", value: "combined" }); }]) {
      const f = fixture(); change(f);
      await expect(runOpsCoreMigration({ ...f.options, action: "initialize" })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
      expect(f.writes()).toBe(0);
    }
  });
  it("refuses modified retained plan before source effects", async () => {
    const f = fixture(); await runOpsCoreMigration({ ...f.options, action: "initialize" });
    const key = `plans/core/${archiveEvidenceHash(f.plan)}.json`;
    f.blobs.get(key).text = JSON.stringify({ ...f.plan, domain: "ops" }); let calls = 0;
    await expect(runOpsCoreMigration({ ...f.options, action: "fence", credentials: {}, runtime: { fence: () => { calls++; } } }))
      .rejects.toThrow("MIGRATION_RETAINED_PLAN_MISMATCH");
    expect(calls).toBe(0);
  });
  it("passes exact global plan and private credentials to source controller and releases custody on failure", async () => {
    const f = fixture(); await runOpsCoreMigration({ ...f.options, action: "initialize" });
    const credentials = { sourceConfig: { password: randomUUID() }, readerConfig: { password: randomUUID() }, railwayToken: randomUUID() };
    let preflight = false;
    await expect(runOpsCoreMigration({ ...f.options, action: "fence", credentials, runtime: {
      transferPreflight: async () => { preflight = true; }, fence: async options => {
      expect(preflight).toBe(true);
      expect(options.plan).toEqual(f.plan); expect(options.sourceConfig).toEqual(credentials.sourceConfig);
      expect(options.railway.token).toBe(credentials.railwayToken);
      expect(options.custody.snapshot().intentSha256).toBe(archiveEvidenceHash(f.plan));
      throw new Error(credentials.railwayToken);
    } } })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(f.releases()).toBe(2);
    expect([...f.blobs.values()].some(row => row.text.includes(credentials.railwayToken))).toBe(false);
  });
  it("a failed target preparation check leaves source fencing untouched", async () => {
    const f = fixture(); await runOpsCoreMigration({ ...f.options, action: "initialize" }); let called = false;
    await expect(runOpsCoreMigration({ ...f.options, action: "fence", credentials: { sourceConfig: {}, readerConfig: {} }, runtime: {
      transferPreflight: async () => { throw new Error("target not ready"); }, fence: async () => { called = true; },
    } })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(called).toBe(false); expect(JSON.parse(f.blobs.get("cutovers/core.json").text).phase).toBe("PREPARED");
  });
  it("rejects a private health probe for another worker image before journal initialization", async () => {
    const f = fixture(); f.plan.health.worker.image = f.plan.health.worker.image.replace("b".repeat(64), "e".repeat(64));
    await expect(runOpsCoreMigration({ ...f.options, action: "initialize" })).rejects.toThrow("MIGRATION_HEALTH_BINDING_MISMATCH");
    expect(f.writes()).toBe(0);
  });
  it("web health requires exact origin, JSON and bounded response without redirects", async () => {
    const origin = "https://fixture-web.environment.westus3.azurecontainerapps.io";
    const args = { role: "web", origin, signal: new AbortController().signal };
    const response = text => { const r = new Response(text, { headers: { "content-type": "application/json" } });
      Object.defineProperty(r, "url", { value: `${origin}/api/health` }); return r; };
    const value = await fetchWebActivationHealth(args, async (_url, options) => {
      expect(options.redirect).toBe("error"); return response(JSON.stringify({ status: "ok" })); });
    expect(value.health.body.status).toBe("ok");
    await expect(fetchWebActivationHealth(args, async () => response("a".repeat(32769)))).rejects.toThrow("MIGRATION_WEB_HEALTH_TOO_LARGE");
    await expect(fetchWebActivationHealth({ ...args, origin: "https://foreign.invalid" })).rejects.toThrow("MIGRATION_HEALTH_ORIGIN_INVALID");
  });
  it("reads owned private input and rejects public permissions and symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ops-core-operator-")); directories.push(directory);
    const path = join(directory, "input.json"); await writeFile(path, JSON.stringify({ synthetic: true }), { mode: 0o600 });
    expect(await readPrivateMigrationJson(path)).toEqual({ synthetic: true });
    const link = join(directory, "link.json"); await symlink(path, link);
    await expect(readPrivateMigrationJson(link)).rejects.toThrow("MIGRATION_INPUT_INVALID");
    await chmod(path, 0o644); await expect(readPrivateMigrationJson(path)).rejects.toThrow("MIGRATION_INPUT_NOT_PRIVATE");
  });
  it("dispatches explicit transfer reconcile/resume under the same retained global plan", async () => {
    const f=fixture(); await runOpsCoreMigration({...f.options,action:"initialize"});
    const directory=await mkdtemp(join(tmpdir(),"ops-core-dispatch-")); directories.push(directory);
    for(const [action,method] of [["reconcile-transfer","reconcileTransfer"],["resume-transfer","resumeTransfer"]]) {
      let calls=0;
      const result=await runOpsCoreMigration({...f.options,action,artifactDir:directory,
        credentials:{sourceConfig:{},readerConfig:{},objectSource:{accessKeyId:randomUUID(),secretAccessKey:randomUUID()}},runtime:{[method]:async options=>{
          calls++;expect(options.plan).toEqual(f.plan);expect(options.operationStore).toBeDefined();
          return {status:"INCOMPLETE_EFFECTS",complete:false};
        }}});
      expect(calls).toBe(1);expect(result.complete).toBe(false);
    }
  });
  it("reconciliation after committed activation uses the actual acceptance-mode health dispatcher", async () => {
    const f=fixture();await runOpsCoreMigration({...f.options,action:"initialize"});stage(f,"TARGET_ACTIVATING");
    let reachedTransport=false;
    await expect(runOpsCoreMigration({...f.options,action:"reconcile-activate",credentials:{sourceConfig:{},readerConfig:{}},
      runtime:{assertSource:async()=>({domain:"core",intentSha256:archiveEvidenceHash(f.plan),railway:{complete:true}}),
        healthTransport:async()=>{reachedTransport=true;throw Error("fixture stop before provider effect");},
        activate:options=>({reconcile:async()=>{
          await options.custody.begin("TARGET_ACTIVE",archiveEvidenceHash(f.plan.activation));
          return options.healthProbe({role:"worker",origin:f.plan.health.worker.origin,appId:f.plan.health.worker.appId,
            revisionName:"fixture-worker--boot-fixture",release:f.plan.activation.release,invocationContext:"worker-final",
            signal:options.custody.signal});
        }})}})).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(reachedTransport).toBe(true);
  });
  it("retains acceptance evidence in independent custody and binds it to the exact migration", async () => {
    const f=fixture();await runOpsCoreMigration({...f.options,action:"initialize"});const j=stage(f,"TARGET_ACTIVE");
    const artifact={schemaVersion:1,binding:{domain:"core",intentSha256:archiveEvidenceHash(f.plan),
      targetBindingSha256:archiveEvidenceHash(f.plan.azure),release:structuredClone(f.plan.activation.release),
      sourceFenceSha256:j.history.find(x=>x.phase==="SOURCE_FENCED").evidenceSha256,
      routes:["app","mcp"].map(name=>({publicOrigin:`https://${name}.corgtex.com`,
        azureOrigin:"https://fixture-web.environment.westus3.azurecontainerapps.io",
        expectedCname:"fixture-web.environment.westus3.azurecontainerapps.io"}))},
      kind:"workflow",details:{result:"fixture"}};
    const opts={...f.options,action:"retain-acceptance-evidence",credentials:{sourceConfig:{},readerConfig:{}},acceptanceArtifact:artifact};
    const result=await runOpsCoreMigration(opts);expect(result.status).toBe("EVIDENCE_RETAINED");
    expect(f.blobs.has(`acceptance/core/${archiveEvidenceHash(f.plan)}/${archiveEvidenceHash(artifact)}.json`)).toBe(true);
    const writes=f.writes();await runOpsCoreMigration(opts);expect(f.writes()).toBe(writes);
    artifact.binding.release.version="foreign";
    await expect(runOpsCoreMigration(opts)).rejects.toThrow("MIGRATION_ACCEPTANCE_BINDING_MISMATCH");
  });

});
