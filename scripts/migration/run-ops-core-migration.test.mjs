import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUTOVER_PHASES } from "./ops-core-custody.mjs";
import { createHash, randomUUID } from "node:crypto";
import { azureProviderOperationStore } from "./ops-core-provider-operations.mjs";
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
    resources: { cpu: 0.5, memory: "1Gi" },
    env: [{ name: "DATABASE_URL", secretRef: "database" }, { name: "REDIS_URL", secretRef: "redis" }],
    secrets: ["database", "redis"].map(key => ({ name: key, keyVaultUrl: `https://fixture.vault.azure.net/secrets/${key}/${"a".repeat(32)}`, identity })) });
  const sourceConnection = { host: "source.local", port: 5432, database: "railway", user: "postgres" };
  const targetRedis = { mode: "azure-enterprise-proxy", resourceId: azure.redis.databaseId,
    server: { version: "7.4.0", runId: null }, connection: { host: azure.redis.host, port: 10000, database: 0, username: "default", tls: true } };
  const job = { environmentResourceId: azure.environmentId, infrastructureSubnetId: `${base}Microsoft.Network/virtualNetworks/fixture/subnets/apps`,
    workspaceId: "00000000-0000-4000-8000-000000000004", identityResourceId: identity, image, probeSha256: "d".repeat(64), location: "westus3" };
  const plan = { schemaVersion: 1, domain, azure,
    source: {
      writers: { binding: { projectId: "00000000-0000-4000-8000-000000000010",
        environmentId: "00000000-0000-4000-8000-000000000011",
        serviceIds: ["00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000013"] } },
      health: { schemaVersion: 1, projectId: "00000000-0000-4000-8000-000000000010",
        environmentId: "00000000-0000-4000-8000-000000000011",
        services: ["web", "worker"].map((role, index) => ({ role,
          serviceId: `00000000-0000-4000-8000-00000000001${index + 2}`,
          deploymentId: `00000000-0000-4000-8000-00000000002${index + 2}`,
          port: role === "web" ? 3000 : 9090, release: structuredClone(release) })) },
      postgres: { expected: { connection: sourceConnection, readerRole: "reader" }, vaultName: "fixture-custody",
      originalSecretVersion: `https://fixture-custody.vault.azure.net/secrets/original/${"1".repeat(32)}`,
      retainedSecretVersion: `https://fixture-custody.vault.azure.net/secrets/recovery/${"2".repeat(32)}` } },
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

function postgresVariant(plan) {
  plan.schemaVersion = 2;
  plan.sharedState = { backend: "postgres", sourceRedis: structuredClone(plan.redis.source) };
  delete plan.redis;
  plan.azure.sharedStateBackend = "postgres";
  plan.azure.redis = null;
  plan.activation.target = structuredClone(plan.azure);
  for (const role of Object.values(plan.activation.roles)) {
    role.env = role.env.filter(entry => entry.name !== "REDIS_URL");
    role.env.push({ name: "SHARED_STATE_BACKEND", value: "postgres" });
    role.secrets = role.secrets.filter(entry => entry.name !== "redis");
  }
}

function azureAccessVariant(plan) {
  postgresVariant(plan);
  plan.azure.postgres.resourceGroupName = plan.azure.resourceGroupName;
  plan.activation.target = structuredClone(plan.azure);
  plan.activation.schemaVersion = 2;
  const vault = plan.activation.runtimeVaultUri, identity = plan.activation.managedIdentityId;
  const secret = name => `${vault}secrets/${name}/${"a".repeat(32)}`;
  const policy = { schemaVersion: 2, providerProfile: "azure-flexible-postgres-18",
    runtimeRole: "corgtex_core_runtime", applicationSchema: "public",
    runtimeDatabaseSecrets: { web: secret("core-web"), worker: secret("core-worker") },
    scaler: { role: "worker_scale_core", connectionSecretVersion: secret("core-scaler") },
    isolation: { inventorySha256: "a".repeat(64), databases: [
      { name: "postgres", oid: "5", owner: "target_admin", action: "replace-public-connect",
        beforeAclSha256: "b".repeat(64), preserveConnectRoles: [] },
      { name: "azure_sys", oid: "6", owner: "azuresu", action: "allow-provider-connect",
        beforeAclSha256: "c".repeat(64), preserveConnectRoles: [] },
    ] } };
  plan.transfer.postgres.runtimeAccess = policy;
  plan.activation.runtimeAccess = policy;
  plan.activation.workerDemand = { schedulerJobName: "core-scheduler", schedulerCadenceMinutes: 5,
    schedulerResources: { cpu: 0.5, memory: "1Gi" },
    scalerConnectionSecret: { name: "worker-scaler-connection", keyVaultUrl: policy.scaler.connectionSecretVersion, identity } };
  for (const role of ["web", "worker"])
    plan.activation.roles[role].secrets.find(entry => entry.name === "database").keyVaultUrl = policy.runtimeDatabaseSecrets[role];
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
  it.each(["missing", "mutable", "wrong-vault", "same-version"])("rejects %s original recovery-secret binding before initialization", async kind => {
    const f=fixture(), pg=f.plan.source.postgres;
    if(kind==="missing") delete pg.originalSecretVersion;
    if(kind==="mutable") pg.originalSecretVersion="https://fixture-custody.vault.azure.net/secrets/original";
    if(kind==="wrong-vault") pg.originalSecretVersion=pg.originalSecretVersion.replace("fixture-custody", "foreign-vault");
    if(kind==="same-version") pg.originalSecretVersion=pg.retainedSecretVersion;
    await expect(runOpsCoreMigration({...f.options,action:"initialize"})).rejects.toThrow(/MIGRATION_/);
    expect(f.writes()).toBe(0);
  });
  it("initializes and reopens a PostgreSQL v2 plan through the real operator validator", async () => {
    const f = fixture(); postgresVariant(f.plan);
    const first = await runOpsCoreMigration({ ...f.options, action: "initialize" });
    expect(first.status).toBe("PREPARED");
    expect(f.blobs.has(`plans/core/${archiveEvidenceHash(f.plan)}.json`)).toBe(true);
    const writes = f.writes();
    expect(await runOpsCoreMigration({ ...f.options, action: "status" })).toEqual(first);
    expect(f.writes()).toBe(writes);
    f.plan.redis = {};
    await expect(runOpsCoreMigration({ ...f.options, action: "status" })).rejects.toThrow();
    expect(f.writes()).toBe(writes);
  });
  it("checks Azure identity before creating any plan or journal", async () => {
    const f = fixture();
    await expect(runOpsCoreMigration({ ...f.options, action: "initialize", identityCheck: async () => { throw new Error("private token response"); } }))
      .rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(f.writes()).toBe(0);
  });
  it.each(["missing", "foreign-environment", "foreign-service", "duplicate-role"])("rejects %s source health before retaining a plan", async kind => {
    const f = fixture();
    if (kind === "missing") delete f.plan.source.health;
    if (kind === "foreign-environment") f.plan.source.health.environmentId = randomUUID();
    if (kind === "foreign-service") f.plan.source.health.services[0].serviceId = randomUUID();
    if (kind === "duplicate-role") f.plan.source.health.services[1].role = "web";
    await expect(runOpsCoreMigration({ ...f.options, action: "initialize" })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
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
    const credentials = { sourceConfig: { password: randomUUID() }, readerConfig: { password: randomUUID() }, railwayToken: randomUUID(),
      objectSource: {accessKeyId:randomUUID(),secretAccessKey:randomUUID()} };
    let preflight = false, fenced = false;
    await expect(runOpsCoreMigration({ ...f.options, action: "fence", credentials, runtime: {
      transferPreflight: async () => { preflight = true; }, fence: async options => {
      fenced = true; expect(preflight).toBe(true);
      expect(options.plan).toEqual(f.plan); expect(options.sourceConfig).toEqual(credentials.sourceConfig);
      expect(options.railway.token).toBe(credentials.railwayToken);
      expect(typeof options.assertSourceHealthy).toBe("function");
      expect(options.custody.snapshot().intentSha256).toBe(archiveEvidenceHash(f.plan));
      throw new Error(credentials.railwayToken);
    } } })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(preflight).toBe(true); expect(fenced).toBe(true); expect(f.releases()).toBe(2);
    expect([...f.blobs.values()].some(row => row.text.includes(credentials.railwayToken))).toBe(false);
  });
  it("a failed target preparation check leaves source fencing untouched", async () => {
    const f = fixture(); await runOpsCoreMigration({ ...f.options, action: "initialize" }); let called = false, checked = false;
    await expect(runOpsCoreMigration({ ...f.options, action: "fence", credentials: { sourceConfig: {}, readerConfig: {}, objectSource:{accessKeyId:randomUUID(),secretAccessKey:randomUUID()} }, runtime: {
      transferPreflight: async () => { checked = true; throw new Error("target not ready"); }, fence: async () => { called = true; },
    } })).rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(checked).toBe(true); expect(called).toBe(false); expect(JSON.parse(f.blobs.get("cutovers/core.json").text).phase).toBe("PREPARED");
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
  it("dispatches explicit source recovery and read-only reconciliation without transfer credentials", async () => {
    const f=fixture(); await runOpsCoreMigration({...f.options,action:"initialize"}); stage(f,"CAPTURED");
    for (const [action,expected] of [["recover-source","apply"],["reconcile-source-recovery","reconcile"]]) {
      let called=false;
      const result=await runOpsCoreMigration({...f.options,action,credentials:{sourceConfig:{},readerConfig:{}},
        runtime:{recoverSource:async options=>{called=true;expect(options.action).toBe(expected);
          expect(typeof options.assertTargetInactive).toBe("function");expect(options.plan).toEqual(f.plan);
          expect(typeof options.assertSourceHealthy).toBe("function");
          return{status:"SOURCE_RECOVERED"};}}});
      expect(called).toBe(true);expect(result.status).toBe("SOURCE_RECOVERED");
    }
    stage(f,"TARGET_ACTIVATING");let called=false;
    await expect(runOpsCoreMigration({...f.options,action:"recover-source",credentials:{sourceConfig:{},readerConfig:{}},
      runtime:{recoverSource:async()=>{called=true;}}})).rejects.toThrow("MIGRATION_SOURCE_RECOVERY_FORBIDDEN");
    expect(called).toBe(false);
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

  it("runs Azure access monitoring after activation without source credentials and gates acceptance", async () => {
    const f = fixture(); azureAccessVariant(f.plan);
    await runOpsCoreMigration({ ...f.options, action: "initialize" });
    stage(f, "TARGET_ACTIVE");
    const calls = [];
    const monitor = async () => { calls.push("monitor"); return { complete: true, domain: "core", profileSha256: "d".repeat(64) }; };
    const monitored = await runOpsCoreMigration({ ...f.options, action: "monitor-access",
      credentials: { targetAdminConfig: {} }, runtime: { monitorAccess: monitor } });
    expect(monitored.status).toBe("ACCESS_MONITORED");
    expect(monitored.complete).toBe(true);
    expect(calls).toEqual(["monitor"]);
    const j = stage(f, "ROUTED");
    const artifact = { binding: { domain: "core", intentSha256: archiveEvidenceHash(f.plan),
      targetBindingSha256: archiveEvidenceHash(f.plan.azure), release: structuredClone(f.plan.activation.release),
      sourceFenceSha256: j.history.find(entry => entry.phase === "SOURCE_FENCED").evidenceSha256,
      routes: ["app", "mcp"].map(name => ({ publicOrigin: `https://${name}.corgtex.com`,
        azureOrigin: "https://fixture-web.environment.westus3.azurecontainerapps.io",
        expectedCname: "fixture-web.environment.westus3.azurecontainerapps.io" })) } };
    await runOpsCoreMigration({ ...f.options, action: "accept", acceptanceArtifact: artifact,
      credentials: { sourceConfig: {}, readerConfig: {}, targetAdminConfig: {} },
      runtime: { monitorAccess: monitor, acceptance: async () => { calls.push("accept"); return { phase: "ACCEPTED" }; } } });
    expect(calls).toEqual(["monitor", "monitor", "accept"]);
    await expect(runOpsCoreMigration({ ...f.options, action: "accept", acceptanceArtifact: artifact,
      credentials: { sourceConfig: {}, readerConfig: {}, targetAdminConfig: {} },
      runtime: { monitorAccess: async () => { throw Error("drift"); }, acceptance: async () => { calls.push("bad-accept"); } } }))
      .rejects.toThrow("MIGRATION_RECONCILIATION_REQUIRED");
    expect(calls).not.toContain("bad-accept");
  });

});

describe("live transfer dependency admission before source fencing", () => {
  async function setup() {
    const f = fixture();
    const { runOpsCoreTransferPreflight, preflightTargetPostgres } = await import("./ops-core-preflight.mjs");
    const { buildRedisProbeJobDefinition } = await import("./ops-core-redis-job.mjs");
    const { buildHealthProbeJobDefinition } = await import("./ops-core-health-job.mjs");
    const calls = [], controller = new AbortController();
    const state = { phase: "PREPARED", pending: null, domain: "core", intentSha256: archiveEvidenceHash(f.plan), destinationMayHaveWritten: false };
    const custody = { signal: controller.signal, snapshot: () => structuredClone(state), assertOwned: async () => {} };
    const key = Buffer.alloc(32, 7);
    const config = { ...f.plan.transfer.postgres.target, password: "ephemeral-fixture", sslmode: "verify-full", targetTlsRootCert: "fixture-root" };
    let pgResult = { database: config.database, role: config.user, version: 180006, recovering: false, can_create_database: true };
    const client = { async connect() { calls.push("postgres-connect"); }, async end() { calls.push("postgres-close"); },
      async query(sql) {
        calls.push(sql);
        if (sql === "SHOW transaction_read_only") return { rows: [{ transaction_read_only: "on" }] };
        if (sql.startsWith("SELECT current_database")) return { rows: [pgResult] };
        return { rows: [] };
      } };
    const object = Buffer.from("fixture object");
    const source = { identity: f.plan.transfer.objects.sourceStoreId, async assertPrivate() {},
      async inventory() { calls.push("objects-inventory"); return [{ key: "object", etag: "etag", bytes: object.length }]; },
      async read() { calls.push("objects-read"); return { etag: "etag", bytes: object.length, body: (async function* () { yield object; })() }; } };
    const transport = p => async ({method,path,body}) => {
      calls.push({method,path,body});
      if (path.endsWith("/query")) return { status: 200, body: { tables: [{ columns: [{ name: "preflight", type: "long" }], rows: [[1]] }] } };
      if (path.startsWith(p.jobResourceId + "?")) {
        const definition = p.worker ? buildHealthProbeJobDefinition(p) : buildRedisProbeJobDefinition(p);
        return { status: 200, body: { id: p.jobResourceId, ...definition, properties: { ...definition.properties, provisioningState: "Succeeded" } } };
      }
      if (path.startsWith(p.environmentResourceId + "?")) return { status: 200, body: { id: p.environmentResourceId,
        properties: { provisioningState: "Succeeded", defaultDomain: "environment.westus3.azurecontainerapps.io",
          vnetConfiguration: { infrastructureSubnetId: p.infrastructureSubnetId }, appLogsConfiguration: { destination: "log-analytics",
            logAnalyticsConfiguration: { customerId: p.workspaceId } } } } };
      throw Error("unexpected provider write");
    };
    // Use the production adapter so key-path and create-only restrictions apply.
    const operationStore = azureProviderOperationStore(f.containerFactory(f.plan.operator.custodyContainerUrl));
    const options = { plan: f.plan, custody, operationStore, targetAdminConfig: config, objectSource: source,
      sourceCredentials: { readerConfig: { ...f.plan.transfer.postgres.source, sslmode: "require", sourceTlsRootCert: "fixture-root" } },
      archiveStore: { identity: f.plan.transfer.postgres.archiveStoreId, async assertPrivate() {} },
      objectTarget: { identity: f.plan.transfer.objects.targetStoreId, async assertPrivate() {} } };
    const dependencies = { sourcePreflight: async () => {calls.push("source-admission");return {complete:true};}, clientFactory: settings => { expect(settings.ssl.rejectUnauthorized).toBe(true); return client; },
      resolveKey: async () => { calls.push("archive-key"); return key; },
      redisTransport: transport(f.plan.redis.job), healthTransport: transport(f.plan.health),
      contextFactory: () => ({ plan: f.plan, async check() { controller.signal.throwIfAborted(); await custody.assertOwned(); },
        async assertTargetInactive() { calls.push("target-inactive"); return { complete: true }; } }) };
    return { f, options, dependencies, calls, state, controller, client, key, source,
      setPgResult: row => { pgResult = row; },
      run: () => runOpsCoreTransferPreflight(options, dependencies), preflightTargetPostgres };
  }

  it("proves TLS SQL auth, key access, bounded object reads and exact probe/log bindings with no runtime writes", async () => {
    const f = await setup(), before = structuredClone(f.state); const result = await f.run();
    expect(result.status).toBe("PREFLIGHT_READY"); expect(result.evidence.finalAcceptance).toBe(false);
    expect(result.evidence.objects.readObjects).toBe(1); expect(result.evidence.postgres.readOnly).toBe(true);
    expect(f.key.every(byte => byte === 0)).toBe(true); expect(f.state).toEqual(before);
    expect(f.calls.filter(value => typeof value === "object").every(call => call.method === "GET"
      || call.method === "POST" && call.path.endsWith("/query") && call.body.query === "print preflight = 1")).toBe(true);
    expect(f.calls.filter(value => typeof value === "string" && /^(ALTER|CREATE|DROP|UPDATE|INSERT)/.test(value))).toEqual([]);
  });

  it("preflights PostgreSQL v2 without a Redis job while preserving all remaining admission checks", async () => {
    const f = await setup(); postgresVariant(f.f.plan);
    f.state.intentSha256 = archiveEvidenceHash(f.f.plan);
    f.dependencies.redisTransport = async () => { throw Error("No Redis job is permitted"); };
    const result = await f.run();
    expect(result.status).toBe("PREFLIGHT_READY");
    expect(result.evidence.sharedState).toMatchObject({ backend: "postgres", finalAcceptance: false });
    expect(Object.hasOwn(result.evidence, "redis")).toBe(false);
    expect(result.evidence.sourceAdmission).toMatchObject({ fresh: true, proof: { complete: true } });
    expect(result.evidence.postgres).toMatchObject({ readOnly: true, tlsVerified: true });
    expect(result.evidence.objects.readObjects).toBe(1);
    expect(result.evidence.health).toBeDefined();
    expect(f.calls).toContain("source-admission");
    expect(f.calls).toContain("archive-key");
    expect(f.calls.filter(call => typeof call === "object").some(call => call.path.includes("fixture-redis"))).toBe(false);
    expect(f.key.every(byte => byte === 0)).toBe(true);
    expect(f.state.phase).toBe("PREPARED");
  });

  it.each(["source", "postgres", "archive", "object-list", "object-read", "redis-job", "health-logs", "lease", "target-written"])(
    "rejects unavailable %s before source fencing or any target write", async dependency => {
      const f = await setup();
      if (dependency === "source") f.dependencies.sourcePreflight = async () => {throw Error("private source response");};
      if (dependency === "postgres") f.client.connect = async () => { throw Error("private connection credentials"); };
      if (dependency === "archive") f.dependencies.resolveKey = async () => { throw Error("private vault response"); };
      if (dependency === "object-list") f.source.inventory = async () => { throw Error("private bucket response"); };
      if (dependency === "object-read") f.source.read = async () => null;
      if (dependency === "redis-job") f.dependencies.redisTransport = async () => ({status:404,body:null});
      if (dependency === "health-logs") {
        const transport = f.dependencies.healthTransport;
        f.dependencies.healthTransport = request => request.path.endsWith("/query") ? {status:403,body:{error:"private"}} : transport(request);
      }
      if (dependency === "lease") f.options.custody.assertOwned = async () => { throw Error("lease lost"); };
      if (dependency === "target-written") f.state.destinationMayHaveWritten = true;
      await expect(f.run()).rejects.toThrow(/PREFLIGHT_/);
      expect(f.state.phase).toBe("PREPARED");
      expect(f.calls.some(value => typeof value === "object" && value.path.includes("/start"))).toBe(false);
      if (!["source", "postgres", "archive", "lease", "target-written"].includes(dependency)) expect(f.key.every(byte => byte === 0)).toBe(true);
    });

  it.each(["role", "version", "recovering", "can_create_database"])("rejects PostgreSQL %s drift through actual read-only query path", async field => {
    const f = await setup(); f.setPgResult({ database: "postgres", role: field === "role" ? "foreign" : "target_admin",
      version: field === "version" ? 170000 : 180006, recovering: field === "recovering", can_create_database: field !== "can_create_database" });
    await expect(f.run()).rejects.toThrow("PREFLIGHT_POSTGRES_IDENTITY_UNPROVEN");
    expect(f.calls).toContain("postgres-close"); expect(f.calls).not.toContain("archive-key");
  });
});
