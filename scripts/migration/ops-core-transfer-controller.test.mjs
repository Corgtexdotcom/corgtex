import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveEvidenceHash } from "./ops-core-archive.mjs";
import { createCutoverJournal, openCutoverCustody } from "./ops-core-custody.mjs";
import { opsCoreAzureTargetBindingSha256 } from "./ops-core-azure-target.mjs";
import { redisGateBindingSha256 } from "./ops-core-redis-gate.mjs";
import { runOpsCoreDataTransfer, resumeOpsCoreDataTransfer, reconcileOpsCoreDataTransfer, validateOpsCoreTransferPlan } from "./ops-core-transfer-controller.mjs";

const shared = vi.hoisted(() => ({ current: null }));
vi.mock("./ops-core-source-controller.mjs", () => ({ assertOpsCoreSourceFenced: vi.fn(async ({ plan }) => ({
  schemaVersion: 1, domain: plan.domain, intentSha256: shared.current.intentHash,
  railway: { complete: shared.current.sourceComplete }, postgres: { synthetic: true },
})) }));
vi.mock("./ops-core-azure-target.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, createOpsCoreAzureTarget: ({ binding }) => ({
    async assertInactive() { return { complete: shared.current.targetComplete, domain: binding.domain,
      intentSha256: shared.current.intentHash, targetBindingSha256: original.opsCoreAzureTargetBindingSha256(binding) }; },
    async assertEnterpriseBinding() { return { complete: true }; },
  }) };
});
vi.mock("./ops-core-postgres-copy.mjs", () => ({
  runOpsCorePostgresCopy: vi.fn(options => syntheticCopy(options, "copy")),
  resumeOpsCorePostgresCopy: vi.fn(options => syntheticCopy(options, "resume-copy")),
}));
vi.mock("./ops-core-postgres-reconcile.mjs", () => ({ reconcileOpsCorePostgresCopy: vi.fn(async options => {
  shared.current.events.push("reconcile-copy");
  if (shared.current.copyIncomplete) return { complete: false, status: "INCOMPLETE" };
  const j = options.custody.snapshot();
  if (j.pending?.to === "CAPTURED") { await options.custody.complete(j.pending.operationId, "a".repeat(64)); return { complete: true, phase: "CAPTURED", nextAction: "RESTORE_RETAINED_ARCHIVE" }; }
  if (j.phase === "CAPTURED" && !j.pending) return { complete: true, phase: "CAPTURED", nextAction: "RESTORE_RETAINED_ARCHIVE" };
  return syntheticCopy(options, null);
}) }));
vi.mock("./run-postgres-restore-rehearsal.mjs", async importOriginal => ({ ...await importOriginal(),
  observePostgresDatabase: vi.fn(async options => {
    const f = shared.current; await options.assertCustody(); f.events.push(`observe-${options.config.database}`);
    const source = options.config.database === "railway";
    const evidence = structuredClone(f.copied.evidence[source ? "source" : "destination"]);
    if (f.sourceDrift && source || f.destinationDrift && !source) evidence.tables[0].rowSha256 = "f".repeat(64);
    return { databaseOid: source ? "16300" : f.observedOid ?? "16401", evidence, sequences: [] };
  }),
}));
vi.mock("pg", () => ({ default: { Client: class {
  constructor(config) { this.connectionParameters = config; }
  async connect() {}
  async end() { shared.current.closed++; }
  async query(sql) {
    const f = shared.current;
    if (sql.startsWith("SELECT oid::text")) return { rows: [{ oid: "16401" }] };
    if (sql.includes("current_database()")) return { rows: [{ database: "postgres", session_user: "target_admin", role_user: "target_admin" }] };
    if (sql.includes("FROM pg_catalog.pg_database")) return { rows: [{ name: f.databaseName, oid: f.databaseOid ?? "16401", owner: f.databaseOwner ?? "target_admin",
      is_template: false, connection_count: f.sessions ?? 0 }] };
    if (sql.startsWith("ALTER DATABASE")) {
      expect(f.records.size).toBeGreaterThan(2); f.events.push("promote"); f.databaseName = "corgtex_core";
      expect(JSON.parse(await readFile(f.copied.stateFile)).phase).toBe("PROMOTION_INTENT");
      if (f.lostAlter) { f.lostAlter = false; throw new Error("uncertain private SQL acknowledgement"); } return { rows: [] };
    }
    throw new Error("unexpected SQL in bounded controller test");
  }
} } }));
vi.mock("./ops-core-redis-job.mjs", async importOriginal => ({ ...await importOriginal(), createRedisJobDispatcher: () => ({
  identity: { synthetic: true }, runProbe: async () => {},
  async prepare() { shared.current.events.push("prepare-probe"); },
}) }));
vi.mock("./ops-core-redis-gate.mjs", async importOriginal => {
  const original = await importOriginal();
  return { ...original, assertOpsCoreRedisEmpty: async options => {
    const f = shared.current; f.events.push("redis");
    expect(f.events).toContain("prepare-probe");
    const source = await options.assertSourceFenced(); const target = await options.assertTargetInactive();
    expect(target.targetBindingSha256).toBe(original.redisGateBindingSha256(options.target));
    expect(target.azureTargetBindingSha256).toBe(opsCoreAzureTargetBindingSha256(f.plan.azure));
    if (f.redisFails) throw new Error("private Redis diagnostic");
    return { status: "REDIS_EMPTY_ACCEPTED", domain: f.plan.domain, intentSha256: f.intentHash,
      sourceFenceSha256: source.sourceFenceSha256 };
  } };
});

vi.mock("./ops-core-postgres-state-gate.mjs", () => ({ assertOpsCorePostgresStateEmpty: async options => {
  const f = shared.current;
  f.events.push("postgres-state");
  expect(options.targetAdminConfig.database).toBe("postgres");
  expect(typeof options.assertSourceRedisBound).toBe("function");
  expect(options.targetDatabaseOid).toBe("16401");
  expect(options.sourceRedis).toEqual(f.plan.sharedState.sourceRedis);
  expect(options.targetBindingSha256).toBe(opsCoreAzureTargetBindingSha256(f.plan.azure));
  const source = await options.assertSourceFenced();
  await options.assertTargetInactive();
  if (f.postgresStateFails) throw new Error("private shared state diagnostic");
  return { status: "POSTGRES_SHARED_STATE_ACCEPTED", domain: f.plan.domain,
    intentSha256: f.intentHash, sourceFenceSha256: source.sourceFenceSha256,
    targetBindingSha256: options.targetBindingSha256 };
} }));

const databaseEvidence = () => ({
  server: { majorVersion: 18 }, locale: { encoding: "UTF8", collation: "C", ctype: "C", provider: "builtin",
    providerLocale: "C.UTF-8", icuRules: null, collationVersion: "1", actualCollationVersion: "1" },
  extensions: [{ name: "plpgsql", version: "1.0" }, { name: "vector", version: "0.8.2" }], schema: { algorithm: "PG_DUMP_SQL_TOKENS_V1", digest: "a".repeat(64) },
  tables: [{ schema: "public", name: "Event", rowCount: 0, rowSha256: "a".repeat(64) }],
  largeObjects: { count: 0, contentSha256: "a".repeat(64) }, migrations: { rows: [], counts: { finished: 0, rolledBack: 0, incomplete: 0 } },
  queues: { event: { statuses: [{ status: "DISPATCHED", count: 0 }, { status: "FAILED", count: 0 }, { status: "PENDING", count: 0 }], lockedCount: 0 },
    workflowJob: { statuses: [{ status: "CANCELLED", count: 0 }, { status: "COMPLETED", count: 0 }, { status: "FAILED", count: 0 },
      { status: "PENDING", count: 0 }, { status: "RUNNING", count: 0 }], lockedCount: 0 } },
});
async function syntheticCopy(options, event) {
  const f = shared.current; if (event) f.events.push(event);
  expect(options.operationStore).toBe(f.options.operationStore);
  await options.assertSourceFenced(); await options.assertTargetInactive();
  const operationDir = await mkdtemp(join(f.directory, "copy-")), stateFile = join(operationDir, "scratch-state.json");
  const source = databaseEvidence();
  if (f.bigCopy) for (let i = 0; i < 1000; i++) source.tables.push({ schema: "public", name: `fixture_${String(i).padStart(4, "0")}`, rowCount: 0, rowSha256: "a".repeat(64) });
  const evidence = { schemaVersion: "1.0.0", domain: f.plan.domain,
    sourceRef: "sha256:0123456789abcdef", targetRef: f.targetRef, source, destination: structuredClone(source),
    frozenSourceSequences: [], archiveSequences: { tocEntryCount: 0, beforeReplay: [], afterReplay: [] } };
  const { validatePostgresDatabaseParity } = await import("./validate-postgres-restore-rehearsal.mjs");
  const parity = validatePostgresDatabaseParity(evidence, { requireFrozenSourceSequences: true });
  const archive = { sha256: "a".repeat(64) };
  const evidenceSha256 = archiveEvidenceHash({ parity, archiveManifestSha256: archive.sha256 });
  for (const phase of ["CAPTURED", "RESTORED"]) {
    if (options.custody.snapshot().history.some(e => e.phase === phase)) continue;
    const op = options.custody.snapshot().pending ?? await options.custody.begin(phase, "d".repeat(64));
    await options.custody.complete(op.operationId, phase === "RESTORED" ? evidenceSha256 : archive.sha256);
  }
  const restore = options.custody.snapshot().history.find(e => e.phase === "RESTORED");
  const proof = { type: "POSTGRES_COPY_PARITY", restoreOperationId: restore.operationId, restoreIntentSha256: restore.intentSha256,
    scratchOid: "16401", archiveManifestSha256: archive.sha256, evidence, parity };
  const evidenceKey = `operations/${f.plan.domain}/${f.intentHash}/${restore.operationId}/phase-evidence-${archiveEvidenceHash(proof)}.json`;
  f.records.set(evidenceKey, JSON.stringify(proof));
  await writeFile(stateFile, JSON.stringify({ schemaVersion: "1.0.0", scratchName: options.scratchName, targetRef: f.targetRef, phase: "MIGRATION_RETAINED", scratchOid: "16401" }), { mode: 0o600 });
  return f.copied = { complete: true, phase: "RESTORED", operationDir, stateFile, scratchName: options.scratchName, scratchOid: "16401", archive, parity, evidence, evidenceKey, evidenceSha256 };
}

const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.custody.close(); await rm(f.directory, { recursive: true, force: true }); }
  shared.current = null;
});

async function fixture(changePlan = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "ops-core-transfer-"));
  const sub = "00000000-0000-4000-8000-000000000001";
  const root = `/subscriptions/${sub}/resourceGroups/migration-fixture/providers/`;
  const azure = { domain: "core", subscriptionId: sub, resourceGroupName: "migration-fixture",
    environmentId: `${root}Microsoft.App/managedEnvironments/fixture`,
    postgres: { resourceId: `${root}Microsoft.DBforPostgreSQL/flexibleServers/fixture-pg`,
      host: "fixture-pg.postgres.database.azure.com", major: 18, privateEndpointId: `${root}Microsoft.Network/privateEndpoints/pg` },
    redis: { resourceId: `${root}Microsoft.Cache/redisEnterprise/fixture-redis`,
      databaseId: `${root}Microsoft.Cache/redisEnterprise/fixture-redis/databases/default`,
      host: "fixture.westus3.redis.azure.net", port: 10000, privateEndpointId: `${root}Microsoft.Network/privateEndpoints/redis` },
    apps: { web: "fixture-web", worker: "fixture-worker" } };
  const redis = { source: { mode: "standalone", resourceId: null, server: { version: "8.2.9", runId: "a".repeat(40) },
    connection: { host: "source.local", port: 6379, database: 0, username: "default", tls: false } },
  target: { mode: "azure-enterprise-proxy", resourceId: azure.redis.databaseId, server: { version: "7.4.0", runId: null },
    connection: { host: azure.redis.host, port: 10000, database: 0, username: "default", tls: true } } };
  redis.job = { target: structuredClone(redis.target), environmentResourceId: azure.environmentId,
    jobResourceId: `${root}Microsoft.App/jobs/fixture-probe`,
    infrastructureSubnetId: `${root}Microsoft.Network/virtualNetworks/fixture/subnets/aca`,
    workspaceId: "00000000-0000-4000-8000-000000000002",
    identityResourceId: `${root}Microsoft.ManagedIdentity/userAssignedIdentities/fixture`,
    image: `fixture.azurecr.io/worker@sha256:${"d".repeat(64)}`, probeSha256: "e".repeat(64),
    redisSecretVersion: `https://fixture-vault.vault.azure.net/secrets/redis/${"a".repeat(32)}`, location: "westus3" };
  const sourceConnection = { host: "source.local", port: 5432, database: "railway", user: "postgres" };
  const plan = { schemaVersion: 1, domain: "core", azure, redis,
    source: { postgres: { expected: { connection: sourceConnection, readerRole: "reader" } } },
    transfer: { postgres: { source: { ...sourceConnection, user: "reader" },
      target: { host: azure.postgres.host, port: 5432, database: "postgres", user: "target_admin" },
      scratchName: "corgtex_rehearsal_10_1_core", targetIdentity: "fixture-pg", archiveStoreId: "archive-fixture",
      keyVersion: `https://fixture-vault.vault.azure.net/secrets/archive/${"a".repeat(32)}`, vaultName: "fixture-vault", maxArchiveBytes: 100000 },
    objects: { sourceStoreId: "source-objects", targetStoreId: "target-objects",
      limits: { maxPages: 2, maxObjects: 5, maxObjectBytes: 100, maxTotalBytes: 500 } } } };
  changePlan(plan);
  const intentHash = archiveEvidenceHash(plan);
  let journal = JSON.stringify(createCutoverJournal({ domain: "core", intentSha256: intentHash, evidenceSha256: "e".repeat(64) }));
  let etag = 0; let lease;
  const blob = {
    async acquire() { lease = randomUUID(); return lease; }, async renew(value) { expect(value).toBe(lease); }, async release() {},
    async read() { return { text: journal, etag }; },
    async write(text, expected) { expect(expected.etag).toBe(etag); journal = text; return { etag: ++etag }; },
  };
  let custody = await openCutoverCustody(blob, intentHash);
  const sourceFence = await custody.begin("SOURCE_FENCED", "d".repeat(64)); await custody.complete(sourceFence.operationId, "c".repeat(64));
  const f = { directory, custody, plan, intentHash, stateFile: join(directory, "scratch-state.json"), records: new Map(),
    events: [], sourceComplete: true, targetComplete: true, redisFails: false, closed: 0,
    databaseName: plan.transfer.postgres.scratchName };
  // Same opaque target reference contract as the actual scratch/promotion code.
  const { createHash } = await import("node:crypto");
  f.targetRef = `sha256:${createHash("sha256").update(`${azure.postgres.host}\0${plan.transfer.postgres.scratchName}`).digest("hex").slice(0, 16)}`;
  const sourceValues = new Map([["document", { data: Buffer.from("retained"), etag: "one", metadata: {}, contentType: "text/plain" }]]);
  const targetValues = new Map();
  function objects(identity, map) {
    return { identity, async assertPrivate() {},
      async head(key) { const v = map.get(key); return v ? { etag: v.etag, bytes: v.data.length, metadata: v.metadata, contentType: v.contentType } : null; },
      async read(key) { const v = map.get(key); return v ? { ...await this.head(key), body: (async function* () { yield v.data; })() } : null; },
      async createOnly(key, bytes, metadata, contentType) { if (map.has(key)) return false;
        f.events.push("object"); map.set(key, { data: bytes, metadata, contentType, etag: "target-one" }); return true; },
      async removeIfMatch() { throw new Error("deletion forbidden"); },
      async inventory() { return Promise.all([...map.keys()].map(async key => ({ key, ...await this.head(key) }))); },
    };
  }
  const secret = randomBytes(24).toString("base64");
  f.sourceValues = sourceValues; f.targetValues = targetValues;
  f.options = { plan, custody, artifactDir: directory, archiveStore: { identity: "archive-fixture" },
    sourceCredentials: { sourceConfig: { ...sourceConnection, password: secret },
      readerConfig: { ...sourceConnection, user: "reader", password: secret } },
    targetAdminConfig: { host: azure.postgres.host, port: 5432, database: "postgres", user: "target_admin",
      password: secret, sslmode: "verify-full", targetTlsRootCert: "local-test-only" },
    objectSource: objects("source-objects", sourceValues), objectTarget: objects("target-objects", targetValues),
    operationStore: { async assertPrivate() {}, async readOptional(key) { return f.records.get(key) ?? null; },
      async createOnly(key, text) { expect(f.records.has(key)).toBe(false); f.records.set(key, text);
        if (f.failPromotionReceipt && key.endsWith("/promotion-receipt.json")) { f.failPromotionReceipt = false; throw Error("private acknowledgement"); } } },
  };
  f.reopen = async () => { await custody.close(); custody = await openCutoverCustody(blob, intentHash); f.custody = custody; f.options.custody = custody; };
  fixtures.push(f); shared.current = f; return f;
}

describe("Ops/Core combined transfer controller", () => {
  it("integrates retained copy, real object transfer, durable promotion and Redis hash bridge before VERIFIED", async () => {
    const f = await fixture(); const result = await runOpsCoreDataTransfer(f.options);
    expect(result.status).toBe("VERIFIED"); expect(f.custody.snapshot().phase).toBe("VERIFIED");
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
    expect(f.events).toEqual(["copy", "object", "promote", "prepare-probe", "redis"]);
    expect(f.closed).toBe(1); expect(result.evidence.objects.entries).toHaveLength(1);
    expect(await f.options.objectTarget.head("document")).not.toBeNull();
    for (const text of f.records.values()) expect(text).not.toContain(f.options.targetAdminConfig.password);
  });
  it("rejects a different Redis target even when the surrounding intent is correctly hashed", async () => {
    const f = await fixture(plan => { plan.redis.target.connection.host = "other.westus3.redis.azure.net"; });
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_REDIS_BINDING_MISMATCH");
    expect(f.events).toEqual([]);
  });
  it("requires verified TLS for external Azure PostgreSQL before source capture", async () => {
    const f = await fixture(); f.options.targetAdminConfig.sslmode = "disable";
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_STORAGE_BINDING_MISMATCH");
    expect(f.events).toEqual([]);
  });
  it("rejects an unpinned probe image before source capture", async () => {
    const f = await fixture(plan => { plan.redis.job.image = "fixture.azurecr.io/worker:latest"; });
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.events).toEqual([]);
  });
  it("rejects an explicitly incomplete source or target assertion before any copy", async () => {
    for (const side of ["sourceComplete", "targetComplete"]) {
      const f = await fixture(); f[side] = false;
      await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow(side === "sourceComplete" ? "TRANSFER_SOURCE_UNPROVEN" : "TRANSFER_TARGET_UNPROVEN");
      expect(f.events).toEqual([]);
    }
  });
  it("retains promoted data and pending verification after a Redis failure, with no automatic repeat", async () => {
    const f = await fixture(); f.redisFails = true;
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.databaseName).toBe("corgtex_core"); expect(f.custody.snapshot().phase).toBe("RESTORED");
    expect(f.custody.snapshot().pending.to).toBe("VERIFIED");
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
    const previous = [...f.events];
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.events).toEqual(previous);
  });
});


describe("explicit interrupted transfer recovery", () => {
  it("reopens pending VERIFIED after Redis failure with full reads and no object/DB writes", async () => {
    const f = await fixture(); f.redisFails = true; await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow();
    const start = f.events.length; await f.reopen(); f.redisFails = false;
    const result = await reconcileOpsCoreDataTransfer(f.options);
    expect(result.status).toBe("VERIFIED"); expect(f.custody.snapshot().phase).toBe("VERIFIED");
    expect(f.events.slice(start)).toEqual(["observe-railway", "observe-corgtex_core", "prepare-probe", "redis"]);
    expect(result.evidence.parity.sourceSequenceParity).toBe("VERIFIED"); expect(result.evidence.parityEvidence.destination.tables).toHaveLength(1);
    expect(f.events.filter(e => e === "promote")).toHaveLength(1); expect(f.events.filter(e => e === "object")).toHaveLength(1);
  });
  it("lost durable promotion receipt acknowledgement reconciles without local marker or second ALTER", async () => {
    const f = await fixture(); f.failPromotionReceipt = true;
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow(); expect(f.databaseName).toBe("corgtex_core");
    await rm(f.copied.stateFile); await f.reopen();
    expect((await reconcileOpsCoreDataTransfer(f.options)).status).toBe("VERIFIED");
    expect(f.events.filter(e => e === "promote")).toHaveLength(1);
  });
  for (const [name, change] of [
    ["missing object", f => f.targetValues.delete("document")],
    ["source object drift", f => { f.sourceValues.get("document").etag = "changed"; }],
    ["target object corruption", f => { f.targetValues.get("document").data = Buffer.from("modified"); }],
    ["source database drift", f => { f.sourceDrift = true; }],
    ["destination row drift", f => { f.destinationDrift = true; }],
    ["database OID swap", f => { f.databaseOid = "16402"; }],
    ["database owner swap", f => { f.databaseOwner = "foreign"; }],
    ["unpromoted scratch", f => { f.databaseName = f.plan.transfer.postgres.scratchName; }],
    ["active sessions", f => { f.sessions = 1; }],
    ["observation database OID swap", f => { f.observedOid = "16402"; }],
    ["missing promotion intent", f => { for (const key of f.records.keys()) if (key.endsWith("/promotion-intent.json")) f.records.delete(key); }],
    ["missing copy receipt", f => { f.records.delete(f.copied.evidenceKey); }],
  ]) it(`reconcile refuses ${name} without repairing or mutating target`, async () => {
    const f = await fixture(); f.redisFails = true; await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow();
    await f.reopen(); f.redisFails = false; change(f); const start = f.events.length;
    await expect(reconcileOpsCoreDataTransfer(f.options)).rejects.toThrow(); expect(f.custody.snapshot().pending.to).toBe("VERIFIED");
    expect(f.events.slice(start)).not.toContain("promote"); expect(f.events.slice(start)).not.toContain("object"); expect(f.events.slice(start)).not.toContain("copy");
  });
  it("explicit resume at completed RESTORED freshly reconciles copy before first object/promotion effects", async () => {
    const f = await fixture(); const inventory = f.options.objectSource.inventory;
    f.options.objectSource.inventory = async () => { throw Error("interrupted before object effects"); };
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow(); expect(f.custody.snapshot().phase).toBe("RESTORED"); expect(f.custody.snapshot().pending).toBeNull();
    await f.reopen(); f.options.objectSource.inventory = inventory;
    expect((await resumeOpsCoreDataTransfer(f.options)).status).toBe("VERIFIED");
    expect(f.events).toEqual(["copy", "reconcile-copy", "object", "promote", "prepare-probe", "redis"]);
  });
  it("resume never accepts pending VERIFIED as permission to rerun writes", async () => {
    const f = await fixture(); f.redisFails = true; await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow();
    const before = [...f.events]; await expect(resumeOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED"); expect(f.events).toEqual(before);
  });
  it("phase-plan stays below SDK 64KiB while full immutable copy evidence stays separate", async () => {
    const f = await fixture(); f.bigCopy = true; await runOpsCoreDataTransfer(f.options);
    const values = [...f.records.entries()], phasePlan = values.find(([k, text]) => k.endsWith("/phase-plan.json") && JSON.parse(text).schemaVersion === 2);
    expect(Buffer.byteLength(phasePlan[1])).toBeLessThan(65536);
    const value = JSON.parse(phasePlan[1]); expect(value).not.toHaveProperty("postgresCopy");
    const copy = values.find(([k]) => k.endsWith(`/phase-evidence-${value.postgresCopyEvidenceSha256}.json`));
    expect(JSON.parse(copy[1]).copied.evidence.destination.tables).toHaveLength(1001);
    expect(Buffer.byteLength(copy[1])).toBeGreaterThan(65536);
  });
});


describe("copy phase continuation and terminal readback", () => {
  it("completed VERIFIED reconciliation reports only historical retained proof without probes", async () => {
    const f = await fixture(); const original = await runOpsCoreDataTransfer(f.options); await f.reopen();
    f.sourceComplete = false; f.targetComplete = false; const before = [...f.events];
    const retained = await reconcileOpsCoreDataTransfer(f.options);
    expect(retained).toMatchObject({ status: "VERIFIED", historical: true, freshAcceptance: false, evidenceSha256: original.evidenceSha256 });
    expect(f.events).toEqual(before);
    const entry = f.custody.snapshot().history.find(e => e.phase === "VERIFIED");
    f.records.delete(`operations/core/${f.intentHash}/${entry.operationId}/phase-evidence-${entry.evidenceSha256}.json`);
    await expect(reconcileOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_COMPLETED_EVIDENCE_CHANGED");
  });
  it("pending CAPTURED reconciles only capture and requires explicit subsequent resume", async () => {
    const f = await fixture(); await f.custody.begin("CAPTURED", "d".repeat(64));
    const result = await reconcileOpsCoreDataTransfer(f.options); expect(result.phase).toBe("CAPTURED");
    expect(f.custody.snapshot().pending).toBeNull(); expect(f.events).toEqual(["reconcile-copy"]);
    expect((await resumeOpsCoreDataTransfer(f.options)).status).toBe("VERIFIED");
    expect(f.events).toContain("resume-copy"); expect(f.events).not.toContain("copy");
  });
  it("pending RESTORED reconciliation stops at RESTORED without promotion or object writes", async () => {
    const f = await fixture(); const capture = await f.custody.begin("CAPTURED", "d".repeat(64)); await f.custody.complete(capture.operationId, "a".repeat(64));
    await f.custody.begin("RESTORED", "d".repeat(64));
    const result = await reconcileOpsCoreDataTransfer(f.options); expect(result.phase).toBe("RESTORED");
    expect(f.events).toEqual(["reconcile-copy"]); expect(f.custody.snapshot().phase).toBe("RESTORED"); expect(f.custody.snapshot().pending).toBeNull();
  });
  it("incomplete database proof cannot dispatch remaining steps", async () => {
    const f = await fixture(); const capture = await f.custody.begin("CAPTURED", "d".repeat(64)); await f.custody.complete(capture.operationId, "a".repeat(64));
    await f.custody.begin("RESTORED", "d".repeat(64)); f.copyIncomplete = true;
    expect(await reconcileOpsCoreDataTransfer(f.options)).toMatchObject({ complete: false, status: "INCOMPLETE" });
    expect(f.events).toEqual(["reconcile-copy"]); expect(f.custody.snapshot().pending.to).toBe("RESTORED");
  });
});


function postgresVariant(plan) {
  plan.schemaVersion = 2;
  plan.sharedState = { backend: "postgres", sourceRedis: structuredClone(plan.redis.source) };
  delete plan.redis;
  plan.azure.sharedStateBackend = "postgres";
  plan.azure.redis = null;
}

describe("PostgreSQL shared state transfer variant", () => {
  it("preserves transfer and promotion controls while recording PostgreSQL acceptance without Redis proof", async () => {
    const f = await fixture(postgresVariant);
    const result = await runOpsCoreDataTransfer(f.options);
    expect(result.status).toBe("VERIFIED");
    expect(f.events).toEqual(["copy", "object", "promote", "postgres-state"]);
    expect(result.evidence.sharedState.status).toBe("POSTGRES_SHARED_STATE_ACCEPTED");
    expect(Object.hasOwn(result.evidence, "redis")).toBe(false);
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
  });

  it.each([
    ["legacy plus PG state", plan => { plan.sharedState = { backend: "postgres", sourceRedis: plan.redis.source }; }],
    ["PG plus old Redis", plan => { const redis = plan.redis; postgresVariant(plan); plan.redis = redis; }],
    ["PG plus Redis Azure binding", plan => { const redis = plan.azure.redis; postgresVariant(plan); plan.azure.redis = redis; }],
    ["PG plus implicit Azure backend", plan => { postgresVariant(plan); delete plan.azure.sharedStateBackend; }],
    ["PG plus legacy schema", plan => { postgresVariant(plan); plan.schemaVersion = 1; }],
    ["legacy plus PG schema", plan => { plan.schemaVersion = 2; }],
  ])("rejects mixed variant %s before copying", async (name, mutate) => {
    const f = await fixture(mutate);
    expect(() => validateOpsCoreTransferPlan(f.plan)).toThrow();
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow();
    expect(f.events).toEqual([]);
  });

  it("keeps failed PostgreSQL acceptance in pending verification without activation", async () => {
    const f = await fixture(postgresVariant); f.postgresStateFails = true;
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow("TRANSFER_RECONCILIATION_REQUIRED");
    expect(f.custody.snapshot().phase).toBe("RESTORED");
    expect(f.custody.snapshot().pending.to).toBe("VERIFIED");
    expect(f.custody.snapshot().destinationMayHaveWritten).toBe(false);
    const previous = [...f.events];
    await expect(runOpsCoreDataTransfer(f.options)).rejects.toThrow();
    expect(f.events).toEqual(previous);
  });
});
